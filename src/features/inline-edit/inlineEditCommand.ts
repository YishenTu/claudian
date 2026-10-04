import type { Command, Component, Editor, MarkdownFileInfo } from 'obsidian';
import { MarkdownView, Notice } from 'obsidian';

import { buildCursorContext } from '@/core/prompt/editorContext';
import type { FeatureHost } from '@/features/FeatureHost';

import type { InlineEditSessionOwner } from './InlineEditSessionOwner';
import { type InlineEditContext, InlineEditModal } from './ui/InlineEditModal';

export interface InlineEditCommandDeps {
  readonly host: FeatureHost;
  /** Owns the lifetime of rendered previews. */
  readonly component: Component;
  readonly sessions: InlineEditSessionOwner;
}

function buildInlineEditContext(editor: Editor): InlineEditContext {
  const selectedText = editor.getSelection();
  if (selectedText.trim()) {
    return { mode: 'selection', selectedText };
  }

  const cursor = editor.getCursor();
  const cursorContext = buildCursorContext(
    (line) => editor.getLine(line),
    editor.lineCount(),
    cursor.line,
    cursor.ch,
  );
  return { mode: 'cursor', cursorContext };
}

/** Edits the selection, or inserts at the cursor, of the active Markdown editor. */
export function createInlineEditCommand(deps: InlineEditCommandDeps): Command {
  const { host } = deps;
  return {
    id: 'inline-edit',
    name: 'Inline edit',
    editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
      const view = ctx instanceof MarkdownView
        ? ctx
        : host.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice('Inline edit unavailable: could not access the active Markdown view.');
        return;
      }

      const editContext = buildInlineEditContext(editor);
      const modal = new InlineEditModal(
        host.app,
        host,
        deps.component,
        editor,
        view,
        editContext,
        view.file?.path || 'unknown',
        deps.sessions,
      );
      const result = await modal.openAndWait();

      if (result.decision === 'accept' && result.editedText !== undefined) {
        new Notice(editContext.mode === 'cursor' ? 'Inserted' : 'Edit applied');
      }
    },
  };
}
