-- core/BootTidal.hs
-- Loaded into ghci at startup. Connects Tidal to SuperDirt on OSC :57120.
-- The Rust shell spawns: ghci -package-env vendor/tidal-ghc-env
--                              -ghci-script core/BootTidal.hs
-- Prints "SELENE_READY" when Tidal is up and accepting eval blocks.

:set -XOverloadedStrings
:set prompt ""
:set prompt-cont ""

import Sound.Tidal.Context

tidal <- startTidal (superdirtTarget {oLatency = 0.1, oAddress = "127.0.0.1", oPort = 57120}) (defaultConfig {cFrameTimespan = 1/20})

:{
let p           = streamReplace tidal
    hush        = streamHush tidal
    nudgeAll    = streamNudgeAll tidal
    all         = streamAll tidal
    resetCycles = streamResetCycles tidal
    mute        = streamMute tidal
    unmute      = streamUnmute tidal
    unmuteAll   = streamUnmuteAll tidal
    solo        = streamSolo tidal
    unsolo      = streamUnsolo tidal
    unsoloAll   = streamUnsoloAll tidal
    xfade    i   = transition tidal True (Sound.Tidal.Transition.xfadeIn 4)   i
    xfadeIn  i t = transition tidal True (Sound.Tidal.Transition.xfadeIn t)   i
    jumpIn   i t = transition tidal True (Sound.Tidal.Transition.jumpIn t)    i
    jumpIn'  i t = transition tidal True (Sound.Tidal.Transition.jumpIn' t)   i
    jumpMod  i t = transition tidal True (Sound.Tidal.Transition.jumpMod t)   i
    clutch   i   = transition tidal True  Sound.Tidal.Transition.clutch       i
    clutchIn i t = transition tidal True (Sound.Tidal.Transition.clutchIn t)  i
    anticipate   i   = transition tidal True  Sound.Tidal.Transition.anticipate      i
    anticipateIn i t = transition tidal True (Sound.Tidal.Transition.anticipateIn t) i
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
:}

-- stdout is a pipe (not a TTY) under the Rust shell, so GHC block-buffers it by
-- default — the ready line and later eval echoes would stall. Force line
-- buffering so each line flushes immediately for the shell to read.
System.IO.hSetBuffering System.IO.stdout System.IO.LineBuffering
System.IO.hSetBuffering System.IO.stderr System.IO.LineBuffering

putStrLn "SELENE_READY"

:set prompt "tidal> "
