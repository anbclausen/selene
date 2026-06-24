# TODO

One task = one commit. **Remove a task line the moment it's done** — don't tick
it, don't strike it through. Tasks are grouped by phase; within a phase they're
ordered highest-priority first.

---

## Phase 5 — Bundle (macOS only for now)

macOS-first: ship a working macOS installer before touching other platforms.
Windows and Linux come later (see Backlog).

`cargo tauri build` now produces `Selene.app` (~3.2 GB) with vendor/backend/core
bundled. It launches, but has the issues below.

- [ ] Enable logging in release builds (PREREQ for diagnosing the rest). The log plugin is gated on `cfg!(debug_assertions)`, so the packaged app is silent — write logs to a file (e.g. `~/Library/Logs/Selene/`) in release so backend boot/eval failures are visible.
- [ ] Built app: no sound on play. App boots and Play works, but nothing is audible. Likely a relocation issue exposed by running from Resources (sclang_conf `includePaths` still point at the repo; `tidal-ghc-env` points at `~/.cabal/store`; GHC `-B`/libdir; scsynth path) or an audio-output problem. Needs the release logs above to diagnose.
- [ ] Hide the SuperCollider (sclang) process from the Dock — it currently shows as a second app next to Selene. It's a spawned sidecar; suppress its Dock icon (LSUIElement/activation policy on the bundled SuperCollider.app, or launch sclang so it never registers a Dock presence).
- [ ] Distribution strategy: the fat 3.2 GB bundle vs a thin installer + first-run fetch. Samples MUST be fetched on first run regardless (licensing), so a first-run fetcher is needed either way. Likely hybrid: bundle the small relocation-sensitive bits (SuperCollider, quarks, sc3-plugins ≈ 700 MB), fetch the big/licensed bits on first run (samples; maybe GHC via a managed install to dodge relocation). Decide before investing in GHC relocation.
- [ ] GHC relocation (only if we keep GHC bundled): absolute paths are baked in — needs a ghci wrapper passing `-B` + a relocated package db, AND Tidal itself moved into the bundle (currently it lives in `~/.cabal/store`, referenced by absolute path in `tidal-ghc-env`). See the GHC-relocation memory note.
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
