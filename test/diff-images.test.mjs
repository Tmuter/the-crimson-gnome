// Tests for diff-images.mjs — the pixel-diff step of the pipeline. Spawns the CLI
// as a real subprocess (it prints a single JSON blob to stdout and writes a diff
// PNG), so these assert the actual contracted I/O, not internals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';

// Resolve the CLI relative to THIS test file so the suite passes regardless of cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const DIFF_CLI = join(HERE, '..', 'diff-images.mjs');

// Write a solid-color RGBA PNG and return its path.
function writePng(dir, name, w, h, [r, g, b, a = 255] = [0, 0, 0, 255]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  const p = join(dir, name);
  writeFileSync(p, PNG.sync.write(png));
  return p;
}

function runDiff(before, after, diff) {
  // execFileSync throws on non-zero exit, which would fail the test — exactly
  // what we want (a crash in the diff step must surface, not pass silently).
  const stdout = execFileSync('node', [DIFF_CLI, before, after, diff], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

test('identical images auto-pass (changedPixels 0, pass true, diff written)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crimson-gnome-diff-'));
  // Same content twice → zero changed pixels → must auto-pass.
  const before = writePng(dir, 'before.png', 24, 16, [120, 80, 200]);
  const after = writePng(dir, 'after.png', 24, 16, [120, 80, 200]);
  const diff = join(dir, 'diff.png');

  const stats = runDiff(before, after, diff);

  // Contract essentials for an unchanged row: no changed pixels → auto-pass at 0%.
  // (We don't assert on bbox here: pixelmatch renders the unchanged background as
  // the original blended over white — always bright — so the diff step's bbox
  // heuristic isn't a meaningful "no change" signal; `changedPixels`/`pass` are.)
  assert.equal(stats.changedPixels, 0, 'no pixels should differ');
  assert.equal(stats.pass, true, 'zero-change diff must auto-pass');
  assert.equal(stats.totalPixels, 24 * 16, 'totalPixels = w*h');
  assert.equal(stats.pct, 0, 'pct is 0% for identical images');
  // The diff PNG is a real artifact the report inlines — it must exist + be non-empty.
  assert.ok(existsSync(diff), 'diff file written');
  assert.ok(readFileSync(diff).length > 0, 'diff file non-empty');
});

test('different-size inputs are padded and do not crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crimson-gnome-diff-'));
  // Mismatched dimensions are the historical crash case: diff-images must pad to
  // max(w,h) via PNG.bitblt instead of throwing on a buffer-length mismatch.
  const before = writePng(dir, 'before.png', 20, 10, [255, 255, 255]);
  const after = writePng(dir, 'after.png', 30, 25, [255, 255, 255]);
  const diff = join(dir, 'diff.png');

  const stats = runDiff(before, after, diff);

  assert.equal(stats.width, 30, 'width padded to max');
  assert.equal(stats.height, 25, 'height padded to max');
  assert.equal(stats.totalPixels, 30 * 25, 'totalPixels uses padded dims');
  // The padded region (where `before` had no pixels) differs → non-zero change,
  // a finite pct, and a bbox covering it. The point is it ran without crashing.
  assert.ok(stats.changedPixels > 0, 'padding region registers as changed');
  assert.ok(Number.isFinite(stats.pct), 'pct is a finite number');
  assert.ok(stats.bbox && typeof stats.bbox.width === 'number', 'bbox computed');
  assert.ok(existsSync(diff) && readFileSync(diff).length > 0, 'diff file written');
});
