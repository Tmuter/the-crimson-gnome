#!/usr/bin/env node
/**
 * Build a self-contained before/after review report (static HTML) from a manifest.
 *
 *   node build-report.mjs <manifest.json> [out.html]
 *
 * The template, CSS (dark-aware), responsive layout, and the localStorage
 * wiring (checkbox + decision <select> + notes persistence) all live HERE. To
 * produce a report you only supply a manifest — images + descriptions + diff
 * stats — nothing else to hand-write.
 *
 * Manifest shape:
 * {
 *   "title": "Settings page — review",
 *   "id": "settings-2026-02-14T1200",          // unique → localStorage namespace
 *   "lang": "en",                                // optional, <html lang>; default "en"
 *   "strings": { "checked": "Checked", ... },    // optional, override any UI string
 *   "rows": [
 *     { "id": "a1", "title": "Save button restyled",
 *       "where": "/settings → Profile",
 *       "before": ".crimson-gnome/a1-before.png",       // path | null
 *       "after":  ".crimson-gnome/a1-after.png",         // path | null
 *       "diff":   ".crimson-gnome/a1-diff.png",          // optional, filled by diff-images.mjs
 *       "diffStats": { "pct": 0.41, "pass": false, "bbox": {…} },  // optional, from diff-images.mjs
 *       "suggestedSelector": "[data-crimson-gnome=\"save-button\"]", // optional, auto-detected
 *       "note":   "needs a logged-in session" }    // optional, pre-filled, read-only ℹ️ context
 *   ]
 * }
 * before/after may be omitted/null → a "— no screenshot" placeholder renders.
 * Images are inlined as base64 data-URIs so the .html is fully portable.
 *
 * NOTE: the generated .html embeds full-resolution screenshots of whatever the
 * capture browser rendered — treat it as sensitive (it can contain private data).
 *
 * WHY localStorage is namespaced by manifest.id (fallback title): two reports
 * with the same title would otherwise share checkbox/notes/decision state.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, dirname } from 'node:path';

const [, , manifestPath, outArg] = process.argv;
if (!manifestPath) {
  console.error('Usage: node build-report.mjs <manifest.json> [out.html]');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const out = outArg || manifestPath.replace(/\.json$/, '') + '.html';
const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
const lang = manifest.lang || 'en';
const manifestDir = dirname(resolve(manifestPath));

// All user-facing copy. English built-in; override any key via manifest.strings
// (that's how a non-English locale is supported — supply your own table). The
// three keys used inside the inlined <script> (combinedHeader/noNotes/copied)
// are injected via JSON.stringify below, so apostrophes/quotes/newlines are safe.
const STRINGS = {
  reportTitle: 'UI verification',
  intro: 'Tick “Checked”, set a decision, write in “My notes” on each item — they join into a comment at the bottom (Copy button). State is saved locally and survives reload. Click a screenshot to zoom. Shortcuts: <code>j/k</code> navigate, <code>c</code> checked, <code>a</code> approve, <code>r</code> reject, <code>Enter</code> zoom.',
  showChanged: 'Show changed only',
  approveVisible: 'Approve visible',
  exportJson: 'Export JSON',
  checked: 'Checked',
  decisionPlaceholder: '— decision —',
  decisionAria: 'Decision',
  verdictAutoPass: 'auto-pass',
  verdictChanged: 'changed',
  verdictNone: 'no diff',
  before: 'Before',
  after: 'After',
  diff: 'Diff',
  sliderAria: 'before/after comparison',
  beforePrefix: 'before: ',
  afterPrefix: 'after: ',
  diffPrefix: 'diff: ',
  missing: '— no screenshot',
  likelyChanged: 'likely changed:',
  myNotes: 'My notes',
  myNotesPlaceholder: 'What to fix / a note on this change — joins at the bottom',
  combinedTitle: 'All notes',
  generalNotes: 'General notes (outside the items)',
  generalNotesPlaceholder: 'Anything outside the items…',
  commentToCopy: 'Comment to copy (auto-joined)',
  copy: '📋 Copy',
  copied: 'Copied ✓',
  lbClose: 'Close',
  lbPrev: 'Previous',
  lbNext: 'Next',
  combinedHeader: 'UI verification — ',
  noNotes: '(no notes — add something in “My notes” on the items)',
};
const S = { ...STRINGS, ...(manifest.strings || {}) };

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function dataUri(p) {
  if (!p) return null;
  // Resolve image paths relative to the CWD first (how the pipeline writes them),
  // then relative to the manifest's own directory (so a hand-written / bundled
  // manifest works regardless of where it is run from).
  for (const cand of [resolve(p), resolve(manifestDir, p)]) {
    try {
      const buf = readFileSync(cand);
      return `data:${MIME[extname(p).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`;
    } catch { /* try next candidate */ }
  }
  return null;
}
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function shot(p, label, cls = 'shot-img') {
  const uri = dataUri(p);
  return uri
    ? `<img class="${cls}" src="${uri}" alt="${esc(label)}" data-cap="${esc(label)}" loading="lazy">`
    : `<div class="missing">${esc(S.missing)}${p ? ` (${esc(p)})` : ''}</div>`;
}
// Render diffStats.pct → a human verdict badge. We compute the inlined data-URIs
// once per row so the slider + the (optional) Diff column reuse them.
function verdictBadge(stats) {
  if (!stats || stats.pct == null) return `<span class="verdict none">${esc(S.verdictNone)}</span>`;
  const pct = typeof stats.pct === 'number' ? stats.pct : Number(stats.pct);
  const shown = Number.isFinite(pct) ? pct : 0;
  return stats.pass
    ? `<span class="verdict pass">${esc(S.verdictAutoPass)}: ${shown}%</span>`
    : `<span class="verdict changed">${esc(S.verdictChanged)}: ${shown}%</span>`;
}

