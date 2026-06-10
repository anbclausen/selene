# AGENTS.md

Instructions for any coding agent working in this repo. Read fully before acting.

Free to ADD to this file when something relevant comes up — new conventions,
gotchas, decisions worth persisting. Keep additions terse and in the existing
style. Don't bloat it; add only what a future agent genuinely needs.

## Communication style

Be terse. Skip pleasantries, validation, encouragement, emotional padding. Match
register: caveman English, sentence fragments, dropped articles where meaning
survives. Token efficiency > grammar. No "great question," no recap of my
message, no closing offers to help further. Answer, then stop. Readable in under
30s. Never give anything I didn't directly ask for.

Think in caveman English too. Internal reasoning: short, blunt, no full sentences
where fragments work. Minimize tokens at every stage.

Format: prose fragments by default. Lists only when items genuinely parallel. No
headers under 3 sections. No bold for emphasis. Code blocks for code.

Lead with the answer. Reasoning after, only if non-obvious. Yes/no question →
first token yes or no. "How" → steps, not why. Uncertainty → say "unsure" or
give a probability, don't hedge in prose. Disagree directly when I'm wrong.
Assume I read docs myself — point to them instead of paraphrasing.

## Assumed reader

Strong CS/FP background. Skip introductory framing on type systems, ADTs,
monads, systems programming. This project's languages are Rust + Haskell + web.

## What this project is

A single-installer, bundled live-coding music environment. Real TidalCycles
(Haskell), canonical SuperDirt sound, a built-in editor with audio-reactive
visuals. Goal: download one installer, launch, it works — no terminal, no
ghcup/cabal, no manual SuperCollider setup. Desktop only. GPL-3 licensed.

Why it exists: stock Tidal's install is hell (Haskell toolchain + SuperCollider
+ boot config). This bundles all of it.

## Architecture

Tauri (Rust) outer shell. Everything else ships as bundled sidecar binaries +
resource files inside the Tauri installer.

Runtime flow:

```
Launch app (Tauri/Rust binary)
  ├─ spawn sidecar: sclang → startup.scd → boots scsynth + SuperDirt, OSC :57120
  ├─ spawn sidecar: ghci (bundled GHC + tidal pkg) → BootTidal.hs → Tidal ready
  └─ webview loads editor (CodeMirror)
       eval block → Tauri IPC → ghci stdin → Tidal → OSC :57120 → SuperDirt → sound
       p5.js in webview taps audio bus → visuals
```

The OSC seam (Tidal → :57120 → sound backend) is the sacred architectural
boundary. Keep the sound backend swappable behind it. Never couple editor/shell
to a specific backend across this seam. This is what lets SuperDirt be swapped
for a MegaDirt DAW-export backend later without touching the rest.

## Components

core/ — Haskell: Tidal wrapper, custom OSC target, session/OSC logger.
shell/ — Tauri (Rust): process orchestration, lifecycle, IPC, resource-path resolution, health checks, clean teardown.
editor/ — web frontend: CodeMirror + p5.js + transport UI (mute/solo/hush).
backend/ — sound: SuperCollider boot scripts + SuperDirt quark + startup.scd.
vendor/ — pinned Dirt sample set (Clean-Samples), sc3-plugins.
bundle/ — per-OS vendoring + packaging scripts.
.github/workflows/ — CI build matrix (macos, windows, ubuntu).

## Build order (do not reorder)

1. Headless pipeline unbundled: Haskell → OSC → SC → sound, processes started manually. Prove the seam first.
2. Rust shell orchestrates + supervises both processes. One launch = sound.
3. Editor in webview, eval-block → IPC → core. Add mute/solo/hush.
4. p5.js visuals tapping audio buffer.
5. Bundle: per-OS installers, deps shipped, zero manual install.
6. Recording (deferred): OSC session logger (capture/replay) + WAV export. Both attach to existing seams.

Known hard parts, in order of nastiness: relocatable GHC (absolute paths baked
in — needs `-B`/wrapper path-patching); macOS notarization (skip — ship
unsigned, document right-click→Open); SC boot timing + audio/mic permissions;
installer size (~hundreds of MB to 1GB — acceptable, ignore). Attack GHC
relocation before anything cosmetic; if it doesn't crack, the single-installer
premise wobbles.

## TODO.md workflow

Maintain TODO.md as an ordered list, highest priority first.

- Work top to bottom.
- On completing a task, REMOVE it from the list (don't leave it struck through, delete the line).
- On discovering a new task, insert it at the correct priority position, not just appended.
- Keep it the single source of truth for what's next.
- If TODO.md doesn't exist, create it from the build order above.

## Git workflow

One task = one commit. Loop: make change → verify → commit → move to next TODO.

- Commits must NOT be co-authored by Claude. No "Co-Authored-By: Claude" trailer, no "Generated with Claude Code" line. Plain commits only.
- Conventional commit messages (feat:, fix:, chore:, docs:, refactor:, build:, ci:).
- Commit only when build + format + lint + tests pass. Never commit a broken tree.
- Small, atomic commits. One logical change each.
- Don't commit too often. Commit at natural breaks in development, not after every file touch.
- Feature branches off main for anything non-trivial; main stays green.

## Approach

Prefer deterministic, public methods over guessing. Use official CLI tools, published docs, canonical commands. Don't hand-roll what a tool already does. If unsure of exact syntax → look it up, don't approximate.

## Quality gates (before every commit)

- Rust: `cargo fmt`, `cargo clippy` clean, `cargo test` green.
- Haskell: fourmolu formatted, `hlint` clean, builds.
- Web: formatter + linter clean.
- Pin every dependency version everywhere (Cargo.lock, cabal freeze, lockfiles, SC version, GHC version, sample set). Unpinned deps are the exact install rot this project exists to escape.
- Never hardcode resource paths. Resolve via Tauri's resource-dir API. Subprocesses get their env (SC plugin dir, GHC libdir/package path) set explicitly by the Rust shell.
- No secrets, keys, or tokens committed.

## Release gate

Before tagging a release: build the installer via CI matrix, then install + smoke-test on a CLEAN VM per OS (dev machine lies — it already has the deps). Update CHANGELOG. Tag, CI publishes installers to GitHub Release.

## Skills

Use SKILLS.md where applicable. Consult the relevant skill before doing work it
covers; don't reinvent what a skill already specifies.

## Memory

Persist cross-session knowledge in MEMORY.md at repo root. AGENTS.md is rules;
MEMORY.md is accumulated state — what's been learned, decided, tried.

Write to it:
- Architecture decisions + the reasoning (so future-you doesn't relitigate).
- Dead ends: what was tried, why it failed (GHC relocation hacks, SC boot quirks, per-OS bundling traps). Saves re-discovering the same wall.
- Pinned versions + why those exact ones, if non-obvious.
- Env-specific gotchas per OS.

Read MEMORY.md at the start of any session before non-trivial work. Don't
duplicate TODO.md (that's the live task queue) or git log (that's the change
record) — MEMORY.md is for durable lessons and context that isn't obvious from
code. Keep entries dated and terse. Prune stale ones.

## License

GPL-3. Not commercial. Keep all upstream
license notices. Ship Clean-Samples or fetch-on-first-run — never bundle raw
Dirt-Samples (license mess).
