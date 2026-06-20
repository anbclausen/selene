import "./style.css";

import { EditorState, StateField, StateEffect } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  hoverTooltip,
  Decoration,
  type DecorationSet,
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
import {
  autocompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  lintGutter,
  setDiagnostics,
  type Diagnostic,
} from "@codemirror/lint";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  open as dialogOpen,
  save as dialogSave,
} from "@tauri-apps/plugin-dialog";
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
  if (!isDirty) {
    isDirty = true;
    updateFileStatus();
  }
}

function markClean(): void {
  isDirty = false;
  updateFileStatus();
}

function addRecent(path: string): void {
  const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  const filtered = list.filter((p) => p !== path);
  filtered.unshift(path);
  localStorage.setItem(
    RECENT_KEY,
    JSON.stringify(filtered.slice(0, MAX_RECENT)),
  );
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

// In-app three-way "save before quitting?" modal. Tauri's `ask` dialog only
// offers two buttons, so we roll our own to get Save / Don't Save / Cancel.
function quitPrompt(): Promise<"save" | "discard" | "cancel"> {
  const modal = document.querySelector<HTMLDivElement>("#quit-modal")!;
  return new Promise((resolve) => {
    const done = (r: "save" | "discard" | "cancel") => {
      modal.hidden = true;
      document.removeEventListener("keydown", onKey);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done("cancel");
      if (e.key === "Enter") done("save");
    };
    document.querySelector<HTMLButtonElement>("#quit-save")!.onclick = () =>
      done("save");
    document.querySelector<HTMLButtonElement>("#quit-discard")!.onclick = () =>
      done("discard");
    document.querySelector<HTMLButtonElement>("#quit-cancel")!.onclick = () =>
      done("cancel");
    document.addEventListener("keydown", onKey);
    modal.hidden = false;
    document.querySelector<HTMLButtonElement>("#quit-save")!.focus();
  });
}

// Guard the window close when there are unsaved changes: offer to save on exit.
getCurrentWebviewWindow()
  .onCloseRequested(async (e) => {
    if (!isDirty) return;
    e.preventDefault();
    const choice = await quitPrompt();
    if (choice === "cancel") return; // abort quit, stay open
    if (choice === "save") await fileSave();
    getCurrentWebviewWindow().close();
  })
  .catch(() => {});

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
// The 1-based editor line a ghci error should attach to: ghci reports errors
// against its own internal line counter, not ours, so we pin any error that
// comes back to whatever line we last evaluated.
let lastEvalLine = 1;

function evalCode(code: string, lineNo?: number): void {
  lastEvalLine =
    lineNo ?? view.state.doc.lineAt(view.state.selection.main.head).number;
  // Optimistically clear the previous error; if this eval also fails, the
  // `eval-error` event below will re-mark the line a moment later.
  clearEvalError();
  invoke("eval", { code }).catch((e) => console.error("eval failed:", e));
}

// Info about a single line: its text and the Tidal channel (dN) it defines.
function lineInfo(
  view: EditorView,
  lineNo?: number,
): { text: string; channel: number | null } {
  const n =
    lineNo ?? view.state.doc.lineAt(view.state.selection.main.head).number;
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

// The contiguous run of non-blank lines around the cursor. Tidal editors eval
// blocks (paragraphs), not single lines — this is what lets a multi-line `do`
// arrangement, or a pattern split over several lines, play in one keystroke.
function blockInfo(view: EditorView): {
  text: string;
  channel: number | null;
  multiline: boolean;
  startLine: number;
} {
  const doc = view.state.doc;
  const cur = doc.lineAt(view.state.selection.main.head).number;
  let start = cur;
  let end = cur;
  while (start > 1 && doc.line(start - 1).text.trim() !== "") start--;
  while (end < doc.lines && doc.line(end + 1).text.trim() !== "") end++;

  const lines: string[] = [];
  for (let n = start; n <= end; n++) lines.push(doc.line(n).text);
  const text = lines.join("\n").trim();
  // Statements = non-blank, non-comment lines. One => a togglable single track.
  const stmts = lines.filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("--");
  });
  const m = text.match(/\bd(\d+)\b/);
  return {
    text,
    channel: m ? Number(m[1]) : null,
    multiline: stmts.length > 1,
    startLine: start,
  };
}

// Cmd-Enter / Play button: evaluate the block under the cursor. A single dN
// statement toggles play/silence; a multi-line block (e.g. a `do` arrangement)
// or a helper just evaluates — stop those with Hush (Cmd-.).
function togglePlayLine(view: EditorView): boolean {
  const { text, channel, multiline, startLine } = blockInfo(view);
  if (text === "") return false;

  if (multiline || channel === null) {
    evalCode(text, startLine);
    updatePianoroll(text, channel);
    updateScope(text, channel);
    updateArrangeStatus(text);
    flash("play");
    return true;
  }
  if (playing.has(channel)) {
    evalCode(`d${channel} silence`, startLine);
    playing.delete(channel);
    setPianoroll(channel, false);
    setScope(channel, false);
  } else {
    evalCode(text, startLine);
    playing.add(channel);
    updatePianoroll(text, channel);
    updateScope(text, channel);
    updateArrangeStatus(text);
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
  clearAllPianorolls();
  clearAllScopes();
  clearAllHighlights();
  clearArrangeStatus();
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
  {
    key: "Mod-n",
    run: () => {
      fileNew();
      return true;
    },
    preventDefault: true,
  },
  {
    key: "Mod-o",
    run: () => {
      fileOpen();
      return true;
    },
    preventDefault: true,
  },
  {
    key: "Mod-s",
    run: () => {
      fileSave();
      return true;
    },
    preventDefault: true,
  },
  {
    key: "Mod-Shift-s",
    run: () => {
      fileSaveAs();
      return true;
    },
    preventDefault: true,
  },
]);

