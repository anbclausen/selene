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
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Line a backend prints on stdout once it is fully up and listening.
const READY_LINE: &str = "SELENE_READY";

/// Vendored GHC version — MUST match `GHC_VERSION` in `bundle/fetch-ghc.sh`.
/// Used to locate the real `ghc` binary and lib dir under `vendor/ghc/`.
const GHC_VERSION: &str = "9.6.7";

/// Pinned Dirt-Samples commit — MUST match `DIRT_SAMPLES_COMMIT` in
/// `bundle/fetch-superdirt.sh`. The SHA content-addresses the sample set, so the
/// downloaded tarball is pinned without a separate checksum.
const DIRT_SAMPLES_COMMIT: &str = "c74fc80f8db8038f6a33648ffef5ac00a07ad402";

/// Latest human-readable boot stage, polled by the editor (`boot_status` command)
/// to label the Play button while the backends come up — including the possibly
/// slow first-run sample download.
static BOOT_STATUS: OnceLock<Mutex<String>> = OnceLock::new();

fn boot_status_cell() -> &'static Mutex<String> {
    BOOT_STATUS.get_or_init(|| Mutex::new(String::from("Starting…")))
}

/// Record the current boot stage (shown on the editor's Play button).
pub fn set_boot_status(msg: &str) {
    log::info!("boot: {msg}");
    *boot_status_cell().lock().unwrap() = msg.to_string();
}

/// The current boot stage line.
pub fn boot_status() -> String {
    boot_status_cell().lock().unwrap().clone()
}

/// Prefix of the line sclang prints listing loaded sample banks (see
/// `backend/startup.scd`): `SELENE_SAMPLES name:count name:count …`.
const SAMPLES_LINE: &str = "SELENE_SAMPLES";

/// Event carrying the loaded sample banks to the editor's sound browser.
const SAMPLES_EVENT: &str = "samples-loaded";

/// Prefix of the line listing playable synths: `SELENE_SYNTHS name name …`.
const SYNTHS_LINE: &str = "SELENE_SYNTHS";

/// Event carrying the loaded synth names to the editor's sound browser.
const SYNTHS_EVENT: &str = "synths-loaded";

static SYNTHS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn synths() -> &'static Mutex<Vec<String>> {
    SYNTHS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Snapshot of the loaded synth names (empty until sclang reports them).
pub fn loaded_synths() -> Vec<String> {
    synths().lock().unwrap().clone()
}

/// Prefix of the line listing audio output devices: `SELENE_DEVICES a<TAB>b…`.
const DEVICES_LINE: &str = "SELENE_DEVICES";
const DEVICES_EVENT: &str = "devices-loaded";

static DEVICES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn devices() -> &'static Mutex<Vec<String>> {
    DEVICES.get_or_init(|| Mutex::new(Vec::new()))
}

/// Snapshot of the available output devices (empty until sclang reports them).
pub fn loaded_devices() -> Vec<String> {
    devices().lock().unwrap().clone()
}

/// Path of the persisted output-device choice (in the app config dir).
fn output_device_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("output_device.txt"))
}

/// The persisted output device, or None for the system default.
pub fn output_device(app: &AppHandle) -> Option<String> {
    let s = std::fs::read_to_string(output_device_file(app)?).ok()?;
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Persist the output device choice (empty string clears it). Takes effect on
/// the next launch (rebooting scsynth live is disruptive).
pub fn set_output_device(app: &AppHandle, name: &str) -> std::io::Result<()> {
    let path = output_device_file(app).ok_or_else(|| std::io::Error::other("no app config dir"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, name.trim())
}

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

/// Root that holds `vendor/`, `backend/`, `core/`. In a packaged build these
/// ship inside the app and are resolved via Tauri's resource dir; in dev
/// (debug) we use the repo root so `cargo tauri dev` runs against the tree.
fn resource_root(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        repo_root()
    } else {
        app.path()
            .resource_dir()
            .expect("resource dir available in a bundled app")
    }
}

/// The vendored runtime tree (GHC, cabal store, SuperCollider, quarks,
/// sc3-plugins). Not bundled in the (thin) installer: a dev checkout has it in
/// the repo's `vendor/`, a distributed app fetches it on first run into the app
/// data dir (see [`ensure_runtime`]). `vendor/ghc` is the presence probe — it's
/// only populated by a completed fetch.
pub fn vendor_dir(app: &AppHandle) -> PathBuf {
    let local = resource_root(app).join("vendor");
    if is_populated(&local.join("ghc")) {
        return local;
    }
    runtime_vendor_dir(app)
}

/// Where a fetched runtime lands: `<app-data>/runtime/vendor`.
fn runtime_vendor_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir available")
        .join("runtime/vendor")
}

/// Release tag whose `selene-runtime-aarch64.tar.gz` asset matches this build.
/// Baked in by CI (empty/unset in dev builds, which use the repo vendor tree).
const RUNTIME_TAG: Option<&str> = option_env!("SELENE_RUNTIME_TAG");

