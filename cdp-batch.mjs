#!/usr/bin/env node
/**
 * Parallel batch capturer — captures EVERY manifest row's beforeUrl→before and
 * afterUrl→after over ONE browser WebSocket using FLATTENED CDP sessions (one tab
 * per job, routed by sessionId). This collapses a per-shot shell loop (one process
 * + one WS + one theme RELOAD per image) into a single pooled run, taking N rows ×
 * {before,after} from "minutes" down to tens of seconds.
 *
 *   CDP_CONCURRENCY=4 node cdp-batch.mjs <manifest.json>
 *   env CDP_PORT(=9333)  CDP_CONCURRENCY(=4)
 *
 * Dependency-free (Node global WebSocket + fetch). CDP at 127.0.0.1:9333 — launch
 * the dedicated logged-in browser with cdp-launch.sh first. A shot showing the
 * login screen = that profile isn't logged in yet.
 *
 * Per page we (in order):
 *   1. createTarget(about:blank) + attachToTarget{flatten:true} → its own sessionId
 *   2. setDeviceMetricsOverride (viewport @scale)
 *   3. if theme: setEmulatedMedia(prefers-color-scheme) so media queries match,
 *      AND addScriptToEvaluateOnNewDocument that seeds the theme/seed localStorage
 *      BEFORE the page's own JS runs (no reload, no theme flash)
 *   4. addScriptToEvaluateOnNewDocument: deterministic-render prelude (freeze
 *      animations/transitions/caret, scroll-behavior auto, optionally hide framework
 *      dev overlays + optional per-row `hide` CSS) — injected pre-nav so first paint is stable
 *   5. navigate → race(loadEventFired, 15s) → optional readySel wait →
 *      document.fonts.ready + 2× rAF → sleep(wait)
 *   6. apply clicktext (open a <summary>'s <details>, else click a real button —
 *      never a wrapping <div>), then sel clip / outline / outlinetext framing
 *   7. captureScreenshot{format:png, captureBeyondViewport:true} (+clip when sel)
 *   8. writeFile; closeTarget in finally (so failures never leak tabs)
 *
 * Per-row capture overrides: row.capture merges over the manifest-level `capture`
 * defaults. Capture opts: w, h, scale, theme, themeKeys, seed, hide, hideDevOverlays,
 * wait, readySel, sel, clicktext, outline, outlinetext.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = process.env.CDP_PORT || 9333;
const CONCURRENCY = +(process.env.CDP_CONCURRENCY || 4);
const [, , manifestPath] = process.argv;
if (!manifestPath) {
  console.error('Usage: CDP_CONCURRENCY=4 node cdp-batch.mjs <manifest.json>');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const baseCapture = manifest.capture || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single multiplexed CDP connection. All jobs share one browser-level WebSocket;
 * replies are routed by `id` (command results) and `sessionId` (per-tab events),
 * so flattened sessions never cross-talk. Every send() carries a timeout that
 * rejects AND clears the pending entry — a hung CDP call must not stall the pool.
 */
class Cdp {
  id = 0;
  pending = new Map();
  waiters = [];

