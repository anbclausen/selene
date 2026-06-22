# TODO

One task = one commit. **Remove a task line the moment it's done** — don't tick
it, don't strike it through. Tasks are grouped by phase; within a phase they're
ordered highest-priority first.

---

## Phase 5 — Bundle (macOS only for now)

macOS-first: ship a working macOS installer before touching other platforms.
Windows and Linux come later (see Backlog).

- [ ] macOS bundle. Resource-path resolution is done (sidecar.rs resolves vendor/backend/core via the Tauri resource dir in release, repo root in dev). Remaining: declare `bundle.resources` in tauri.conf so vendor/backend/core ship in the .app; **GHC relocation** (absolute paths baked in — needs a ghci wrapper passing `-B` + a relocated package db; see the GHC-relocation memory note); sclang/scsynth already relocatable inside SuperCollider.app. Needs real `cargo tauri build` + install iteration — not verifiable from build/check alone.
- [ ] CI: `.github/workflows/` build + package on macOS.
- [ ] Smoke-test the installer on a clean macOS VM before any release tag.
- [ ] Import-sample button: open a file/folder picker and copy the chosen samples into an internal, git-ignored samples folder under a category (a new bank folder). Reload SuperDirt's `loadSoundFiles` so they show up in the sound browser. Add the internal folder to `.gitignore`.

## Phase 6 — Recording (deferred)

- [ ] OSC session logger in `core/` — capture/replay via the existing OSC seam.
- [ ] WAV export: with the cursor on an `arrange` block, a Render button (or Cmd-R) bounces the track to WAV — reset the cycle clock, play for the arrangement's duration, capture scsynth's output via its recording OSC API (`/b_alloc`, `/b_read`, `/b_write` or the `Record` quark). No separate DAW.

## Backlog (optional / unscheduled)

- [ ] Strudel demo port — needs the Phase 5 synths (`sawtooth`/`supersaw`/`pulse`), so do it after the bundle. Showcases `_scope`, `_pianoroll`, sidechain ducking, a minor-scale acid bass. NO sliders — replace `slider(x,…)` with the fixed value `x`.
  ```
  $kick: s("sbd!4")._scope().duck("2:3:4").duckattack(.2).duckdepth(.8)
  $bass: n(irand(10).sub(7).seg(16)).scale("c:minor").rib(46,1)
    .distort("2.2:.3").s("sawtooth").lpf(200).lpenv(3.376).lpq(12).orbit(2)._pianoroll()
  $saw: s("supersaw").detune(1).rel(6).beat(2, 32).slow(2).orbit(2).fm("2").fmh(1.04)
  $rising: s("pulse").orbit(4).seg(16).dec(.1).fm(time).fmh(time).lpf(500).lpenv(3.008)
  ```
  Unknowns: `duck`/`duckattack`/`duckdepth` (sidechain) has no stock Tidal form — define a Selene helper or approximate (LFO/`whenmod` on gain). Map `.sub`→`|- `, `.seg`→`segment`, `.rib`→`zoom`/loop window, `lpenv`→filter-env control; confirm each exists in Tidal 1.9.4 first.
- [ ] `ur`-style named-section arranger, if the `arrange` tuple form proves clunky for longer tracks.
- [ ] Windows bundle: package the sidecars + resolve resource paths; add to CI; smoke-test on a clean VM.
- [ ] Linux bundle: same.

---

## Conventions (reference, not tasks)

- **Visuals** are opt-in and `_`-prefixed (Strudel-style). Each is defined as `id`
  in `core/BootTidal.hs` (pure passthrough, no audio effect); the editor detects
  the marker on an evaluated `dN` block and renders a per-channel canvas in the
  viz panel, fed by the `tidal-event` / `scope-frame` OSC streams. Plain Canvas
  2D, zero-dep — do NOT use `@strudel/draw` (AGPL-3, and it needs a JS Pattern
  object we don't have since Tidal runs in Haskell).
- **Selene-specific functions** (anything not stock Tidal) must be documented in
  the README's "Selene-specific functions" section when added.
