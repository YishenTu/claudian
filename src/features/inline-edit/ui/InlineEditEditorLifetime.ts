import { StateEffect } from '@codemirror/state';
import { type EditorView, ViewPlugin } from '@codemirror/view';

const listeners = new WeakMap<EditorView, Set<() => void>>();
const lifetime = ViewPlugin.define(view => ({
  destroy() {
    const callbacks = listeners.get(view);
    listeners.delete(view);
    for (const callback of callbacks ?? []) callback();
  },
}));

/** Watches the editor, independently of input/preview widget replacement. */
export function onInlineEditEditorDestroyed(view: EditorView, callback: () => void): () => void {
  let callbacks = listeners.get(view);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(view, callbacks);
    view.dispatch({ effects: StateEffect.appendConfig.of(lifetime) });
  }
  callbacks.add(callback);
  return () => { callbacks.delete(callback); };
}
