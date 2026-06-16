#!/usr/bin/env bash
# bundle/fetch-hls.sh
#
# Installs Haskell Language Server 2.13.0.0 (GHC 9.6.7 build) into vendor/hls/.
# Run from repo root. Safe to re-run (skips if already done).
#
# Build-time deps (not shipped): ghcup
# Output: vendor/hls/haskell-language-server-9.6.7
#         vendor/hls/haskell-language-server-wrapper

set -euo pipefail

HLS_VERSION="2.13.0.0"
GHC_VERSION="9.6.7"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_HLS="$REPO_ROOT/vendor/hls"
HLS_BIN="$VENDOR_HLS/bin/haskell-language-server-${GHC_VERSION}"

# ghcup — same auto-detect as fetch-ghc.sh; override with GHCUP_CMD env var.
if [[ -n "${GHCUP_CMD:-}" ]]; then
  GHCUP="$GHCUP_CMD"
elif command -v ghcup &>/dev/null; then
  GHCUP="ghcup"
elif [[ -x "$HOME/.ghcup/bin/ghcup" ]]; then
  GHCUP="$HOME/.ghcup/bin/ghcup"
else
  echo "Error: ghcup not found. Install via https://www.haskell.org/ghcup/" >&2
  exit 1
fi

if [[ -x "$HLS_BIN" ]]; then
  echo "==> vendor/hls already present — skipping (delete to reinstall)"
  exit 0
fi

mkdir -p "$VENDOR_HLS"
TMP_ISOLATE="$REPO_ROOT/vendor/.hls-tmp-install"
rm -rf "$TMP_ISOLATE"

echo "==> Installing HLS ${HLS_VERSION} for GHC ${GHC_VERSION} via ghcup..."

# Try --isolate first (ghcup ≥ 0.1.20). If unsupported, fall back to a normal
# install and copy the binaries out so ~/.ghcup isn't the canonical location.
if ! "$GHCUP" install hls "${HLS_VERSION}" --isolate "$TMP_ISOLATE" 2>/dev/null; then
  rm -rf "$TMP_ISOLATE"
  echo "Error: ghcup --isolate failed for HLS ${HLS_VERSION}" >&2
  exit 1
fi

# ghcup --isolate produces bin/ + lib/ with wrapper shell scripts that have
# hardcoded exedir paths pointing to the tmp location. Copy the whole tree to
# vendor/hls/ and rewrite those paths in-place.
cp -R "$TMP_ISOLATE/bin" "$VENDOR_HLS/"
cp -R "$TMP_ISOLATE/lib" "$VENDOR_HLS/"
rm -rf "$TMP_ISOLATE"

# Fix hardcoded exedir references so the wrappers find their real binaries.
find "$VENDOR_HLS/bin" -type f | while read -r f; do
  sed -i '' "s|${TMP_ISOLATE}|${VENDOR_HLS}|g" "$f" 2>/dev/null || true
done

echo ""
echo "==> Done."
echo "    Binary: $HLS_BIN"
echo "    Wrapper: $VENDOR_HLS/bin/haskell-language-server-wrapper"
echo "    Verify: PATH=\"$(dirname "$VENDOR_HLS/../vendor/ghc/bin"):$PATH\" $HLS_BIN --version"
