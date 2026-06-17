# TODO

Ordered highest priority first. One task = one commit. Remove completed lines; don't strike through.

---

## Phase 4 — Visuals (Strudel-style, event-driven)

Piano-roll/structured visuals driven by Tidal's OSC EVENT stream, NOT audio.
Render on plain HTML5 Canvas 2D (zero-dep). Do NOT use `@strudel/draw` (AGPL-3
and needs a JS Pattern object we don't have — Tidal runs in Haskell). p5.js
(LGPL-2.1) dropped: heavy + generative-art oriented, wrong tool here.

- [ ] Tap the event stream: add a secondary OSC target in `BootTidal.hs` (or an `oscMap`) that mirrors events to a local UDP port; Rust shell listens and forwards to the webview via a Tauri event. Keep the `:57120` SuperDirt seam untouched.
- Highlight exactly what notes/beats are currently playing
- [ ] Render a scrolling piano roll on Canvas 2D from the event feed. (Optional perf escalation: PixiJS, MIT — only if Canvas 2D can't keep up.)
- [ ] (Deferred/optional) Audio-reactive scope: requires scsynth-side analysis sent over OSC — hard, only if wanted later.

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