// ── Autocomplete (Tidal vocabulary) ────────────────────────────────────────
// HLS was dropped: Tidal code isn't valid Haskell modules, so a language server
// fights it more than it helps. Instead we offer a curated, static dictionary
// of the functions/params a TidalCycles user actually reaches for. This matches
// what the standard editor plugins give (word/snippet completion, not semantic).
const TIDAL_WORDS: ReadonlyArray<[string, string, string]> = [
  // channels & transport
  ["d1", "function", "Play pattern on channel 1"],
  ["d2", "function", "Play pattern on channel 2"],
  ["d3", "function", "Play pattern on channel 3"],
  ["d4", "function", "Play pattern on channel 4"],
  ["d5", "function", "Play pattern on channel 5"],
  ["d6", "function", "Play pattern on channel 6"],
  ["d7", "function", "Play pattern on channel 7"],
  ["d8", "function", "Play pattern on channel 8"],
  ["d9", "function", "Play pattern on channel 9"],
  ["d10", "function", "Play pattern on channel 10"],
  ["d11", "function", "Play pattern on channel 11"],
  ["d12", "function", "Play pattern on channel 12"],
  ["d13", "function", "Play pattern on channel 13"],
  ["d14", "function", "Play pattern on channel 14"],
  ["d15", "function", "Play pattern on channel 15"],
  ["d16", "function", "Play pattern on channel 16"],
  ["hush", "function", "Silence every channel"],
  ["panic", "function", "Hush + kill any hanging synths"],
  ["once", "function", "Play a pattern once, immediately"],
  ["silence", "keyword", "The empty (silent) pattern"],
  ["getcps", "function", "Get the current cps (tempo)"],
  ["mute", "function", "Mute a channel"],
  ["unmute", "function", "Unmute a channel"],
  ["unmuteAll", "function", "Unmute all channels"],
  ["solo", "function", "Solo a channel"],
  ["unsolo", "function", "Unsolo a channel"],
  ["unsoloAll", "function", "Unsolo all channels"],
  ["setcps", "function", "Set cycles per second (tempo)"],
  ["resetCycles", "function", "Reset the cycle clock to 0"],
  // sources / control params
  ["sound", "function", 'Sample/synth name, e.g. sound "bd sn"'],
  ["s", "function", "Alias for sound"],
  ["n", "function", "Note/sample index pattern"],
  ["note", "function", "Note pattern (semitones)"],
  ["up", "function", "Pitch up/down in semitones"],
  ["vowel", "function", "Formant filter vowel"],
  ["gain", "function", "Volume"],
  ["pan", "function", "Stereo position (0–1)"],
  ["shape", "function", "Waveshaping distortion"],
  ["speed", "function", "Playback speed (pitch)"],
  ["accelerate", "function", "Sample acceleration"],
  ["crush", "function", "Bit-crush"],
  ["coarse", "function", "Sample-rate reduction"],
  ["cut", "function", "Cut group (chokes same group)"],
  ["cutoff", "function", "Low-pass filter cutoff"],
  ["resonance", "function", "Filter resonance"],
  ["room", "function", "Reverb amount"],
  ["size", "function", "Reverb size"],
  ["orbit", "function", "Output/effect bus"],
  ["delay", "function", "Delay send level"],
  ["delaytime", "function", "Delay time"],
  ["delayfeedback", "function", "Delay feedback"],
  ["legato", "function", "Note length multiplier"],
  ["sustain", "function", "Note sustain in seconds"],
  ["begin", "function", "Sample start point (0–1)"],
  ["end", "function", "Sample end point (0–1)"],
  // time / structure
  ["rev", "function", "Reverse the pattern"],
  ["fast", "function", "Speed up by a factor"],
  ["slow", "function", "Slow down by a factor"],
  ["hurry", "function", "fast + speed up samples"],
  ["density", "function", "Alias for fast"],
  ["sparsity", "function", "Alias for slow"],
  ["every", "function", 'every n f — apply f every n cycles'],
  ["every'", "function", "every' n o f — with offset"],
  ["whenmod", "function", "Apply f on certain cycle mods"],
  ["iter", "function", "Shift start point each cycle"],
  ["iter'", "function", "iter backwards"],
  ["palindrome", "function", "Alternate forwards/backwards"],
  ["rot", "function", "Rotate values, keep rhythm"],
  ["run", "function", "Pattern 0..n-1"],
  ["range", "function", "Scale a 0–1 pattern to a range"],
  ["segment", "function", "Sample a continuous pattern"],
  ["struct", "function", "Apply a boolean rhythm"],
  ["mask", "function", "Filter events by a boolean pattern"],
  ["euclid", "function", "euclid k n — Euclidean rhythm"],
  ["euclidInv", "function", "Inverted Euclidean rhythm"],
  ["euclidFull", "function", "Euclidean with filled rests"],
  ["stut", "function", "Echo with feedback"],
  ["echo", "function", "Echo (newer stut)"],
  ["off", "function", "off t f — layer a shifted copy"],
  ["superimpose", "function", "Layer a transformed copy"],
  ["layer", "function", "Apply a list of functions, stacked"],
  ["jux", "function", "Pan original L, transformed R"],
  ["juxBy", "function", "jux with a stereo width"],
  ["chunk", "function", "Apply f to a moving slice"],
  ["striate", "function", "Granular sample slicing"],
  ["chop", "function", "Chop samples into pieces"],
  ["loopAt", "function", "Stretch a sample over n cycles"],
  ["slice", "function", "Play indexed sample slices"],
  ["splice", "function", "slice + match speed to cycle"],
  ["ply", "function", "Repeat each event n times"],
  ["degrade", "function", "Randomly drop ~50% of events"],
  ["degradeBy", "function", "Randomly drop a fraction"],
  ["sometimes", "function", "Apply f to ~50% of events"],
  ["sometimesBy", "function", "Apply f to a fraction of events"],
  ["often", "function", "Apply f ~75% of the time"],
  ["rarely", "function", "Apply f ~25% of the time"],
  ["almostAlways", "function", "Apply f ~90% of the time"],
  ["almostNever", "function", "Apply f ~10% of the time"],
  ["someCycles", "function", "Apply f on some whole cycles"],
  ["swingBy", "function", "Add swing"],
  ["inside", "function", "Run f as if pattern were slower"],
  ["outside", "function", "Run f as if pattern were faster"],
  ["within", "function", "Apply f to part of the cycle"],
  ["compress", "function", "Squeeze pattern into a window"],
  ["zoom", "function", "Play a slice of the cycle"],
  // combinators / stacks
  ["stack", "function", "Layer patterns simultaneously"],
  ["overlay", "function", "Layer two patterns"],
  ["cat", "function", "One pattern per cycle, in turn"],
  ["fastcat", "function", "Squeeze patterns into one cycle"],
  ["slowcat", "function", "Alias for cat"],
  ["randcat", "function", "Random order each cycle"],
  ["append", "function", "Alternate two patterns by cycle"],
  ["timeCat", "function", "Concat with weights"],
  ["seqP", "function", "Sequence (start,end,pattern) tuples on a timeline"],
  ["seqPLoop", "function", "Like seqP, looping the whole sequence"],
  ["arrange", "function", "arrange [(start,end,pat),…] — build a looping track"],
  // scales / chords / randomness
  ["scale", "function", 'scale "major" — map to a scale'],
  ["toScale", "function", "Map to a custom scale list"],
  ["arp", "function", "Arpeggiate chords"],
  ["rand", "keyword", "Continuous random 0–1"],
  ["irand", "function", "Random integer 0..n-1"],
  ["perlin", "keyword", "Perlin noise 0–1"],
  ["choose", "function", "Randomly choose from a list"],
  ["wchoose", "function", "Weighted random choice"],
  ["shuffle", "function", "Shuffle parts of the cycle"],
  // Selene visualisation markers (passthrough = id, detected by the editor)
  ["_pianoroll", "function", "Show a scrolling piano roll for this channel"],
  ["_scope", "function", "Show this channel's waveform (oscilloscope)"],
];