const rowsHtml = rows
  .map((r, i) => {
    const id = esc(r.id || String(i + 1));
    const beforeUri = dataUri(r.before);
    const afterUri = dataUri(r.after);
    const hasSlider = beforeUri && afterUri;
    const isPass = !!r.diffStats?.pass;
    // Slider: stack after over before, clip the top image with clip-path driven
    // by a range input (--pos). Lets you wipe between states without flipping.
    const sliderHtml = hasSlider
      ? `    <div class="slider" style="--pos:50%">
      <img src="${beforeUri}" alt="${esc(S.beforePrefix + (r.title || ''))}">
      <img class="top" src="${afterUri}" alt="${esc(S.afterPrefix + (r.title || ''))}">
      <input type="range" min="0" max="100" value="50" aria-label="${esc(S.sliderAria)}">
    </div>\n`
      : '';
    return `  <section class="row${isPass ? ' is-pass' : ''}" id="row-${id}" data-rowid="${id}">
    <div class="hd">
      <span class="num">${i + 1}</span>
      <div class="meta"><h2>${esc(r.title || '')}</h2>${r.where ? `<p class="where">${esc(r.where)}</p>` : ''}</div>
      <div class="checks">
        <label class="chk"><input type="checkbox" data-persist="chk-${id}"> ${esc(S.checked)}</label>
        <select class="decision" data-decision data-persist="decision-${id}" aria-label="${esc(S.decisionAria)}">
          <option value="">${esc(S.decisionPlaceholder)}</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
          <option value="needs-work">needs-work</option>
          <option value="auto-pass">auto-pass</option>
        </select>
      </div>
    </div>
    <div class="verdict-row">${verdictBadge(r.diffStats)}</div>
${sliderHtml}    <div class="shots${r.diff ? ' tri' : ''}">
      <figure><figcaption>${esc(S.before)}</figcaption>${shot(r.before, S.beforePrefix + (r.title || ''))}</figure>
      <figure><figcaption>${esc(S.after)}</figcaption>${shot(r.after, S.afterPrefix + (r.title || ''))}</figure>
      ${r.diff ? `<figure><figcaption>${esc(S.diff)}</figcaption>${shot(r.diff, S.diffPrefix + (r.title || ''), 'shot-img diff-img')}</figure>` : ''}
    </div>
    ${r.suggestedSelector ? `<p class="ctx">🎯 ${esc(S.likelyChanged)} <code>${esc(r.suggestedSelector)}</code></p>` : ''}
    ${r.note ? `<p class="ctx">ℹ️ ${esc(r.note)}</p>` : ''}
    <label class="note">${esc(S.myNotes)}<textarea data-mynote data-persist="mynote-${id}" data-title="${esc(r.title || '#' + (i + 1))}" rows="2" placeholder="${esc(S.myNotesPlaceholder)}"></textarea></label>
  </section>`;
  })
  .join('\n');

