# TODO

Ordered highest priority first. One task = one commit. Remove completed lines; don't strike through.

---

## Phase 4 — Visuals (Strudel-style, opt-in per track)

Visualisations are **opt-in**: the user adds a viz function to their pattern
and Selene renders a canvas for that channel beneath the editor line — exactly
like Strudel's `.pianoroll()`. No viz function = no canvas, zero overhead.

Viz functions are defined as `id` in BootTidal (pure passthrough, no audio
effect). The editor detects them on evaluated lines and shows the matching
canvas, fed by the existing `tidal-event` OSC stream.

Render on plain HTML5 Canvas 2D (zero-dep). Do NOT use `@strudel/draw` (AGPL-3
and needs a JS Pattern object we don't have — Tidal runs in Haskell).

- [ ] (Deferred/optional) `scope = id` — audio-reactive waveform scope; requires scsynth-side analysis sent over OSC, hard, only if wanted later.

## Phase 4.5 — Arrangement

`arrange = seqPLoop` is defined in BootTidal (a thin alias over Tidal's
`seqPLoop`); the editor shows the arrangement length next to the filename when an
`arrange [(start,end,pat),…]` block is evaluated. Remaining/optional:

- [ ] `ur`-style named-section arranger as an alternative ergonomics, if the tuple form proves clunky for longer tracks.

## Phase 5 — Bundle

- [ ] Vendor sc3-plugins (pinned) into the SC plugins path — SuperDirt's default-synths need them for canonical sound (currently falls back to comb delay; "not a problem" but not the real thing)
- [ ] macOS: package GHC, sclang/scsynth, SuperDirt quark, Clean-Samples as sidecars; resolve all resource paths via Tauri API
- [ ] Windows: same
- [ ] Linux: same
- [ ] CI matrix: `.github/workflows/` build + package on macos/windows/ubuntu
- [ ] Smoke-test installer on clean VM per OS before any release tag

## Phase 6 — Recording (deferred)

- [ ] OSC session logger in `core/` — capture/replay via existing OSC seam
- [ ] WAV export: when the cursor is on an `arrange` block, a Render button (or Cmd-R) bounces the track to WAV. Selene resets the cycle clock, lets Tidal play for the arrange's total duration, and captures scsynth's output via its built-in recording OSC API (`/b_alloc`, `/b_read`, `/b_write` or the `Record` quark). No separate DAW needed.
