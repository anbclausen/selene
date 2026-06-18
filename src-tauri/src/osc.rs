//! Tidal event tap → editor highlighting.
//!
//! Tidal is configured (in `core/BootTidal.hs`) to send a copy of every event
//! to a second local UDP port using the standard SuperDirt OSC shape. We listen
//! there, pull out the bits the editor needs to highlight the playing step
//! (which orbit/channel, where in the cycle, what sample), and forward each one
//! to the webview as a `tidal-event`. The real `:57120` SuperDirt seam is never
//! touched — this is a pure read-only tap.

use std::net::UdpSocket;

use rosc::{OscPacket, OscType};
use tauri::{AppHandle, Emitter};

/// Port Tidal mirrors its event stream to (see BootTidal's second target).
pub const TIDAL_TAP_PORT: u16 = 57121;

/// Event forwarded to the webview for each Tidal onset.
#[derive(Clone, serde::Serialize)]
struct TidalEvent {
    /// Output bus. Channel dN == orbit + 1 (BootTidal maps d1 -> orbit 0).
    orbit: i32,
    /// Absolute cycle position as a float; the fractional part places the event
    /// within its cycle, which the editor uses to pick the active step.
    cycle: f64,
    /// Event duration in seconds — how long to keep the step lit.
    delta: f64,
    /// Sample/synth name (the `s`/`sound` value), if any.
    s: Option<String>,
    /// Pitch for the piano roll: Tidal's `note` control, falling back to `n`
    /// (which melodic patterns use). None for unpitched/drum events.
    note: Option<f64>,
}

/// Bind the tap port and forward every Tidal event to the webview. Blocking —
/// run on its own thread. Returns only on a fatal socket error (logged).
pub fn listen(app: &AppHandle) {
    let socket = match UdpSocket::bind(("127.0.0.1", TIDAL_TAP_PORT)) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("OSC tap: failed to bind :{TIDAL_TAP_PORT} (no highlighting): {e}");
            return;
        }
    };
    log::info!("OSC tap listening on :{TIDAL_TAP_PORT}");

    // SuperDirt messages are small; 8 KiB is plenty for one bundle.
    let mut buf = [0u8; 8192];
    loop {
        let n = match socket.recv(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                log::warn!("OSC tap: recv failed: {e}");
                return;
            }
        };
        match rosc::decoder::decode_udp(&buf[..n]) {
            Ok((_, packet)) => handle_packet(app, packet),
            Err(e) => log::warn!("OSC tap: malformed packet: {e}"),
        }
    }
}

/// Walk a packet (Tidal wraps each event message in a timetagged bundle) and
/// emit a `tidal-event` for every `/dirt/play`-style message inside it.
fn handle_packet(app: &AppHandle, packet: OscPacket) {
    match packet {
        OscPacket::Bundle(bundle) => {
            for inner in bundle.content {
                handle_packet(app, inner);
            }
        }
        OscPacket::Message(msg) => {
            if let Some(event) = parse_event(&msg.args) {
                let _ = app.emit("tidal-event", event);
            }
        }
    }
}

/// The SuperDirt shape is a flat list of alternating `"key", value` pairs. Pull
/// the few we care about. Returns None if there's no orbit (not a play message).
fn parse_event(args: &[OscType]) -> Option<TidalEvent> {
    let mut orbit = 0;
    let mut cycle = 0.0;
    let mut delta = 0.0;
    let mut s = None;
    let mut note = None;
    let mut n = None;
    let mut saw_orbit = false;

    let mut i = 0;
    while i + 1 < args.len() {
        let key = match &args[i] {
            OscType::String(k) => k.as_str(),
            _ => {
                i += 1;
                continue;
            }
        };
        let val = &args[i + 1];
        match key {
            "orbit" => {
                if let Some(v) = as_int(val) {
                    orbit = v;
                    saw_orbit = true;
                }
            }
            "cycle" => cycle = as_float(val).unwrap_or(0.0),
            "delta" => delta = as_float(val).unwrap_or(0.0),
            "s" => {
                if let OscType::String(v) = val {
                    s = Some(v.clone());
                }
            }
            "note" => note = as_float(val),
            "n" => n = as_float(val),
            _ => {}
        }
        i += 2;
    }

    // Orbit isn't always present in stock SuperDirt messages; default to 0 so a
    // bare `d1`-style event still highlights.
    let _ = saw_orbit;
    Some(TidalEvent {
        orbit,
        cycle,
        delta,
        s,
        // Pitch row: prefer the explicit `note` control; fall back to `n`, which
        // melodic patterns use (e.g. `n (scale "minor" ...)`). For drum patterns
        // `n` is a sample index near 0, so it just sits as a low flat line.
        note: note.or(n),
    })
}

fn as_int(v: &OscType) -> Option<i32> {
    match v {
        OscType::Int(i) => Some(*i),
        OscType::Float(f) => Some(*f as i32),
        OscType::Double(f) => Some(*f as i32),
        _ => None,
    }
}

fn as_float(v: &OscType) -> Option<f64> {
    match v {
        OscType::Float(f) => Some(*f as f64),
        OscType::Double(f) => Some(*f),
        OscType::Int(i) => Some(*i as f64),
        _ => None,
    }
}
