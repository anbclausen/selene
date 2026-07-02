-- core/BootTidal.hs
-- Loaded into ghci at startup. Connects Tidal to SuperDirt on OSC :57120.
-- The Rust shell spawns: ghci -package-env vendor/tidal-ghc-env
--                              -ghci-script core/BootTidal.hs
-- Prints "SELENE_READY" when Tidal is up and accepting eval blocks.

:set -XOverloadedStrings
:set prompt ""
:set prompt-cont ""

import Sound.Tidal.Context

-- Two targets: the real SuperDirt on :57120, plus a read-only "tap" on :57121
-- that the Rust shell listens to for editor step-highlighting. The tap gets the
-- same SuperDirt-shaped messages; oHandshake is off since nothing replies there.
:{
tidal <- startStream (defaultConfig {cFrameTimespan = 1/20})
  [ (superdirtTarget {oLatency = 0.1, oAddress = "127.0.0.1", oPort = 57120}, [superdirtShape])
  , (superdirtTarget {oName = "selene-tap", oLatency = 0.1, oAddress = "127.0.0.1", oPort = 57121, oHandshake = False}, [superdirtShape])
  ]
:}

:{
let p           = streamReplace tidal
    hush        = streamHush tidal
    panic       = hush >> once (sound "superpanic")
    list        = streamList tidal
    mute        = streamMute tidal
    unmute      = streamUnmute tidal
    unmuteAll   = streamUnmuteAll tidal
    unsoloAll   = streamUnsoloAll tidal
    solo        = streamSolo tidal
    unsolo      = streamUnsolo tidal
    once        = streamOnce tidal
    first       = streamFirst tidal
    asap        = once
    nudgeAll    = streamNudgeAll tidal
    all         = streamAll tidal
    resetCycles = streamResetCycles tidal
    setCycle    = streamSetCycle tidal
    setcps      = streamOnce tidal . cps . pure
    getcps      = streamGetcps tidal
    getnow      = streamGetnow tidal
    xfade    i   = transition tidal True (Sound.Tidal.Transition.xfadeIn 4)   i
    xfadeIn  i t = transition tidal True (Sound.Tidal.Transition.xfadeIn t)   i
    histpan  i t = transition tidal True (Sound.Tidal.Transition.histpan t)   i
    wait     i t = transition tidal True (Sound.Tidal.Transition.wait t)      i
    waitT  i f t = transition tidal True (Sound.Tidal.Transition.waitT f t)   i
    jump     i   = transition tidal True  Sound.Tidal.Transition.jump         i
    jumpIn   i t = transition tidal True (Sound.Tidal.Transition.jumpIn t)    i
    jumpIn'  i t = transition tidal True (Sound.Tidal.Transition.jumpIn' t)   i
    jumpMod  i t = transition tidal True (Sound.Tidal.Transition.jumpMod t)   i
    jumpMod' i t p = transition tidal True (Sound.Tidal.Transition.jumpMod' t p) i
    mortal i lifespan release = transition tidal True (Sound.Tidal.Transition.mortal lifespan release) i
    interpolate    i   = transition tidal True  Sound.Tidal.Transition.interpolate      i
    interpolateIn  i t = transition tidal True (Sound.Tidal.Transition.interpolateIn t) i
    clutch   i   = transition tidal True  Sound.Tidal.Transition.clutch       i
    clutchIn i t = transition tidal True (Sound.Tidal.Transition.clutchIn t)  i
    anticipate   i   = transition tidal True  Sound.Tidal.Transition.anticipate      i
    anticipateIn i t = transition tidal True (Sound.Tidal.Transition.anticipateIn t) i
    forId    i t = transition tidal False (Sound.Tidal.Transition.wait t)     i
    d1  = p 1  . (|< orbit 0)
    d2  = p 2  . (|< orbit 1)
    d3  = p 3  . (|< orbit 2)
    d4  = p 4  . (|< orbit 3)
    d5  = p 5  . (|< orbit 4)
    d6  = p 6  . (|< orbit 5)
    d7  = p 7  . (|< orbit 6)
    d8  = p 8  . (|< orbit 7)
    d9  = p 9  . (|< orbit 8)
    d10 = p 10 . (|< orbit 9)
    d11 = p 11 . (|< orbit 10)
    d12 = p 12 . (|< orbit 11)
    d13 = p 13 . (|< orbit 12)
    d14 = p 14 . (|< orbit 13)
    d15 = p 15 . (|< orbit 14)
    d16 = p 16 . (|< orbit 15)
