//! Sidecar process orchestration.
//!
//! Phase 2: the Rust shell spawns and supervises the sound + pattern backends.
//! It boots SuperDirt (sclang → scsynth + SuperDirt, OSC :57120), then — once
//! SuperDirt signals ready — boots ghci/Tidal (BootTidal.hs connects to :57120).
//!
//! Each backend is watched for unexpected exit (a crash) and emits a
//! `backend-crashed` event the editor surfaces. On teardown the whole process
//! group is killed so grandchildren (scsynth, spawned by sclang) die too.
//!
//! The OSC seam (Tidal → :57120 → SuperDirt) is the sacred boundary — this
//! module only knows how to *launch and supervise* the two processes, never how
//! to talk across that seam. Tidal opens the OSC connection itself.

use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// Line a backend prints on stdout once it is fully up and listening.
const READY_LINE: &str = "SELENE_READY";

/// Prefix of the line sclang prints listing loaded sample banks (see
/// `backend/startup.scd`): `SELENE_SAMPLES name:count name:count …`.
const SAMPLES_LINE: &str = "SELENE_SAMPLES";

/// Event carrying the loaded sample banks to the editor's sound browser.
const SAMPLES_EVENT: &str = "samples-loaded";

/// One loaded sample bank: a folder name and how many samples it holds.
#[derive(Clone, serde::Serialize)]
pub struct SampleBank {
    pub name: String,
    pub count: u32,
}

/// The sample banks reported by sclang at boot. Filled once, read by the
/// `list_samples` command for editors that mount after the boot line is printed.
static SAMPLE_BANKS: OnceLock<Mutex<Vec<SampleBank>>> = OnceLock::new();

fn sample_banks() -> &'static Mutex<Vec<SampleBank>> {
    SAMPLE_BANKS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Snapshot of the loaded sample banks (empty until sclang reports them).
pub fn loaded_samples() -> Vec<SampleBank> {
    sample_banks().lock().unwrap().clone()
}

/// Parse `name:count name:count …` into sorted sample banks. Malformed tokens
/// (no colon, non-numeric count) are skipped rather than failing the whole line.
fn parse_sample_banks(rest: &str) -> Vec<SampleBank> {
    let mut banks: Vec<SampleBank> = rest
        .split_whitespace()
        .filter_map(|tok| {
            let (name, count) = tok.rsplit_once(':')?;
            Some(SampleBank {
                name: name.to_string(),
                count: count.parse().ok()?,
            })
        })
        .collect();
    banks.sort_by(|a, b| a.name.cmp(&b.name));
    banks
}

/// How long to wait for a backend's ready signal before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// How often the crash watcher polls the child for exit.
const WATCH_POLL: Duration = Duration::from_millis(500);

/// Event emitted to the webview when a backend exits unexpectedly.
const CRASH_EVENT: &str = "backend-crashed";

/// Event carrying one stderr line from ghci after boot — a Tidal eval error.
const EVAL_ERROR_EVENT: &str = "eval-error";

/// Payload for [`CRASH_EVENT`].
#[derive(Clone, serde::Serialize)]
struct BackendCrash {
    backend: &'static str,
    code: Option<i32>,
}

/// A supervised child process. Killed on drop so the app never leaks backends.
pub struct Sidecar {
    name: &'static str,
    /// Shared with the crash watcher so both can reach the child (watcher polls
    /// `try_wait`, `kill` calls `kill`). Behind a mutex since `Child` needs
    /// `&mut` for both.
    child: Arc<Mutex<Child>>,
    /// Held open so the process keeps reading (closing stdin = EOF = exit).
    /// Phase 3 writes eval blocks here. `None` for backends we don't drive.
    #[allow(dead_code)] // consumed by the editor IPC in Phase 3
    stdin: Option<ChildStdin>,
    /// Set when we kill on purpose, so the watcher doesn't report a crash.
    intentional: Arc<AtomicBool>,
}

impl Sidecar {
    /// Write a single line to the process's stdin (e.g. `hush` to ghci).
    #[allow(dead_code)] // used by the transport UI in a later Phase 3 step
    pub fn send(&mut self, line: &str) -> std::io::Result<()> {
        let stdin = self.stdin()?;
        writeln!(stdin, "{line}")?;
        stdin.flush()
    }

