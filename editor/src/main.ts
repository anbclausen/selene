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
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { invoke } from "@tauri-apps/api/core";

// Tidal is Haskell — reuse the legacy Haskell mode for syntax highlighting.
const tidalLanguage = StreamLanguage.define(haskell);

// The "block" under the cursor: contiguous non-blank lines around it, the way
// Tidal/Strudel eval works. Cmd/Ctrl-Enter sends it to ghci.
function blockAt(view: EditorView): string {
  const { state } = view;
  const { doc } = state;
  const cursorLine = doc.lineAt(state.selection.main.head).number;

  let first = cursorLine;
  while (first > 1 && doc.line(first - 1).text.trim() !== "") first--;
  let last = cursorLine;
  while (last < doc.lines && doc.line(last + 1).text.trim() !== "") last++;

  return doc.sliceString(doc.line(first).from, doc.line(last).to).trim();
}

function evalBlock(view: EditorView): boolean {
  const code = blockAt(view);
  if (code === "") return false;
  invoke("eval", { code }).catch((e) => console.error("eval failed:", e));
  return true;
}

// A starter pattern so the editor isn't empty on first launch.
const SEED = `-- Selene — live-coding with TidalCycles
-- (eval wiring lands next; for now this is just the editor)

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
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    // Eval keymap takes precedence so Mod-Enter isn't swallowed by defaults.
    keymap.of([{ key: "Mod-Enter", run: evalBlock, preventDefault: true }]),
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ],
});

const parent = document.querySelector<HTMLDivElement>("#editor");
if (!parent) {
  throw new Error("missing #editor mount point");
}

export const view = new EditorView({ state: startState, parent });
