#!/bin/bash
# aside-telegram-bridge one-line installer
#   curl -fsSL https://raw.githubusercontent.com/SaiAmartya/aside-telegram-bridge/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/SaiAmartya/aside-telegram-bridge"
DEST="${ASIDE_BRIDGE_DIR:-$HOME/aside-telegram-bridge}"

if [ "$(uname)" != "Darwin" ]; then
  echo "✗ macOS only for now (the bridge uses launchd)." >&2
  exit 1
fi
command -v git >/dev/null || { echo "✗ git is required (xcode-select --install)"; exit 1; }
command -v python3 >/dev/null || { echo "✗ python3 is required"; exit 1; }

if [ -d "$DEST/.git" ]; then
  echo "→ Existing install found at $DEST, updating..."
  git -C "$DEST" pull --ff-only || echo "! couldn't fast-forward (local edits?), continuing with current copy"
else
  echo "→ Cloning into $DEST..."
  git clone --depth 1 "$REPO" "$DEST"
fi

cd "$DEST"
exec python3 setup.py < /dev/tty
