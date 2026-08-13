#!/bin/bash

# --- tailnet hostname ------------------------------------------------------
#
# Every install has a different one, so it is resolved here rather than
# written into the repo. Asking Tailscale is more reliable than asking the
# user to remember it, and it is the same value the server publishes on.
#
# The socket path is the bridge's own tailscaled, not the system one, so a
# machine running both keeps them separate.
if [ -z "${ASIDE_TAILNET_HOST:-}" ]; then
  TS_SOCK="$HOME/.aside-telegram-bridge/tailscale/ts.sock"
  TS_BIN="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
  if [ -S "$TS_SOCK" ]; then
    ASIDE_TAILNET_HOST="$("$TS_BIN" --socket "$TS_SOCK" status --json 2>/dev/null \
      | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  fi
  if [ -z "${ASIDE_TAILNET_HOST:-}" ]; then
    ASIDE_TAILNET_HOST="$("$TS_BIN" status --json 2>/dev/null \
      | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  fi
fi
if [ -z "${ASIDE_TAILNET_HOST:-}" ]; then
  echo "error: could not work out this Mac's tailnet hostname." >&2
  echo "Start Tailscale, or set it by hand:" >&2
  echo "  export ASIDE_TAILNET_HOST=your-mac.tailXXXX.ts.net" >&2
  exit 1
fi
export ASIDE_TAILNET_HOST
echo "==> tailnet host: $ASIDE_TAILNET_HOST"
#
# Rebuild the Aside Android app.
#
# Run this after any change to the web app that you want baked into a fresh
# APK. Note that for most changes you do NOT need to rebuild at all: the
# shell loads the UI from the Mac at runtime, so a `npm run build` in
# miniapp/web plus a reload on the phone is enough. Rebuild the APK only
# when something in the native shell changes: the icon, the app name, the
# server URL in capacitor.config.ts, or a Capacitor plugin.
#
# The toolchain lives outside Homebrew on purpose. `brew install openjdk@21`
# produced a broken install on this machine (empty libexec, every symlink
# dangling), so the JDK is an unpacked Temurin tarball instead.
#
set -euo pipefail

export JAVA_HOME="/Users/parth/java/jdk-21.0.12+8/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:/opt/homebrew/bin:/usr/local/bin:$PATH"

WEB="$HOME/.aside-telegram-bridge/miniapp/web"
OUT="$WEB/android/app/build/outputs/apk/debug/app-debug.apk"

cd "$WEB"

echo "==> building web assets"
npm run build

echo "==> syncing into the native project"
npx cap sync android

echo "==> baking the pairing key into the shell"
#
# Why this exists.
#
# The Android WebView is its own browser context: separate cookie jar,
# separate localStorage, no relationship to Chrome on the same phone. A
# freshly installed APK is therefore an unpaired device, and it has no way
# to receive a pairing key -- /pair is loopback-only, so the phone cannot
# open it, and the shell always launches at the same URL.
#
# So the URL it launches at carries the key. `standalone.ts` prefers a key
# in the hash over a stored token, spends it, and scrubs it from the
# address bar. Because Capacitor reloads this URL on every cold start, the
# app can never get stuck unpaired: if the token is ever lost, the next
# launch simply mints a new one.
#
# The key is derived from the JWT secret, so this adds no new secret. It
# does mean the APK contains a credential, which is acceptable precisely
# because the server is tailnet-only: holding this file is useless without
# also being on Parth's tailnet. Do not post the APK anywhere public.
#
PAIR_KEY=$(python3 -c "
import json, hashlib
s = json.load(open('$HOME/.aside-telegram-bridge/miniapp-secret.json'))['secret']
print(hashlib.sha256((s + ':standalone-pairing:v1').encode()).hexdigest()[:32])
")
ASSET_CFG="$WEB/android/app/src/main/assets/capacitor.config.json"
python3 - "$ASSET_CFG" "$PAIR_KEY" <<'PYEOF'
import json, sys
path, key = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
url = cfg['server']['url'].split('#')[0]
cfg['server']['url'] = f"{url}#pair={key}"
json.dump(cfg, open(path, 'w'), indent=2)
print("  shell will self-pair on launch")
PYEOF

echo "==> assembling APK"
cd android
#
# Memory flags, not preferences.
#
# This is an 8 GB M1 Air that is usually already running Chrome, the Aside
# daemon and a Node server, so a default Gradle invocation gets OOM-killed
# by the kernel partway through (`zsh: killed`, no stack trace, nothing in
# the log). Three things keep it inside the budget:
#
#   --no-daemon        a lingering daemon cannot be killed from the agent
#                      sandbox, and a stale one holds the SDK lock
#   --max-workers=1    parallel workers each get their own JVM
#   -Xmx1280m          under the 1536m in gradle.properties, and low enough
#                      that the JVM plus metaspace still fits
#
# With these the whole assemble runs in ~13s and has not been killed since.
./gradlew assembleDebug --no-daemon --max-workers=1 \
  -Dorg.gradle.jvmargs="-Xmx1280m -XX:MaxMetaspaceSize=384m" -q

echo "==> done"
ls -lh "$OUT"
cp "$OUT" "$HOME/Downloads/Aside-mobile.apk"
echo "copied to ~/Downloads/Aside-mobile.apk"

echo
echo "Install on the phone with either:"
echo "  adb install -r ~/Downloads/Aside-mobile.apk"
echo "  (or AirDrop/copy the file and tap it on the phone)"

# PUBLISH_BLOCK_V1
# Publish the new build so the phone can install it over the tailnet
# instead of needing a cable. `npm run build` empties dist, so this has to
# run after the assemble step rather than before it.
mkdir -p "$HOME/.aside-telegram-bridge/apk"
cp "$OUT" "$WEB/dist/Aside-mobile.apk"
cp "$OUT" "$HOME/.aside-telegram-bridge/apk/Aside-mobile.apk"
echo "published: https://$ASIDE_TAILNET_HOST/Aside-mobile.apk"
