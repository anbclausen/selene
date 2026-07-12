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

- [ ] Verify the thin-installer release (tag pushed after the 832 MB fat dmg on v0.1.3): CI green, small `.dmg` + `selene-runtime-aarch64.tar.gz` both on the draft release, then publish the draft (the README badge points at `releases/latest`, which ignores drafts). Delete the dead v0.1.0–v0.1.2 tags/drafts while at it.
- [ ] Smoke-test on a clean arm64 macOS machine: install the thin `.dmg`, confirm first-run fetch (runtime ~380 MB + samples), then sound. Verified locally via simulation (tarball extracted to /tmp: sclang resolves classes, ghci boots Tidal) — this is the real-machine confirmation.
- [ ] Import-sample button — IN PROGRESS. Done: `backend/startup.scd` now defines `~seleneReportSamples` + `~seleneLoadBank path` (loads one bank folder then re-reports), and loads persisted banks from `SELENE_USER_SAMPLES_PATH/*` at boot. Remaining: (1) `sidecar.rs` — set `SELENE_USER_SAMPLES_PATH` env in `spawn_superdirt` to an app-data `user-samples/` dir, and add a copy helper (chosen folder → `user-samples/<bankname>/`, audio files only). (2) `lib.rs` — `import_samples(src)` command: copy via the helper, then `send` `~seleneLoadBank.value("<dest>");` to the superdirt sidecar's stdin (verified: sclang evals a plain `\n`-terminated line); browser refreshes off the re-reported `samples-loaded`. (3) frontend — an Import button in `.sb-header` (index.html + style.css) that calls `dialogOpen({directory:true})` then `invoke("import_samples",{src})`. Note: internal dir lives in app-data (writable in a bundled app), NOT the repo, so no `.gitignore` change needed — deviates from the original task line's "git-ignored" wording on purpose.

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
