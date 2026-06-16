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
HLS_BIN="$VENDOR_HLS/haskell-language-server-${GHC_VERSION}"

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
if "$GHCUP" install hls "${HLS_VERSION}" --isolate "$TMP_ISOLATE" 2>/dev/null; then
  src_bin="$TMP_ISOLATE/haskell-language-server-${GHC_VERSION}"
  src_wrap="$TMP_ISOLATE/haskell-language-server-wrapper"
  if [[ ! -x "$src_bin" ]]; then
    echo "Error: expected $src_bin after --isolate install" >&2
    rm -rf "$TMP_ISOLATE"
    exit 1
  fi
  cp "$src_bin" "$HLS_BIN"
  [[ -x "$src_wrap" ]] && cp "$src_wrap" "$VENDOR_HLS/haskell-language-server-wrapper"
  rm -rf "$TMP_ISOLATE"
else
  rm -rf "$TMP_ISOLATE"
  echo "==> --isolate not available; installing HLS ${HLS_VERSION} globally then copying..."
  "$GHCUP" install hls "${HLS_VERSION}"

  GHCUP_BIN="$HOME/.ghcup/bin"
  src_bin="$GHCUP_BIN/haskell-language-server-${GHC_VERSION}"
  src_wrap="$GHCUP_BIN/haskell-language-server-wrapper"

  if [[ ! -x "$src_bin" ]]; then
    echo "Error: could not find $src_bin after install" >&2
    exit 1
  fi
  cp "$src_bin" "$HLS_BIN"
  [[ -x "$src_wrap" ]] && cp "$src_wrap" "$VENDOR_HLS/haskell-language-server-wrapper"
fi

chmod +x "$HLS_BIN"

echo ""
echo "==> Done."
echo "    Binary: $HLS_BIN"
echo "    Verify: $HLS_BIN --version"
