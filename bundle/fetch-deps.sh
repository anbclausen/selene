#!/usr/bin/env bash
# bundle/fetch-deps.sh
#
# Orchestrates all vendor fetching. Run by Tauri's beforeDevCommand /
# beforeBuildCommand. Each sub-script is idempotent (skips work already done),
# so this is cheap to re-run on every dev start.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

bash "$HERE/fetch-ghc.sh"
bash "$HERE/fetch-superdirt.sh"
