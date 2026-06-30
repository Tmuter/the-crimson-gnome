#!/usr/bin/env node
/**
 * Capture a page screenshot from the dedicated CDP browser (see cdp-launch.sh) —
 * background-safe, no OS foreground needed, writes a PNG file. Dependency-free
 * (Node global WebSocket + fetch).
 *
 *   node cdp-shot.mjs <url> <out.png> [opts]
 *   --w=1440 --h=900 --scale=2   viewport metrics (desktop @2x by default)
 *   --wait=500                   settle ms after load / after each action (default 500 — short because we already await fonts.ready + 2x rAF)
 *   --full | --viewport          full-page (default) vs current viewport
 *   --theme=light|dark           emulate prefers-color-scheme + seed the theme localStorage keys BEFORE navigation (no reload)
 *   --themeKeys=a,b,c            which localStorage keys get the --theme value (default: theme,color-theme,ui-theme)
 *   --seed=key=value             seed an arbitrary localStorage entry before nav (repeatable; e.g. --seed=cookie_consent=granted)
 *   --hideDevOverlays[=false]    hide framework dev overlays (Next.js portals/toasts) — on by default; pass =false to keep them
 *   --clicktext="Advanced"       click first element whose text includes this, then wait (e.g. expand a disclosure)
 *   --sel="#section-2"           clip the shot to this element's box (fail-fast if not found)
 *   --readySel="[data-x]"        wait for this selector to appear before capturing (+ fonts.ready + 2x rAF)
 *   --hide=".foo{visibility:hidden!important}"  extra CSS appended to the deterministic-render prelude
 *   --outline="#sel"             frame matching element(s) with an outline (drawn OUTSIDE the box → no obscuring)
 *   --outlinetext="After how..."  frame the PARENT of the tightest element whose text includes this
 *   --frame                      draw a red frame around the --sel element (faithful: no border-radius)
 *
 * A shot showing the login screen = the dedicated profile isn't logged in yet —
 * run cdp-launch.sh and log in once in that window.
 */
