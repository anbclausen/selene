import "./style.css";

import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { tags as t } from "@lezer/highlight";
import { LSPClient, type Transport, languageServerSupport, serverDiagnostics } from "@codemirror/lsp-client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// ── File state ───────────────────────────────────────────────────────────────
const RECENT_KEY = "selene:recentFiles";
const MAX_RECENT = 10;

let currentPath: string | null = null;
let isDirty = false;

const fileStatusEl = document.querySelector<HTMLDivElement>("#file-status")!;

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function updateFileStatus(): void {
  const name = currentPath ? basename(currentPath) : "untitled.tidal";
  fileStatusEl.textContent = isDirty ? `● ${name}` : name;
  fileStatusEl.classList.toggle("dirty", isDirty);
  const title = isDirty ? `● ${name} — Selene` : `${name} — Selene`;
  invoke("set_title", { title }).catch(() => {});
}

function markDirty(): void {
  if (!isDirty) { isDirty = true; updateFileStatus(); }
}

function markClean(): void {
  isDirty = false;
  updateFileStatus();
}

function addRecent(path: string): void {
  const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  const filtered = list.filter((p) => p !== path);
  filtered.unshift(path);
  localStorage.setItem(RECENT_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)));
}

// Returns false if user cancelled (chose not to discard unsaved changes).
async function confirmDiscard(): Promise<boolean> {
  if (!isDirty) return true;
  const name = currentPath ? basename(currentPath) : "untitled.tidal";
  // Tauri v2 message dialog doesn't support confirm natively in all builds;
  // use the browser confirm as fallback — it's reliable in the webview.
  return window.confirm(`"${name}" has unsaved changes. Discard and continue?`);
}

async function loadFile(path: string): Promise<void> {
  const text = await readTextFile(path);
  currentPath = path;
  addRecent(path);
  // Replace editor content without adding to undo history.
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  markClean();
}

async function saveToPath(path: string): Promise<void> {
  await writeTextFile(path, view.state.doc.toString());
  currentPath = path;
  addRecent(path);
  markClean();
}

async function fileNew(): Promise<void> {
  if (!(await confirmDiscard())) return;
  currentPath = null;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: SEED },
  });
  markClean();
}

async function fileOpen(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const selected = await dialogOpen({
    title: "Open Tidal file",
    filters: [{ name: "Tidal", extensions: ["tidal", "hs"] }],
    multiple: false,
  });
  if (selected && typeof selected === "string") {
    await loadFile(selected);
  }
}

async function fileSave(): Promise<void> {
  if (currentPath) {
    await saveToPath(currentPath);
  } else {
    await fileSaveAs();
  }
}

async function fileSaveAs(): Promise<void> {
  const path = await dialogSave({
    title: "Save Tidal file",
    filters: [{ name: "Tidal", extensions: ["tidal"] }],
    defaultPath: currentPath ?? "untitled.tidal",
  });
  if (path) await saveToPath(path);
}

// Guard the window close when there are unsaved changes.
getCurrentWebviewWindow().onCloseRequested(async (e) => {
  if (isDirty) {
    e.preventDefault();
    const ok = await confirmDiscard();
    if (ok) getCurrentWebviewWindow().close();
  }
}).catch(() => {});

// Tidal is Haskell — reuse the legacy Haskell mode for syntax highlighting.
const tidalLanguage = StreamLanguage.define(haskell);

// ── Moonlight dark theme ──────────────────────────────────────────────────
const seleneTheme = EditorView.theme(
  {
    "&": { color: "#cdeaf7", backgroundColor: "transparent", height: "100%" },
    ".cm-content": { caretColor: "#8fcdeb", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#8fcdeb" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "rgba(143, 205, 235, 0.22)" },
    ".cm-activeLine": { backgroundColor: "rgba(143, 205, 235, 0.06)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "rgba(143, 205, 235, 0.35)",
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "rgba(143, 205, 235, 0.1)" },
  },
  { dark: true },
);

const seleneHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#5b7fa6", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string)], color: "#8fcdeb" },
  { tag: [t.number, t.bool, t.atom], color: "#a9d6f5" },
  { tag: [t.keyword, t.definitionKeyword, t.operator], color: "#6fb0e6" },
  { tag: [t.variableName, t.propertyName], color: "#cdeaf7" },
  { tag: t.typeName, color: "#bfe3f7" },
  { tag: t.punctuation, color: "#7fa8ce" },
]);

// ── Sending code to Tidal ─────────────────────────────────────────────────
function evalCode(code: string): void {
  invoke("eval", { code }).catch((e) => console.error("eval failed:", e));
}

// Info about a single line: its text and the Tidal channel (dN) it defines.
function lineInfo(
  view: EditorView,
  lineNo?: number,
): { text: string; channel: number | null } {
  const n = lineNo ?? view.state.doc.lineAt(view.state.selection.main.head).number;
  const text = view.state.doc.line(n).text;
  const m = text.match(/\bd(\d+)\b/);
  return { text: text.trim(), channel: m ? Number(m[1]) : null };
}

