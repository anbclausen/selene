# TODO

Ordered highest priority first. One task = one commit. Remove completed lines; don't strike through.

---

## Phase 4 — Visuals (Strudel-style, event-driven)

Piano-roll/structured visuals driven by Tidal's OSC EVENT stream, NOT audio.
Render on plain HTML5 Canvas 2D (zero-dep). Do NOT use `@strudel/draw` (AGPL-3
and needs a JS Pattern object we don't have — Tidal runs in Haskell). p5.js
(LGPL-2.1) dropped: heavy + generative-art oriented, wrong tool here.

- [ ] Render a scrolling piano roll on Canvas 2D from the event feed. (Optional perf escalation: PixiJS, MIT — only if Canvas 2D can't keep up.)
- [ ] Sound browser: a searchable/browsable panel of available sample banks + synths (like Strudel's sounds tab or a DAW's instrument browser). List the loaded Dirt-Samples folders with counts, preview on click (audition via a one-shot `once $ sound "..."`), and click-to-insert the name into the editor.
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
