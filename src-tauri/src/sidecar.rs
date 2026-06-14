//! Sidecar process orchestration.
//!
//! Phase 2: the Rust shell spawns and supervises the sound + pattern backends.
//! It boots SuperDirt (sclang → scsynth + SuperDirt, OSC :57120), then — once
//! SuperDirt signals ready — boots ghci/Tidal (BootTidal.hs connects to :57120).
//!
//! The OSC seam (Tidal → :57120 → SuperDirt) is the sacred boundary — this
//! module only knows how to *launch and supervise* the two processes, never how
//! to talk across that seam. Tidal opens the OSC connection itself.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Duration;

/// Line a backend prints on stdout once it is fully up and listening.
const READY_LINE: &str = "SELENE_READY";

/// How long to wait for a backend's ready signal before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// A supervised child process. Killed on drop so the app never leaks backends.
pub struct Sidecar {
    name: &'static str,
    child: Child,
    /// Held open so the process keeps reading (closing stdin = EOF = exit).
    /// Phase 3 writes eval blocks here. `None` for backends we don't drive.
    #[allow(dead_code)] // consumed by the editor IPC in Phase 3
    stdin: Option<ChildStdin>,
}

impl Sidecar {
    /// Write a line to the process's stdin (e.g. a Tidal eval block to ghci).
    #[allow(dead_code)] // wired to the editor IPC in Phase 3
    pub fn send(&mut self, line: &str) -> std::io::Result<()> {
        match self.stdin.as_mut() {
            Some(stdin) => {
                writeln!(stdin, "{line}")?;
                stdin.flush()
            }
            None => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("sidecar '{}' has no stdin", self.name),
            )),
        }
    }

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
    repo_root().join("vendor")
}

/// Repo-root-relative `backend/` dir (SC boot scripts).
fn backend_dir() -> PathBuf {
    repo_root().join("backend")
}

/// Repo-root-relative `core/` dir (Haskell/Tidal boot script).
fn core_dir() -> PathBuf {
    repo_root().join("core")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

/// Spawn a backend, stream its output to the log, and BLOCK until it prints
/// `SELENE_READY` (or `READY_TIMEOUT` elapses). On timeout the child is killed
/// and an error returned, so callers can gate dependent backends on success.
///
/// `ready_msg` is logged in place of the raw ready line.
fn spawn_gated(
    name: &'static str,
    mut command: Command,
    ready_msg: &'static str,
) -> std::io::Result<Sidecar> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdin = child.stdin.take();

    // Single-slot channel: the stdout reader pings once it sees the ready line.
    let (ready_tx, ready_rx) = sync_channel::<()>(1);

    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim() == READY_LINE {
                    log::info!("{ready_msg}");
                    let _ = ready_tx.try_send(());
                } else {
                    log::info!("[{name}] {line}");
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[{name}] {line}");
            }
        });
    }

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(()) => Ok(Sidecar { name, child, stdin }),
        Err(_) => {
            log::error!("sidecar '{name}' did not signal ready within {READY_TIMEOUT:?}");
            let _ = child.kill();
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("'{name}' ready timeout"),
            ))
        }
    }
}

/// Spawn the SuperDirt sound backend via the vendored sclang. Blocks until
/// SuperDirt is listening on :57120.
pub fn spawn_superdirt() -> std::io::Result<Sidecar> {
    let vendor = vendor_dir();

    let sclang = vendor.join("supercollider/SuperCollider.app/Contents/MacOS/sclang");
    let conf = vendor.join("sclang_conf.yaml");
    let startup = backend_dir().join("startup.scd");
    let samples = vendor.join("samples/Dirt-Samples");

    log::info!("spawning SuperDirt: {}", sclang.display());

    let mut cmd = Command::new(&sclang);
    cmd.arg("-l")
        .arg(&conf)
        .arg(&startup)
        .env("SELENE_SAMPLES_PATH", &samples);

    spawn_gated("sclang", cmd, "SuperDirt ready (OSC :57120)")
}

/// Spawn the ghci/Tidal pattern backend. Must be called AFTER SuperDirt is
/// ready — BootTidal.hs opens the OSC connection to :57120 on startup. Blocks
/// until Tidal is up and accepting eval blocks. The returned sidecar's stdin is
/// the eval pipe the editor writes to (Phase 3).
pub fn spawn_ghci() -> std::io::Result<Sidecar> {
    let vendor = vendor_dir();

    let ghci = vendor.join("ghc/bin/ghci");
    let pkg_env = vendor.join("tidal-ghc-env");
    let boot = core_dir().join("BootTidal.hs");

    log::info!("spawning ghci/Tidal: {}", ghci.display());

    let mut cmd = Command::new(&ghci);
    cmd.arg("-package-env")
        .arg(&pkg_env)
        .arg("-ghci-script")
        .arg(&boot);

    spawn_gated("ghci", cmd, "Tidal ready (eval pipe open)")
}
