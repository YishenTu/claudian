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

export function createSelectionHighlighter(): SelectionHighlighter {
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

  const installedEditors = new WeakSet<EditorView>();

  function ensureHighlightField(editorView: EditorView): void {
    if (!installedEditors.has(editorView)) {
      editorView.dispatch({
        effects: StateEffect.appendConfig.of(selectionHighlightField),
      });
      installedEditors.add(editorView);
    }
  }

  function show(editorView: EditorView, from: number, to: number): void {
    ensureHighlightField(editorView);
    editorView.dispatch({
      effects: showHighlight.of({ from, to }),
    });
  }

  function hide(editorView: EditorView): void {
    if (installedEditors.has(editorView)) {
      editorView.dispatch({
        effects: hideHighlight.of(null),
      });
    }
  }

  return { show, hide };
}

const defaultHighlighter = createSelectionHighlighter();

/** Shows selection highlight on the given range. */
export function showSelectionHighlight(editorView: EditorView, from: number, to: number): void {
  defaultHighlighter.show(editorView, from, to);
}

/** Hides selection highlight. */
export function hideSelectionHighlight(editorView: EditorView): void {
  defaultHighlighter.hide(editorView);
}
