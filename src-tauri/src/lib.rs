mod sidecar;

use std::sync::Mutex;

use tauri::Manager;

use sidecar::Sidecar;

/// Backends supervised for the app's lifetime. Dropped (killed) on exit.
#[derive(Default)]
struct Backends {
    superdirt: Mutex<Option<Sidecar>>,
    tidal: Mutex<Option<Sidecar>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backends::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Boot the backends off the setup thread so the window appears
            // immediately — spawn_superdirt blocks until SuperDirt is listening
            // (or times out), and we must never stall the UI thread on that.
            //
            // Order: SuperDirt first, then ghci/Tidal which connects to it.
            // Tidal is gated on SuperDirt — no point spawning it if the sound
            // backend never came up. Failures are logged, not fatal; the editor
            // still loads and surfaces the missing seam.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let backends: tauri::State<Backends> = handle.state();
                match sidecar::spawn_superdirt() {
                    Ok(sc) => {
                        *backends.superdirt.lock().unwrap() = Some(sc);
                        match sidecar::spawn_ghci() {
                            Ok(tidal) => *backends.tidal.lock().unwrap() = Some(tidal),
                            Err(e) => log::error!("failed to spawn ghci/Tidal: {e}"),
                        }
                    }
                    Err(e) => log::error!("failed to spawn SuperDirt: {e}"),
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Explicit teardown so backends die before the process does.
                // Tidal first (the pattern producer), then the sound backend.
                let backends: tauri::State<Backends> = app.state();
                *backends.tidal.lock().unwrap() = None;
                *backends.superdirt.lock().unwrap() = None;
            }
        });
}
