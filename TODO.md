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

Piano roll is done (centered playhead). Scope is in progress (below).

## Phase 4.6 — Selene polish (execute top-down, commit after each)

- [ ] Finish `_scope` waveform. SC tap (read-only per-orbit RecordBuf streamed to :57121 as `/scope orbit s…`) and the BootTidal marker are in place. Remaining: parse `/scope` in `osc.rs` → emit `scope-frame`; editor renderer that draws the waveform on a canvas for any channel whose block contains the scope marker (reuse the viz-panel + detection plumbing from the piano roll). NOTE: the SC capture is unverified — needs a real audio run to confirm it shows a live waveform (it's read-only so it can't break sound).
- [ ] Prefix visual functions with `_` (Strudel-style): rename `pianoroll`→`_pianoroll`, `scope`→`_scope` in BootTidal, the editor's detection regexes, autocomplete, and the default seed. Keep `arrange` un-prefixed (it's not a visual).
- [ ] Configurable visual latency. The piano-roll playhead uses a fixed `PLAYHEAD_LOOKAHEAD_MS`; the user reports visuals running slightly ahead of sound. Add a setting (persisted to localStorage, small input in the toolbar or a settings popover) to offset visual timing, applied to the piano roll (and scope if relevant).
- [ ] Import-sample button. A button that opens a file/folder picker and copies the chosen samples into an internal, git-ignored samples folder, slotted under a category (a new bank folder). SuperDirt should pick them up (reload `loadSoundFiles`), and they appear in the sound browser. Add the internal folder to `.gitignore`.

## Phase 4.7 — Docs

- [ ] README: state that Selene is a **superset of TidalCycles**, and add a "Selene-specific functions" reference section listing everything that isn't stock Tidal (`arrange`, `_pianoroll`, `_scope`, …) with one-line usage. Add a rule to AGENTS.md: whenever a Selene-specific function is added, document it in that README section.
- [ ] README: add a "Showcase" section with a placeholder GIF (`docs/showcase.gif` or similar) showing the tool in action — user will supply the real capture.

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
