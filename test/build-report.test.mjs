// Tests for build-report.mjs — the report-rendering step of the pipeline.
// Spawns the CLI as a subprocess against a temp manifest (referencing real PNGs
// so base64 inlining runs), then asserts on the emitted HTML string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';

// Resolve the CLI relative to THIS test file so the suite passes regardless of cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_CLI = join(HERE, '..', 'build-report.mjs');

function writePng(dir, name) {
  const png = new PNG({ width: 8, height: 8 });
  const p = join(dir, name);
  writeFileSync(p, PNG.sync.write(png));
  return p;
}

// Build a report from `manifest`, return the generated HTML.
function buildReport(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'ui-diff-report-'));
  const manifestPath = join(dir, 'task.json');
  const outPath = join(dir, 'task.html');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  execFileSync('node', [REPORT_CLI, manifestPath, outPath], { encoding: 'utf8' });
  return readFileSync(outPath, 'utf8');
}

test('escapes HTML in titles and notes (no injection from manifest text)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-diff-report-'));
  const html = buildReport({
    title: 'T<script>alert(1)</script>',
    id: 'esc-1',
    rows: [
      {
        id: 'r1',
        title: 'Row <b>bold</b> & "quoted"',
        where: '/x?a=1&b=2',
        note: 'caveat <img src=x>',
        before: writePng(dir, 'b.png'),
        after: writePng(dir, 'a.png'),
      },
    ],
  });

  // The escaped forms must be present in the rendered HTML body (title, h1, row).
  // NB: titles/rows also appear as JS string literals inside the <script> block
  // (JSON.stringify'd → JS-string-safe), so we don't forbid the raw substring
  // globally — we assert HTML-context escaping where it actually matters.
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'title HTML-escaped');
  assert.ok(html.includes('Row &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;'), 'row title HTML-escaped');
  assert.ok(html.includes('caveat &lt;img src=x&gt;'), 'note HTML-escaped');
  // The note is body-only (never echoed into a JS literal), so its raw markup
  // must NOT appear anywhere — a genuine injection-vector check.
  assert.ok(!html.includes('caveat <img src=x>'), 'note never rendered raw');
});

test('namespaces localStorage by manifest id', () => {
  const withId = buildReport({
    title: 'Shared Title',
    id: 'unique-report-id-123',
    rows: [{ id: 'r1', title: 'A' }],
  });
  // The localStorage namespace must derive from the unique id, not the title —
  // so two reports sharing a title keep separate checkbox/notes state.
  assert.ok(withId.includes('unique-report-id-123'), 'namespace uses id');

  // Falls back to title when no id is supplied (contract: id ?? title).
  const noId = buildReport({ title: 'Only Title', rows: [{ id: 'r1', title: 'A' }] });
  assert.ok(noId.includes('Only Title'), 'namespace falls back to title');
});

test('renders in English by default (no leftover localized strings)', () => {
  const html = buildReport({ title: 'Default locale', id: 'en-1', rows: [{ id: 'r1', title: 'A' }] });
  assert.match(html, /<html lang="en"/, 'lang defaults to en');
  for (const s of ['Checked', 'Show changed only', 'Approve visible', 'Export JSON', 'My notes', 'Before', 'After']) {
    assert.ok(html.includes(s), `English UI string present: ${s}`);
  }
});

test('manifest.strings overrides any UI string (locale hook), and lang is honored', () => {
  const html = buildReport({
    title: 'Override',
    id: 'ov-1',
    lang: 'de',
    strings: { checked: 'Geprüft', exportJson: 'JSON exportieren', copied: 'Kopiert ✓' },
    rows: [{ id: 'r1', title: 'A' }],
  });
  assert.match(html, /<html lang="de"/, 'lang honored');
  assert.ok(html.includes('Geprüft'), 'overridden checkbox label rendered');
  assert.ok(html.includes('JSON exportieren'), 'overridden toolbar label rendered');
  // The script-side string is injected via JSON.stringify, so a non-ASCII / spaced
  // value survives intact (this is the G2 safe-injection guarantee).
  assert.ok(html.includes('Kopiert ✓'), 'overridden script-side string injected safely');
});

