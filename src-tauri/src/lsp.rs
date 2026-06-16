//! HLS (Haskell Language Server) sidecar — LSP over stdio.
//!
//! JSON-RPC Content-Length framing is handled here. The webview communicates via:
//!   invoke("lsp_send", { msg }) — client → server (msg is a JSON string)
//!   event  "lsp-recv" (msg)    — server → client (payload is a JSON string)
//!
//! HLS death is non-fatal: the editor continues to eval without LSP features.
//!
//! Architecture matches the plan: a dedicated session dir holds hie.yaml and
//! current.hs so HLS resolves the direct cradle from the tidal-ghc-env package env.

use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::sidecar::vendor_dir;

const WATCH_POLL: Duration = Duration::from_millis(500);
const LSP_RECV_EVENT: &str = "lsp-recv";

/// State for the running HLS process. Killed on drop.
pub struct LspSidecar {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    intentional: Arc<AtomicBool>,
    pub session_dir: PathBuf,
}

impl LspSidecar {
    /// Frame a JSON string as a Content-Length LSP message and write it to HLS stdin.
    pub fn send(&self, msg: &str) -> std::io::Result<()> {
        let frame = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "HLS stdin closed")
        })?;
        stdin.write_all(frame.as_bytes())?;
        stdin.flush()
    }

    pub fn kill(&self) {
        if self.intentional.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            #[cfg(unix)]
            unsafe {
                libc::killpg(child.id() as libc::pid_t, libc::SIGTERM);
            }
            let _ = child.kill();
        }
        log::info!("HLS sidecar terminated");
    }
}

impl Drop for LspSidecar {
    fn drop(&mut self) {
        self.kill();
        // Best-effort cleanup of the session dir.
        let _ = std::fs::remove_dir_all(&self.session_dir);
    }
}

/// Generate the session dir, write hie.yaml and a placeholder current.hs, then
/// spawn `haskell-language-server-9.6.7 --lsp`. Returns the sidecar or an error.
pub fn spawn_hls(app: &AppHandle) -> std::io::Result<LspSidecar> {
    let vendor = vendor_dir();

    let hls_bin = vendor.join("hls/bin/haskell-language-server-9.6.7");
    let ghc_bin_dir = vendor.join("ghc/bin");
    let pkg_env = vendor.join("tidal-ghc-env");

    // Session dir: per-process temp dir so concurrent dev runs don't collide.
    let session_dir = std::env::temp_dir()
        .join(format!("selene-hls-{}", std::process::id()));
    std::fs::create_dir_all(&session_dir)?;

    // hie.yaml with the direct cradle pointing at the absolute tidal-ghc-env path.
    let hie_yaml = format!(
        "cradle:\n  direct:\n    arguments:\n      - \"-package-env\"\n      - \"{env}\"\n      - \"-XOverloadedStrings\"\n",
        env = pkg_env
            .to_str()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "non-UTF8 path"))?
    );
    std::fs::write(session_dir.join("hie.yaml"), hie_yaml)?;
    // Empty placeholder so the URI resolves under the session dir.
    std::fs::write(session_dir.join("current.hs"), "")?;

    log::info!("HLS session dir: {}", session_dir.display());
    log::info!("spawning HLS: {}", hls_bin.display());

    // Build PATH with vendor GHC prepended so HLS finds ghc-9.6.7, not a system GHC.
    let path_env = match std::env::var_os("PATH") {
        Some(p) => {
            let mut dirs = std::env::split_paths(&p).collect::<Vec<_>>();
            dirs.insert(0, ghc_bin_dir.clone());
            std::env::join_paths(dirs).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string())
            })?
        }
        None => ghc_bin_dir.as_os_str().to_os_string(),
    };

    let mut cmd = Command::new(&hls_bin);
    cmd.arg("--lsp")
        .current_dir(&session_dir)
        .env("PATH", path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let intentional = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(child));
    let stdin = Arc::new(Mutex::new(stdin));

    // Stdout reader: deframe Content-Length messages and emit each as an event.
    if let Some(stdout) = stdout {
        let app_clone = app.clone();
        thread::spawn(move || {
            read_lsp_messages(stdout, &app_clone);
        });
    }

    // Stderr: log as warnings (HLS is chatty on stderr).
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[hls] {line}");
            }
        });
    }

    // Crash watcher (non-fatal — just log; no backend-crashed banner).
    {
        let app_clone = app.clone();
        let child_arc = Arc::clone(&child);
        let intentional_arc = Arc::clone(&intentional);
        thread::spawn(move || {
            watch_hls(app_clone, child_arc, intentional_arc);
        });
    }

    Ok(LspSidecar {
        child,
        stdin,
        intentional,
        session_dir,
    })
}

/// Read Content-Length-framed LSP messages from HLS stdout and emit each as
/// a `lsp-recv` Tauri event carrying the raw JSON string.
fn read_lsp_messages(stdout: std::process::ChildStdout, app: &AppHandle) {
    let mut reader = BufReader::new(stdout);
    loop {
        // Read headers until blank line.
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return, // EOF or error
                _ => {}
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                break; // end of headers
            }
            if let Some(val) = line.strip_prefix("Content-Length: ") {
                if let Ok(n) = val.trim().parse::<usize>() {
                    content_length = Some(n);
                }
            }
        }

        let n = match content_length {
            Some(n) => n,
            None => {
                log::warn!("[hls] message missing Content-Length, skipping");
                continue;
            }
        };

        let mut body = vec![0u8; n];
        match std::io::Read::read_exact(&mut reader, &mut body) {
            Ok(()) => {}
            Err(e) => {
                log::warn!("[hls] failed to read message body: {e}");
                return;
            }
        }

        match String::from_utf8(body) {
            Ok(msg) => {
                if let Err(e) = app.emit(LSP_RECV_EVENT, msg) {
                    log::warn!("[hls] failed to emit lsp-recv: {e}");
                }
            }
            Err(e) => log::warn!("[hls] non-UTF8 message body: {e}"),
        }
    }
}

fn watch_hls(
    _app: AppHandle,
    child: Arc<Mutex<Child>>,
    intentional: Arc<AtomicBool>,
) {
    loop {
        let exit = match child.lock().unwrap().try_wait() {
            Ok(status) => status,
            Err(e) => {
                log::warn!("[hls] watcher poll failed: {e}");
                return;
            }
        };
        if let Some(status) = exit {
            if !intentional.load(Ordering::SeqCst) {
                log::warn!(
                    "HLS exited unexpectedly (code {:?}) — LSP features unavailable",
                    status.code()
                );
            }
            return;
        }
        thread::sleep(WATCH_POLL);
    }
}
