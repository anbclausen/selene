# MEMORY

Durable cross-session findings. Not for TODO items or git history.

---

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