import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const [, , url, out, ...rest] = process.argv;
if (!url || !out) { console.error('Usage: node cdp-shot.mjs <url> <out.png> [--w= --h= --scale= --wait= --full|--viewport --theme= --themeKeys= --seed=k=v --hideDevOverlays[=false] --clicktext= --sel= --readySel= --hide= --outline= --outlinetext= --frame]'); process.exit(1); }
const opt = (k, d) => { const a = rest.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const W = +opt('w', 1440), H = +opt('h', 900), SCALE = +opt('scale', 2), WAIT = +opt('wait', 500);
const FULL = !rest.includes('--viewport');
const THEME = opt('theme', null), CLICKTEXT = opt('clicktext', null), SEL = opt('sel', null);
const READYSEL = opt('readySel', null), HIDE = opt('hide', '');
const OUTLINE = opt('outline', null), OUTLINETEXT = opt('outlinetext', null);
const FRAME = rest.includes('--frame'); // draw a red frame around the --sel element (faithful: no border-radius)
// Which localStorage keys get the --theme value. Generic defaults — many apps
// read one of these; override with --themeKeys for an app-specific key.
const THEME_KEYS = opt('themeKeys', 'theme,color-theme,ui-theme').split(',').map((s) => s.trim()).filter(Boolean);
// Arbitrary localStorage seeding (repeatable --seed=k=v) — e.g. dismiss a cookie
// banner the app gates content behind. Nothing app-specific is hardcoded.
const SEED = {};
for (const p of rest.filter((x) => x.startsWith('--seed='))) { const s = p.slice(7); const i = s.indexOf('='); if (i > 0) SEED[s.slice(0, i)] = s.slice(i + 1); }
// Dev-overlay hiding is on by default (harmless on apps that have none — the
// selectors just match nothing); --hideDevOverlays=false keeps them.
const HIDE_DEV = opt('hideDevOverlays', 'true') !== 'false';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic-render prelude — runs on EVERY new document (before the page's
// own JS) so the very first paint is already frozen: kills animations/transitions,
// hides the caret, forces instant scroll, optionally hides framework dev overlays.
// When --theme/--seed are set we seed the localStorage keys here too, so the app
// reads the right state on first render — no load→localStorage→reload double-nav.
const seedJs = [
  ...(THEME ? [`for(const k of ${JSON.stringify(THEME_KEYS)})localStorage.setItem(k,${JSON.stringify(THEME)});`] : []),
  ...Object.entries(SEED).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`),
].join('');
const devCss = HIDE_DEV ? 'nextjs-portal,[data-nextjs-toast],[data-nextjs-dialog-overlay]{display:none!important}' : '';
const prelude = `(()=>{try{${seedJs}}catch{}
const css=\`
*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}
${devCss}
${HIDE}
\`;
const add=()=>{if(document.getElementById('__ui_diff_freeze'))return;const s=document.createElement('style');s.id='__ui_diff_freeze';s.textContent=css;document.documentElement.appendChild(s)};
if(document.documentElement)add();
else new MutationObserver((_,o)=>{if(document.documentElement){add();o.disconnect()}}).observe(document,{childList:true});
})();`;

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const waiters = [];
// Every send() carries a timeout that rejects + clears the pending entry, so a
// CDP hang never stalls the process forever. The timer is cleared on response.
const send = (method, params = {}, sessionId, timeoutMs = 30000) => new Promise((res, rej) => {
  const _id = ++id;
  const t = setTimeout(() => { pending.delete(_id); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
  pending.set(_id, { res, rej, t });
  ws.send(JSON.stringify({ id: _id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// once() waiters self-clean on their own timeout — otherwise a missed event
// (e.g. Page.loadEventFired that never fires) would leak a dangling waiter.
const once = (event, sessionId, timeoutMs = 15000) => new Promise((res, rej) => {
  const w = { event, sessionId, res, t: null };
  w.t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error(`CDP event timeout: ${event}`)); }, timeoutMs);
  waiters.push(w);
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method) for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; if (w.event === m.method && (!w.sessionId || w.sessionId === m.sessionId)) { clearTimeout(w.t); waiters.splice(i, 1); w.res(m); } }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
// Everything after target creation runs inside try/finally so the target ALWAYS
// closes — even on a thrown selector/navigation error — and never leaks a tab.
try {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false }, sessionId);
  if (THEME) {
    // Pair the localStorage seed (in the prelude) with the OS-level media query so
    // apps that read prefers-color-scheme directly also match. Set before nav.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] }, sessionId);
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: prelude }, sessionId);
  const evalJs = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result?.value);

  async function navAndLoad(u) {
    const loaded = once('Page.loadEventFired', sessionId).catch(() => null);
    const nav = await send('Page.navigate', { url: u }, sessionId);
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    await Promise.race([loaded, sleep(15000)]);
    if (READYSEL) {
      // Wait for the target selector to mount (MutationObserver, 10s cap) — covers
      // client-rendered surfaces that aren't present at load.
      await evalJs(`new Promise((resolve)=>{const s=${JSON.stringify(READYSEL)};if(document.querySelector(s))return resolve(true);const mo=new MutationObserver(()=>{if(document.querySelector(s)){mo.disconnect();resolve(true)}});mo.observe(document,{childList:true,subtree:true});setTimeout(()=>{mo.disconnect();resolve(false)},10000);})`);
    }
    // Web fonts and two animation frames before we trust the layout — removes the
    // biggest source of pixel-diff noise (font swap + first-paint reflow).
    await evalJs(`(async()=>{try{await document.fonts?.ready}catch{} await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
    await sleep(WAIT);
  }
  await navAndLoad(url);

  if (CLICKTEXT) {
    // Prefer a native <summary> (open its <details>), else a real button — never a
    // wrapping ancestor <div> that merely contains the text.
    await evalJs(`(()=>{const t=${JSON.stringify(CLICKTEXT)};let s=[...document.querySelectorAll('summary')].find(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(s){const d=s.closest('details');if(d){d.open=true;return 'details';}s.click();return 'summary';}let b=[...document.querySelectorAll('button,[role=button]')].find(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(b){b.click();return 'button';}return 'none';})()`);
    await sleep(WAIT);
  }
  if (OUTLINE || OUTLINETEXT) {
    // Frame the changed element with an OUTLINE (drawn OUTSIDE the box → never covers
    // content) + offset. --outline=<css> outlines all matches; --outlinetext outlines
    // the PARENT of the tightest text match (so the frame doesn't obscure the text).
    const HILITE = `(s)=>{s.style.setProperty('outline','3px solid #f43f5e','important');s.style.setProperty('outline-offset','4px','important');s.style.setProperty('border-radius','10px','important');}`;
    if (OUTLINE) await evalJs(`(()=>{const f=${HILITE};const els=[...document.querySelectorAll(${JSON.stringify(OUTLINE)})];els.forEach(f);return els.length;})()`);
    if (OUTLINETEXT) await evalJs(`(()=>{const t=${JSON.stringify(OUTLINETEXT)};const f=${HILITE};const c=[...document.querySelectorAll('body *')].filter(e=>e.offsetParent!==null&&e.textContent.includes(t));const el=c.sort((a,b)=>a.textContent.length-b.textContent.length)[0];const tgt=(el&&el.parentElement)||el;if(tgt)f(tgt);return tgt?tgt.tagName:'none';})()`);
    await sleep(300);
  }

  if (FRAME && SEL) {
    // Frame the --sel element itself (faithful: no border-radius mutation). Sits in
    // the +8px sel-clip margin so it stays visible even on a clipped shot.
    const FRAMECSS = `(s)=>{s.style.setProperty('outline','3px solid #f43f5e','important');s.style.setProperty('outline-offset','4px','important');}`;
    await evalJs(`(()=>{const f=${FRAMECSS};const e=document.querySelector(${JSON.stringify(SEL)});if(e){f(e);return true;}return false;})()`);
    await sleep(150);
  }

  let clip;
  if (SEL) {
    clip = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(SEL)});if(!e)return null;const r=e.getBoundingClientRect();if(r.width<1||r.height<1)return null;return {x:Math.max(0,Math.floor(r.left+scrollX-8)),y:Math.max(0,Math.floor(r.top+scrollY-8)),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16),scale:1};})()`);
    // Fail fast: a missing --sel must error, not silently fall back to full-page —
    // a silent full-page shot would produce a noisy, misleading diff.
    if (!clip) throw new Error(`selector not found or empty: ${SEL}`);
  }
  const shotParams = { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : (FULL ? {} : { captureBeyondViewport: false })) };
  const { data } = await send('Page.captureScreenshot', shotParams, sessionId, 60000);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`wrote ${out} (${clip ? `clip ${SEL}` : FULL ? 'full-page' : 'viewport'}${THEME ? ` theme=${THEME}` : ''})`);
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  ws.close();
}
