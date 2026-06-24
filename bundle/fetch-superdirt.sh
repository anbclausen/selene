#!/usr/bin/env bash
# bundle/fetch-superdirt.sh
#
# Vendors SuperCollider 3.14.1 + SuperDirt 1.7.4 + Vowel + Clean-Samples into
# a self-contained vendor/ tree. macOS only for now.
# Run from repo root. Safe to re-run (skips steps already done).
#
# Build-time deps (not shipped): curl, git, hdiutil (macOS)
# Output:
#   vendor/supercollider/SuperCollider.app   (sclang + scsynth)
#   vendor/quarks/SuperDirt                  (pinned v1.7.4)
#   vendor/quarks/Vowel                      (SuperDirt dep)
#   vendor/samples/Dirt-Samples              (fetched here, NEVER bundled/committed)
#   vendor/sclang_conf.yaml                  (generated: quark include paths)
#
# Licensing: Dirt-Samples has mixed/unclear per-sample provenance, so we NEVER
# bundle it into the installer or commit it (vendor/ is gitignored). It is
# fetched on the dev machine here, and will be fetched-on-first-run on the end
# user's machine by the Rust shell — Selene redistributes no audio either way.
# Clean-Samples (GPL-3) is the preferred set but is currently an empty index.

set -euo pipefail

SC_VERSION="3.14.1"
SUPERDIRT_TAG="v1.7.4"
VOWEL_COMMIT="ab59caa870201ecf2604b3efdd2196e21a8b5446"
DIRT_SAMPLES_COMMIT="c74fc80f8db8038f6a33648ffef5ac00a07ad402"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$REPO_ROOT/vendor"
SC_DIR="$VENDOR/supercollider"
QUARKS="$VENDOR/quarks"
SAMPLES="$VENDOR/samples"
CACHE="$VENDOR/.download-cache"
SCLANG_CONF="$VENDOR/sclang_conf.yaml"

# SHA256 of the SuperCollider dmg. Empty = compute + print on first run, then
# paste here to pin (AGENTS.md: pin everything).
SC_DMG_SHA256="ed264b32752d27fc86e506dd0a7eb36de7c19ebce73c3fdf2ed5514f8c73f02e"

# ── Platform guard ────────────────────────────────────────────────────────────

OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  echo "fetch-superdirt.sh: macOS only for now (got $OS). Other platforms TODO." >&2
  exit 1
fi

DMG="SuperCollider-${SC_VERSION}-macOS-universal.dmg"
DMG_URL="https://github.com/supercollider/supercollider/releases/download/Version-${SC_VERSION}/${DMG}"

# ── SuperCollider ─────────────────────────────────────────────────────────────

if [[ -d "$SC_DIR/SuperCollider.app" ]]; then
  echo "==> SuperCollider already present — skipping (delete vendor/supercollider to reinstall)"
else
  mkdir -p "$CACHE"
  DMG_PATH="$CACHE/$DMG"

  if [[ ! -f "$DMG_PATH" ]]; then
    echo "==> Downloading SuperCollider ${SC_VERSION}..."
    curl -fL "$DMG_URL" -o "$DMG_PATH"
  else
    echo "==> Using cached $DMG"
  fi

  echo "==> Verifying checksum..."
  ACTUAL_SHA="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
  if [[ -z "$SC_DMG_SHA256" ]]; then
    echo "WARNING: SC_DMG_SHA256 not pinned. Computed: $ACTUAL_SHA" >&2
    echo "         Paste it into bundle/fetch-superdirt.sh to pin." >&2
  elif [[ "$ACTUAL_SHA" != "$SC_DMG_SHA256" ]]; then
    echo "Error: checksum mismatch!" >&2
    echo "  expected: $SC_DMG_SHA256" >&2
    echo "  actual:   $ACTUAL_SHA" >&2
    exit 1
  fi

  echo "==> Mounting dmg + copying SuperCollider.app..."
  MNT="$(mktemp -d)"
  cleanup_dmg() { hdiutil detach "$MNT" -quiet -force 2>/dev/null || true; rm -rf "$MNT"; }
  # Safety net: clean up if the copy fails (set -e). Disarmed after success.
  trap cleanup_dmg EXIT
  hdiutil attach "$DMG_PATH" -nobrowse -quiet -mountpoint "$MNT"

  # App sits at the mount root. Check directly first; fall back to a shallow
  # search (maxdepth 1 so we never descend into macOS's protected .Trashes).
  APP_SRC="$MNT/SuperCollider.app"
  if [[ ! -d "$APP_SRC" ]]; then
    APP_SRC="$(find "$MNT" -maxdepth 1 -name "SuperCollider.app" -type d 2>/dev/null | head -1)"
  fi
  if [[ -z "$APP_SRC" || ! -d "$APP_SRC" ]]; then
    echo "Error: SuperCollider.app not found in mounted dmg" >&2
    exit 1
  fi

  mkdir -p "$SC_DIR"
  cp -R "$APP_SRC" "$SC_DIR/"

  cleanup_dmg
  trap - EXIT
fi

SCLANG="$SC_DIR/SuperCollider.app/Contents/MacOS/sclang"
if [[ ! -x "$SCLANG" ]]; then
  echo "Error: sclang not found at $SCLANG" >&2
  exit 1
fi

# ── Quarks: SuperDirt + Vowel ─────────────────────────────────────────────────
#
# Pinned clones. We do NOT install SuperDirt's Dirt-Samples dependency.

mkdir -p "$QUARKS"

clone_pinned() {
  local url="$1" dir="$2" ref="$3"
  if [[ -d "$dir" ]]; then
    echo "==> $(basename "$dir") already present — skipping"
  else
    echo "==> Cloning $(basename "$dir") @ $ref..."
    git clone --quiet "$url" "$dir"
    git -C "$dir" checkout --quiet "$ref"
    # Drop .git — we pin by ref and never update in place, and bundling the
    # history is wasteful + trips the Tauri resource walk (permission errors).
    rm -rf "$dir/.git"
  fi
}

clone_pinned "https://github.com/musikinformatik/SuperDirt.git" "$QUARKS/SuperDirt" "$SUPERDIRT_TAG"
clone_pinned "https://github.com/supercollider-quarks/Vowel.git" "$QUARKS/Vowel" "$VOWEL_COMMIT"

# ── Samples: Dirt-Samples (fetched, never bundled — see licensing note above) ──

mkdir -p "$SAMPLES"
clone_pinned "https://github.com/tidalcycles/Dirt-Samples.git" "$SAMPLES/Dirt-Samples" "$DIRT_SAMPLES_COMMIT"

# ── sclang config: point class library at our quarks ──────────────────────────
#
# includePaths adds our quark roots to the class library compile. The app's
# built-in standard library is always loaded; these are additive.
#
# excludePaths makes Selene hermetic: ignore the user's GLOBAL SuperCollider
# extensions (~/Library/.../Extensions and the system dir) so we load only our
# vendored quarks. Without this, sclang scans the user's SC3Plugins etc. and
# spams hundreds of dlopen errors on macOS AppleDouble (._*) junk files.

echo "==> Writing $SCLANG_CONF..."
cat > "$SCLANG_CONF" << YAML
includePaths:
  - $QUARKS/SuperDirt/classes
  - $QUARKS/Vowel
  - $VENDOR/sc3-plugins/classes
excludePaths:
  - $HOME/Library/Application Support/SuperCollider/Extensions
  - /Library/Application Support/SuperCollider/Extensions
postInlineWarnings: false
YAML

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "==> Done. The app (cargo tauri dev) boots SuperDirt automatically."
