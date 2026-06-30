---
name: the-crimson-gnome
description: After a batch of 2+ distinct user-facing UI changes, produce a before/after verification report the user ticks off while reviewing locally. Invoke on request ('before/after report', 'verification table', 'crimson-gnome this') or proactively whenever a finished change set touches ≥2 distinct UI surfaces/behaviors. Captures before+after screenshots in parallel, pixel-diffs each row, auto-passes unchanged rows, and renders a self-contained report with a before/after slider, per-row decision + notes, and JSON export.
---

# The Crimson Gnome — before/after UI review report

When a change set has **2 or more distinct user-facing UI changes**, produce a single report the user walks while reviewing locally — each change side-by-side (before/after + diff), tick what they verified, record a decision, jot notes. Below 2 changes, skip the report (just describe the one change).

> "≥2" is the default threshold; if the user names a different X ("only when >3"), use that.

## Fast path: one command

The whole pipeline — parallel capture → pixel-diff → report — is a single orchestrator:

```
node <path>/the-crimson-gnome/verify-ui.mjs .crimson-gnome/<task>.json
```

It (1) runs `cdp-batch.mjs` to capture **every** row's `beforeUrl`→`before` and `afterUrl`→`after` in parallel over one browser WebSocket, (2) runs `diff-images.mjs` per row to fill `diff` + `diffStats` (and `suggestedSelector` for changed rows), (3) writes the mutated manifest back, (4) runs `build-report.mjs` → `<task>.html`, and prints a `changed vs auto-pass` summary. So the per-batch work is just: **write the manifest → run one command → hand over the `.html`.**

**Where files live:** keep manifests, screenshots and the generated `.html` under **`.crimson-gnome/` at the repo root** — git-ignore it (local-only, never committed; the report inlines screenshots that may contain private data). It survives reboots (unlike `/tmp`) and is easy to find.

## Manifest

One row per **user-perceived** change (not per file). `verify-ui.mjs` fills the diff fields; you author the rest.

```json
{
  "title": "Settings — review",
  "id": "settings-2026-02-14",
  "capture": { "w": 1440, "h": 900, "scale": 2, "theme": "light", "wait": 500 },
  "rows": [
    { "id": "a1", "title": "Save button restyled",
      "where": "/settings → Profile",
      "beforeUrl": "http://localhost:3001/settings",
      "afterUrl":  "http://localhost:3000/settings",
      "before": ".crimson-gnome/a1-before.png",
      "after":  ".crimson-gnome/a1-after.png",
      "sel": "[data-crimson-gnome='save-button']",
      "note": "needs a logged-in session" }
  ]
}
```

