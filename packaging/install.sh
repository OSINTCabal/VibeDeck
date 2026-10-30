#!/usr/bin/env bash
# VibeDeck user-level install (no root). Builds the frontend, creates the sidecar
# venv, and installs the launcher, desktop entry, and icon.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"   # repo root
APP="${VIBEDECK_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/vibedeck}"
BIN="$HOME/.local/bin"
DATA="${VIBEDECK_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/vibedeck}"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/vibedeck"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
[ "$SRC" != "$APP" ] || { echo "Install from a source checkout, not the installed app." >&2; exit 1; }

for tool in python3 node npm pnpm vibe curl; do
  command -v "$tool" >/dev/null || { echo "Missing $tool; see README.md Linux prerequisites." >&2; exit 1; }
done
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) throw Error("Node 22.12+ required")'
[ "$(cd "$SRC/frontend" && pnpm --version | cut -d. -f1)" = 9 ] || { echo "Use pnpm 9 for the committed lockfile." >&2; exit 1; }
echo "==> Building current frontend source"
( cd "$SRC/frontend" && pnpm install --frozen-lockfile && pnpm build )
echo "==> Preparing dependencies"
python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install --quiet "$SRC"
( cd "$SRC/shell/electron" && npm ci --no-audit --no-fund && node node_modules/electron/install.js && test -x node_modules/electron/dist/electron )

# Replace application files only after all builds and dependency installs pass.
echo "==> Installing app to $APP"
mkdir -p "$APP" "$BIN" "$APPS" "$ICONS" "$CFG" "$DATA/logs"
STAGE="$(mktemp -d "$APP/.install-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -r "$SRC/sidecar" "$STAGE/sidecar"
cp -r "$SRC/frontend/dist" "$STAGE/dist"
mkdir -p "$STAGE/shell"
cp -rL "$SRC/shell/electron" "$STAGE/shell/electron"
for part in sidecar dist shell; do
  rm -rf "$APP/$part"
  mv "$STAGE/$part" "$APP/$part"
done

echo "==> Installing launcher and desktop entry"
install -m 0755 "$SRC/packaging/bin/vibedeck" "$BIN/vibedeck"
sed "s|^Exec=.*|Exec=$BIN/vibedeck %U|" "$SRC/packaging/vibedeck.desktop" > "$APPS/vibedeck.desktop"
chmod 0644 "$APPS/vibedeck.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

echo "==> Installing icon"
for size in 16x16 32x32 48x48 128x128 256x256; do
  mkdir -p "$ICONS/$size/apps"
done
# Render each size from the SVG when rsvg-convert is available; else reuse the PNG.
if [ -f "$SRC/packaging/vibedeck-icon.png" ]; then
  for size in 16x16 32x32 48x48 128x128 256x256; do
    if command -v rsvg-convert >/dev/null 2>&1 && [ -f "$SRC/packaging/vibedeck-icon.svg" ]; then
      rsvg-convert -w "${size%x*}" -h "${size%x*}" "$SRC/packaging/vibedeck-icon.svg" -o "$ICONS/$size/apps/vibedeck.png"
    else
      cp "$SRC/packaging/vibedeck-icon.png" "$ICONS/$size/apps/vibedeck.png"
    fi
  done
fi
if [ -f "$SRC/packaging/vibedeck-icon.svg" ]; then
  mkdir -p "$ICONS/scalable/apps"
  cp "$SRC/packaging/vibedeck-icon.svg" "$ICONS/scalable/apps/vibedeck.svg"
fi
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICONS" >/dev/null 2>&1 || true

if [ ! -f "$CFG/env" ]; then
  cat > "$CFG/env" <<'EOF'
# VibeDeck environment — sourced by the launcher. 600 perms.
# The sidecar also resolves the key from the system keyring (ai.mistral.vibe).
# export MISTRAL_API_KEY=""
EOF
  chmod 600 "$CFG/env"
fi

cat <<'EOF'

Done. Next steps:

  1. API key (Chat + Studio): the sidecar reads it from the system keyring
     (same store the vibe CLI uses). To override, edit ${XDG_CONFIG_HOME:-~/.config}/vibedeck/env
  2. Launch "VibeDeck" from your app drawer, or run:  vibedeck

EOF
