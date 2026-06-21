#!/usr/bin/env bash
# bundle/fetch-sc3-plugins.sh
#
# Vendors sc3-plugins 3.14.0 (matches SuperCollider 3.14.1). macOS only for now.
# SuperDirt's default synths (supersaw, supersquare, superpwm, superpiano, …)
# need these UGens; without them try-load-extra-synths.scd silently skips them
# and `sound "supersaw"` reports "not found".
#
# Two halves must land in two places:
#   - server plugins (*.scx) -> vendor/sc3-plugins/plugins, added to scsynth's
#     ugenPluginsPath by startup.scd (via SELENE_SC3_PLUGINS_PATH from the Rust
#     shell). We do NOT copy them into SuperCollider.app — macOS blocks writing
#     into the signed bundle ("Operation not permitted").
#   - sclang classes (*.sc)  -> vendor/sc3-plugins/classes, added to
#     sclang_conf.yaml includePaths by fetch-superdirt.sh, so the synthdef
#     files compile (try-load-extra-synths.scd checks \MembraneHexagon.asClass)
#
# sc3-plugins is GPL-3, so unlike Dirt-Samples it CAN be bundled.
# Build-time deps (not shipped): curl, unzip. Run from repo root. Safe to re-run.

set -euo pipefail

SC3P_VERSION="3.14.0"
SC3P_ZIP_SHA256="bb53fa73317a0c0e5ea865556f817bf6aa7a3b1961cf5e5d92f75967385be785"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$REPO_ROOT/vendor"
PLUGINS="$VENDOR/sc3-plugins/plugins"
CLASSES="$VENDOR/sc3-plugins/classes"
CACHE="$VENDOR/.download-cache"
MARKER="$VENDOR/sc3-plugins/.installed-$SC3P_VERSION"

OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  echo "fetch-sc3-plugins.sh: macOS only for now (got $OS). Other platforms TODO." >&2
  exit 1
fi

if [[ -f "$MARKER" ]]; then
  echo "==> sc3-plugins $SC3P_VERSION already installed — skipping"
  exit 0
fi


ZIP="sc3-plugins-${SC3P_VERSION}-macOS.zip"
URL="https://github.com/supercollider/sc3-plugins/releases/download/Version-${SC3P_VERSION}/${ZIP}"
mkdir -p "$CACHE"
ZIP_PATH="$CACHE/$ZIP"

if [[ ! -f "$ZIP_PATH" ]]; then
  echo "==> Downloading sc3-plugins ${SC3P_VERSION}..."
  curl -fL "$URL" -o "$ZIP_PATH"
else
  echo "==> Using cached $ZIP"
fi

echo "==> Verifying checksum..."
ACTUAL_SHA="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$SC3P_ZIP_SHA256" ]]; then
  echo "Error: checksum mismatch!" >&2
  echo "  expected: $SC3P_ZIP_SHA256" >&2
  echo "  actual:   $ACTUAL_SHA" >&2
  exit 1
fi

echo "==> Extracting..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP_PATH" -d "$TMP"
SRC="$TMP/sc3-plugins-${SC3P_VERSION}-macOS/SC3plugins"
if [[ ! -d "$SRC" ]]; then
  echo "Error: SC3plugins/ not found in archive" >&2
  exit 1
fi

# Drop macOS AppleDouble junk — scsynth/sclang try to dlopen/compile ._*.scx and
# ._*.sc and spew errors otherwise.
find "$TMP" -name '._*' -delete
find "$TMP" -name '.DS_Store' -delete

echo "==> Installing server plugins (*.scx) into vendor/sc3-plugins/plugins..."
rm -rf "$PLUGINS"
mkdir -p "$PLUGINS"
find "$SRC" -name '*.scx' -exec cp {} "$PLUGINS/" \;

echo "==> Installing sclang classes into vendor/sc3-plugins/classes..."
rm -rf "$CLASSES"
mkdir -p "$CLASSES"
# Copy the whole (cleaned) tree; sclang compiles the .sc files and ignores the
# rest. .scx alongside them are harmless to the class compiler.
cp -R "$SRC/." "$CLASSES/"

mkdir -p "$(dirname "$MARKER")"
touch "$MARKER"
echo "==> Done. sc3-plugins $SC3P_VERSION installed."
