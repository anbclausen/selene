//! Sidecar process orchestration.
//!
//! Phase 2: the Rust shell spawns and supervises the sound + pattern backends.
//! Right now this boots SuperDirt (sclang → scsynth + SuperDirt, OSC :57120).
//! The ghci/Tidal sidecar attaches in a later step.
//!
//! The OSC seam (Tidal → :57120 → SuperDirt) is the sacred boundary — this
//! module only knows how to *launch* the sound backend, never how to talk to
//! it across that seam.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;

/// A supervised child process. Killed on drop so the app never leaks backends.
pub struct Sidecar {
    name: &'static str,
    child: Child,
}

impl Sidecar {
    pub fn kill(&mut self) {
        match self.child.kill() {
            Ok(_) => log::info!("sidecar '{}' terminated", self.name),
            Err(e) => log::warn!("failed to kill sidecar '{}': {e}", self.name),
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Repo-root-relative `vendor/` dir.
///
/// Dev only: anchored to the crate manifest at compile time. Phase 5 swaps this
/// for Tauri's resource-dir API once vendor/ ships inside the installer.
fn vendor_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("vendor")
}

/// Repo-root-relative `backend/` dir (boot scripts).
fn backend_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("backend")
}

/// Spawn the SuperDirt sound backend via the vendored sclang.
///
/// Streams sclang stdout/stderr into the log and watches for the
/// `SELENE_READY` line that `backend/startup.scd` prints once SuperDirt is
/// listening on :57120.
pub fn spawn_superdirt() -> std::io::Result<Sidecar> {
    let vendor = vendor_dir();
    let backend = backend_dir();

    let sclang = vendor.join("supercollider/SuperCollider.app/Contents/MacOS/sclang");
    let conf = vendor.join("sclang_conf.yaml");
    let startup = backend.join("startup.scd");
    let samples = vendor.join("samples/Dirt-Samples");

    log::info!("spawning SuperDirt: {}", sclang.display());

    let mut child = Command::new(&sclang)
        .arg("-l")
        .arg(&conf)
        .arg(&startup)
        .env("SELENE_SAMPLES_PATH", &samples)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Drain stdout on a background thread; log every line, flag readiness.
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim() == "SELENE_READY" {
                    log::info!("SuperDirt ready (OSC :57120)");
                } else {
                    log::info!("[sclang] {line}");
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[sclang] {line}");
            }
        });
    }

    Ok(Sidecar {
        name: "superdirt",
        child,
    })
}