// Light-weight row model handed to the report JS for the Export JSON feature.
// We carry only persisted/derived fields; live values are read from the DOM.
const ROWS = rows.map((r, i) => ({
  id: r.id || String(i + 1),
  title: r.title || '',
  where: r.where || '',
  diffStats: r.diffStats || null,
}));

const reportTitle = manifest.title || S.reportTitle;

const html = `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(reportTitle)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0 auto;padding:24px;max-width:1500px;background:#fafaf9;color:#1c1917}
@media(prefers-color-scheme:dark){body{background:#0c0a09;color:#e7e5e4}}
h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:0}
.sub{opacity:.7;font-size:13px;margin:0 0 16px}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.toolbar button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #d6d3d1;background:#fff;color:inherit;border-radius:8px;padding:6px 12px}
.toolbar button:hover{border-color:#0d9488}
.toolbar button[data-on="1"]{background:#0d9488;border-color:#0d9488;color:#fff}
@media(prefers-color-scheme:dark){.toolbar button{background:#1c1917;border-color:#292524}}
.row{border:1px solid #d6d3d1;border-radius:12px;padding:16px;margin:16px 0;background:#fff;transition:opacity .15s}
@media(prefers-color-scheme:dark){.row{background:#1c1917;border-color:#292524}}
.row.done{opacity:.5}
.row.active{outline:3px solid #0d9488;outline-offset:3px}
.row[hidden]{display:none}
.hd{display:flex;gap:12px;align-items:flex-start}
.num{flex:0 0 28px;height:28px;border-radius:50%;background:#0d9488;color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px}
.meta{flex:1} .where{margin:.25rem 0 0;font-size:13px;opacity:.7;font-family:ui-monospace,monospace}
.checks{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.chk{font-size:13px;white-space:nowrap;cursor:pointer;user-select:none;display:flex;gap:6px;align-items:center}
.chk input{width:18px;height:18px}
.decision{font:inherit;font-size:13px;padding:3px 6px;border:1px solid #d6d3d1;border-radius:7px;background:transparent;color:inherit;cursor:pointer}
@media(prefers-color-scheme:dark){.decision{border-color:#292524}}
.verdict-row{margin:10px 0 0}
.verdict{font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px;display:inline-block}
.verdict.pass{background:#dcfce7;color:#166534}
.verdict.changed{background:#ffe4e6;color:#9f1239}
.verdict.none{background:#f5f5f4;color:#78716c}
@media(prefers-color-scheme:dark){.verdict.none{background:#292524;color:#a8a29e}}
.slider{position:relative;margin:12px 0;border:1px solid #d6d3d1;border-radius:8px;overflow:hidden;background:#000}
@media(prefers-color-scheme:dark){.slider{border-color:#292524}}
.slider img{display:block;width:100%}
.slider .top{position:absolute;inset:0;clip-path:inset(0 calc(100% - var(--pos)) 0 0)}
.slider input{position:absolute;left:12px;right:12px;bottom:10px;width:calc(100% - 24px);cursor:ew-resize}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.shots.tri{grid-template-columns:1fr 1fr 1fr}
@media(max-width:640px){.shots,.shots.tri{grid-template-columns:1fr}}
figure{margin:0} figcaption{font-size:12px;font-weight:600;opacity:.7;margin-bottom:4px}
.shots img{width:100%;border:1px solid #d6d3d1;border-radius:8px;display:block;cursor:zoom-in}
@media(prefers-color-scheme:dark){.shots img{border-color:#292524}}
.missing{padding:28px 12px;text-align:center;border:1px dashed #a8a29e;border-radius:8px;font-size:13px;opacity:.6}
.note{display:block;font-size:13px;font-weight:600}
textarea{width:100%;margin-top:4px;font:inherit;font-weight:400;padding:8px;border:1px solid #d6d3d1;border-radius:8px;background:transparent;color:inherit;resize:vertical}
@media(prefers-color-scheme:dark){textarea{border-color:#292524}}
footer{margin-top:32px;border-top:2px solid #d6d3d1;padding-top:16px}
@media(prefers-color-scheme:dark){footer{border-color:#292524}}
footer ul{padding-left:18px}
.ctx{margin:8px 0 0;font-size:12.5px;opacity:.75;background:#f5f5f4;border-radius:6px;padding:6px 10px}
.ctx code{font-family:ui-monospace,monospace}
@media(prefers-color-scheme:dark){.ctx{background:#292524}}
.foot-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.copy{font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #0d9488;background:#0d9488;color:#fff;border-radius:8px;padding:6px 14px}
.copy:hover{background:#0f766e}
#combined{font-family:ui-monospace,monospace;font-size:13px;background:#f5f5f4}
@media(prefers-color-scheme:dark){#combined{background:#0c0a09}}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.93);display:none;z-index:50;align-items:center;justify-content:center;user-select:none}
.lb.open{display:flex}
.lb img{max-width:94vw;max-height:88vh;object-fit:contain;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.6)}
.lb-cap{position:fixed;top:14px;left:60px;right:60px;text-align:center;color:#e7e5e4;font-size:14px;font-weight:600;text-shadow:0 1px 4px #000}
.lb-btn{position:fixed;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.12);color:#fff;border:none;font-size:40px;line-height:1;width:60px;height:88px;border-radius:10px;cursor:pointer;display:grid;place-items:center}
.lb-btn:hover{background:rgba(255,255,255,.25)}
.lb-prev{left:18px}.lb-next{right:18px}
.lb-close{position:fixed;top:12px;right:16px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:22px;width:44px;height:44px;border-radius:8px;cursor:pointer}
.lb-count{position:fixed;bottom:16px;left:0;right:0;text-align:center;color:#a8a29e;font-size:13px}
</style></head><body>
<h1>${esc(reportTitle)}</h1>
<p class="sub">${S.intro}</p>
<div class="toolbar">
  <button type="button" id="showChanged" data-on="0">${esc(S.showChanged)}</button>
  <button type="button" id="approveVisible">${esc(S.approveVisible)}</button>
  <button type="button" id="exportJson">${esc(S.exportJson)}</button>
</div>
${rowsHtml}
<footer>
  <h2>${esc(S.combinedTitle)}</h2>
  <label class="note">${esc(S.generalNotes)}<textarea data-mynote data-persist="mynote-overall" data-title="${esc(S.generalNotes)}" rows="3" placeholder="${esc(S.generalNotesPlaceholder)}"></textarea></label>
  <div class="foot-hd" style="margin-top:16px"><strong>${esc(S.commentToCopy)}</strong><button id="copyBtn" type="button" class="copy">${esc(S.copy)}</button></div>
  <textarea id="combined" rows="8" readonly></textarea>
</footer>
<div class="lb" id="lb">
  <div class="lb-cap" id="lbCap"></div>
  <button class="lb-close" id="lbClose" aria-label="${esc(S.lbClose)}">✕</button>
  <button class="lb-btn lb-prev" id="lbPrev" aria-label="${esc(S.lbPrev)}">‹</button>
  <img id="lbImg" alt="">
  <button class="lb-btn lb-next" id="lbNext" aria-label="${esc(S.lbNext)}">›</button>
  <div class="lb-count" id="lbCount"></div>
</div>
<script>
// Namespace by manifest.id (fallback title) so distinct reports never collide
// in localStorage even when their titles match.
const NS=${JSON.stringify('crimson-gnome:' + (manifest.id || manifest.title || 'report'))};
const TITLE=${JSON.stringify(reportTitle)};
const RID=${JSON.stringify(manifest.id || manifest.title || 'report')};
const ROWS=${JSON.stringify(ROWS)};
// Script-side strings injected via JSON.stringify (NOT raw-interpolated) so any
// quote/apostrophe/newline/locale character is safe.
const S=${JSON.stringify({ combinedHeader: S.combinedHeader, noNotes: S.noNotes, copied: S.copied })};
// Find a persisted element by its data-persist value WITHOUT string-interpolating
// the (possibly odd) id into a CSS selector — avoids breaking on dots/quotes/etc.
function byPersist(name){
  return [...document.querySelectorAll('[data-persist]')].find((e)=>e.dataset.persist===name);
}
function rebuild(){
  const lines=[S.combinedHeader+TITLE,''];
  document.querySelectorAll('textarea[data-mynote]').forEach((el)=>{
    const v=el.value.trim(); if(!v) return;
    const key=el.dataset.persist.replace('mynote-','');
    const chk=byPersist('chk-'+key);
    const mark=chk?(chk.checked?'[x] ':'[ ] '):'';
    lines.push('• '+mark+(el.dataset.title||'')+': '+v);
  });
  const outEl=document.getElementById('combined');
  if(outEl) outEl.value=(lines.length>2)?lines.join('\\n'):S.noNotes;
}
for(const el of document.querySelectorAll('[data-persist]')){
  const k=NS+':'+el.dataset.persist, v=localStorage.getItem(k);
  if(el.type==='checkbox'){
    if(v==='1'){el.checked=true; el.closest('.row')?.classList.add('done');}
    el.addEventListener('change',()=>{localStorage.setItem(k,el.checked?'1':'0'); el.closest('.row')?.classList.toggle('done',el.checked); rebuild();});
  } else {
    if(v!=null) el.value=v;
    // <select> fires 'change'; textareas fire 'input'. Persist on BOTH so the
    // decision dropdown survives reload and the combined note stays live.
    const save=()=>{localStorage.setItem(k,el.value); if(el.hasAttribute('data-mynote')) rebuild();};
    el.addEventListener('input',save);
    el.addEventListener('change',save);
  }
}
const btn=document.getElementById('copyBtn');
if(btn) btn.addEventListener('click',async()=>{
  const t=document.getElementById('combined');
  try{ await navigator.clipboard.writeText(t.value); }
  catch(e){ t.removeAttribute('readonly'); t.select(); document.execCommand('copy'); t.setAttribute('readonly',''); }
  const o=btn.textContent; btn.textContent=S.copied; setTimeout(()=>{btn.textContent=o;},1500);
});
rebuild();
// Export JSON — a machine-readable acceptance artifact, reading LIVE DOM state
// (decision/checked/note) merged onto the static row model.
function rowState(row){
  const note=byPersist('mynote-'+row.id)?.value || '';
  const checked=!!byPersist('chk-'+row.id)?.checked;
  const decision=byPersist('decision-'+row.id)?.value || '';
  return { id:row.id, title:row.title, where:row.where, decision, checked, note, diffStats:row.diffStats };
}
function decisionsJson(){
  return { title:TITLE, id:RID, exportedAt:new Date().toISOString(), rows:ROWS.map(rowState) };
}
document.getElementById('exportJson')?.addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify(decisionsJson(),null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(RID.replace(/[^a-z0-9_-]+/gi,'-').toLowerCase() || 'ui-verification')+'-decisions.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
// Approve visible — set decision=approved + checked on every non-hidden row,
// dispatching the events so persistence + .done styling fire normally.
document.getElementById('approveVisible')?.addEventListener('click',()=>{
  for(const row of document.querySelectorAll('.row:not([hidden])')){
    const sel=row.querySelector('[data-decision]');
    if(sel){ sel.value='approved'; sel.dispatchEvent(new Event('change',{bubbles:true})); }
    const chk=row.querySelector('input[type=checkbox]');
    if(chk && !chk.checked){ chk.checked=true; chk.dispatchEvent(new Event('change',{bubbles:true})); }
  }
});
// Show changed only — hide rows whose verdict is an auto-pass (.is-pass).
document.getElementById('showChanged')?.addEventListener('click',(e)=>{
  const on=e.currentTarget.dataset.on!=='1';
  e.currentTarget.dataset.on=on?'1':'0';
  for(const row of document.querySelectorAll('.row')){
    row.hidden = on && row.classList.contains('is-pass');
  }
});
// Before/after slider: range input → CSS var that drives the top image clip-path.
for(const s of document.querySelectorAll('.slider')){
  const input=s.querySelector('input');
  if(input) input.addEventListener('input',()=>s.style.setProperty('--pos',input.value+'%'));
}
// Lightbox: click any shot → fullscreen; ‹/› buttons + arrow keys flip through
// ALL shots in order (before1, after1, diff1, before2, …).
const imgs=[...document.querySelectorAll('.shots img')];
const lb=document.getElementById('lb'), lbImg=document.getElementById('lbImg'),
      lbCap=document.getElementById('lbCap'), lbCount=document.getElementById('lbCount');
let li=0;
function lbShow(i){ if(!imgs.length) return; li=(i+imgs.length)%imgs.length; const im=imgs[li];
  lbImg.src=im.src; lbCap.textContent=im.dataset.cap||''; lbCount.textContent=(li+1)+' / '+imgs.length;
  lb.classList.add('open'); }
function lbClose(){ lb.classList.remove('open'); lbImg.src=''; }
imgs.forEach((im,i)=>im.addEventListener('click',()=>lbShow(i)));
document.getElementById('lbPrev').addEventListener('click',(e)=>{e.stopPropagation();lbShow(li-1);});
document.getElementById('lbNext').addEventListener('click',(e)=>{e.stopPropagation();lbShow(li+1);});
document.getElementById('lbClose').addEventListener('click',lbClose);
lb.addEventListener('click',(e)=>{ if(e.target===lb) lbClose(); });
document.addEventListener('keydown',(e)=>{ if(!lb.classList.contains('open')) return;
  if(e.key==='ArrowLeft') lbShow(li-1); else if(e.key==='ArrowRight') lbShow(li+1); else if(e.key==='Escape') lbClose(); });
// Keyboard review shortcuts — only when NOT typing in a field and the lightbox
// is closed, so they never steal keystrokes from textarea/select/input.
let activeRow=0;
const visibleRows=()=>[...document.querySelectorAll('.row')].filter((r)=>!r.hidden);
function focusReviewRow(i){
  const rs=visibleRows(); if(!rs.length) return;
  activeRow=Math.max(0,Math.min(i,rs.length-1));
  rs.forEach((r)=>r.classList.remove('active'));
  rs[activeRow].classList.add('active');
  rs[activeRow].scrollIntoView({block:'center',behavior:'smooth'});
}
document.addEventListener('keydown',(e)=>{
  if(lb.classList.contains('open')) return;
  if(e.target.matches('textarea,input,select')) return;
  const rs=visibleRows();
  const row=rs[activeRow];
  if(e.key==='j'){ e.preventDefault(); focusReviewRow(activeRow+1); }
  else if(e.key==='k'){ e.preventDefault(); focusReviewRow(activeRow-1); }
  else if(e.key==='c' && row){
    e.preventDefault();
    const chk=row.querySelector('input[type=checkbox]');
    if(chk){ chk.checked=!chk.checked; chk.dispatchEvent(new Event('change',{bubbles:true})); }
  }
  else if(e.key==='a' && row){
    e.preventDefault();
    const sel=row.querySelector('[data-decision]');
    if(sel){ sel.value='approved'; sel.dispatchEvent(new Event('change',{bubbles:true})); }
  }
  else if(e.key==='r' && row){
    e.preventDefault();
    const sel=row.querySelector('[data-decision]');
    if(sel){ sel.value='rejected'; sel.dispatchEvent(new Event('change',{bubbles:true})); }
    row.querySelector('textarea[data-mynote]')?.focus();
  }
  else if(e.key==='Enter' && row){ row.querySelector('.shots img')?.click(); }
});
focusReviewRow(0);
</script></body></html>`;

writeFileSync(out, html);
console.log(`Wrote ${out} (${rows.length} rows, ${rows.filter((r) => dataUri(r.before) || dataUri(r.after)).length} with ≥1 screenshot)`);
