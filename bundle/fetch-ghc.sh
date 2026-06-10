#!/usr/bin/env bash
# bundle/fetch-ghc.sh
#
# Installs GHC 9.6.7 + tidal 1.9.4 into a self-contained vendor/ghc/.
# Run from repo root. Safe to re-run (skips steps already done).
#
# Build-time deps (not shipped): ghcup, cabal
# Output: vendor/ghc/  vendor/cabal-store/  vendor/tidal-ghc-env

set -euo pipefail

GHC_VERSION="9.6.7"
TIDAL_VERSION="1.9.4"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_GHC="$REPO_ROOT/vendor/ghc"
GHC_ENV="$REPO_ROOT/vendor/tidal-ghc-env"

# ghcup — auto-detected; override with GHCUP_CMD env var if needed
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

# cabal — auto-detected; override with CABAL_CMD env var if needed
if [[ -n "${CABAL_CMD:-}" ]]; then
  CABAL="$CABAL_CMD"
elif command -v cabal &>/dev/null; then
  CABAL="cabal"
elif [[ -x "$HOME/.ghcup/bin/cabal" ]]; then
  CABAL="$HOME/.ghcup/bin/cabal"
else
  echo "Error: cabal not found. Install via https://www.haskell.org/ghcup/" >&2
  exit 1
fi

# ── Install GHC ───────────────────────────────────────────────────────────────
# ghcup handles download, checksum, wrapper patching, and boot package
# registration. --isolate installs to vendor/ghc/ without touching ~/.ghcup.

if [[ -d "$VENDOR_GHC" ]]; then
  echo "==> vendor/ghc already present — skipping (delete to reinstall)"
else
  echo "==> Installing GHC ${GHC_VERSION} via ghcup..."
  "$GHCUP" install ghc "${GHC_VERSION}" --isolate "$VENDOR_GHC"
fi

# ── Install tidal ─────────────────────────────────────────────────────────────
# Uses system cabal (build tool only — never shipped) with the vendor GHC.
# Packages land in vendor/cabal-store/; vendor/tidal-ghc-env lists them for ghci.
#
# Relocation note: cabal-store paths are absolute. The Rust shell rewrites them
# to the actual install location before spawning ghci. (Phase 5 concern —
# for Phase 1 dev the paths point to this repo's vendor/ tree and work as-is.)

if [[ -f "$GHC_ENV" ]]; then
  echo "==> tidal already installed — skipping (delete vendor/tidal-ghc-env to reinstall)"
else
  echo "==> Installing tidal ${TIDAL_VERSION}..."
  "$CABAL" install "tidal-${TIDAL_VERSION}" \
    --with-compiler="$VENDOR_GHC/bin/ghc" \
    --package-env="$GHC_ENV" \
    --lib \
    --overwrite-policy=always
fi

echo ""
echo "==> Done. Verify:"
echo "    $VENDOR_GHC/bin/ghci -package-env $GHC_ENV"
echo "    Prelude> import Sound.Tidal.Context"