const TIDAL_COMPLETIONS: Completion[] = TIDAL_WORDS.map(
  ([label, type, info]) => ({ label, type, info }),
);

function tidalCompletions(
  context: CompletionContext,
): CompletionResult | null {
  const word = context.matchBefore(/[\w']+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: TIDAL_COMPLETIONS };
}

// Same dictionary, keyed for O(1) hover lookup.
const TIDAL_INFO = new Map<string, { type: string; info: string }>(
  TIDAL_WORDS.map(([label, type, info]) => [label, { type, info }]),
);

// Hover a known Tidal word → show its kind and one-line description.
const tidalHover = hoverTooltip((view, pos) => {
  // Expand to the identifier under the cursor (allow trailing ' as in every').
  const { text, from: lineFrom } = view.state.doc.lineAt(pos);
  const rel = pos - lineFrom;
  const re = /[A-Za-z_][\w']*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (rel >= start && rel <= end) {
      const entry = TIDAL_INFO.get(m[0]);
      if (!entry) return null;
      const from = lineFrom + start;
      const to = lineFrom + end;
      return {
        pos: from,
        end: to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "tidal-tooltip";
          const head = dom.appendChild(document.createElement("div"));
          head.className = "tt-head";
          const name = head.appendChild(document.createElement("span"));
          name.className = "tt-name";
          name.textContent = m![0];
          const type = head.appendChild(document.createElement("span"));
          type.className = "tt-type";
          type.textContent = entry.type;
          const desc = dom.appendChild(document.createElement("div"));
          desc.className = "tt-info";
          desc.textContent = entry.info;
          return { dom };
        },
      };
    }
  }
  return null;
});

// ── Eval errors → editor diagnostics ────────────────────────────────────────
const errorConsole = document.querySelector<HTMLDivElement>("#error-console")!;

function showEvalError(message: string): void {
  const lineNo = Math.min(lastEvalLine, view.state.doc.lines);
  const line = view.state.doc.line(lineNo);
  const diag: Diagnostic = {
    from: line.from,
    to: line.to,
    severity: "error",
    message,
  };
  view.dispatch(setDiagnostics(view.state, [diag]));
  errorConsole.textContent = message;
  errorConsole.hidden = false;
}

function clearEvalError(): void {
  view.dispatch(setDiagnostics(view.state, []));
  errorConsole.hidden = true;
}

// ghci streams an error as a burst of stderr lines; collect them within a short
// window and surface the whole message at once.
let errorBuf: string[] = [];
let errorTimer: number | undefined;
listen<string>("eval-error", (e) => {
  errorBuf.push(e.payload);
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => {
    const message = errorBuf.join("\n").trim();
    errorBuf = [];
    if (message) showEvalError(message);
  }, 120);
}).catch((e) => console.error("failed to listen for eval errors:", e));

// ── Playing-step highlight (Strudel-style) ──────────────────────────────────
// Tidal mirrors its event stream to the Rust shell, which forwards each onset as
// a `tidal-event`. We light up the mini-notation step that's sounding right now.
// Exact for flat sequences; approximate for nested/`*`/`<>` groups (stock Tidal
// doesn't emit true source columns, so we infer the step from cycle position).
const playMark = Decoration.mark({ class: "cm-playing" });
const setPlaying = StateEffect.define<readonly { from: number; to: number }[]>();

const playingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setPlaying)) {
        return Decoration.set(
          e.value.map((r) => playMark.range(r.from, r.to)),
          true, // ranges are pre-sorted by `from`
        );
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Split a mini-notation string into its top-level steps, returning each step's
// char offsets within the string. Bracket groups ([] <> {} ()) count as one
// step; whitespace at depth 0 separates steps; `~` rests count as steps too so
// indices stay aligned with Tidal's.
function topLevelSteps(s: string): { start: number; end: number }[] {
  const open = "[<{(";
  const close = "]>})";
  const steps: { start: number; end: number }[] = [];
  let depth = 0;
  let tokStart = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : undefined;
    const isWs = c === undefined || /\s/.test(c);
    if (c !== undefined && open.includes(c)) {
      if (tokStart < 0) tokStart = i;
      depth++;
      continue;
    }
    if (c !== undefined && close.includes(c)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && isWs) {
      if (tokStart >= 0) {
        steps.push({ start: tokStart, end: i });
        tokStart = -1;
      }
    } else if (tokStart < 0) {
      tokStart = i;
    }
  }
  return steps;
}

// Find the char range of the step currently sounding on a given channel.
function activeStepRange(
  channel: number,
  cycle: number,
): { from: number; to: number } | null {
  const re = new RegExp(`\\bd${channel}\\b`);
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    if (line.text.trim().startsWith("--")) continue; // skip comment lines
    if (!re.test(line.text)) continue;
    const strMatch = line.text.match(/"([^"]*)"/);
    if (!strMatch || strMatch.index === undefined) return null;
    const contentStart = line.from + strMatch.index + 1;
    const steps = topLevelSteps(strMatch[1]);
    if (steps.length === 0) return null;
    const frac = cycle - Math.floor(cycle);
    const idx = Math.min(steps.length - 1, Math.floor(frac * steps.length));
    const step = steps[idx];
    return { from: contentStart + step.start, to: contentStart + step.end };
  }
  return null;
}

// One live highlight per channel; replaced/extended as new events arrive and
// cleared when the event's duration elapses.
type ActiveHL = { from: number; to: number; timer: number };
const activeHighlights = new Map<number, ActiveHL>();

function pushHighlights(): void {
  const ranges = [...activeHighlights.values()]
    .map(({ from, to }) => ({ from, to }))
    .sort((a, b) => a.from - b.from);
  view.dispatch({ effects: setPlaying.of(ranges) });
}

// Cancel every pending expiry timer and drop all highlights at once (on Hush,
// so the editor doesn't keep a stale step lit for up to its duration).
function clearAllHighlights(): void {
  for (const hl of activeHighlights.values()) clearTimeout(hl.timer);
  activeHighlights.clear();
  pushHighlights();
}

type TidalEvent = { orbit: number; cycle: number; delta: number; s: string | null; note: number | null };

listen<TidalEvent>("tidal-event", (e) => {
  const { orbit, cycle, delta, note } = e.payload;
  const channel = orbit + 1;

  // Feed the pianoroll buffer ONLY for channels with an active canvas. The
  // arrays are pruned while drawing, which only happens for active channels —
  // buffering inactive ones would grow them without bound.
  if (activePianorolls.has(channel)) {
    const buf = pianoRollEvents.get(channel) ?? [];
    buf.push({ receivedAt: Date.now(), delta, note });
    pianoRollEvents.set(channel, buf);
  }

  // Step highlight.
  const range = activeStepRange(channel, cycle);
  if (!range) return;
  const prev = activeHighlights.get(channel);
  if (prev) clearTimeout(prev.timer);
  const durMs = Math.max(80, Math.min(600, delta * 1000));
  const timer = window.setTimeout(() => {
    activeHighlights.delete(channel);
    pushHighlights();
  }, durMs);
  activeHighlights.set(channel, { ...range, timer });
  pushHighlights();
}).catch((err) => console.error("failed to listen for tidal events:", err));

// Waveform frames from the scope tap; store the latest per channel (drawn by
// the viz loop only for channels with an active scope).
type ScopeFrame = { orbit: number; samples: number[] };
listen<ScopeFrame>("scope-frame", (e) => {
  const channel = e.payload.orbit + 1;
  if (activeScopes.has(channel)) scopeFrames.set(channel, e.payload.samples);
}).catch((err) => console.error("failed to listen for scope frames:", err));

// ── Piano roll visualisation ──────────────────────────────────────────────
// Opt-in per channel by writing `pianoroll` anywhere in a dN block. `pianoroll`
// is defined as `id` in BootTidal — pure passthrough, no audio effect. We render
// each active channel as a scrolling canvas in a panel below the editor (NOT
// inline between code lines: block widgets inside the contenteditable scramble
// the cursor/selection). Canvases are fed by the `tidal-event` stream.

interface PianoRollEvent {
  receivedAt: number; // Date.now() ms
  delta: number;      // event duration in seconds
  note: number | null;
}

// Per-channel rolling event buffer (kept pruned to the visible window + margin).
const pianoRollEvents = new Map<number, PianoRollEvent[]>();

// Channels with pianoroll currently active, → their canvas in the panel.
const activePianorolls = new Map<number, HTMLCanvasElement>();

// Channels with a scope active, → their canvas; plus the latest waveform frame.
const activeScopes = new Map<number, HTMLCanvasElement>();
const scopeFrames = new Map<number, number[]>();

const vizPanel = document.querySelector<HTMLDivElement>("#viz-panel")!;

// The panel is shown whenever any visualisation (piano roll or scope) is live.
function updateVizPanelVisibility(): void {
  vizPanel.hidden = activePianorolls.size === 0 && activeScopes.size === 0;
}

// Total time span across the canvas width. The playhead ("now") sits at the
// centre: the left half is the recent past, the right half is the near future.
const PIANOROLL_WINDOW_MS = 4000;

// Tidal/SuperDirt deliver each event slightly before it sounds, so we treat an
// event's play moment as its receipt time plus this offset: a fresh event
// appears right of centre and crosses the playhead when it should sound. It's
// user-tunable (persisted) to line the visuals up with the audio on their rig.
const LATENCY_KEY = "selene:visualLatencyMs";
const DEFAULT_VISUAL_LATENCY_MS = 300;

