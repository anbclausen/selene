mod sidecar;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::Manager;

use sidecar::Sidecar;

/// Backends supervised for the app's lifetime. Dropped (killed) on exit.
#[derive(Default)]
struct Backends {
    superdirt: Mutex<Option<Sidecar>>,
    tidal: Mutex<Option<Sidecar>>,
    /// Set once the app starts tearing down. The boot thread may still be
    /// spawning backends at that point; it checks this (under the slot lock)
    /// before stashing so a late spawn can't outlive the exit handler.
    shutting_down: AtomicBool,
}

impl Backends {
    /// Stash a freshly-spawned backend into `slot`, or — if we're already
    /// shutting down — drop it immediately (which kills it). Checked under the
    /// slot lock so it can't race the exit handler draining the same slot.
    /// Returns whether the sidecar was stored.
    fn stash(&self, slot: &Mutex<Option<Sidecar>>, sc: Sidecar) -> bool {
        let mut guard = slot.lock().unwrap();
        if self.shutting_down.load(Ordering::SeqCst) {
            return false; // sc dropped here -> killed
        }
        *guard = Some(sc);
        true
    }
}

/// Send a code block from the editor to the running Tidal/ghci backend.
/// Errors (backend not up, broken pipe) come back to the webview as a string.
#[tauri::command]
fn eval(code: String, backends: tauri::State<Backends>) -> Result<(), String> {
    match backends.tidal.lock().unwrap().as_mut() {
        Some(tidal) => tidal.send_block(&code).map_err(|e| e.to_string()),
        None => Err("Tidal backend is not running".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backends::default())
        .invoke_handler(tauri::generate_handler![eval])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Boot the backends off the setup thread so the window appears
            // immediately — readiness waits can take seconds, and we must never
            // stall the UI thread on them.
            let handle = app.handle().clone();
            std::thread::spawn(move || boot_backends(&handle));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tear down on BOTH events: window close fires ExitRequested, but the
            // macOS app-menu Quit (Cmd+Q) can skip straight to Exit — handling
            // only ExitRequested would orphan scsynth on Cmd+Q. teardown is
            // idempotent (kill() guards on an `intentional` flag), so running it
            // on whichever fires (or both) is safe.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // Flag first (stops the boot thread resurrecting a backend),
                // then drain both slots — Tidal (pattern producer) before the
                // sound backend.
                let backends: tauri::State<Backends> = app.state();
                backends.shutting_down.store(true, Ordering::SeqCst);
                *backends.tidal.lock().unwrap() = None;
                *backends.superdirt.lock().unwrap() = None;
            }
        });
}

/// Boot SuperDirt, then ghci/Tidal gated on it. Each backend is stashed into
/// shared state *before* we block on its ready signal, so the exit handler can
/// always kill it — even if the user quits mid-boot. Failures are logged, not
/// fatal; the editor still loads and surfaces the missing seam.
fn boot_backends(app: &tauri::AppHandle) {
    let backends: tauri::State<Backends> = app.state();

    // SuperDirt first.
    let (sc, ready) = match sidecar::spawn_superdirt(app) {
        Ok(pair) => pair,
        Err(e) => return log::error!("failed to spawn SuperDirt: {e}"),
    };
    if !backends.stash(&backends.superdirt, sc) {
        return; // shutting down
    }
    if sidecar::wait_ready("sclang", &ready).is_err() {
        *backends.superdirt.lock().unwrap() = None; // timed out -> kill
        return;
    }

    // ghci/Tidal — gated on SuperDirt being ready (BootTidal.hs connects to it).
    let (tidal, ready) = match sidecar::spawn_ghci(app) {
        Ok(pair) => pair,
        Err(e) => return log::error!("failed to spawn ghci/Tidal: {e}"),
    };
    if !backends.stash(&backends.tidal, tidal) {
        return; // shutting down
    }
    if sidecar::wait_ready("ghci", &ready).is_err() {
        *backends.tidal.lock().unwrap() = None; // timed out -> kill
    }
}