// ── Transport state ───────────────────────────────────────────────────────
const playing = new Set<number>(); // channels currently sounding
const muted = new Set<number>();
const soloed = new Set<number>();

// Channel the Play button currently reflects: the hovered line if any, else the
// cursor's line. Lets hovering a line preview whether that track is live.
let hoverChannel: number | null = null;

// Cmd-Enter / Play button: toggle the line under the cursor. A dN line plays
// when off and goes silent when on; a non-track line just evals (helpers).
function togglePlayLine(view: EditorView): boolean {
  const { text, channel } = lineInfo(view);
  if (text === "") return false;

  if (channel === null) {
    evalCode(text);
    flash("play");
    return true;
  }
  if (playing.has(channel)) {
    evalCode(`d${channel} silence`);
    playing.delete(channel);
  } else {
    evalCode(text);
    playing.add(channel);
  }
  refreshTransport(view);
  flash("play");
  return true;
}

function hush(view: EditorView): boolean {
  evalCode("hush");
  evalCode("unmuteAll");
  evalCode("unsoloAll");
  playing.clear();
  muted.clear();
  soloed.clear();
  refreshTransport(view);
  flash("hush");
  return true;
}

function toggleMute(view: EditorView): boolean {
  const { channel } = lineInfo(view);
  if (channel === null) return false;
  if (muted.has(channel)) {
    evalCode(`unmute ${channel}`);
    muted.delete(channel);
  } else {
    evalCode(`mute ${channel}`);
    muted.add(channel);
  }
  refreshTransport(view);
  flash("mute");
  return true;
}

function toggleSolo(view: EditorView): boolean {
  const { channel } = lineInfo(view);
  if (channel === null) return false;
  if (soloed.has(channel)) {
    evalCode(`unsolo ${channel}`);
    soloed.delete(channel);
  } else {
    evalCode(`solo ${channel}`);
    soloed.add(channel);
  }
  refreshTransport(view);
  flash("solo");
  return true;
}

// ── Toolbar DOM ───────────────────────────────────────────────────────────
function button(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (!el) throw new Error(`missing #${id} button`);
  return el;
}

const buttons = {
  play: button("play"),
  hush: button("hush"),
  mute: button("mute"),
  solo: button("solo"),
};

function flash(id: keyof typeof buttons): void {
  const el = buttons[id];
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 150);
}

// Sync button states to the cursor's track (and the hovered line, for Play).
function refreshTransport(view: EditorView): void {
  const cursor = lineInfo(view).channel;
  const focus = hoverChannel ?? cursor;

  buttons.play.disabled = false;
  buttons.play.classList.toggle("active", focus !== null && playing.has(focus));

  const onTrack = cursor !== null;
  buttons.mute.disabled = !onTrack;
  buttons.solo.disabled = !onTrack;
  buttons.mute.classList.toggle("active", onTrack && muted.has(cursor));
  buttons.solo.classList.toggle("active", onTrack && soloed.has(cursor));
}

// ── Keyboard shortcuts (also shown under each button) ─────────────────────
const isMac = navigator.platform.toLowerCase().includes("mac");
const SHORTCUTS = {
  play: { key: "Mod-Enter", label: isMac ? "⌘↩" : "Ctrl+↵" },
  hush: { key: "Mod-.", label: isMac ? "⌘." : "Ctrl+." },
  mute: { key: "Mod-Shift-m", label: isMac ? "⇧⌘M" : "Ctrl+Shift+M" },
  solo: { key: "Mod-Shift-s", label: isMac ? "⇧⌘S" : "Ctrl+Shift+S" },
} as const;

document.querySelectorAll<HTMLElement>("[data-kbd]").forEach((el) => {
  const k = el.dataset.kbd as keyof typeof SHORTCUTS;
  el.textContent = SHORTCUTS[k].label;
});

const transportKeymap = keymap.of([
  { key: SHORTCUTS.play.key, run: togglePlayLine, preventDefault: true },
  { key: SHORTCUTS.hush.key, run: hush, preventDefault: true },
  { key: SHORTCUTS.mute.key, run: toggleMute, preventDefault: true },
  { key: SHORTCUTS.solo.key, run: toggleSolo, preventDefault: true },
]);

const fileKeymap = keymap.of([
  { key: "Mod-n", run: () => { fileNew(); return true; }, preventDefault: true },
  { key: "Mod-o", run: () => { fileOpen(); return true; }, preventDefault: true },
  { key: "Mod-s", run: () => { fileSave(); return true; }, preventDefault: true },
  { key: "Mod-Shift-s", run: () => { fileSaveAs(); return true; }, preventDefault: true },
]);

// ── LSP (HLS) ─────────────────────────────────────────────────────────────
// Transport backed by Tauri IPC. send/subscribe/unsubscribe satisfy the
// @codemirror/lsp-client Transport contract. Framing is in the Rust sidecar.
const lspSubscribers = new Set<(msg: string) => void>();

