# MEMORY

Durable cross-session findings. Not for TODO items or git history.

---

## HLS cradle recipe (2026-06-16)

HLS 2.13.0.0, GHC 9.6.7 build. Vendored to `vendor/hls/haskell-language-server-9.6.7`.

**hie.yaml** (direct cradle, placed in session dir alongside `current.hs`):
```yaml
cradle:
  direct:
    arguments:
      - "-package-env"
      - "<ABS_REPO_ROOT>/vendor/tidal-ghc-env"
      - "-XOverloadedStrings"
```
Only `-XOverloadedStrings` is needed (the one `:set -X` in BootTidal.hs); the
rest of BootTidal.hs is runtime setup, not dialect flags.

HLS must be launched with `PATH=vendor/ghc/bin:$PATH` so it finds GHC 9.6.7,
not a system GHC. The session dir is a temp dir per process (`/tmp/selene-hls-<pid>/`).

Virtual document URI: `file://<session_dir>/current.hs` — HLS resolves the
cradle from `hie.yaml` in the same dir. The user's `.tidal` file is never
shown to HLS; LSP overlay carries the text via `didOpen`/`didChange`.

`lsp-recv` event payload: JSON string. `lsp_send` Tauri command takes a JSON string.
Content-Length framing is handled entirely in Rust.

## GHC relocation (2026-06-10)

The installed `bin/ghc` wrapper hardcodes `-B/absolute/libdir`. Fix: rewrite wrapper to compute `GHC_HOME` dynamically at runtime:

```sh
GHC_HOME=$(cd "$(dirname "$0")/.." && pwd)
exec "$GHC_HOME/lib/ghc-X.Y.Z/bin/ghc-X.Y.Z-real" -B"$GHC_HOME/lib/ghc-X.Y.Z" "$@"
```

Package db `.conf` files also contain absolute paths — need a sed pass + `ghc-pkg recache` at first launch, or set `GHC_PACKAGE_PATH` from the Rust shell before spawning ghci.

Approach: download official GHC binary tarball → rewrite wrappers → rewrite pkg db → bundle under `vendor/ghc/`. Tauri sidecar points to `vendor/ghc/bin/ghci`.

Prior art: [ghc-dot-app](https://github.com/ghcformacosx/ghc-dot-app) (old but proves the technique), [zw3rk's relocatable distributions](https://medium.com/@zw3rk/relocatable-ghc-cross-compiler-binary-distributions-f55080b837b1).

Windows is easiest (GHC finds libdir automatically). macOS next. Linux last.
