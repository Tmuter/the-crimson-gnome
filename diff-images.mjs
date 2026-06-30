#!/usr/bin/env node
/**
 * Pixel-diff two PNG screenshots and emit a machine-readable verdict — the
 * "did this change?" signal the report uses to auto-pass unchanged rows and
 * draw a Diff column. Reads before/after, writes a highlighted diff PNG, prints
 * JSON {before,after,diff,width,height,changedPixels,totalPixels,pct,pass,bbox}.
 *
 *   node diff-images.mjs <before.png> <after.png> <diff.png>
 *
 * Env:
 *   PIXELMATCH_THRESHOLD=0.1   per-pixel colour-distance tolerance (0..1; higher = more permissive)
 *   NITPICK_PASS_PCT=0.02      % of changed pixels at/below which the row auto-passes
 *
 * The ONE allowed dependency island in this package: pixelmatch + pngjs.
 * Everything else in nitpicker stays dependency-free (Node global WebSocket + fetch).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [, , beforePath, afterPath, diffPath] = process.argv;
if (!beforePath || !afterPath || !diffPath) {
  console.error('Usage: node diff-images.mjs <before.png> <after.png> <diff.png>');
  process.exit(1);
}

// threshold = pixelmatch's per-pixel YIQ tolerance; passPct = the row-level gate
// (% changed pixels). Both env-overridable so a caller can tighten/loosen without
// editing the file — verify-ui.mjs spawns this per row with the same env.
const threshold = +(process.env.PIXELMATCH_THRESHOLD || 0.1);
const passPct = +(process.env.NITPICK_PASS_PCT || 0.02);

const before0 = PNG.sync.read(readFileSync(beforePath));
const after0 = PNG.sync.read(readFileSync(afterPath));

// before/after can differ in size (responsive reflow, full-page height drift).
// pixelmatch demands identical dimensions, so pad both up to the union box. The
// padded margin is transparent → it diffs clean against itself unless one image
// genuinely extends past the other.
const width = Math.max(before0.width, after0.width);
const height = Math.max(before0.height, after0.height);

function pad(img) {
  if (img.width === width && img.height === height) return img;
  // fill:true zero-inits the buffer (transparent black) before bitblt copies the
  // real pixels into the top-left; the rest stays transparent padding.
  const out = new PNG({ width, height, fill: true });
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

const before = pad(before0);
const after = pad(after0);
const diff = new PNG({ width, height });

// includeAA:false → ignore anti-aliasing noise (sub-pixel font rendering jitter
// would otherwise flood every row with false positives). diffColor = the rose
// [255,0,80] the report's Diff column expects.
const changedPixels = pixelmatch(before.data, after.data, diff.data, width, height, {
  threshold,
  includeAA: false,
  alpha: 0.15,
  diffColor: [255, 0, 80],
  diffColorAlt: [0, 160, 255]
});

// Tight bbox around the changed pixels so the report can point at the region
// (and verify-ui can map it back to a DOM element for suggestedSelector). We
// detect a diff pixel by the rose marker pixelmatch stamped: opaque + strong R,
// or the alt blue channel — matches the diffColor/diffColorAlt above.
let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (diff.data[i + 3] && (diff.data[i] > 200 || diff.data[i + 2] > 200)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}

writeFileSync(diffPath, PNG.sync.write(diff));

const totalPixels = width * height;
const pct = totalPixels ? (changedPixels / totalPixels) * 100 : 0;
const stats = {
  before: beforePath,
  after: afterPath,
  diff: diffPath,
  width,
  height,
  changedPixels,
  totalPixels,
  pct: +pct.toFixed(4),
  // pass = unchanged enough to skip human review. bbox null when nothing changed.
  pass: pct <= passPct,
  bbox: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null
};
console.log(JSON.stringify(stats, null, 2));
