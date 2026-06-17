<p align="center">
  <img src="assets/logo.png" alt="Selene" width="350" />
</p>

<h1 align="center">selene</h1>

<p align="center">
  A single-installer live-coding music environment.<br>
      Simple. Declarative. Music as code.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0" /></a>
  <img src="https://img.shields.io/badge/status-early%20development-orange" alt="early development" />
</p>

---

## What it is

Selene is a desktop app for composing music declaratively in Haskell. You describe patterns, rhythms, and harmony as code. It runs [TidalCycles](https://tidalcycles.org/), all bundled into a single installer.

No terminal. No package managers. No configuration. Open the app and start playing.

## Why

Writing music in Haskell normally means installing a Haskell toolchain, SuperCollider, SuperDirt, and wiring them together by hand. Selene ships everything preconfigured, so you can focus on the music.

## Development

Requires Rust, [GHCup](https://www.haskell.org/ghcup/) (for cabal), and [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
cargo tauri dev
```

GHC 9.6.7 and tidal 1.9.4 are fetched and vendored automatically on first run.

## Status

Early development, not yet functional. Follow along or contribute on [GitHub](https://github.com).

## License

GPL-3.0, see [LICENSE](LICENSE).