/// Make sure a usable runtime tree exists, downloading it on first run if
/// needed. No-op when the repo/bundle already has one (dev) or a previous run
/// fetched it. Errors mean: no runtime and the download failed — the app can't
/// make sound; the caller surfaces that.
pub fn ensure_runtime(app: &AppHandle) -> std::io::Result<()> {
    let vendor = vendor_dir(app);
    if is_populated(&vendor.join("ghc")) {
        return Ok(());
    }

    let tag = RUNTIME_TAG.unwrap_or("");
    if tag.is_empty() {
        return Err(std::io::Error::other(
            "no vendored runtime and this build has no runtime tag (dev build outside the repo?)",
        ));
    }
    let url = format!(
        "https://github.com/anbclausen/selene/releases/download/{tag}/selene-runtime-aarch64.tar.gz"
    );

    set_boot_status("Downloading audio runtime (first run, ~450 MB)…");
    let dest = runtime_vendor_dir(app);
    let parent = dest
        .parent()
        .ok_or_else(|| std::io::Error::other("runtime dir has no parent"))?
        .to_path_buf();
    std::fs::create_dir_all(&parent)?;

    let tarball = parent.join(".runtime.tar.gz");
    let staging = parent.join(".runtime.partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    log::info!("fetching runtime: {url}");
    run(Command::new("curl")
        .arg("-fL")
        .arg(&url)
        .arg("-o")
        .arg(&tarball))?;
    set_boot_status("Unpacking audio runtime…");
    // The tarball holds a single `vendor/` tree (see .github/workflows).
    run(Command::new("tar")
        .arg("-xzf")
        .arg(&tarball)
        .arg("-C")
        .arg(&staging))?;
    let _ = std::fs::remove_file(&tarball);

    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(staging.join("vendor"), &dest)?;
    let _ = std::fs::remove_dir_all(&staging);
    log::info!("runtime ready at {}", dest.display());
    Ok(())
}

/// `backend/` dir (SC boot scripts).
fn backend_dir(app: &AppHandle) -> PathBuf {
    resource_root(app).join("backend")
}

/// `core/` dir (Haskell/Tidal boot script).
fn core_dir(app: &AppHandle) -> PathBuf {
    resource_root(app).join("core")
}

fn repo_root() -> PathBuf {
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
                if let Some(rest) = line.strip_prefix(SYNTHS_LINE) {
                    let names: Vec<String> = rest.split_whitespace().map(String::from).collect();
                    log::info!("[{name}] loaded {} synths", names.len());
                    *synths().lock().unwrap() = names.clone();
                    let _ = app.emit(SYNTHS_EVENT, names);
                    continue;
                }
                if let Some(rest) = line.strip_prefix(DEVICES_LINE) {
                    let names: Vec<String> = rest
                        .trim()
                        .split('\t')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect();
                    log::info!("[{name}] {} output devices", names.len());
                    *devices().lock().unwrap() = names.clone();
                    let _ = app.emit(DEVICES_EVENT, names);
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

/// True if `dir` exists and holds at least one entry.
fn is_populated(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut d| d.next().is_some())
        .unwrap_or(false)
}

/// Resolve the Dirt-Samples directory, downloading it on first run if needed.
///
/// Priority: a bundled set (resource dir) > an already-fetched set in the app
/// data dir > the repo's vendored set (dev / locally-built release). If none
/// exist, fetch the pinned commit tarball into the app data dir. Returns `None`
/// only when every path is missing and the fetch fails (offline first run) — the
/// caller then boots SuperDirt without samples.
fn ensure_samples(app: &AppHandle) -> Option<PathBuf> {
    let bundled = vendor_dir(app).join("samples/Dirt-Samples");
    if is_populated(&bundled) {
        return Some(bundled);
    }

    // Fetched on a previous run.
    let fetched = app.path().app_data_dir().ok()?.join("samples/Dirt-Samples");
    if is_populated(&fetched) {
        return Some(fetched);
    }

    // Build machine: the repo's vendored set, so a locally-built app keeps drums
    // without a download (mirrors the old fallback).
    let repo = repo_root().join("vendor/samples/Dirt-Samples");
    if is_populated(&repo) {
        return Some(repo);
    }

    // First run of a distributed app: download the pinned samples.
    match fetch_samples(&fetched) {
        Ok(()) => Some(fetched),
        Err(e) => {
            log::error!("Dirt-Samples fetch failed: {e}");
            None
        }
    }
}

/// Download the pinned Dirt-Samples tarball from GitHub and extract it into
/// `dest`. Uses curl + tar (both ship with macOS) to avoid an HTTP/gzip crate in
/// the bundle. Extracts into a temp dir and renames into place so an interrupted
/// download never leaves a half-populated dir we'd later treat as complete.
fn fetch_samples(dest: &Path) -> std::io::Result<()> {
    set_boot_status("Downloading drum samples (first run)…");

    let url =
        format!("https://github.com/tidalcycles/Dirt-Samples/archive/{DIRT_SAMPLES_COMMIT}.tar.gz");
    let parent = dest
        .parent()
        .ok_or_else(|| std::io::Error::other("samples dest has no parent"))?;
    std::fs::create_dir_all(parent)?;

    let tarball = parent.join(".Dirt-Samples.tar.gz");
    let staging = parent.join(".Dirt-Samples.partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    log::info!("fetching Dirt-Samples: {url}");
    run(Command::new("curl")
        .arg("-fL")
        .arg(&url)
        .arg("-o")
        .arg(&tarball))?;
    // GitHub wraps the tree in a single `Dirt-Samples-<sha>/` dir; strip it.
    run(Command::new("tar")
        .arg("-xzf")
        .arg(&tarball)
        .arg("-C")
        .arg(&staging)
        .arg("--strip-components=1"))?;
    let _ = std::fs::remove_file(&tarball);

    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest)?;
    log::info!("Dirt-Samples ready at {}", dest.display());
    Ok(())
}

/// Run a command to completion, mapping a non-zero exit to an error.
fn run(cmd: &mut Command) -> std::io::Result<()> {
    let status = cmd.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "{cmd:?} exited with {status}"
        )))
    }
}

