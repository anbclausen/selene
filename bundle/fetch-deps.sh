#!/usr/bin/env bash
# bundle/fetch-deps.sh
#
# Orchestrates all vendor fetching. Run by Tauri's beforeDevCommand /
# beforeBuildCommand. Each sub-script is idempotent (skips work already done),
# so this is cheap to re-run on every dev start.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# GHC is still needed — ghci runs the Tidal session. HLS was dropped (a language
# server fights Tidal's non-module syntax), so fetch-hls.sh is no longer run.
bash "$HERE/fetch-ghc.sh"
bash "$HERE/fetch-superdirt.sh"
# sc3-plugins after SuperDirt: it drops .scx into the vendored SC.app and classes
# into vendor/sc3-plugins/classes (which fetch-superdirt.sh lists in includePaths).
bash "$HERE/fetch-sc3-plugins.sh"
