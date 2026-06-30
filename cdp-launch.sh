#!/bin/bash
# Launch a DEDICATED Chrome/Chromium instance with remote debugging + its own
# profile, so the-crimson-gnome can screenshot pages via CDP (Page.captureScreenshot)
# WITHOUT bringing any tab to the OS foreground — works in the background, even
# while you use your normal browser. The profile persists, so you log in ONCE.
#
#   bash cdp-launch.sh            # launch (idempotent-ish; opens a window)
#
# After launch: in the opened window, go to the app and LOG IN once (into the
# account that has the data you want to screenshot). The session is saved in the
# profile dir and reused by every later capture. Then run verify-ui.mjs.
#
# Env overrides:
#   CDP_PORT          debugging port (default 9333)
#   CRIMSON_GNOME_PROFILE   profile dir   (default ~/.crimson-gnome-cap-profile)
#   CHROME_BIN        explicit path to the Chrome/Chromium binary (skips detection)
#
# Needs a DESKTOP SESSION for the one-time interactive login — the full pipeline
# is not designed to run fully headless.
PORT="${CDP_PORT:-9333}"
PROFILE="${CRIMSON_GNOME_PROFILE:-$HOME/.crimson-gnome-cap-profile}"

# Resolve a Chrome/Chromium binary: explicit CHROME_BIN first, then per-OS
# well-known paths, then PATH lookups. Cross-platform (macOS + Linux; on Windows
# run under Git Bash / WSL and set CHROME_BIN).
find_chrome() {
  if [ -n "$CHROME_BIN" ]; then echo "$CHROME_BIN"; return; fi
  local candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  )
  local c
  for c in "${candidates[@]}"; do [ -x "$c" ] && { echo "$c"; return; }; done
  for c in google-chrome-stable google-chrome chromium chromium-browser chrome; do
    command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return; }
  done
}

CHROME="$(find_chrome)"
if [ -z "$CHROME" ] || { [ ! -x "$CHROME" ] && ! command -v "$CHROME" >/dev/null 2>&1; }; then
  echo "Chrome/Chromium not found." >&2
  echo "Set CHROME_BIN to the browser binary, e.g.:" >&2
  echo "  CHROME_BIN=/path/to/chrome bash cdp-launch.sh" >&2
  exit 1
fi

if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "CDP browser already running on $PORT (profile $PROFILE)"; exit 0
fi

# SECURITY: bind the debugging socket to loopback ONLY and scope the allowed
# origin to our own port — never `--remote-allow-origins=*`. A wildcard origin
# on a LOGGED-IN profile lets any page that reaches 127.0.0.1:$PORT drive this
# browser (screenshot pages, read cookies/session). The Node client connects
# from http://127.0.0.1:$PORT, so that single origin is all we need.
# The three --disable-*background* flags stop the browser from throttling/
# freezing our background (never-foregrounded) tabs, which otherwise stalls captures.
"$CHROME" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --remote-allow-origins="http://127.0.0.1:$PORT" \
  --no-first-run --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --new-window "about:blank" >/dev/null 2>&1 &
echo "launched dedicated CDP browser on port $PORT, profile $PROFILE (PID $!)"
echo "→ log in once in the opened window, then capture via verify-ui.mjs"