- `id` — **unique** per report; namespaces the report's `localStorage` (two reports with the same title no longer share checkbox/notes state). Falls back to `title`.
- `lang` / `strings` — optional `<html lang>` + a map overriding any UI string (the report is English by default; supply `strings` to localize).
- `capture` — global defaults (`w/h/scale/theme/wait`); any row may override via `row.capture`.
- `beforeUrl` / `afterUrl` — pages `cdp-batch.mjs` navigates and captures.
- `before` / `after` — output PNG paths (under `.crimson-gnome/`), inlined as base64 so the `.html` is portable.
- `diff` / `diffStats` / `suggestedSelector` — **filled by `verify-ui.mjs`**; don't hand-author.
- `sel` / `clicktext` / `outline` / `outlinetext` / `hide` — capture options (same semantics as the one-off `cdp-shot.mjs`).
- `seed` / `themeKeys` / `hideDevOverlays` — capture config: `seed` is a `{key:value}` map written to `localStorage` before navigation (e.g. dismiss a cookie banner the app gates content behind); `themeKeys` overrides which `localStorage` keys receive `theme`; `hideDevOverlays` (default true) hides framework dev overlays.
- `note` — read-only ℹ️ context line YOU show the user (a caveat: needs a logged-in session, a locale you couldn't verify). It is NOT the user's input field — their input goes in the separate "My notes" textarea.

**Prefer stable element clips over full-page for diffable rows.** Add `data-crimson-gnome="..."` to the changed surface in app code and set `sel: "[data-crimson-gnome='…']"`. Full-page shots make **noisy diffs** (layout shifts, lazy content, sticky headers, dynamic timestamps all flip pixels) — keep full-page as context only, clip the actual component for the diff.

**One report = one change group; create a fresh manifest + `.html` per new group** (don't append later groups to an old file).

## The report

`build-report.mjs` renders a **self-contained** static HTML (CSS dark-aware, base64-inlined images, all state in `localStorage` namespaced by `manifest.id`). Per row:

- **verdict badge** from `diffStats` — `auto-pass: X%` (green, `pct ≤ CRIMSON_GNOME_PASS_PCT`) or `changed: X%` (red).
- **before/after slider** (clip-path + range input) when both shots exist, plus a 3-column **Before / After / Diff** strip when `row.diff` is set.
- **decision `<select>`** (`''`/`approved`/`rejected`/`needs-work`/`auto-pass`) + **"Checked"** checkbox + editable **"My notes"**; `row.note` renders read-only ℹ️ and `row.suggestedSelector` as a small `🎯 likely changed: <code>…`.
- **lightbox** (click a shot → fullscreen; ‹/› + arrow keys flip through all shots).

Toolbar / footer: **Show changed only** (hides auto-pass rows), **Approve visible**, **Export JSON** (downloads `{title,id,exportedAt,rows:[{id,title,where,decision,checked,note,diffStats}]}`), and an auto-combined copyable comment with **📋 Copy**.

**Keyboard shortcuts** (when NOT typing in an input and the lightbox is closed): `j`/`k` next/prev row, `c` toggle checked, `a` approve, `r` reject + focus notes, `Enter` open the row's first shot.

## Steps

1. **Enumerate the changes** as the USER sees them — one row each. "Replaced the grid with a select" and "the default is now on" are two rows even if one file. Use the user's own wording / the app's section headings.

2. **Find the live surface** for each: the exact local URL + section/element. Note the viewport that matters (capture **375px** via `capture.w`/`row.capture` if the layout differs on mobile). Add `data-crimson-gnome` to the changed surface and use it as `sel`.

3. **Stand up before + after.** The before *code* is in git history, but a before *screenshot* needs that code running, so capture it in the SAME pass as after, before you merge/switch:
   - **After:** the dev server with your change.
   - **Before:** a second checkout/worktree still on the pre-change commit (`git worktree add --detach <dir> <parent-sha>`, symlink `node_modules`/env, run the dev server on a free port). Point `beforeUrl` at it.
   - Both servers must be reachable from the dedicated capture browser (same logged-in profile reaches any localhost port).

4. **Write the manifest** (`.crimson-gnome/<task>.json`): unique `id`, `capture` defaults, one row per change with `beforeUrl`/`afterUrl`/`before`/`after` and a `sel` clip; pre-fill `note` with any caveat you know.

5. **Run `verify-ui.mjs`** → it captures, diffs, mutates the manifest, builds `<task>.html`, prints the summary. Give the user the `.html` path. State persists in `localStorage`. To serve it over plain HTTP (some browsers won't open `file://` for `navigate`): `python3 -m http.server <port> --bind 127.0.0.1 --directory .crimson-gnome` then open `http://127.0.0.1:<port>/<task>.html`.

## Capture engine (CDP)

Capture uses a **dedicated debugging browser** — background-safe (works while you use your own browser), no OS foreground or clicks needed, clean output.

- **`bash cdp-launch.sh`** — launches the dedicated Chrome/Chromium (`--remote-debugging-port=9333`, persistent profile `~/.crimson-gnome-cap-profile`, **loopback-only** — see Security). Resolves the binary via `CHROME_BIN` → macOS app paths → Linux `command -v` (google-chrome/chromium). **One-time:** log into the test account in its window. The session persists in the profile across runs. A shot showing the login screen = profile not logged in (re-run + log in).
- **`cdp-batch.mjs <manifest.json>`** (default capture step, run by `verify-ui.mjs`) — opens ONE browser WebSocket and multiplexes **flattened CDP sessions** over a `CDP_CONCURRENCY` (default 4) worker pool. Per page it sets device metrics, emulates `prefers-color-scheme` + seeds `theme`/`seed` into `localStorage` **before** the first navigation (no reload), runs a deterministic-render prelude (freeze animations/transitions/caret, hide dev overlays, optional row `hide` CSS), navigates, awaits load + `document.fonts.ready` + 2×rAF + `wait`, applies `clicktext`/`sel`/`outline`, captures, writes the PNG. Env: `CDP_PORT`, `CDP_CONCURRENCY`.
- **`diff-images.mjs <before.png> <after.png> <diff.png>`** (diff step) — pads to `max(w,h)`, runs `pixelmatch` (`includeAA:false`, diff color `[255,0,80]`), writes `diff.png`, prints `{changedPixels,totalPixels,pct,pass,bbox,…}`. `pass = pct ≤ CRIMSON_GNOME_PASS_PCT` (default `0.02`). Env: `PIXELMATCH_THRESHOLD` (default `0.1`), `CRIMSON_GNOME_PASS_PCT`.

### One-offs

For a single ad-hoc shot (not a full before/after batch):

```
node <path>/the-crimson-gnome/cdp-shot.mjs <url> <out.png> [--full|--viewport --w= --h= --scale= --wait= --theme= --seed=k=v --clicktext= --sel= --outline= --outlinetext=]
```

It captures the page itself (no browser chrome → no cropping), full-page by default. For before/after verification use the batch path (`verify-ui.mjs`) — it's faster and produces the diff.

## Security

The dedicated browser is logged into the test account, so the CDP port is bound to **loopback only** (`--remote-debugging-address=127.0.0.1`, no wildcard `--remote-allow-origins=*`). Don't widen it — any page that can reach `127.0.0.1:9333` could otherwise drive that browser, screenshot it, or exfiltrate its session cookies. The generated `.html` inlines screenshots of a logged-in session — treat it as sensitive (never attach it to a public issue).

## Rules

- **Don't fabricate screenshots.** If you couldn't capture one (no session, no pre-change server, surface needs data you don't have), leave `before`/`after` null — the report renders a "— no screenshot" placeholder. A missing shot is fine; a fake one is not.
- **One row = one user-perceived change.** Don't split by file or merge unrelated changes.
- **Mobile-first?** If a change affects layout, capture the 375px shot too — that's where mobile bugs hide.
- **Auto-pass is a hint, not a verdict.** A green `auto-pass` (no visual change) usually means "skip", but the user still decides — `Show changed only` hides them to focus review on real changes.
- The report IS the deliverable — give the `.html` path; don't re-paste it as markdown.
