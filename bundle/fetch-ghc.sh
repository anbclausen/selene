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
# Packages land in vendor/cabal-store/ (NOT the user's ~/.cabal/store) so the
# whole thing ships inside the bundle. The .conf files cabal writes carry the
# build machine's absolute paths, which won't exist on the user's Mac — so after
# install we make the store relocatable:
#   * rewrite each package .conf to use ${pkgroot} (GHC expands it to the dir
#     holding package.db, i.e. wherever the bundle lands) instead of the absolute
#     store path, then ghc-pkg recache;
#   * rewrite the env's `package-db` line to be relative to the env file, which
#     GHC resolves against the env file's own directory.
# Combined with the Rust shell invoking ghci's real binary with a runtime -B,
# this makes the bundle run off the build machine.

VENDOR="$REPO_ROOT/vendor"
STORE="$VENDOR/cabal-store"
STORE_GHC="$STORE/ghc-${GHC_VERSION}"

if [[ -f "$GHC_ENV" ]]; then
  echo "==> tidal already installed — skipping (delete vendor/tidal-ghc-env to reinstall)"
else
  # A fresh cabal (e.g. CI) has no hackage index yet; without it the install
  # fails with "Unknown package". Idempotent and cheap once cached.
  echo "==> cabal update (hackage index)..."
  "$CABAL" update

  echo "==> Installing tidal ${TIDAL_VERSION} into $STORE ..."
  "$CABAL" --store-dir="$STORE" install "tidal-${TIDAL_VERSION}" \
    --with-compiler="$VENDOR_GHC/bin/ghc" \
    --package-env="$GHC_ENV" \
    --lib \
    --overwrite-policy=always

  echo "==> Making the store relocatable (\${pkgroot} in .conf files)..."
  for f in "$STORE_GHC"/package.db/*.conf; do
    perl -pi -e "s{\Q$STORE_GHC\E}{\\\$\{pkgroot\}}g" "$f"
  done
  "$VENDOR_GHC/bin/ghc-pkg" recache --package-db="$STORE_GHC/package.db"

  echo "==> Making the env's package-db path relative to the env file..."
  # cabal wrote an absolute `package-db …/cabal-store/ghc-x/package.db`; the env
  # file lives in vendor/, so a path relative to it resolves anywhere.
  perl -pi -e "s{\Q$STORE\E/}{cabal-store/}g" "$GHC_ENV"
fi

echo ""
echo "==> Done. Verify:"
echo "    $VENDOR_GHC/bin/ghci -package-env $GHC_ENV"
echo "    Prelude> import Sound.Tidal.Context"