    /// Send a (possibly multi-line) code block to ghci, wrapped in `:{ … :}` so
    /// it is evaluated as one unit regardless of line breaks — Tidal patterns
    /// routinely span several lines.
    pub fn send_block(&mut self, code: &str) -> std::io::Result<()> {
        let stdin = self.stdin()?;
        writeln!(stdin, ":{{")?;
        writeln!(stdin, "{code}")?;
        writeln!(stdin, ":}}")?;
        stdin.flush()
    }

    fn stdin(&mut self) -> std::io::Result<&mut ChildStdin> {
        self.stdin.as_mut().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("sidecar '{}' has no stdin", self.name),
            )
        })
    }

    /// Kill the process (idempotent). Marks the exit intentional first so the
    /// watcher stays quiet, then signals the whole process group — sclang spawns
    /// scsynth as a grandchild, and killing only the leader would orphan it.
    pub fn kill(&mut self) {
        if self.intentional.swap(true, Ordering::SeqCst) {
            return; // already killed
        }
        if let Ok(mut child) = self.child.lock() {
            // child.id() stays valid even once reaped, so the group signal is
            // safe to send unconditionally (ESRCH if already gone).
            #[cfg(unix)]
            unsafe {
                libc::killpg(child.id() as libc::pid_t, libc::SIGTERM);
                libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
            }
            let _ = child.kill();
        }
        log::info!("sidecar '{}' terminated", self.name);
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
pub fn vendor_dir() -> PathBuf {
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

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

/// Spawn a backend, start streaming its output to the log, and watch it for
/// crashes. Returns the (already-running) sidecar plus a receiver that fires
/// once the process prints `SELENE_READY`. Does NOT block on readiness — the
/// caller stashes the sidecar into shared state *first* (so teardown can kill it
/// mid-boot), then waits via [`wait_ready`]. `ready_msg` is logged in place of
/// the raw ready line.
fn spawn_proc(
    app: &AppHandle,
    name: &'static str,
    mut command: Command,
    ready_msg: &'static str,
    death_marker: Option<&'static str>,
    // When true, stderr lines printed *after* the ready signal are forwarded to
    // the editor as `eval-error` events (this is how ghci reports type/scope
    // errors from an eval). Lines before ready are boot noise and ignored.
    emit_eval_errors: bool,
) -> std::io::Result<(Sidecar, Receiver<()>)> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Lead a new process group so teardown can kill the whole subtree (sclang
    // -> scsynth) at once. 0 = use the child's own pid as the group id.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn()?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Single-slot channel: the stdout reader pings once it sees the ready line.
    // When the process dies its stdout closes, the reader thread ends, and the
    // sender drops — so a caller blocked in `wait_ready` unblocks immediately on
    // a boot-time crash instead of waiting out the full timeout.
    let (ready_tx, ready_rx) = sync_channel::<()>(1);
    let intentional = Arc::new(AtomicBool::new(false));
    // Flipped once the ready line is seen; gates eval-error forwarding so boot
    // chatter on stderr isn't surfaced to the user as a Tidal error.
    let ready_flag = Arc::new(AtomicBool::new(false));

    if let Some(stdout) = stdout {
        let app = app.clone();
        let intentional = Arc::clone(&intentional);
        let ready_flag = Arc::clone(&ready_flag);
        thread::spawn(move || {
            let mut reported = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim() == READY_LINE {
                    log::info!("{ready_msg}");
                    ready_flag.store(true, Ordering::SeqCst);
                    let _ = ready_tx.try_send(());
                    continue;
                }
                // sclang reports its loaded sample banks once at boot; stash them
                // and forward to the editor's sound browser.
                if let Some(rest) = line.strip_prefix(SAMPLES_LINE) {
                    let banks = parse_sample_banks(rest);
                    log::info!("[{name}] loaded {} sample banks", banks.len());
                    *sample_banks().lock().unwrap() = banks.clone();
                    let _ = app.emit(SAMPLES_EVENT, banks);
                    continue;
                }
                log::info!("[{name}] {line}");

                // Some backends survive the death of a child they manage: sclang
                // stays alive when scsynth (the audio server) dies, so the
                // process-exit watcher never fires even though sound is gone.
                // Detect that from a known log line — unless we're the ones
                // tearing down (then scsynth dying is expected).
                if let Some(marker) = death_marker {
                    if !reported && !intentional.load(Ordering::SeqCst) && line.contains(marker) {
                        reported = true;
                        log::error!("backend '{name}' lost its server: {line}");
                        let _ = app.emit(
                            CRASH_EVENT,
                            BackendCrash {
                                backend: name,
                                code: None,
                            },
                        );
                    }
                }
            }
        });
    }

    if let Some(stderr) = stderr {
        let app = app.clone();
        let ready_flag = Arc::clone(&ready_flag);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[{name}] {line}");
                // Forward post-boot stderr to the editor as eval errors.
                if emit_eval_errors && ready_flag.load(Ordering::SeqCst) {
                    let _ = app.emit(EVAL_ERROR_EVENT, line);
                }
            }
        });
    }

    let child = Arc::new(Mutex::new(child));
    watch_for_crash(
        app.clone(),
        name,
        Arc::clone(&child),
        Arc::clone(&intentional),
    );

    Ok((
        Sidecar {
            name,
            child,
            stdin,
            intentional,
        },
        ready_rx,
    ))
}