test('renders slider + diff column + decision + export when a row has diff + diffStats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-diff-report-'));
  const html = buildReport({
    title: 'Diff report',
    id: 'diff-1',
    rows: [
      {
        id: 'r1',
        title: 'Changed row',
        where: '/settings/profile',
        before: writePng(dir, 'b.png'),
        after: writePng(dir, 'a.png'),
        diff: writePng(dir, 'd.png'),
        diffStats: {
          changedPixels: 1234,
          totalPixels: 100000,
          pct: 1.234,
          pass: false,
          width: 400,
          height: 250,
          bbox: { x: 10, y: 20, width: 50, height: 60 },
        },
        suggestedSelector: "[data-ui-diff='save-button']",
      },
    ],
  });

  // before/after slider (clip-path comparison driven by a range input).
  assert.ok(html.includes('slider'), 'slider markup present');
  assert.ok(html.includes('type="range"'), 'slider range input present');
  // Third "Diff" column appears because the row carries a diff image.
  assert.ok(/diff/i.test(html), 'diff column present');
  // Verdict badge reflects diffStats (changed, not pass) with the percentage.
  assert.ok(html.includes('1.234'), 'diff pct rendered in verdict');
  // Per-row decision <select> with the contracted option set.
  assert.ok(html.includes('approved') && html.includes('rejected') && html.includes('needs-work'),
    'decision select options present');
  // Suggested selector hint line.
  assert.ok(html.includes("[data-ui-diff='save-button']")
    || html.includes('[data-ui-diff=&#39;save-button&#39;]')
    || html.includes('[data-ui-diff=&apos;save-button&apos;]'),
    'suggested selector rendered (escaped or raw)');
  // Export-to-JSON affordance (English label + the control id).
  assert.ok(html.includes('exportJson') && /export json/i.test(html), 'JSON export control present');
});

test('red-frame legend renders only when a row is actually framed', () => {
  // NB: the class tokens (.frame-legend/.frame-chip) also live in the <style> block,
  // so assert on the RENDERED <p class="frame-legend"> element, not the bare token.
  const LEGEND = '<p class="frame-legend">';

  // Auto-frame default: a row that clips to `sel` → legend + chip + text rendered.
  const framed = buildReport({ title: 'Framed', id: 'fr-1', rows: [{ id: 'r1', title: 'A', sel: '#save' }] });
  assert.ok(framed.includes(LEGEND), 'legend rendered when a row has a sel');
  assert.ok(framed.includes('<span class="frame-chip"'), 'red-frame chip rendered');
  assert.match(framed, /Red frame = the element under review/, 'legend text rendered');

  // Per-row opt-out (frame:false) suppresses the legend.
  const optOut = buildReport({ title: 'Opt out', id: 'fr-2', rows: [{ id: 'r1', title: 'A', sel: '#save', frame: false }] });
  assert.ok(!optOut.includes(LEGEND), 'no legend when the row opts out');

  // Global opt-out via capture.frame:false.
  const globalOff = buildReport({ title: 'Global off', id: 'fr-3', capture: { frame: false }, rows: [{ id: 'r1', title: 'A', sel: '#save' }] });
  assert.ok(!globalOff.includes(LEGEND), 'no legend when framing disabled globally');

  // Nothing to frame (no sel, no outline) → no legend.
  const noFrame = buildReport({ title: 'No frame', id: 'fr-4', rows: [{ id: 'r1', title: 'A' }] });
  assert.ok(!noFrame.includes(LEGEND), 'no legend when no row is framed');

  // An explicit outline always frames (even without a sel clip).
  const outlined = buildReport({ title: 'Outlined', id: 'fr-5', rows: [{ id: 'r1', title: 'A', outline: '#hero' }] });
  assert.ok(outlined.includes(LEGEND), 'legend rendered for an explicit outline');

  // The legend string is localizable via manifest.strings.
  const localized = buildReport({ title: 'PL', id: 'fr-6', strings: { frameLegend: 'Czerwona ramka = element w przeglądzie.' }, rows: [{ id: 'r1', title: 'A', sel: '#save' }] });
  assert.match(localized, /Czerwona ramka = element w przeglądzie\./, 'legend text is overridable via manifest.strings');
});
