import type { EditorView } from '@codemirror/view';
import type { Editor, EditorPosition } from 'obsidian';

function unsupported(): never {
  throw new Error('This Obsidian Editor operation is not modeled by the CodeMirror adapter.');
}

/** Obsidian's selection/position boundary over a real CodeMirror document and selection. */
export function createObsidianEditor(cm: EditorView): Editor & { cm: EditorView } {
  const editor: Editor & { cm: EditorView } = {
    cm,
    getDoc() { return this; },
    getValue: () => cm.state.doc.toString(),
    getLine: line => cm.state.doc.line(line + 1).text,
    lineCount: () => cm.state.doc.lines,
    lastLine: () => cm.state.doc.lines - 1,
    getSelection: () => cm.state.sliceDoc(cm.state.selection.main.from, cm.state.selection.main.to),
    somethingSelected: () => !cm.state.selection.main.empty,
    getCursor: (side = 'head') => editor.offsetToPos(cm.state.selection.main[side]),
    posToOffset: (pos: EditorPosition) => cm.state.doc.line(pos.line + 1).from + pos.ch,
    offsetToPos: offset => {
      const line = cm.state.doc.lineAt(offset);
      return { line: line.number - 1, ch: offset - line.from };
    },
    refresh: unsupported,
    setValue: unsupported,
    setLine: unsupported,
    getRange: unsupported,
    replaceSelection: unsupported,
    replaceRange: unsupported,
    listSelections: unsupported,
    setCursor: unsupported,
    setSelection: unsupported,
    setSelections: unsupported,
    focus: () => cm.focus(),
    blur: () => cm.contentDOM.blur(),
    hasFocus: () => cm.hasFocus,
    getScrollInfo: unsupported,
    scrollTo: unsupported,
    scrollIntoView: unsupported,
    undo: unsupported,
    redo: unsupported,
    exec: unsupported,
    transaction: unsupported,
    wordAt: unsupported,
    processLines: unsupported,
  };
  return editor;
}
