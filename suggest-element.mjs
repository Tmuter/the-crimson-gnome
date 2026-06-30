#!/usr/bin/env node
/**
 * Suggest the CSS selector of the element that most likely CHANGED, given a
 * pixel-diff bounding box. The diff bbox comes back from diff-images.mjs in
 * DEVICE pixels (screenshots are captured at deviceScaleFactor), so we divide
 * by the capture scale to get CSS pixels before asking the DOM which visible
 * elements overlap that region. We rank by overlap-fraction (how much of the
 * element sits inside the changed box) then by smallest area, so we land on the
 * tightest element that actually changed rather than a giant wrapper. We prefer
 * stable hooks ([data-nitpick] / id / [data-testid]) over a tag.class guess so
 * the suggestion can be pasted straight back into a manifest row's `sel`.
 *
 *   node suggest-element.mjs <manifest.json> <rowId>
 *   node suggest-element.mjs <afterUrl> '<bboxJson>' [scale]
 *
 * In manifest mode we read the row's `afterUrl` + `diffStats.bbox` + capture
 * scale ourselves; in URL mode the caller passes them explicitly (handy for
 * one-off probing). Prints the suggested selector on the last stdout line and
 * a JSON line with the ranked candidates before it. Dependency-free (Node
 * global WebSocket + fetch). CDP must be up (see cdp-launch.sh).
 */
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- resolve inputs (manifest+rowId  OR  afterUrl+bbox[+scale]) -------------
const [, , arg1, arg2, arg3] = process.argv;
if (!arg1 || !arg2) {
  console.error('Usage: node suggest-element.mjs <manifest.json> <rowId>');
  console.error('   or: node suggest-element.mjs <afterUrl> \'{"x":..,"y":..,"width":..,"height":..}\' [scale]');
  process.exit(1);
}

let afterUrl;
let bbox;
let scale;
const looksLikeUrl = /^https?:\/\//i.test(arg1);
if (looksLikeUrl) {
  // URL mode: explicit bbox (device px) + optional scale.
  afterUrl = arg1;
  bbox = JSON.parse(arg2);
  scale = +(arg3 || 2);
} else {
  // Manifest mode: pull everything from the named row so this matches what
  // verify-ui.mjs would feed us (one source of truth for scale + bbox).
  const manifest = JSON.parse(readFileSync(arg1, 'utf8'));
  const row = (manifest.rows || []).find((r) => String(r.id) === String(arg2));
  if (!row) { console.error(`row not found: ${arg2}`); process.exit(1); }
  afterUrl = row.afterUrl;
  bbox = row.diffStats?.bbox;
  // Per-row capture overrides win over the global default, mirroring cdp-batch.
  scale = +(row.capture?.scale ?? manifest.capture?.scale ?? 2);
  if (!afterUrl) { console.error(`row ${arg2} has no afterUrl`); process.exit(1); }
  if (!bbox) { console.error(`row ${arg2} has no diffStats.bbox (run diff first)`); process.exit(1); }
}

// Device px → CSS px. Screenshots/bbox are at deviceScaleFactor; getBoundingClientRect is CSS px.
const box = {
  x: bbox.x / scale,
  y: bbox.y / scale,
  width: bbox.width / scale,
  height: bbox.height / scale,
};

// ---- minimal CDP client (same send/once/timeout shape as cdp-shot.mjs) ------
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const waiters = [];
const send = (method, params = {}, sessionId, timeoutMs = 30000) => new Promise((res, rej) => {
  const _id = ++msgId;
  // Every send MUST be able to time out, else a CDP hang stalls the whole run.
  const t = setTimeout(() => { pending.delete(_id); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
  pending.set(_id, { res, rej, t });
  ws.send(JSON.stringify({ id: _id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const once = (event, sessionId, timeoutMs = 15000) => new Promise((res) => {
  const w = { event, sessionId, res };
  // Self-evicting timeout so an event that never fires doesn't leak a waiter.
  w.t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(null); }, timeoutMs);
  waiters.push(w);
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    return;
  }
  if (m.method) for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.event === m.method && (!w.sessionId || w.sessionId === m.sessionId)) {
      clearTimeout(w.t); waiters.splice(i, 1); w.res(m);
    }
  }
});

let targetId;
try {
  ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const evalJs = (expression) =>
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result?.value);

  // Navigate to the AFTER page (that's where the changed element lives now).
  const loaded = once('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url: afterUrl }, sessionId);
  await Promise.race([loaded, sleep(15000)]);
  // Let fonts + two frames settle so geometry matches what was screenshotted.
  await evalJs(`(async()=>{try{await document.fonts?.ready}catch{} await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
  await sleep(300);

  // Ask the DOM which visible elements overlap the changed box. Rank by
  // overlap-fraction (overlap / element area) — a tiny element fully inside the
  // box beats a huge wrapper that the box only nicks — then by smallest area as
  // a tiebreak. Build a stable selector preferring [data-nitpick] → id →
  // [data-testid] → tag.class so the result is paste-ready into a manifest.
  const candidates = await evalJs(`(() => {
    const box = ${JSON.stringify(box)};
    const overlap = (a, b) => {
      const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      return ox * oy;
    };
    const sel = (el) => {
      if (el.dataset && el.dataset.nitpick) return '[data-nitpick="' + CSS.escape(el.dataset.nitpick) + '"]';
      if (el.id) return '#' + CSS.escape(el.id);
      const tid = el.getAttribute('data-testid');
      if (tid) return '[data-testid="' + CSS.escape(tid) + '"]';
      const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      return el.tagName.toLowerCase() + cls;
    };
    return [...document.querySelectorAll('body *')]
      .filter((e) => e.offsetParent !== null) // visible only (offsetParent null = display:none / detached)
      .map((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        const a = { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
        const ov = overlap(a, box);
        if (!ov) return null;
        const area = r.width * r.height;
        return { selector: sel(e), text: (e.textContent || '').trim().slice(0, 80), area, overlap: ov, frac: ov / area };
      })
      .filter(Boolean)
      .sort((a, b) => (b.frac - a.frac) || (a.area - b.area))
      .slice(0, 5);
  })()`);

  const ranked = candidates || [];
  const suggestedSelector = ranked[0]?.selector || null;
  // Candidates first (machine-readable), suggestion LAST so callers can grab the
  // final stdout line (verify-ui.mjs reads it that way).
  console.log(JSON.stringify({ afterUrl, scale, box, candidates: ranked }, null, 2));
  console.log(suggestedSelector || '');
} finally {
  if (targetId) await send('Target.closeTarget', { targetId }).catch(() => {});
  ws.close();
}
