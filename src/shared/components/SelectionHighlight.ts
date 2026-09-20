/**
 * SelectionHighlight - Shared CM6 selection highlight for chat and inline edit
 *
 * Provides a reusable mechanism to highlight selected text in the editor
 * when focus moves elsewhere (e.g., to an input field).
 */

import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView } from '@codemirror/view';

export interface SelectionHighlighter {
  show: (editorView: EditorView, from: number, to: number) => void;
  hide: (editorView: EditorView) => void;
}

function createSelectionHighlighter(): SelectionHighlighter {
  const showHighlight = StateEffect.define<{ from: number; to: number }>();
  const hideHighlight = StateEffect.define<null>();

  const selectionHighlightField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (deco, tr) => {
      for (const e of tr.effects) {
        if (e.is(showHighlight)) {
          const builder = new RangeSetBuilder<Decoration>();
          builder.add(e.value.from, e.value.to, Decoration.mark({
            class: 'claudian-selection-highlight',
          }));
          return builder.finish();
        } else if (e.is(hideHighlight)) {
          return Decoration.none;
        }
      }
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Obsidian reuses one EditorView per leaf and swaps in a fresh state when
  // another note is opened, so installation is tracked on the state itself.
  function isFieldInstalled(editorView: EditorView): boolean {
    return editorView.state.field(selectionHighlightField, false) !== undefined;
  }

  function show(editorView: EditorView, from: number, to: number): void {
    if (!isFieldInstalled(editorView)) {
      editorView.dispatch({
        effects: StateEffect.appendConfig.of(selectionHighlightField),
      });
    }
    editorView.dispatch({
      effects: showHighlight.of({ from, to }),
    });
  }

  function hide(editorView: EditorView): void {
    if (isFieldInstalled(editorView)) {
      editorView.dispatch({
        effects: hideHighlight.of(null),
      });
    }
  }

  return { show, hide };
}

const defaultHighlighter = createSelectionHighlighter();

export function showSelectionHighlight(editorView: EditorView, from: number, to: number): void {
  defaultHighlighter.show(editorView, from, to);
}

export function hideSelectionHighlight(editorView: EditorView): void {
  defaultHighlighter.hide(editorView);
}
