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
  s.options.numBuffers           = 1024 * 256;
  s.options.memSize              = 8192 * 32;
  s.options.numWireBufs          = 2048;
  s.options.maxNodes             = 1024 * 32;
  s.options.numOutputBusChannels = 2;
  s.options.numInputBusChannels  = 2;

  // ── Boot ────────────────────────────────────────────────────────────────────
  s.waitForBoot {
    ~dirt = SuperDirt(2, s);

    // Load samples: use SELENE_SAMPLES_PATH env var if set (Phase 5),
    // otherwise fall back to SuperDirt's bundled default.
    if (Platform.getenv("SELENE_SAMPLES_PATH").notNil) {
      ~dirt.loadSoundFiles(Platform.getenv("SELENE_SAMPLES_PATH") ++ "/*");
    } {
      ~dirt.loadSoundFiles;
    };

    s.sync;

    // Start SuperDirt on OSC port 57120, 12 orbits
    ~dirt.start(57120, 0 ! 12);

    // Orbit shortcuts ~d1..~d12
    ~dirt.orbits.do { |orbit, i|
      currentEnvironment.put(("d" ++ (i + 1)).asSymbol, orbit);
    };

    // Signal readiness to the Rust shell
    "SELENE_READY".postln;
  };
)
