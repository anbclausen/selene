# Plan — Haskell Language Server over LSP into CodeMirror

TODO line: *"Haskell Language Server: run HLS against the Tidal env so the editor
gets type hints, hover docs, completion, errors. Needs HLS wired over LSP to
CodeMirror (bundled like the rest — no user install)."*

Goal: editor gets hover types, completion, and diagnostics from a bundled HLS,
running against the same GHC 9.6.7 + Tidal package-env the eval pipe uses. No
user-side toolchain install. Don't touch the OSC seam or the eval pipe.

## Established facts (verified)

- Vendor GHC: `vendor/ghc/bin/ghc-9.6.7` (+ unsuffixed `ghc`, `ghci`).
- Tidal env: `vendor/tidal-ghc-env` (package-env file, absolute store paths).
- HLS: install via `ghcup` (recommended `2.13.0.0`); must use the
  `haskell-language-server-9.6.7` binary (HLS is per-GHC). Verify 2.13 ships a
  9.6.7 build; if not, pick the newest HLS that does.
- Frontend LSP client: `@codemirror/lsp-client` 6.2.5 — official, MIT, fits
  CM 6.43. Needs a custom `Transport` (it does not assume WebSocket).
- BootTidal.hs language extensions must be mirrored into the cradle so HLS sees
  the same dialect (read `core/BootTidal.hs` for the exact `:set -X…` list and
  `import` lines).

## Architecture

```
CodeMirror (@codemirror/lsp-client)
   │  LSP JSON-RPC messages (objects)
   ▼
Tauri IPC:  invoke("lsp_send", {msg})        ← client → server
            event "lsp-recv" (msg)            ← server → client
   ▼
Rust: Lsp sidecar (new) — frames/deframes Content-Length JSON-RPC on
      HLS stdio, spawns haskell-language-server-9.6.7
   ▼
HLS  ── cradle (hie.yaml, direct) ──> vendor GHC + tidal-ghc-env
```

HLS is a **third supervised process**, independent of SuperDirt/Tidal. It is NOT
gated on SuperDirt readiness and its death is non-fatal (editor still evals).
Reuse `spawn_proc` only if framing allows; LSP has no `SELENE_READY` line, so
add a dedicated spawn path (see step 3).

## The two real risks — SPIKE THESE FIRST before writing UI code

1. **Cradle / loose-file loading.** HLS needs to know how to compile the edited
   buffer with Tidal in scope, with no cabal project. Use a hie-bios **direct**
   cradle:

   ```yaml
   # hie.yaml
   cradle:
     direct:
       arguments:
         - "-package-env"
         - "<ABS>/vendor/tidal-ghc-env"
         - "-XOverloadedStrings"   # + every -X from BootTidal.hs
   ```

   HLS must also find GHC 9.6.7: launch it with `PATH` prefixed by
   `vendor/ghc/bin`, or pass `--ghc-version`/set the cradle compiler. Verify
   HLS picks 9.6.7, not a system GHC.

2. **`.tidal` extension.** ghcide/HLS only type-checks Haskell-extension files.
   The editor's real save file is `.tidal`. **Decouple the LSP document from the
   save path:** sync the buffer to a fixed virtual URI ending in `.hs` (e.g. a
   per-session scratch dir `<sessiondir>/current.hs` next to `hie.yaml`).
   `didOpen`/`didChange` carry the full text as an overlay, so HLS never needs
   the real file on disk and the cradle resolves because the URI sits under the
   dir containing `hie.yaml`. The user's actual file I/O is unchanged.

   **Validate the whole spike from a terminal first** (no app): build the
   session dir, run `haskell-language-server-9.6.7 --lsp` by hand piping a
   minimal `initialize` + `didOpen` with a Tidal snippet, confirm a hover on
   `sound` returns a type and that a type error produces a diagnostic. If this
   doesn't work, stop and rethink the cradle — everything else is plumbing.

## Steps (each = one commit)

### 1. `bundle/fetch-hls.sh` — vendor HLS
- Mirror `fetch-ghc.sh` style: auto-detect `ghcup`, no sudo, idempotent, pinned
  version (`HLS_VERSION=2.13.0.0`, confirm 9.6.7 support).
