# TODO

Ordered highest priority first. One task = one commit. Remove completed lines; don't strike through.

---

## Phase 2 — Rust shell

- [ ] Spawn + supervise ghci sidecar with BootTidal.hs; gate on SuperDirt ready signal before spawning
- [ ] Health checks: detect sidecar crash, surface error to user

## Phase 3 — Editor

- [ ] Load CodeMirror in Tauri webview
- [ ] Eval-block command → Tauri IPC → ghci stdin
- [ ] Transport UI: mute / solo / hush buttons wired to Tidal

## Phase 4 — Visuals

- [ ] Integrate p5.js in webview
- [ ] Tap audio bus → p5.js input

## Phase 5 — Bundle

- [ ] Vendor sc3-plugins (pinned) into the SC plugins path — SuperDirt's default-synths need them for canonical sound (currently falls back to comb delay; "not a problem" but not the real thing)
- [ ] macOS: package GHC, sclang/scsynth, SuperDirt quark, Clean-Samples as sidecars; resolve all resource paths via Tauri API
- [ ] Windows: same
- [ ] Linux: same
- [ ] CI matrix: `.github/workflows/` build + package on macos/windows/ubuntu
- [ ] Smoke-test installer on clean VM per OS before any release tag

## Phase 6 — Recording (deferred)

- [ ] OSC session logger in `core/` — capture/replay via existing OSC seam
- [ ] WAV export — attach to existing seam