  async open() {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => this.onMessage(e));
    // If the browser drops, fail everything in flight instead of hanging forever.
    this.ws.addEventListener('close', () => {
      for (const { rej, t } of this.pending.values()) { clearTimeout(t); rej(new Error('CDP WebSocket closed')); }
      this.pending.clear();
      for (const w of this.waiters) { clearTimeout(w.t); w.rej(new Error('CDP WebSocket closed')); }
      this.waiters.length = 0;
    });
  }

  onMessage(e) {
    const m = JSON.parse(e.data);
    // Command result: match by id (ids are unique across the whole connection).
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      clearTimeout(p.t);
      this.pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    // Event: deliver to the newest matching waiter, scoped by sessionId so one
    // tab's Page.loadEventFired never resolves another tab's nav.
    if (m.method) {
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.event === m.method && (!w.sessionId || w.sessionId === m.sessionId)) {
          clearTimeout(w.t);
          this.waiters.splice(i, 1);
          w.res(m);
        }
      }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, t });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  once(event, sessionId, timeoutMs = 15000) {
    return new Promise((res, rej) => {
      const w = { event, sessionId, res, rej, t: null };
      w.t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        rej(new Error(`CDP event timeout: ${event}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  close() {
    this.ws?.close();
  }
}

const cdp = new Cdp();
try {
  await cdp.open();
} catch (e) {
  console.error(`Could not connect to CDP at 127.0.0.1:${PORT} — launch the browser with cdp-launch.sh first. (${e.message})`);
  process.exit(2);
}

/**
 * Script injected via Page.addScriptToEvaluateOnNewDocument so it runs BEFORE the
 * app's own JS on every navigation. Seeds theme + arbitrary localStorage (no reload
 * needed) and installs a freeze stylesheet the moment <html> exists, so even the
 * first paint has no animation/caret motion and (optionally) no framework dev
 * overlays — the prerequisite for low-noise pixel diffs. Nothing app-specific is
 * hardcoded: theme keys and seeds come from the manifest.
 */
function stablePrelude({ theme, themeKeys, seed = {}, hide = '', hideDevOverlays = true } = {}) {
  const keys = Array.isArray(themeKeys) && themeKeys.length ? themeKeys : ['theme', 'color-theme', 'ui-theme'];
  const seedJs = [
    ...(theme ? [`for(const k of ${JSON.stringify(keys)})localStorage.setItem(k,${JSON.stringify(theme)});`] : []),
    ...Object.entries(seed).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`),
  ].join('');
  const devCss = hideDevOverlays === false ? '' : 'nextjs-portal,[data-nextjs-toast],[data-nextjs-dialog-overlay] { display:none!important; }';
  return `
(() => {
  try {
    ${seedJs}
  } catch {}
  const css = \`
    *,*::before,*::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
    ${devCss}
    ${hide}
  \`;
  const add = () => {
    if (document.getElementById('__nitpick_freeze')) return;
    const s = document.createElement('style');
    s.id = '__nitpick_freeze';
    s.textContent = css;
    document.documentElement.appendChild(s);
  };
  // <html> may not exist yet at document-start → install on first node insert.
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { add(); o.disconnect(); } })
    .observe(document, { childList: true });
})();`;
}

/**
 * Open one flattened tab pre-configured for `opts` (merged manifest+row capture).
 * setEmulatedMedia + the localStorage seed both run pre-nav so the theme is
 * settled on first paint; the prelude is registered before navigate() too.
 */
async function newPage(opts) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: opts.w || 1440,
    height: opts.h || 900,
    deviceScaleFactor: opts.scale || 2,
    mobile: false,
  }, sessionId);
  if (opts.theme) {
    // Match prefers-color-scheme media queries to the seeded theme so components
    // that read the media query (not just our localStorage keys) also flip.
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: opts.theme }],
    }, sessionId);
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: stablePrelude(opts),
  }, sessionId);
  return { targetId, sessionId };
}

const evalJs = (sessionId, expression) =>
  cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    .then((r) => r.result?.value);

/**
 * Navigate and wait until the page is render-stable: load event (raced against
 * 15s for SPA routes that never fire it cleanly), optional readySel appearing,
 * web-fonts settled, two rAFs (lets the framework commit + layout flush), then `wait` ms.
 */
async function nav(sessionId, url, wait = 500, readySel) {
  const loaded = cdp.once('Page.loadEventFired', sessionId).catch(() => null);
  const navResult = await cdp.send('Page.navigate', { url }, sessionId);
  if (navResult.errorText) throw new Error(`navigation failed ${url}: ${navResult.errorText}`);
  await Promise.race([loaded, sleep(15000)]);
  if (readySel) {
    await evalJs(sessionId, `
      new Promise((resolve) => {
        const sel = ${JSON.stringify(readySel)};
        const ok = () => document.querySelector(sel);
        if (ok()) return resolve(true);
        const mo = new MutationObserver(() => { if (ok()) { mo.disconnect(); resolve(true); } });
        mo.observe(document, { childList:true, subtree:true });
        setTimeout(() => { mo.disconnect(); resolve(false); }, 10000);
      })`);
  }
  await evalJs(sessionId, `
    (async()=> {
      try { await document.fonts?.ready; } catch {}
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    })()`);
  if (wait) await sleep(wait);
}

// Highlight helper shared by outline/outlinetext (draws OUTSIDE the box via
// outline+offset → never covers content). Kept identical to cdp-shot.mjs.
const HILITE = `(s)=>{s.style.setProperty('outline','3px solid #f43f5e','important');s.style.setProperty('outline-offset','4px','important');s.style.setProperty('border-radius','10px','important');}`;