- `ghcup install hls 2.13.0.0 --isolate "$REPO_ROOT/vendor/hls"` (check
  `--isolate` is supported for hls; else install + copy the
  `haskell-language-server-9.6.7` + wrapper binaries into `vendor/hls/`).
- Output: `vendor/hls/haskell-language-server-9.6.7` (+ wrapper). Document the
  exact binary path the Rust shell will spawn.
- Note in MEMORY.md: HLS version, why, that it must match GHC 9.6.7.

### 2. Spike the cradle (no commit — throwaway, but capture findings in MEMORY.md)
- Do risk #1 + #2 validation above by hand. Lock down: exact cradle arguments,
  how HLS finds GHC, the virtual `.hs` URI scheme. Record the working recipe.

### 3. Rust: LSP sidecar + IPC commands
- New `src-tauri/src/lsp.rs` (or extend `sidecar.rs`): spawn
  `vendor/hls/haskell-language-server-9.6.7 --lsp` with `PATH` prefixed by
  `vendor/ghc/bin`, cwd = a session dir the shell creates containing the
  generated `hie.yaml` (paths resolved at runtime — never hardcoded; mirror
  `vendor_dir()`/`repo_root()` helpers). Generate `hie.yaml` from a template
  with the abs `tidal-ghc-env` path + BootTidal `-X` flags substituted in.
- Framing: read HLS stdout, parse `Content-Length:` headers, emit each complete
  JSON message to the webview as Tauri event `lsp-recv`. Add `#[tauri::command]
  lsp_send(msg: serde_json::Value)` that re-frames (`Content-Length: N\r\n\r\n`
  + body) and writes to HLS stdin. Hold stdin in shared state like the Tidal
  sidecar.
- Supervise + kill-on-exit like other sidecars (own process group, drop=kill).
  Crash is non-fatal: log + optional distinct event; do NOT reuse the
  `backend-crashed` fatal banner (editor still works without HLS). Add `"hls"`
  spawn into `boot_backends` (parallel to others; not gated).
- Gates: `cargo fmt`, `cargo clippy`, `cargo test`.

### 4. Frontend: wire `@codemirror/lsp-client`
- `npm i @codemirror/lsp-client@6.2.5` (pin exact, update lockfile).
- Implement a `Transport` backed by Tauri: `send(msg)` → `invoke("lsp_send",…)`;
  subscribe to `listen("lsp-recv", …)` and push into the client. Match the
  package's Transport interface exactly (read its types).
- Create `LSPClient` + `languageServerSupport(client, docUri)`; add its
  extensions to the existing `EditorState` next to `tidalLanguage`. Keep the
  StreamLanguage Haskell mode for syntax highlight; LSP adds hover/complete/
  diagnostics on top.
- Document URI = the fixed virtual `current.hs` from step 2, independent of
  `currentPath`. On editor doc changes the LSP client already sends `didChange`;
  ensure the initial `didOpen` fires with the seed text.
- Web gates: formatter + linter + `tsc` clean, `vite build`.

### 5. Lifecycle + polish
- Ensure HLS is torn down on exit (add to the drain in `lib.rs` RunEvent
  handler, before/after the others — order doesn't matter, it's independent).
- Handle HLS-not-ready gracefully on the frontend: LSP features degrade silently
  if the server is slow/absent; no error banners.
- Update `TODO.md`: remove the HLS line.
- Verify (build/check/lint only — never run the app per AGENTS.md). Manual
  behavioral proof came from the step-2 spike.

## Constraints (from AGENTS.md)
- One task = one commit at natural breaks. No Claude co-author trailer.
  Conventional commit prefixes. main stays green — branch for this work.
- Pin every version (HLS, npm pkg). Resolve all paths at runtime, never
  hardcode. Subprocess env (PATH→vendor GHC, package-env) set explicitly.
- No sudo in scripts. Never run the app to verify.
- Record decisions + the cradle recipe + dead ends in MEMORY.md.
```
