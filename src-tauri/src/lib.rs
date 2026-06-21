mod osc;
mod sidecar;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

// SIGINT handler: route Ctrl+C through Tauri's exit so the RunEvent teardown
// fires and all supervised child processes are killed before we exit.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(unix)]
extern "C" fn handle_sigint(_: libc::c_int) {
    if let Some(h) = APP_HANDLE.get() {
        h.exit(0);
    }
}

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
    /// Set once ghci/Tidal has signalled ready (which, per boot order, implies
    /// SuperDirt is up too). The editor polls this before enabling Play.
    tidal_ready: AtomicBool,
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

/// Update the native window title (called by the frontend when file state changes).
#[tauri::command]
fn set_title(title: String, window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

/// Whether Tidal is up and ready to accept eval blocks. The editor polls this on
/// startup before enabling Play (SuperDirt is ready by the time this is true).
#[tauri::command]
fn tidal_ready(backends: tauri::State<Backends>) -> bool {
    backends.tidal_ready.load(Ordering::SeqCst)
}

/// The sample banks SuperDirt loaded, for the editor's sound browser. Empty
/// until sclang reports them at boot (the editor also listens for `samples-loaded`
/// to catch the case where boot finishes after the webview has mounted).
#[tauri::command]
fn list_samples() -> Vec<sidecar::SampleBank> {
    sidecar::loaded_samples()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Backends::default())
        .invoke_handler(tauri::generate_handler![eval, set_title, list_samples, tidal_ready])
        .setup(|app| {
            // Route Ctrl+C through Tauri exit so RunEvent teardown kills children.
            #[cfg(unix)]
            {
                let _ = APP_HANDLE.set(app.handle().clone());
                unsafe { libc::signal(libc::SIGINT, handle_sigint as *const () as libc::sighandler_t); }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ── Native menu ───────────────────────────────────────────────
            let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let new_i  = MenuItem::with_id(app, "file-new",     "New",        true, Some("CmdOrCtrl+N"))?;
            let open_i = MenuItem::with_id(app, "file-open",    "Open…",      true, Some("CmdOrCtrl+O"))?;
            let save_i = MenuItem::with_id(app, "file-save",    "Save",       true, Some("CmdOrCtrl+S"))?;
            let saveas = MenuItem::with_id(app, "file-save-as", "Save As…",   true, Some("CmdOrCtrl+Shift+S"))?;
            let file_menu = Submenu::with_id_and_items(
                app, "file", "File", true,
                &[&new_i, &open_i, &PredefinedMenuItem::separator(app)?, &save_i, &saveas],
            )?;

            // Edit menu — wiring up the OS clipboard so Cmd/Ctrl+C/V/X work in the
            // webview. Without these predefined items the editor can't copy/paste.
            let edit_menu = Submenu::with_id_and_items(
                app, "edit", "Edit", true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            #[cfg(target_os = "macos")]
            let menu = {
                let app_menu = Submenu::with_id_and_items(app, "app", "Selene", true, &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings_i,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ])?;
                Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])?
            };
            #[cfg(not(target_os = "macos"))]
            let menu = Menu::with_items(app, &[&file_menu, &edit_menu])?;

            app.set_menu(menu)?;

            // Forward menu events to the webview so the frontend can handle them.
            app.on_menu_event(|app, event| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("menu", event.id().as_ref());
                }
            });

            // Boot the backends off the setup thread so the window appears
            // immediately — readiness waits can take seconds, and we must never
            // stall the UI thread on them.
            let handle = app.handle().clone();
            std::thread::spawn(move || boot_backends(&handle));

            // Listen for Tidal's mirrored event stream and forward it to the
            // editor for step highlighting. Independent of backend boot; the
            // socket just sits idle until Tidal starts sending.
            let handle = app.handle().clone();
            std::thread::spawn(move || osc::listen(&handle));

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
        return;
    }
    backends.tidal_ready.store(true, Ordering::SeqCst);
}