function loadVisualLatency(): number {
  const v = Number(localStorage.getItem(LATENCY_KEY));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_VISUAL_LATENCY_MS;
}

let visualLatencyMs = loadVisualLatency();

const latencyInput = document.querySelector<HTMLInputElement>("#latency")!;
latencyInput.value = String(visualLatencyMs);
latencyInput.addEventListener("change", () => {
  const v = Number(latencyInput.value);
  if (Number.isFinite(v) && v >= 0) {
    visualLatencyMs = v;
    localStorage.setItem(LATENCY_KEY, String(v));
  } else {
    latencyInput.value = String(visualLatencyMs); // reject bad input
  }
});

function drawPianoRoll(canvas: HTMLCanvasElement, channel: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Sync the backing store to the element's displayed size (handles resize/DPR).
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const now = Date.now();
  const W = cssW;
  const H = cssH;
  const center = W / 2; // the playhead — "now"
  const pxPerMs = W / PIANOROLL_WINDOW_MS;

  // An event's x: future to the right of centre, past to the left. It crosses
  // the playhead at its play moment (receivedAt + lookahead).
  const xOf = (ev: PianoRollEvent) =>
    center + (ev.receivedAt + visualLatencyMs - now) * pxPerMs;

  // Prune anything that has scrolled off the left edge (plus a margin).
  const maxAge = PIANOROLL_WINDOW_MS + visualLatencyMs + 2000;
  const all = (pianoRollEvents.get(channel) ?? []).filter(
    (e) => now - e.receivedAt < maxAge,
  );
  pianoRollEvents.set(channel, all);

  // Background.
  ctx.fillStyle = "#0d1821";
  ctx.fillRect(0, 0, W, H);

  // Pitch range from events currently on screen.
  const visible = all.filter((e) => {
    const x = xOf(e);
    return x >= -8 && x <= W + 8;
  });
  const pitched = visible.map((e) => e.note).filter((n) => n !== null) as number[];
  const hasPitch = pitched.length > 0;
  const minNote = hasPitch ? Math.floor(Math.min(...pitched)) - 1 : 0;
  const maxNote = hasPitch ? Math.ceil(Math.max(...pitched)) + 1 : 1;
  const noteRange = Math.max(maxNote - minNote, 1);
  const rowH = H / noteRange;

  // Draw subtle pitch grid lines.
  if (hasPitch) {
    ctx.strokeStyle = "rgba(143,205,235,0.07)";
    ctx.lineWidth = 1;
    for (let n = minNote; n <= maxNote; n++) {
      const y = H - (n - minNote) * rowH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }

  // Draw events as filled rectangles. Brighten the one currently at the
  // playhead; dim those still in the future so the eye reads left-to-right.
  for (const ev of visible) {
    const x = xOf(ev);
    const w = Math.max(3, ev.delta * 1000 * pxPerMs - 1);
    const isFuture = x > center + 1;
    const atPlayhead = x <= center + 1 && x + w >= center - 1;
    ctx.fillStyle = atPlayhead ? "#aee4ff" : isFuture ? "#3a6f8f" : "#4fa8d5";

    if (ev.note !== null) {
      const y = H - (ev.note - minNote + 1) * rowH;
      ctx.fillRect(x, y + 1, w, Math.max(rowH - 2, 2));
    } else {
      // Drum/unpitched: thin accent line at bottom.
      ctx.fillRect(x, H - 6, w, 5);
    }
  }

  // Centre playhead line.
  ctx.strokeStyle = "rgba(174,228,255,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center, 0);
  ctx.lineTo(center, H);
  ctx.stroke();
}

// One shared rAF loop, running only while at least one channel is active.
let vizRaf: number | undefined;

function renderVizFrame(): void {
  for (const [channel, canvas] of activePianorolls) drawPianoRoll(canvas, channel);
  for (const [channel, canvas] of activeScopes) drawScope(canvas, channel);
  vizRaf =
    activePianorolls.size > 0 || activeScopes.size > 0
      ? requestAnimationFrame(renderVizFrame)
      : undefined;
}

function startVizLoop(): void {
  if (vizRaf === undefined && (activePianorolls.size > 0 || activeScopes.size > 0)) {
    vizRaf = requestAnimationFrame(renderVizFrame);
  }
}

// Build a labelled canvas track and append it to the panel.
function makeVizTrack(
  kind: "pianoroll" | "scope",
  channel: number,
): HTMLCanvasElement {
  const track = document.createElement("div");
  track.className = "viz-track";
  track.dataset.viz = kind;
  track.dataset.channel = String(channel);
  const label = document.createElement("span");
  label.className = "viz-label";
  label.textContent = `d${channel}`;
  const canvas = document.createElement("canvas");
  canvas.className = "pianoroll-canvas";
  track.append(label, canvas);
  vizPanel.append(track);
  return canvas;
}

function removeVizTrack(kind: "pianoroll" | "scope", channel: number): void {
  vizPanel
    .querySelector(`.viz-track[data-viz="${kind}"][data-channel="${channel}"]`)
    ?.remove();
}

// Add or remove a channel's piano-roll track, reconciling panel visibility.
function setPianoroll(channel: number, on: boolean): void {
  const existing = activePianorolls.get(channel);
  if (on && !existing) {
    activePianorolls.set(channel, makeVizTrack("pianoroll", channel));
    updateVizPanelVisibility();
    startVizLoop();
  } else if (!on && existing) {
    activePianorolls.delete(channel);
    pianoRollEvents.delete(channel); // free the buffer; no canvas feeds it now
    removeVizTrack("pianoroll", channel);
    updateVizPanelVisibility();
  }
}

// Called by togglePlayLine after each eval: flip a channel's pianoroll on/off
// based on whether `pianoroll` appears in the evaluated block.
function updatePianoroll(text: string, channel: number | null): void {
  if (channel === null) return;
  setPianoroll(channel, /\b_pianoroll\b/.test(text));
}

function clearAllPianorolls(): void {
  for (const channel of [...activePianorolls.keys()]) setPianoroll(channel, false);
}

// ── Scope (waveform) ───────────────────────────────────────────────────────
// Fed by `scope-frame` events: the latest waveform buffer for each orbit. We
// draw it as a centred oscilloscope trace on the channel's canvas.
function drawScope(canvas: HTMLCanvasElement, channel: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;
  const mid = H / 2;

  ctx.fillStyle = "#0d1821";
  ctx.fillRect(0, 0, W, H);

  // Zero line.
  ctx.strokeStyle = "rgba(143,205,235,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.stroke();

  const samples = scopeFrames.get(channel);
  if (!samples || samples.length === 0) return;

  ctx.strokeStyle = "#aee4ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * W;
    const y = mid - samples[i] * mid * 0.95; // clamp-ish; loud signals clip at edges
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function setScope(channel: number, on: boolean): void {
  const existing = activeScopes.get(channel);
  if (on && !existing) {
    activeScopes.set(channel, makeVizTrack("scope", channel));
    updateVizPanelVisibility();
    startVizLoop();
  } else if (!on && existing) {
    activeScopes.delete(channel);
    scopeFrames.delete(channel);
    removeVizTrack("scope", channel);
    updateVizPanelVisibility();
  }
}

function updateScope(text: string, channel: number | null): void {
  if (channel === null) return;
  setScope(channel, /\b_scope\b/.test(text));
}

function clearAllScopes(): void {
  for (const channel of [...activeScopes.keys()]) setScope(channel, false);
}

// ── Arrangement length readout ──────────────────────────────────────────────
// When an `arrange [(start,end,pat),…]` block is evaluated, show how long the
// arrangement runs (its last end-cycle) and the wall-clock duration derived from
// the current tempo, so you can see the shape of the track at a glance.
const arrangeStatusEl =
  document.querySelector<HTMLDivElement>("#arrange-status")!;

// Total cycles = the largest end-cycle across the tuples, or null if none parse.
function arrangeEndCycle(text: string): number | null {
  let max = -Infinity;
  // Match the (start, end, … of each tuple — the second number is the end.
  const re = /\(\s*[\d.]+\s*,\s*([\d.]+)\s*,/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = parseFloat(m[1]);
    if (!Number.isNaN(end)) max = Math.max(max, end);
  }
  return max === -Infinity ? null : max;
}

// Read the most recent `setcps (…)` from the document and reduce it to a cps
// number. Handles the common `bpm/60/4` and bare-number forms; null if unparsable.
function currentCps(): number | null {
  const re = /setcps\s*\(?\s*([\d.]+(?:\s*\/\s*[\d.]+)*)/g;
  let last: string | null = null;
  const doc = view.state.doc.toString();
  for (let m = re.exec(doc); m; m = re.exec(doc)) last = m[1];
  if (last === null) return null;
  const nums = last.split("/").map((p) => parseFloat(p.trim()));
  if (nums.some((n) => Number.isNaN(n))) return null;
  // Left-fold the division: [130,60,4] -> 130/60/4.
  const cps = nums.reduce((acc, n, i) => (i === 0 ? n : acc / n));
  return Number.isFinite(cps) && cps > 0 ? cps : null;
}

function updateArrangeStatus(text: string): void {
  if (!/\barrange\b/.test(text)) return; // leave any existing readout as-is
  const cycles = arrangeEndCycle(text);
  if (cycles === null) {
    arrangeStatusEl.hidden = true;
    return;
  }
  const cps = currentCps();
  let label = `↻ ${cycles} cycles`;
  if (cps !== null) {
    const secs = Math.round(cycles / cps);
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, "0");
    // bpm assumes the conventional 4 beats per cycle (setcps (bpm/60/4)).
    const bpm = Math.round(cps * 240);
    label = `↻ ${cycles} cycles @ ${bpm} BPM = ${mm}:${ss}`;
  }
  arrangeStatusEl.textContent = label;
  arrangeStatusEl.hidden = false;
}

function clearArrangeStatus(): void {
  arrangeStatusEl.hidden = true;
}

// ── Editor ────────────────────────────────────────────────────────────────
const SEED = `-- Selene — live-coding with TidalCycles
-- Cmd-Enter plays the block under the cursor. Cmd-. hushes all.

setcps (130/60/4)   -- 130 BPM

-- Drums
d1 $ sound "bd*4"

d2 $ sound "~ cp"

d3 $ sound "hh*8" # gain 0.7

-- A little melody (the piano roll shows it scrolling by)
d4 $ _pianoroll $ n "0 2 4 7" # sound "arpy" # room 0.3

-- Arrangement: build a track over cycles, then it loops. Run resetCycles to
-- start from the top. Uncomment and press Play on the block:
-- resetCycles
-- d1 $ arrange
--   [ (0, 16, sound "bd*4")
--   , (4, 16, sound "hh*8" # gain 0.7)
--   , (8, 16, sound "~ cp")
--   , (12, 16, n "0 2 4 7" # sound "arpy" # room 0.3)
--   ]
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
    autocompletion({ override: [tidalCompletions] }),
    tidalHover,
    lintGutter(),
    playingField,
    // File and transport keymaps take precedence so their combos aren't swallowed.
    fileKeymap,
    transportKeymap,
    keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
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
  const ch =
    pos === null
      ? null
      : lineInfo(view, view.state.doc.lineAt(pos).number).channel;
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

// ── Backend crash banner ──────────────────────────────────────────────────
// The Rust shell emits `backend-crashed` when a sidecar exits unexpectedly.
type CrashPayload = { backend: string; code: number | null };

const FRIENDLY: Record<string, string> = {
  sclang: "SuperCollider (sound)",
  ghci: "Tidal (patterns)",
};

const banner = document.querySelector<HTMLDivElement>("#crash-banner")!;
const bannerText = banner.querySelector<HTMLSpanElement>(".banner-text")!;
document
  .querySelector<HTMLButtonElement>("#banner-close")!
  .addEventListener("click", () => {
    banner.hidden = true;
  });

listen<CrashPayload>("backend-crashed", (e) => {
  const name = FRIENDLY[e.payload.backend] ?? e.payload.backend;
  bannerText.textContent = `⚠ The ${name} backend stopped unexpectedly. Restart Selene to recover.`;
  banner.hidden = false;
}).catch((e) => console.error("failed to listen for crashes:", e));

// ── Native menu events ────────────────────────────────────────────────────
listen<string>("menu", (e) => {
  switch (e.payload) {
    case "file-new":
      fileNew();
      break;
    case "file-open":
      fileOpen();
      break;
    case "file-save":
      fileSave();
      break;
    case "file-save-as":
      fileSaveAs();
      break;
  }
}).catch((e) => console.error("failed to listen for menu events:", e));

// ── Sound browser ──────────────────────────────────────────────────────────
// Lists the sample banks SuperDirt loaded (name + count), reported by sclang at
// boot via `samples-loaded` (and queryable with `list_samples` for late mounts).
// Click a bank to audition it (`once $ sound "name"`); double-click to insert.
type SampleBank = { name: string; count: number };

const soundBrowser = document.querySelector<HTMLElement>("#sound-browser")!;
const sbList = document.querySelector<HTMLDivElement>("#sb-list")!;
const sbSearch = document.querySelector<HTMLInputElement>("#sb-search")!;
const soundsBtn = document.querySelector<HTMLButtonElement>("#sounds")!;

let sampleBanks: SampleBank[] = [];
// "loading" until samples arrive (or we give up); drives the empty-state text so
// it can't sit on "Waiting…" forever when the backend never reports anything.
let sampleState: "loading" | "ready" | "timeout" = "loading";

function emptyStateText(): string {
  if (sampleBanks.length > 0) return "No banks match your search.";
  switch (sampleState) {
    case "loading":
      return "Waiting for SuperDirt to load samples…";
    case "timeout":
      return "No samples loaded. Is the SuperCollider backend running? Restart Selene to retry.";
    case "ready":
      return "No sample banks were loaded.";
  }
}

// Best-effort grouping of sample banks into musical categories. Dirt-Samples
// folders carry no metadata, so we classify by name with ordered keyword rules
// (first match wins); anything unrecognised falls into "Other".
const CATEGORY_RULES: ReadonlyArray<[string, RegExp]> = [
  ["Kicks & Drums", /^(bd|kick|sd|sn|snare|cp|clap|rs|rim|hand|808|909|707|606|dr|linn)|drum/],
  ["Hats & Cymbals", /^(hh|oh|ho|hc|hat|cy|cr|rd|ride)|hat|cymbal|crash|ride/],
  ["Percussion", /perc|tom|conga|bongo|tabla|clave|cowbell|^cb|shak|tamb|wood|block|click|metal|maraca|guiro|cabasa/],
  ["Bass", /bass|^sub|808bass/],
  ["Synth & Melodic", /arp|pad|piano|key|organ|string|brass|lead|pluck|bell|chord|note|synth|moog|casio|juno|rhodes|guitar|gtr|sax|flute|harp|mando|xylo|marimba|kalimba|sitar|stab|saw|sine|square/],
  ["Vocal", /voc|vox|voice|speak|speech|breath|sing|choir|number|alphabet/],
  ["FX & Noise", /fx|noise|glitch|^hit|blip|zap|sweep|ris|drone|atmos|space|wind|rain|bird|industrial|amen|scratch/],
];

function classify(name: string): string {
  const n = name.toLowerCase();
  for (const [label, re] of CATEGORY_RULES) if (re.test(n)) return label;
  return "Other";
}

const CATEGORY_ORDER = [
  "Kicks & Drums",
  "Hats & Cymbals",
  "Percussion",
  "Bass",
  "Synth & Melodic",
  "Vocal",
  "FX & Noise",
  "Other",
];

// Flat list of rendered bank rows in display order — the basis for keyboard
// navigation. `selectedName` survives re-renders (search/filter) by name.
let navItems: { bank: SampleBank; el: HTMLElement }[] = [];
let selectedName: string | null = null;

// Collapsed categories (persisted). An active search ignores this and shows all
// so results are never hidden.
const COLLAPSE_KEY = "selene:collapsedCats";
const collapsedCategories = new Set<string>(
  JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]"),
);

function toggleCategory(cat: string): void {
  if (collapsedCategories.has(cat)) collapsedCategories.delete(cat);
  else collapsedCategories.add(cat);
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedCategories]));
  renderSampleBanks();
}

function renderSampleBanks(): void {
  const query = sbSearch.value.trim().toLowerCase();
  const searching = query !== "";
  const matches = searching
    ? sampleBanks.filter((b) => b.name.toLowerCase().includes(query))
    : sampleBanks;

  sbList.replaceChildren();
  navItems = [];
  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = emptyStateText();
    sbList.append(empty);
    return;
  }

  const groups = new Map<string, SampleBank[]>();
  for (const bank of matches) {
    const cat = classify(bank.name);
    const list = groups.get(cat) ?? [];
    list.push(bank);
    groups.set(cat, list);
  }

  for (const cat of CATEGORY_ORDER) {
    const banks = groups.get(cat);
    if (!banks || banks.length === 0) continue;
    banks.sort((a, b) => a.name.localeCompare(b.name));

    // Collapsed only when not actively searching.
    const collapsed = !searching && collapsedCategories.has(cat);

    const header = document.createElement("div");
    header.className = "sb-cat";
    header.classList.toggle("collapsed", collapsed);
    const caret = document.createElement("span");
    caret.className = "sb-caret";
    caret.textContent = collapsed ? "▸" : "▾";
    const title = document.createElement("span");
    title.textContent = cat;
    const tally = document.createElement("span");
    tally.className = "sb-cat-count";
    tally.textContent = String(banks.length);
    header.append(caret, title, tally);
    header.addEventListener("click", () => toggleCategory(cat));
    sbList.append(header);

    if (collapsed) continue;

    for (const bank of banks) {
      const item = document.createElement("div");
      item.className = "sb-item";
      item.title = `${bank.name} — ${bank.count} sample${bank.count === 1 ? "" : "s"}`;
      const name = document.createElement("span");
      name.className = "sb-name";
      name.textContent = bank.name;
      const count = document.createElement("span");
      count.className = "sb-count";
      count.textContent = String(bank.count);
      item.append(name, count);
      // Click selects + previews; double-click inserts.
      item.addEventListener("click", () => {
        selectedName = bank.name;
        highlightSelection();
        previewSound(bank.name);
      });
      item.addEventListener("dblclick", () => insertSound(bank.name));
      navItems.push({ bank, el: item });
      sbList.append(item);
    }
  }

  // Drop a selection that's no longer visible (filtered out or collapsed away).
  if (selectedName && !navItems.some((i) => i.bank.name === selectedName)) {
    selectedName = null;
  }
  highlightSelection();
}

function highlightSelection(): void {
  for (const { bank, el } of navItems) {
    const on = bank.name === selectedName;
    el.classList.toggle("selected", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  }
}

// Move the selection by `delta` rows (clamped) and audition the new one. From
// no selection, ↓ lands on the first row and ↑ on the last.
function moveSelection(delta: number): void {
  if (navItems.length === 0) return;
  let idx = navItems.findIndex((i) => i.bank.name === selectedName);
  if (idx < 0) idx = delta > 0 ? -1 : navItems.length;
  idx = Math.max(0, Math.min(navItems.length - 1, idx + delta));
  selectedName = navItems[idx].bank.name;
  highlightSelection();
  previewSound(selectedName);
}

// Auditioning a sound plays it `once`. Route it to the last orbit (d12) rather
// than the default orbit 0 — otherwise the tidal-event it produces reads as
// channel d1 and lights up the d1 step in the editor. d12 is rarely used, so a
// stray highlight there is unlikely and at worst momentary.
const PREVIEW_ORBIT = 11;

function previewSound(name: string): void {
  invoke("eval", {
    code: `once $ sound "${name}" # orbit ${PREVIEW_ORBIT}`,
  }).catch((e) => console.error("preview failed:", e));
}