:}

-- Selene visualisation markers — passthrough (id), detected by the editor UI.
-- Prefixed with `_` (Strudel-style) to mark them as visual-only no-ops.
-- Usage: d1 $ _pianoroll $ note "c3 e3 g3" # sound "arpy"
--        d1 $ _scope $ sound "bd*4"   -- waveform of this channel's orbit
:{
let _pianoroll = id
    _scope = id
:}

-- Arrangement: lay patterns out on a timeline of (startCycle, endCycle, pattern)
-- and loop the whole thing. Lets a track build up over cycles, e.g.
--   d1 $ arrange [ (0, 8, s "bd*4"), (4, 8, s "hh*8") ]
-- `resetCycles` first to (re)start it from the top. Eta-expanded to dodge the
-- monomorphism restriction so it stays polymorphic over the pattern type.
:{
let arrange xs = seqPLoop xs
:}

-- Sidechain-style gain pump (Selene). True cross-orbit sidechaining (Strudel's
-- `duck`, which ducks *other* orbits when this one triggers) can't be expressed
-- in Tidal, so this approximates it: it dips the gain of the pattern it's called
-- on `n` times per cycle and ramps back, giving the pumping feel. Apply it to the
-- layer you want ducked (bass/pads), not the kick.
--   n      = pumps per cycle (line up with the kick, e.g. 4)
--   depth  = how deep the dip, 0..1 (0.8 = drop to 20% at each pulse onset)
--   attack = recovery width, 0..1 = fraction of each pulse spent ramping back up
--            (0.1 = snappy/short duck, 0.9 = long duck). Gain hits the floor at
--            every pulse onset, then ramps linearly to full over `attack`.
-- Gain is sampled per event onset (no intra-note sweep), which suits busy
-- patterns like an acid bass. e.g.  d1 $ duck 4 0.8 0.5 $ n "0 3 5 7" # s "sawtooth"
:{
let duck n depth attack pat =
      pat |* gain (range (1 - depth) 1 (min 1 <$> (fast n saw / attack)))
:}

-- Strudel-port helpers (Selene). Controls Strudel exposes that stock Tidal
-- doesn't, plus two pattern combinators. Documented in README.
--   fm/fmh/lpenv : raw SuperDirt params (pF passthrough) — FM index, FM
--                  harmonic ratio, and filter-envelope amount.
--   time         : continuous signal of absolute cycle time (Strudel's `time`),
--                  for sweeping a param as the track runs, e.g. `# fm time`.
--   beat i n     : play only on step `i` of an `n`-step cycle (Strudel `beat`).
--   rib start len: freeze a `len`-cycle window starting at cycle `start` and
--                  loop it forever (Strudel `rib`/ribbon). `rib 46 1` pins one
--                  cycle of an otherwise per-cycle-random pattern. Built from
--                  the loop-first-n idiom `_slow n . loopFirst . _fast n`.
:{
let fm    = pF "fm"
    fmh   = pF "fmh"
    lpenv = pF "lpenv"
    time  = sig realToFrac :: Pattern Double
    beat i n = struct (listToPat [k == i | k <- [0 .. n - 1]])
    rib start len = _slow len . loopFirst . _fast len . rotL start
:}

:{
let getState = streamGet tidal
    setI = streamSetI tidal
    setF = streamSetF tidal
    setS = streamSetS tidal
    setR = streamSetR tidal
    setB = streamSetB tidal
:}

-- stdout is a pipe (not a TTY) under the Rust shell, so GHC block-buffers it by
-- default — the ready line and later eval echoes would stall. Force line
-- buffering so each line flushes immediately for the shell to read.
System.IO.hSetBuffering System.IO.stdout System.IO.LineBuffering
System.IO.hSetBuffering System.IO.stderr System.IO.LineBuffering

putStrLn "SELENE_READY"

:set prompt "tidal> "
