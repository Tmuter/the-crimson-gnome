# Contributing to The Crimson Gnome

Thanks for helping! The Crimson Gnome is deliberately small. A few constraints keep it that way.

## The one rule: stay (almost) dependency-free

The **only** module allowed to import a third-party package is `diff-images.mjs`
(`pixelmatch` + `pngjs` — the pixel-diff island). Everything else — capture
(`cdp-*.mjs`, `suggest-element.mjs`), orchestration (`verify-ui.mjs`), and the
report (`build-report.mjs`) — uses **Node built-ins only** (the global `WebSocket`
+ `fetch`, `node:fs`, `node:path`, `node:child_process`). Please don't add runtime
dependencies; if you think you need one, open an issue first.

## Requirements

- **Node ≥ 22.4.0** (unflagged global `WebSocket`).
- A desktop **Chrome/Chromium** only if you're touching the capture path and want
  to exercise it end-to-end (`bash cdp-launch.sh` → log in once → `node verify-ui.mjs …`).

## Running tests

```bash
npm install
npm test            # node --test "test/*.test.mjs"
```

The suite covers the two pure steps (`diff-images.mjs`, `build-report.mjs`) — no
browser required. If you change the report's HTML/strings or the diff output
shape, update or add a test alongside.

## Style

- Match the surrounding code: comments explain **why**, not what.
- Keep the report a single self-contained `.html` (images base64-inlined, state in
  `localStorage`) — don't introduce a build step or external assets.
- User-facing copy is English by default; never hardcode another locale — add it
  via the `manifest.strings` override mechanism.

## Security

- The capture browser's debug port stays **loopback-only** with a scoped
  allowed-origin. Don't widen it.
- Don't add anything that auto-shares or uploads the generated report — it can
  contain screenshots of private data.
