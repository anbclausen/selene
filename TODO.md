# TODO

New here? Read `AGENTS.md` first (conventions). Key ones: one task = one commit;
commit messages are ONE short line (no body, no Claude co-author trailer); never
run the app — verify via `cargo check` / `npm run build`, the user runs it; pin
all vendored deps. **Remove a task line the moment it's done.** Tasks are grouped
by phase; within a phase they're ordered highest-priority first.

State of the world: the editor is feature-complete for now (CodeMirror + Tidal
eval, transport, `_pianoroll`/`_scope` visuals, `arrange`, sound browser with
synths, VS Code keybindings, settings modal). `cargo tauri build` produces a
runnable macOS `Selene.app` (~3.2 GB, vendor/backend/core bundled) that plays
synths + samples on the build machine (samples via a repo fallback). Release
logs: `~/Library/Logs/app.selene/`. Rebuilding needs the old bundle cleared
first: `chflags -R nouchg target/release/bundle 2>/dev/null; rm -rf target/release/bundle`.

---

## Phase 5 — Bundle (macOS only for now)

macOS-first: ship a working macOS installer before touching other platforms.
Windows and Linux come later (see Backlog).

Distribution strategy: **hybrid** (decided). Bundle the relocation-sensitive bits
(SuperCollider, quarks, sc3-plugins, GHC ≈ 700 MB+); fetch the big/licensed bits
on first run (Dirt-Samples — already done via `ensure_samples`).

- [ ] CI: `.github/workflows/` build + package the macOS `.dmg` and publish it to a GitHub Release. NOTE: until GHC relocation lands, the produced `.dmg` only runs on a machine whose `~/.cabal/store` path matches the runner's (Tidal's package env is absolute) — the pipeline is real, the artifact isn't user-portable yet.
- [ ] GHC relocation: absolute paths are baked in — needs a ghci wrapper passing `-B` + a relocated package db, AND Tidal itself moved into the bundle (it currently lives in `~/.cabal/store`, referenced by absolute path in `vendor/tidal-ghc-env`). See the GHC-relocation memory note. Without this the bundle only runs on the build machine.
- [ ] Smoke-test the installer on a clean macOS VM before any release tag (proves relocation/fetch actually work off the build machine).
- [ ] Import-sample button: open a file/folder picker and copy the chosen samples into an internal, git-ignored samples folder under a category (a new bank folder). Reload SuperDirt's `loadSoundFiles` so they show up in the sound browser. Add the internal folder to `.gitignore`.

## Bugs

- [ ] Step highlighting mis-tracks pitched patterns. Eval `note "0 4 7" # s
  "sawtooth"` (audio is correct, arpeggiates 0-4-7): the editor's step
  highlighter lights `0`, `4`, then `4` again instead of `0 4 7` — looks like an
  off-by-one / wrong source-position mapping on the last step. Lives in the
  `tidal-event` OSC stream → editor highlight path (`osc.rs` tap + `main.ts`),
  not in the synths. Check whether it also mistracks plain `s "bd sn hh"`.

## Phase 6 — Recording (deferred)

- [ ] OSC session logger in `core/` — capture/replay via the existing OSC seam.
- [ ] WAV export: with the cursor on an `arrange` block, a Render button (or Cmd-R) bounces the track to WAV — reset the cycle clock, play for the arrangement's duration, capture scsynth's output via its recording OSC API (`/b_alloc`, `/b_read`, `/b_write` or the `Record` quark). No separate DAW.

## Backlog (optional / unscheduled)

- [ ] `ur`-style named-section arranger, if the `arrange` tuple form proves clunky for longer tracks.
- [ ] Windows bundle: package the sidecars + resolve resource paths; add to CI; smoke-test on a clean VM.
- [ ] Linux bundle: same.
- [ ] Hide the sclang Dock icon (cosmetic; parked). Findings: sclang is a Qt cocoa app, so it shows a Dock icon. Clean routes are blocked — the vendored Qt has no `offscreen`/`minimal` platform plugin (so `QT_QPA_PLATFORM=offscreen` fails), and `LSUIElement` on SuperCollider.app's Info.plist can't be written (macOS App Management protects the signed bundle; the user doesn't want SC.app modified anyway). Viable path: a thin "agent" `.app` we own (our Info.plist with `LSUIElement`, a copied `sclang` binary, symlinks to SC's Frameworks/Resources/PlugIns) launched instead of SC.app — fiddly, needs on-device iteration.

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
