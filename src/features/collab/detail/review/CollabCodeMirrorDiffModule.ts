import { standardKeymap } from '@codemirror/commands';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { Compartment, EditorState, Text } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import type { CollabDiffLayout, CollabDiffTheme } from './CollabDiffRenderer';

interface DiffViewInput {
  readonly parent: HTMLElement;
  readonly oldText: string;
  readonly newText: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly layout: CollabDiffLayout;
  readonly theme: CollabDiffTheme;
}

function themeExtension(theme: CollabDiffTheme) {
  return EditorView.theme({
    '&': { backgroundColor: 'var(--background-primary)', color: 'var(--text-normal)' },
    '.cm-scroller': { fontFamily: 'var(--font-monospace)' },
    '.cm-gutters': {
      backgroundColor: 'var(--background-primary)',
      color: 'var(--text-muted)',
      borderColor: 'var(--background-modifier-border)',
    },
  }, { dark: theme === 'dark' });
}

export function createDiffView(input: DiffViewInput) {
  const theme = new Compartment();
  const extensions = (name: string) => [
    EditorState.readOnly.of(true),
    EditorState.lineSeparator.of('\n'),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ 'aria-label': name, 'aria-readonly': 'true', tabindex: '0' }),
    EditorView.lineWrapping,
    lineNumbers(),
    keymap.of(standardKeymap),
    theme.of(themeExtension(input.theme)),
  ];
  const options = {
    collapseUnchanged: { margin: 3, minSize: 6 },
    diffConfig: { scanLimit: 500, timeout: 100 },
    gutter: true,
    highlightChanges: true,
  };
  const view = input.layout === 'split'
    ? new MergeView({
      ...options,
      a: { doc: Text.of(input.oldText.split('\n')), extensions: extensions(input.previousPath ?? input.path) },
      b: { doc: Text.of(input.newText.split('\n')), extensions: extensions(input.path) },
      parent: input.parent,
      root: input.parent.ownerDocument,
    })
    : new EditorView({
      doc: Text.of(input.newText.split('\n')),
      extensions: [
        ...extensions(input.path),
        unifiedMergeView({
          ...options,
          mergeControls: false,
          original: Text.of(input.oldText.split('\n')),
          syntaxHighlightDeletions: false,
        }),
      ],
      parent: input.parent,
      root: input.parent.ownerDocument,
    });
  const editors = view instanceof MergeView ? [view.a, view.b] : [view];
  const releaseControls = accessibleCollapseControls(input.parent);
  return {
    destroy() {
      releaseControls();
      view.destroy();
    },
    setTheme(value: CollabDiffTheme) {
      for (const editor of editors) {
        editor.dispatch({ effects: theme.reconfigure(themeExtension(value)) });
      }
    },
  };
}

// CodeMirror owns these widgets and their click behavior, but exposes no widget
// factory. Add keyboard semantics without replacing DOM managed by its viewport.
function accessibleCollapseControls(parent: HTMLElement): () => void {
  const annotate = () => {
    for (const control of parent.querySelectorAll<HTMLElement>('.cm-collapsedLines')) {
      control.setAttribute('role', 'button');
      control.tabIndex = 0;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains('cm-collapsedLines')
      || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    const editor = EditorView.findFromDOM(target);
    target.click();
    editor?.focus();
  };
  annotate();
  const observer = new MutationObserver(annotate);
  observer.observe(parent, { childList: true, subtree: true });
  parent.addEventListener('keydown', onKeyDown);
  return () => {
    observer.disconnect();
    parent.removeEventListener('keydown', onKeyDown);
  };
}