/**
 * Capture a single before/after job into its PNG. Reads all row capture opts
 * (sel, clicktext, outline, outlinetext) plus merged capture overrides.
 */
async function capture(job) {
  const opts = { ...baseCapture, ...(job.capture || {}) };
  const page = await newPage(opts);
  try {
    await nav(page.sessionId, job.url, opts.wait ?? 500, opts.readySel);

    if (job.clicktext) {
      // Prefer a native <summary> (open its <details>), else a real button —
      // never a wrapping ancestor <div> that merely contains the text.
      await evalJs(page.sessionId, `(()=>{const t=${JSON.stringify(job.clicktext)};let s=[...document.querySelectorAll('summary')].find(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(s){const d=s.closest('details');if(d){d.open=true;return 'details';}s.click();return 'summary';}let b=[...document.querySelectorAll('button,[role=button]')].find(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(b){b.click();return 'button';}return 'none';})()`);
      await sleep(opts.wait ?? 500);
    }

    if (job.outline || job.outlinetext) {
      // --outline=<css> frames all matches; --outlinetext frames the PARENT of
      // the tightest text match (so the frame doesn't obscure the text).
      if (job.outline) await evalJs(page.sessionId, `(()=>{const f=${HILITE};const els=[...document.querySelectorAll(${JSON.stringify(job.outline)})];els.forEach(f);return els.length;})()`);
      if (job.outlinetext) await evalJs(page.sessionId, `(()=>{const t=${JSON.stringify(job.outlinetext)};const f=${HILITE};const c=[...document.querySelectorAll('body *')].filter(e=>e.offsetParent!==null&&e.textContent.includes(t));const el=c.sort((a,b)=>a.textContent.length-b.textContent.length)[0];const tgt=(el&&el.parentElement)||el;if(tgt)f(tgt);return tgt?tgt.tagName:'none';})()`);
      await sleep(300);
    }

    let clip;
    if (job.sel) {
      // 8px pad around the element box; fail fast (don't silently full-page) so a
      // stale selector surfaces instead of producing a misleading diff.
      clip = await evalJs(page.sessionId, `(()=>{const e=document.querySelector(${JSON.stringify(job.sel)});if(!e)return null;const r=e.getBoundingClientRect();if(r.width<1||r.height<1)return null;return {x:Math.max(0,Math.floor(r.left+scrollX-8)),y:Math.max(0,Math.floor(r.top+scrollY-8)),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16),scale:1};})()`);
      if (!clip) throw new Error(`selector not found or empty: ${job.sel}`);
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      // ALWAYS beyond-viewport: a clip below the fold (e.g. #section-3 lower on
      // the page) must still render+capture. With `false` an off-screen clip
      // comes out blank.
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    }, page.sessionId, 60000);
    mkdirSync(dirname(job.out), { recursive: true });
    writeFileSync(job.out, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${job.out}${clip ? ` (clip ${job.sel})` : ''}${opts.theme ? ` theme=${opts.theme}` : ''}`);
  } finally {
    // Always reclaim the tab — a thrown selector/nav error must not leak it.
    await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
}

// Flatten every row into its before+after jobs. Carry all capture opts through so
// each job is self-describing inside the pool.
const jobs = [];
for (const row of manifest.rows || []) {
  for (const kind of ['before', 'after']) {
    if (!row[`${kind}Url`] || !row[kind]) continue;
    jobs.push({
      rowId: row.id,
      kind,
      url: row[`${kind}Url`],
      out: row[kind],
      sel: row.sel,
      clicktext: row.clicktext,
      outline: row.outline,
      outlinetext: row.outlinetext,
      capture: row.capture,
    });
  }
}

/**
 * Bounded-concurrency pool: at most `limit` workers pull from a shared index, so
 * at any instant ≤ limit tabs are open. Each job's failure is isolated to its row
 * (logged) so one bad selector doesn't abort the whole batch.
 */
async function mapLimit(items, limit, fn) {
  let i = 0;
  let failures = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const job = items[i++];
      try {
        await fn(job);
      } catch (e) {
        failures++;
        console.error(`FAILED ${job.out} (${job.url}): ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  return failures;
}

let failures = 0;
try {
  failures = await mapLimit(jobs, CONCURRENCY, capture);
} finally {
  cdp.close();
}
console.log(`batch done: ${jobs.length - failures}/${jobs.length} captured`);
if (failures) process.exit(1);
