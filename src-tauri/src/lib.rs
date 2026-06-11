mod sidecar;

use std::sync::Mutex;

use tauri::Manager;

use sidecar::Sidecar;

/// Backends supervised for the app's lifetime. Dropped (killed) on exit.
#[derive(Default)]
struct Backends {
    superdirt: Mutex<Option<Sidecar>>,
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

            // Boot the sound backend. Failure to spawn is logged but not fatal —
            // the editor still loads; ghci/Tidal will surface the missing seam.
            match sidecar::spawn_superdirt() {
                Ok(sc) => {
                    let backends: tauri::State<Backends> = app.state();
                    *backends.superdirt.lock().unwrap() = Some(sc);
                }
                Err(e) => log::error!("failed to spawn SuperDirt: {e}"),
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Explicit teardown so backends die before the process does.
                let backends: tauri::State<Backends> = app.state();
                *backends.superdirt.lock().unwrap() = None;
            }
        });
}
