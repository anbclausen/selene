# TODO

Ordered highest priority first. One task = one commit. Remove completed lines; don't strike through.

---

## Phase 1 — Headless pipeline (prove the seam)

- [ ] Write `backend/startup.scd` — boots scsynth + loads SuperDirt, targets OSC :57120
- [ ] Verify SC + SuperDirt boot headlessly via `sclang startup.scd` on clean env
- [ ] Write `core/` Haskell package: minimal Tidal wrapper, OSC target pointing at :57120
- [ ] Prove end-to-end headless: `ghci` → Tidal pattern → OSC :57120 → SuperDirt → sound

## Phase 2 — Rust shell

- [ ] Spawn + supervise sclang sidecar; wait for SuperDirt ready signal before continuing
- [ ] Spawn + supervise ghci sidecar with BootTidal.hs
- [ ] Health checks: detect sidecar crash, surface error to user
- [ ] Clean teardown: kill both sidecars on app exit

## Phase 3 — Editor

- [ ] Load CodeMirror in Tauri webview
- [ ] Eval-block command → Tauri IPC → ghci stdin
- [ ] Transport UI: mute / solo / hush buttons wired to Tidal

## Phase 4 — Visuals

- [ ] Integrate p5.js in webview
- [ ] Tap audio bus → p5.js input

## Phase 5 — Bundle

- [ ] macOS: package GHC, sclang/scsynth, SuperDirt quark, Clean-Samples as sidecars; resolve all resource paths via Tauri API
- [ ] Windows: same
- [ ] Linux: same
- [ ] CI matrix: `.github/workflows/` build + package on macos/windows/ubuntu
- [ ] Smoke-test installer on clean VM per OS before any release tag

## Phase 6 — Recording (deferred)

- [ ] OSC session logger in `core/` — capture/replay via existing OSC seam
- [ ] WAV export — attach to existing seam
