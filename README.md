<p align="center">
  <img src="assets/logo.png" alt="Selene" width="250" />
  <h1 align="center">Selene</h1>
</p>

<p align="center">
  A single-installer live-coding music environment.<br>
      Simple. Declarative. Music as code.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0" /></a>
  <img src="https://img.shields.io/badge/status-early%20development-orange" alt="early development" />
</p>

---

## Showcase

<p align="center">
  <img src="assets/showcase.gif" alt="Selene in action — live coding with piano-roll and scope visuals (capture coming soon)" width="720" />
</p>

## What it is

Selene is a desktop app for composing music declaratively in Haskell. You describe patterns, rhythms, and harmony as code. It runs [TidalCycles](https://tidalcycles.org/), all bundled into a single installer.

No terminal. No package managers. No configuration. Open the app and start playing.

Selene is a **superset of TidalCycles**: every Tidal pattern works unchanged, plus a few Selene-specific helpers for arrangement and visuals (see below).

## Selene-specific functions

Everything that isn't stock Tidal. Visual markers are prefixed with `_` (Strudel-style) and are pure passthroughs — they never change the sound.

| Function | What it does |
| --- | --- |
| `arrange [(start, end, pattern), …]` | Lay patterns on a looping timeline so a track builds up over cycles (alias for `seqPLoop`). `resetCycles` restarts it from the top; the editor shows the total length. |
| `_pianoroll` | Show a scrolling piano roll for this channel — fixed centre playhead, past on the left, near-future on the right. |
| `_scope` | Show this channel's waveform (oscilloscope). |
| `duck n depth attack pattern` | Sidechain-style gain pump. Dips this pattern's gain to the floor `n` times per cycle and ramps back (`depth` 0..1 = dip amount, `attack` 0..1 = fraction of each pulse spent recovering, so smaller = snappier). An approximation of Strudel's `duck` — Tidal can't sidechain across orbits, so apply it to the layer you want ducked (bass/pads), not the kick. |
| `sawtooth` / `pulse` | Plain oscillator synths (`s "sawtooth"`, `s "pulse"`), filling the gap where SuperDirt ships `supersaw` but no bare saw/pulse. |
| `fm` / `fmh` / `lpenv` | Raw SuperDirt params (`pF` passthroughs) for FM index, FM harmonic ratio, and filter-envelope amount — the Strudel names, absent from stock Tidal. |
| `time` | Continuous signal of absolute cycle time (Strudel's `time`). Sweep a param as the track runs, e.g. `# fm time`. |
| `beat i n` | Play only on step `i` of an `n`-step cycle (Strudel `beat`). `beat 2 32` hits step 2 of 32. |
| `rib start len` | Freeze a `len`-cycle window from cycle `start` and loop it forever (Strudel `rib`/ribbon). `rib 46 1` pins one cycle of an otherwise per-cycle-random pattern. |

```haskell
resetCycles
d1 $ arrange
  [ (0, 16, sound "bd*4")
  , (8, 16, _pianoroll $ n "0 2 4 7" # sound "arpy")
  ]
d2 $ _scope $ sound "bd*4"
```

## Why

Writing music in Haskell normally means installing a Haskell toolchain, SuperCollider, SuperDirt, and wiring them together by hand. Selene ships everything preconfigured, so you can focus on the music.

## Development

Requires Rust, [GHCup](https://www.haskell.org/ghcup/) (for cabal), and [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
cargo tauri dev
```

GHC 9.6.7 and tidal 1.9.4 are fetched and vendored automatically on first run.

## Platforms

macOS only for now. Windows and Linux are planned later.

## Status

Early development, not yet functional. Follow along or contribute on [GitHub](https://github.com).

## License

GPL-3.0, see [LICENSE](LICENSE).
