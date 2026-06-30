#!/usr/bin/env node
/**
 * One-command orchestrator for the the-crimson-gnome before/after workflow. Turns a
 * manifest into a finished, reviewable HTML report so a human/agent can't forget
 * a step (capture → diff → report) or eyeball stale screenshots. Pipeline:
 *
 *   1. cdp-batch.mjs   — capture EVERY row's beforeUrl→before and afterUrl→after
 *                        in parallel over one browser WebSocket.
 *   2. diff-images.mjs — per row with before+after, produce a diff PNG and set
 *                        row.diff + row.diffStats (changed-pixel %, pass, bbox).
 *   3. suggest-element — for rows that CHANGED (bbox present, not auto-pass), map
 *                        the diff bbox back to a DOM element on the after page and
 *                        set row.suggestedSelector (best-effort; failures are
 *                        non-fatal — a missing suggestion never blocks the report).
 *   4. write the mutated manifest back to disk (so the report + any re-run see
 *      diff/diffStats/suggestedSelector).
 *   5. build-report.mjs — emit the self-contained <task>.html.
 *
 *   node verify-ui.mjs <manifest.json> [out.html]
 *     env CDP_PORT(=9333) CDP_CONCURRENCY(=4) DIFF_CONCURRENCY(=4)
 *         PIXELMATCH_THRESHOLD CRIMSON_GNOME_PASS_PCT (forwarded to diff-images.mjs)
 *
 * Sub-steps run as child processes (execFileSync) so each script keeps its own
 * argv/env contract. A capture failure is NON-FATAL: missing shots render as
 * placeholders and the report is still built (the process exits non-zero so CI
 * still knows). A CDP-down (browser not launched) aborts early with guidance.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CDP_BATCH = join(HERE, 'cdp-batch.mjs');
const DIFF = join(HERE, 'diff-images.mjs');
const SUGGEST = join(HERE, 'suggest-element.mjs');
const BUILD_REPORT = join(HERE, 'build-report.mjs');

const [, , manifestPath, outArg] = process.argv;
if (!manifestPath) {
  console.error('Usage: node verify-ui.mjs <manifest.json> [out.html]');
  process.exit(1);
}

// Run a sub-script, inheriting stderr so its progress/errors are visible; return
// captured stdout for the steps we need to parse (diff JSON, suggested selector).
function run(script, args, { capture = false } = {}) {
  return execFileSync('node', [script, ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024, // diff-images prints small JSON, but be generous
  });
}

// Simple async pool so independent diff jobs run concurrently without exceeding
// the limit (mirrors cdp-batch's mapLimit; diffs are CPU-bound so cap modestly).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
const outHtml = outArg || manifestPath.replace(/\.json$/, '') + '.html';
const DIFF_CONCURRENCY = +(process.env.DIFF_CONCURRENCY || 4);

// ---- 1. capture every row's before/after via the batch runner --------------
// Capture failure is non-fatal: cdp-batch exits 1 when SOME shots failed (their
// PNGs just aren't written → placeholders downstream) and 2 when CDP isn't
// reachable at all (nothing to do → abort with guidance).
let captureFailed = false;
console.log('▶ capture (cdp-batch.mjs)…');
try {
  run(CDP_BATCH, [manifestPath]);
} catch (e) {
  if (e.status === 2) {
    // CDP-down: no browser, no shots — building a placeholder-only report is
    // pointless. Surface the actionable fix and stop.
    console.error('✖ capture aborted: dedicated browser not reachable — run `bash cdp-launch.sh` and log in once, then retry.');
    process.exit(2);
  }
  // Per-shot failure(s): some PNGs may be missing. Warn and continue — the report
  // renders "— no screenshot" for the gaps and diffs the rows that did capture.
  captureFailed = true;
  console.warn('⚠ some captures failed — missing shots will show as placeholders in the report.');
}

// ---- 2. diff each row that has both shots ----------------------------------
console.log('▶ diff (diff-images.mjs)…');
const diffJobs = rows.filter((r) => r.before && r.after);
await mapLimit(diffJobs, DIFF_CONCURRENCY, (row) => {
  // Derive the diff PNG path next to the after image if the manifest didn't set
  // one (foo-after.png → foo-after-diff.png; any *.png → *-diff.png).
  const diffPath = row.diff || row.after.replace(/\.png$/i, '-diff.png');
  let stats;
  try {
    const out = run(DIFF, [row.before, row.after, diffPath], { capture: true });
    stats = JSON.parse(out);
  } catch (e) {
    // A missing screenshot or a decode error shouldn't kill the whole report —
    // record it on the row so the human sees which one needs a re-capture.
    row.note = [row.note, `⚠️ diff failed: ${e.message.split('\n')[0]}`].filter(Boolean).join(' — ');
    return;
  }
  row.diff = stats.diff || diffPath;
  // Normalize diff output into the manifest's diffStats shape (drops the
  // before/after/diff path echoes that diff-images includes).
  row.diffStats = {
    changedPixels: stats.changedPixels,
    totalPixels: stats.totalPixels,
    pct: stats.pct,
    pass: stats.pass,
    width: stats.width,
    height: stats.height,
    bbox: stats.bbox ?? null,
  };
});

// Persist diff/diffStats NOW — suggest-element re-reads the manifest from disk,
// so it must see the fresh bbox (this write is re-done in step 4 to add the
// suggestedSelector). Without it, suggest-element sees a stale, bbox-less row.
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ---- 3. for CHANGED rows with a bbox, suggest the likely changed element ----
// Sequential on purpose: each opens a CDP page and we don't want to fan out tabs
// in the shared dedicated browser while cdp-batch's pages may still be closing.
console.log('▶ suggest-element (changed rows)…');
for (const row of rows) {
  const bbox = row.diffStats?.bbox;
  if (!bbox || row.diffStats?.pass || row.suggestedSelector || !row.afterUrl) continue;
  // Skip when the change spans ~the whole clip — there's no single "changed
  // element" to point at, and the heuristic would just pick a trivial nested
  // node (e.g. an SVG <path>). A 🎯 hint only helps for localized changes.
  const { width: dw = 1, height: dh = 1 } = row.diffStats;
  if (bbox.width * bbox.height >= 0.7 * dw * dh) continue;
  try {
    const out = run(SUGGEST, [manifestPath, String(row.id)], { capture: true });
    // suggest-element prints the selector on its LAST stdout line.
    const last = out.trim().split('\n').pop()?.trim();
    if (last) row.suggestedSelector = last;
  } catch (e) {
    // Best-effort: a failed suggestion just means no 🎯 hint for that row.
    console.error(`  suggest-element failed for row ${row.id}: ${e.message.split('\n')[0]}`);
  }
}

// ---- 4. persist the mutated manifest (diff/diffStats/suggestedSelector) -----
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ---- 5. build the report ----------------------------------------------------
console.log('▶ report (build-report.mjs)…');
run(BUILD_REPORT, [manifestPath, outHtml]);

// ---- summary ----------------------------------------------------------------
const diffed = rows.filter((r) => r.diffStats);
const changed = diffed.filter((r) => !r.diffStats.pass);
const autoPass = diffed.filter((r) => r.diffStats.pass);
const noDiff = rows.length - diffed.length;
console.log(
  `\n✔ ${outHtml}\n  rows: ${rows.length} · changed: ${changed.length} · auto-pass: ${autoPass.length}` +
    (noDiff ? ` · no-diff: ${noDiff}` : ''),
);
if (changed.length) {
  console.log('  changed → ' + changed.map((r) => `${r.id}(${r.diffStats.pct}%)`).join(', '));
}
// Non-zero exit if any capture failed, so CI/automation knows the report has gaps
// — but the report was still written above.
if (captureFailed) {
  console.warn('  (exit 1: report built, but some captures were missing)');
  process.exit(1);
}