/// Poll the child until it exits. If the exit was not requested by us, log it
/// and emit [`CRASH_EVENT`] so the editor can surface a dead backend.
fn watch_for_crash(
    app: AppHandle,
    name: &'static str,
    child: Arc<Mutex<Child>>,
    intentional: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        let exit = match child.lock().unwrap().try_wait() {
            Ok(status) => status,
            Err(e) => {
                log::warn!("watcher for '{name}' failed to poll: {e}");
                return;
            }
        };

        if let Some(status) = exit {
            if intentional.load(Ordering::SeqCst) {
                return; // we killed it on purpose
            }
            let code = status.code();
            log::error!("backend '{name}' exited unexpectedly (code {code:?})");
            let _ = app.emit(
                CRASH_EVENT,
                BackendCrash {
                    backend: name,
                    code,
                },
            );
            return;
        }

        thread::sleep(WATCH_POLL);
    });
}

/// Block until `ready` fires or `READY_TIMEOUT` elapses (or the sender drops,
/// meaning the process died during boot). On failure returns an error; the
/// caller drops the already-stashed sidecar, which kills it. The sidecar is NOT
/// killed here — it lives in shared state.
pub fn wait_ready(name: &str, ready: &Receiver<()>) -> std::io::Result<()> {
    match ready.recv_timeout(READY_TIMEOUT) {
        Ok(()) => Ok(()),
        Err(_) => {
            log::error!("sidecar '{name}' never signalled ready (timeout or crash on boot)");
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("'{name}' not ready"),
            ))
        }
    }
}

/// Spawn the SuperDirt sound backend via the vendored sclang. Returns once the
/// process is running; use [`wait_ready`] to block until it is listening on
/// :57120.
pub fn spawn_superdirt(app: &AppHandle) -> std::io::Result<(Sidecar, Receiver<()>)> {
    let vendor = vendor_dir();

    let sclang = vendor.join("supercollider/SuperCollider.app/Contents/MacOS/sclang");
    let conf = vendor.join("sclang_conf.yaml");
    let startup = backend_dir().join("startup.scd");
    let samples = vendor.join("samples/Dirt-Samples");
    let sc3_plugins = vendor.join("sc3-plugins/plugins");

    log::info!("spawning SuperDirt: {}", sclang.display());

    let mut cmd = Command::new(&sclang);
    cmd.arg("-l")
        .arg(&conf)
        .arg(&startup)
        .env("SELENE_SAMPLES_PATH", &samples)
        .env("SELENE_SC3_PLUGINS_PATH", &sc3_plugins);

    spawn_proc(
        app,
        "sclang",
        cmd,
        "SuperDirt ready (OSC :57120)",
        // sclang outlives scsynth; treat the server going away as a crash.
        Some("Server 'localhost' exited"),
        false,
    )
}

/// Spawn the ghci/Tidal pattern backend. Must be called AFTER SuperDirt is
/// ready — BootTidal.hs opens the OSC connection to :57120 on startup. Returns
/// once the process is running; use [`wait_ready`] to block until Tidal accepts
/// eval blocks. The sidecar's stdin is the eval pipe the editor writes (Phase 3).
pub fn spawn_ghci(app: &AppHandle) -> std::io::Result<(Sidecar, Receiver<()>)> {
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

    spawn_proc(app, "ghci", cmd, "Tidal ready (eval pipe open)", None, true)
}