function insertSound(name: string): void {
  const snippet = `sound "${name}"`;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: snippet },
    selection: { anchor: from + snippet.length },
  });
  view.focus();
}

function setSampleBanks(banks: SampleBank[]): void {
  sampleBanks = banks;
  sampleState = "ready";
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  renderSampleBanks();
}

function closeSoundBrowser(): void {
  soundBrowser.hidden = true;
  soundsBtn.classList.remove("active");
  view.focus();
}

sbSearch.addEventListener("input", renderSampleBanks);
soundsBtn.addEventListener("click", () => {
  const show = soundBrowser.hidden === true;
  soundBrowser.hidden = !show;
  soundsBtn.classList.toggle("active", show);
  if (show) sbSearch.focus();
});
document
  .querySelector<HTMLButtonElement>("#sb-close")!
  .addEventListener("click", closeSoundBrowser);

// Keyboard navigation: ↑/↓ move + audition, Enter inserts, Esc closes. Bound on
// the whole drawer so it works while the search box is focused (arrows/Enter
// don't do anything useful in a single-line input anyway).
soundBrowser.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveSelection(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveSelection(-1);
      break;
    case "Enter":
      if (selectedName) {
        e.preventDefault();
        insertSound(selectedName);
      }
      break;
    case "Escape":
      e.preventDefault();
      closeSoundBrowser();
      break;
  }
});

