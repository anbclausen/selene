// backend/startup.scd
// Boots scsynth + SuperDirt, listens on OSC :57120.
// Run headlessly: sclang -D backend/startup.scd
//
// Phase 1: relies on system SC + SuperDirt install.
// Phase 5: SC ships as sidecar; SELENE_SAMPLES_PATH set by Rust shell.
//
// Ready signal: prints "SELENE_READY" to stdout when SuperDirt is up.
// The Rust shell waits for this exact line before spawning ghci.

(
  s = Server.local;

  // ── Server options ──────────────────────────────────────────────────────────

  // Hermetic UGen plugins: pin scsynth's plugin search path to ONLY the app's
  // bundled plugins (Platform.resourceDir is relocatable — points inside our
  // vendored SuperCollider.app), plus our vendored sc3-plugins dir if the Rust
  // shell points us at it (SELENE_SC3_PLUGINS_PATH — kept outside the signed
  // .app, which macOS won't let us write into). Overrides scsynth's default
  // search, which would otherwise scan the user's global ~/Library/.../Extensions
  // and spam dlopen errors on AppleDouble (._*.scx) junk. The sclang_conf
  // excludePaths is the class-library equivalent; this is the server-side one.
  ~seleneSc3p = "SELENE_SC3_PLUGINS_PATH".getenv;
  s.options.ugenPluginsPath = if(~seleneSc3p.notNil) {
    [Platform.resourceDir +/+ "plugins", ~seleneSc3p]
  } {
    [Platform.resourceDir +/+ "plugins"]
  };

  s.options.numBuffers           = 1024 * 256;
  s.options.memSize              = 8192 * 32;
  s.options.numWireBufs          = 2048;
  s.options.maxNodes             = 1024 * 32;
  s.options.numOutputBusChannels = 2;

  // No audio input. SuperDirt only produces sound; the visuals tap its output
  // bus, not the mic. Disabling input avoids scsynth failing to boot when the
  // default input device's sample rate differs from the output's (e.g. AirPods
  // mic at 24 kHz vs 48 kHz output — "could not initialize audio", server exits).
  s.options.numInputBusChannels  = 0;

  // Output device: the editor's Settings picker persists a choice that the Rust
  // shell passes as SELENE_OUTPUT_DEVICE. Empty/unset = system default.
  ~seleneDev = "SELENE_OUTPUT_DEVICE".getenv;
  if(~seleneDev.notNil and: { ~seleneDev != "" }) { s.options.outDevice = ~seleneDev };

  // Report the available output devices to the editor (tab-separated; names
  // contain spaces). One line: "SELENE_DEVICES name<TAB>name…".
  ("SELENE_DEVICES " ++ ServerOptions.outDevices.join("\t")).postln;

  // ── Boot ────────────────────────────────────────────────────────────────────
  s.waitForBoot {
    ~dirt = SuperDirt(2, s);

    // Load samples: use SELENE_SAMPLES_PATH env var if set (Phase 5),
    // otherwise fall back to SuperDirt's bundled default.
    if ("SELENE_SAMPLES_PATH".getenv.notNil) {
      ~dirt.loadSoundFiles("SELENE_SAMPLES_PATH".getenv ++ "/*");
    } {
      ~dirt.loadSoundFiles;
    };

    // ── Selene custom oscillators ───────────────────────────────────────────
    // Plain raw waveforms so Strudel-style `s "sawtooth"` / `s "pulse"` resolve:
    // SuperDirt ships `supersaw` but no bare sawtooth/pulse. Filtering (cutoff/
    // resonance), fm, and envelope shaping are layered on by SuperDirt's effects
    // and Selene params; these just emit the oscillator. Reported to the sound
    // browser via ~seleneSynths below (they don't match the `super*` convention).
    ~seleneSynths = [\sawtooth, \pulse];

    SynthDef(\sawtooth, { |out, sustain = 1, freq = 440, speed = 1, pan, accelerate|
      var env = EnvGen.ar(Env.linen(0.01, sustain, 0.01, 1, -3), doneAction: 2);
      var rate = freq * (speed + Sweep.kr(1, accelerate));
      Out.ar(out, DirtPan.ar(Saw.ar(rate), ~dirt.numChannels, pan, env));
    }).add;

    SynthDef(\pulse, { |out, sustain = 1, freq = 440, speed = 1, pan, accelerate, width = 0.5|
      var env = EnvGen.ar(Env.linen(0.01, sustain, 0.01, 1, -3), doneAction: 2);
      var rate = freq * (speed + Sweep.kr(1, accelerate));
      Out.ar(out, DirtPan.ar(Pulse.ar(rate, width), ~dirt.numChannels, pan, env));
    }).add;

    s.sync;

    // Start SuperDirt on OSC port 57120, 12 orbits
    ~dirt.start(57120, 0 ! 12);

    // Orbit shortcuts ~d1..~d12
    ~dirt.orbits.do { |orbit, i|
      currentEnvironment.put(("d" ++ (i + 1)).asSymbol, orbit);
    };

    // Report the loaded sample banks to the Rust shell, which forwards them to
    // the editor's sound browser. One line: "SELENE_SAMPLES name:count name:count..."
    // (~dirt.buffers maps \bankName -> Array of Buffers; size = sample count.)
    ("SELENE_SAMPLES " ++
      ~dirt.buffers.keys.asArray.collect({ |name|
        name ++ ":" ++ ~dirt.buffers[name].size
      }).join(" ")
    ).postln;

    // Report the playable synths too (everything named super*, the SuperDirt
    // convention) so the sound browser can list them alongside the samples.
    ("SELENE_SYNTHS " ++
      (SynthDescLib.global.synthDescs.keys.asArray
        .collect(_.asString)
        .select({ |n| n.beginsWith("super") })
        ++ ~seleneSynths.collect(_.asString)
      ).asSet.asArray.sort.join(" ")
    ).postln;

    // ── Per-orbit waveform scope (read-only audio tap) ──────────────────────
    // Each orbit gets a reader synth that records its (dry + effect-send) signal
    // into a small ring buffer. A clock streams the latest frame to the editor
    // via the OSC tap (:57121) as "/scope orbit s0 s1 …". The synth ONLY reads
    // buses and writes to its own buffer — it never touches an audio output, so
    // it cannot affect the sound. The reader group sits at the tail of the
    // default group, after SuperDirt's nodes, so the buses are already filled.
    SynthDef(\selene_scope, { |dryBus, fxBus, scopeBuf|
      var sig = Mix(In.ar(dryBus, ~dirt.numChannels))
              + Mix(In.ar(fxBus, ~dirt.numChannels));
      RecordBuf.ar(sig, scopeBuf, loop: 1, run: 1);
    }).add;
    s.sync;

    ~seleneScopeFrames = 256;
    ~seleneScopeAddr = NetAddr("127.0.0.1", 57121);
    ~seleneScopeGroup = Group.tail(s.defaultGroup);
    ~seleneScopeBufs = ~dirt.orbits.collect { |orbit, i|
      var buf = Buffer.alloc(s, ~seleneScopeFrames, 1);
      Synth(\selene_scope, [
        \dryBus, orbit.dryBus, \fxBus, orbit.globalEffectBus, \scopeBuf, buf
      ], ~seleneScopeGroup, \addToTail);
      buf;
    };
    s.sync;

    // Stream the latest frame of every orbit at ~30 fps. The editor draws only
    // the orbits whose channel has `scope` active, so streaming all is cheap.
    Routine({
      loop {
        ~seleneScopeBufs.do { |buf, i|
          buf.getn(0, ~seleneScopeFrames, { |data|
            ~seleneScopeAddr.sendMsg("/scope", i, *data);
          });
        };
        (1/30).wait;
      };
    }).play;

    // Signal readiness to the Rust shell
    "SELENE_READY".postln;
  };
)