listen<string>("lsp-recv", (e) => {
  lspSubscribers.forEach((fn) => fn(e.payload));
}).catch((e) => console.warn("lsp-recv listener failed:", e));

const lspTransport: Transport = {
  send(msg: string) {
    invoke("lsp_send", { msg }).catch((e) => console.warn("lsp_send failed:", e));
  },
  subscribe(handler: (msg: string) => void) { lspSubscribers.add(handler); },
  unsubscribe(handler: (msg: string) => void) { lspSubscribers.delete(handler); },
};

const lspClient = new LSPClient({ extensions: [serverDiagnostics()] });
lspClient.connect(lspTransport);

// Compartment so we can inject languageServerSupport once we know the session URI.
const lspCompartment = new Compartment();

// ── Editor ────────────────────────────────────────────────────────────────
const SEED = `-- Selene — live-coding with TidalCycles
-- Cmd-Enter plays/stops the line under the cursor. Cmd-. hushes all.

d1 $ sound "bd sn cp hh"

d2 $ n "0 2 4 7" # sound "arpy"
`;

const startState = EditorState.create({
  doc: SEED,
  extensions: [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    tidalLanguage,
    seleneTheme,
    syntaxHighlighting(seleneHighlight),
    // File and transport keymaps take precedence so their combos aren't swallowed.
    fileKeymap,
    transportKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    lspCompartment.of([]),
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) refreshTransport(u.view);
      if (u.docChanged) markDirty();
    }),
  ],
});

const parent = document.querySelector<HTMLDivElement>("#editor");
if (!parent) {
  throw new Error("missing #editor mount point");
}

export const view = new EditorView({ state: startState, parent });

// Hovering a line lights the Play button to preview that track's play state.
view.dom.addEventListener("mousemove", (e) => {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  const ch = pos === null ? null : lineInfo(view, view.state.doc.lineAt(pos).number).channel;
  if (ch !== hoverChannel) {
    hoverChannel = ch;
    refreshTransport(view);
  }
});
view.dom.addEventListener("mouseleave", () => {
  if (hoverChannel !== null) {
    hoverChannel = null;
    refreshTransport(view);
  }
});

buttons.play.addEventListener("click", () => togglePlayLine(view));
buttons.hush.addEventListener("click", () => hush(view));
buttons.mute.addEventListener("click", () => toggleMute(view));
buttons.solo.addEventListener("click", () => toggleSolo(view));

refreshTransport(view);
updateFileStatus();
view.focus();

// ── LSP activation ───────────────────────────────────────────────────────
// Poll for the HLS session URI (available once the Rust sidecar has spawned HLS).
// Once we have it, inject languageServerSupport into the editor. HLS may take a
// few seconds to start; polling avoids a race with the boot thread. Gives up
// after 30 s — if HLS isn't up by then the editor runs without LSP features.
(async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const uri = await invoke<string | null>("lsp_session_uri").catch(() => null);
    if (uri) {
      view.dispatch({
        effects: lspCompartment.reconfigure(
          languageServerSupport(lspClient, uri, "haskell"),
        ),
      });
      return;
    }
  }
  console.warn("HLS did not start within 30 s — LSP features unavailable");
})();

// ── Backend crash banner ──────────────────────────────────────────────────
// The Rust shell emits `backend-crashed` when a sidecar exits unexpectedly.
type CrashPayload = { backend: string; code: number | null };

const FRIENDLY: Record<string, string> = {
  sclang: "SuperCollider (sound)",
  ghci: "Tidal (patterns)",
};

const banner = document.querySelector<HTMLDivElement>("#crash-banner")!;
const bannerText = banner.querySelector<HTMLSpanElement>(".banner-text")!;
document.querySelector<HTMLButtonElement>("#banner-close")!.addEventListener(
  "click",
  () => {
    banner.hidden = true;
  },
);

listen<CrashPayload>("backend-crashed", (e) => {
  const name = FRIENDLY[e.payload.backend] ?? e.payload.backend;
  bannerText.textContent = `⚠ The ${name} backend stopped unexpectedly. Restart Selene to recover.`;
  banner.hidden = false;
}).catch((e) => console.error("failed to listen for crashes:", e));

// ── Native menu events ────────────────────────────────────────────────────
listen<string>("menu", (e) => {
  switch (e.payload) {
    case "file-new":     fileNew();    break;
    case "file-open":    fileOpen();   break;
    case "file-save":    fileSave();   break;
    case "file-save-as": fileSaveAs(); break;
  }
}).catch((e) => console.error("failed to listen for menu events:", e));

// ── Autosave ──────────────────────────────────────────────────────────────
// Save every 30 s if the file has a path and is dirty. Skips untitled docs.
setInterval(() => {
  if (currentPath && isDirty) fileSave();
}, 30_000);