/// Write the sclang class-library config next to the app's other state and
/// return its path. Generated per launch because the include paths must point
/// at wherever the runtime actually lives (repo checkout vs fetched app-data
/// tree) — a pre-baked file would carry the build machine's paths.
fn write_sclang_conf(app: &AppHandle, vendor: &Path) -> std::io::Result<PathBuf> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| std::io::Error::other(format!("no app config dir: {e}")))?
        .join("sclang_conf.yaml");
    let home = std::env::var("HOME").unwrap_or_default();
    let conf = format!(
        "includePaths:\n\
         \x20 - {v}/quarks/SuperDirt/classes\n\
         \x20 - {v}/quarks/Vowel\n\
         \x20 - {v}/sc3-plugins/classes\n\
         excludePaths:\n\
         \x20 - {home}/Library/Application Support/SuperCollider/Extensions\n\
         \x20 - /Library/Application Support/SuperCollider/Extensions\n\
         postInlineWarnings: false\n",
        v = vendor.display(),
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, conf)?;
    Ok(path)
}

/// Spawn the SuperDirt sound backend via the vendored sclang. Returns once the
/// process is running; use [`wait_ready`] to block until it is listening on
/// :57120.
pub fn spawn_superdirt(app: &AppHandle) -> std::io::Result<(Sidecar, Receiver<()>)> {
    let vendor = vendor_dir(app);

    let sclang = vendor.join("supercollider/SuperCollider.app/Contents/MacOS/sclang");
    let conf = write_sclang_conf(app, &vendor)?;
    let startup = backend_dir(app).join("startup.scd");
    let sc3_plugins = vendor.join("sc3-plugins/plugins");

    // Samples aren't bundled (licensing). Resolve a usable set — fetching the
    // pinned Dirt-Samples on first run if needed — and only point SuperDirt at it
    // when one exists. If the fetch fails offline, SuperDirt boots without
    // samples (synths still work) rather than blocking the app.
    let samples = ensure_samples(app);
    set_boot_status("Starting sound engine…");

    log::info!("spawning SuperDirt: {}", sclang.display());

    let mut cmd = Command::new(&sclang);
    cmd.arg("-l")
        .arg(&conf)
        .arg(&startup)
        .env("SELENE_SC3_PLUGINS_PATH", &sc3_plugins);
    if let Some(samples) = &samples {
        cmd.env("SELENE_SAMPLES_PATH", samples);
    }
    if let Some(dev) = output_device(app) {
        cmd.env("SELENE_OUTPUT_DEVICE", dev);
    }

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
    let vendor = vendor_dir(app);

    // The `ghc/bin/ghci` wrapper is a shell script with the build machine's paths
    // baked in (topdir, libdir) — it breaks once the bundle moves. Invoke the real
    // GHC binary directly and pass the relocated lib dir via -B, computed from
    // wherever the bundle actually landed. The vendored store's package .conf
    // files use ${pkgroot}, and `tidal-ghc-env` names its package-db relative to
    // itself, so the whole Tidal install resolves from the bundle. (See
    // bundle/fetch-ghc.sh for the build-time half.)
    let ghc_root = vendor.join(format!("ghc/lib/ghc-{GHC_VERSION}"));
    let ghc_lib = ghc_root.join("lib");
    let ghc_bin = ghc_root.join(format!("bin/ghc-{GHC_VERSION}"));
    let pkg_env = vendor.join("tidal-ghc-env");
    let boot = core_dir(app).join("BootTidal.hs");

    log::info!("spawning ghci/Tidal: {}", ghc_bin.display());

    let mut cmd = Command::new(&ghc_bin);
    cmd.arg("--interactive")
        .arg(format!("-B{}", ghc_lib.display()))
        .arg("-package-env")
        .arg(&pkg_env)
        .arg("-ghci-script")
        .arg(&boot);

    spawn_proc(app, "ghci", cmd, "Tidal ready (eval pipe open)", None, true)
}
