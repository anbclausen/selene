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

// Tidal is Haskell — reuse the legacy Haskell mode for syntax highlighting.
const tidalLanguage = StreamLanguage.define(haskell);

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
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ],
});

const parent = document.querySelector<HTMLDivElement>("#editor");
if (!parent) {
  throw new Error("missing #editor mount point");
}

export const view = new EditorView({ state: startState, parent });
