import "./style.css";

import { EditorState } from "@codemirror/state";
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
import { invoke } from "@tauri-apps/api/core";

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
    // Transport keymap takes precedence so its combos aren't swallowed.
    transportKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) refreshTransport(u.view);
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
view.focus();