// Two ways samples arrive: the `samples-loaded` event (fast path, when sclang
// finishes after we've mounted) and polling `list_samples` (covers a boot that
// finished before mount, or a missed event). Whichever lands first wins; the
// poll stops on success or after a timeout so the panel can't hang on "Waiting…".
const SAMPLE_POLL_MS = 1500;
const SAMPLE_TIMEOUT_MS = 90_000; // generous: cold SuperDirt boot can be slow
let pollTimer: number | undefined;
const pollStarted = Date.now();

listen<SampleBank[]>("samples-loaded", (e) => setSampleBanks(e.payload)).catch(
  (e) => console.error("failed to listen for samples:", e),
);

function pollSamples(): void {
  invoke<SampleBank[]>("list_samples")
    .then((banks) => {
      if (banks.length > 0) {
        setSampleBanks(banks); // clears the timer
      } else if (Date.now() - pollStarted > SAMPLE_TIMEOUT_MS) {
        sampleState = "timeout";
        if (pollTimer !== undefined) clearInterval(pollTimer);
        pollTimer = undefined;
        renderSampleBanks();
      }
    })
    .catch((e) => console.error("list_samples failed:", e));
}

pollTimer = window.setInterval(pollSamples, SAMPLE_POLL_MS);
pollSamples(); // fire immediately; don't wait out the first interval
renderSampleBanks();

// ── Autosave ──────────────────────────────────────────────────────────────
// Save every 30 s if the file has a path and is dirty. Skips untitled docs.
setInterval(() => {
  if (currentPath && isDirty) fileSave();
}, 30_000);
