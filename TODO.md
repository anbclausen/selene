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

- [x] Define `pianoroll = id` in BootTidal + editor canvas renderer (opt-in per dN block, fed by tidal-event OSC stream).
- [ ] Sound browser: a searchable/browsable panel of available sample banks + synths (like Strudel's sounds tab or a DAW's instrument browser). List the loaded Dirt-Samples folders with counts, preview on click (audition via a one-shot `once $ sound "..."`), and click-to-insert the name into the editor.
- [ ] (Deferred/optional) `scope = id` — audio-reactive waveform scope; requires scsynth-side analysis sent over OSC, hard, only if wanted later.

## Phase 4.5 — Arrangement

Tidal has two built-in arrangement tools:
- `seqP` / `seqPLoop` — sequence patterns by cycle number (`seqP [(0,4,d1pat), (4,8,d2pat)]`)
- `ur` — "urban" arranger: `ur 16 "pat1 _ pat2 pat3" [("pat1", d1), ...]` cycles through named sections

Neither is ideal for Selene's linear arrange-then-export workflow. Instead, define an `arrange` function that describes the full track as a list of `(startCycle, endCycle, pattern)` triples — essentially a thin wrapper over `seqP` that's easy to read and that Selene can identify in the source to drive WAV export.

- [ ] Research whether `seqP`/`ur` covers the use case well enough, or whether a `arrange = seqP` alias plus documentation is sufficient. Spike it in the default seed first.
- [ ] Define `arrange` in BootTidal as an alias/wrapper. Usage: `arrange [(0,8, d1pat), (8,16, d2pat), ...]` plays the track from cycle 0 linearly.
- [ ] Editor: detect `arrange` in a block and show its total cycle length in the status bar or a small overlay (e.g. "32 cycles @ 130 BPM = 1:28").

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
