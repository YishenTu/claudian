/** @jest-environment jsdom */

import { EditorView } from '@codemirror/view';

import { MarkdownDraftEditor } from '@/features/collab/shared/markdown/MarkdownDraftEditor';

describe('MarkdownDraftEditor', () => {
  it('edits Markdown through CodeMirror and preserves the draft across Preview', async () => {
    const root = document.createElement('div');
    const renderMarkdown = jest.fn(async (markdown: string, host: HTMLElement) => {
      host.setText(markdown);
    });
    const onUpdate = jest.fn();
    const editor = new MarkdownDraftEditor(root, {
      actionName: 'test-draft',
      ariaLabel: 'Draft',
      initialValue: 'Initial **draft**',
      onUpdate,
      renderMarkdown,
    });

    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('.cm-editor')).not.toBeNull();
    expect(root.querySelector('.cm-activeLine')).toBeNull();
    expect(editor.getValue()).toBe('Initial **draft**');

    setEditorValue(root, 'Updated #17');
    expect(editor.getValue()).toBe('Updated #17');
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      value: 'Updated #17',
    }));

    root.querySelector<HTMLButtonElement>('[data-action="preview-test-draft"]')?.click();
    await nextTurn();

    expect(renderMarkdown).toHaveBeenCalledWith(
      'Updated #17',
      expect.any(HTMLElement),
    );
    expect(root.querySelector<HTMLElement>('.claudian-collab-markdown-draft-editor')?.hidden)
      .toBe(true);
    expect(root.querySelector<HTMLElement>('.claudian-collab-markdown-draft-preview')?.hidden)
      .toBe(false);

    root.querySelector<HTMLButtonElement>('[data-action="edit-test-draft"]')?.click();
    expect(editor.getValue()).toBe('Updated #17');

    editor.destroy();
  });

  it('replaces a selected Markdown range and exposes a rendered read-only mode', async () => {
    const editableRoot = document.createElement('div');
    const editable = new MarkdownDraftEditor(editableRoot, {
      ariaLabel: 'Description',
      initialValue: 'Investigate Resolves #',
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
      ticketSuggestions: [{ number: 17, title: 'Preserve the draft' }],
    });
    editable.setSelection(editable.getValue().length);
    const suggestions = editableRoot.querySelectorAll<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.textContent).toBe('#17 Preserve the draft');
    editableRoot.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    )?.click();

    expect(editable.getValue()).toBe('Investigate Resolves #17 ');
    expect(editable.getSelection()).toEqual({ anchor: 25, head: 25 });
    expect(editableRoot.querySelector('.claudian-collab-markdown-suggestion')).toBeNull();

    const readOnlyRoot = document.createElement('div');
    const renderMarkdown = jest.fn().mockResolvedValue(undefined);
    const readOnly = new MarkdownDraftEditor(readOnlyRoot, {
      ariaLabel: 'Description',
      editable: false,
      initialValue: 'Rendered description',
      renderMarkdown,
    });
    await nextTurn();

    expect(readOnlyRoot.querySelector('.claudian-collab-markdown-draft-modes')).toBeNull();
    expect(readOnlyRoot.querySelector('.cm-editor')).toBeNull();
    expect(renderMarkdown).toHaveBeenCalledWith(
      'Rendered description',
      expect.any(HTMLElement),
    );

    editable.destroy();
    readOnly.destroy();
  });

  it('keeps one Ticket suggestion selected and moves it with the keyboard', () => {
    const root = document.createElement('div');
    const editor = new MarkdownDraftEditor(root, {
      ariaLabel: 'Description',
      initialValue: 'Related #',
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
      ticketSuggestions: [
        { number: 17, title: 'First Ticket' },
        { number: 18, title: 'Second Ticket' },
      ],
    });
    editor.setSelection(editor.getValue().length);

    expect(selectedSuggestions(root)).toEqual(['true', 'false']);
    const view = markdownEditor(root);
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    }));
    expect(selectedSuggestions(root)).toEqual(['false', 'true']);

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    expect(editor.getValue()).toBe('Related #18 ');
    expect(root.querySelector('.claudian-collab-markdown-suggestion')).toBeNull();

    editor.destroy();
  });

  it('advances across an existing space without inserting another one', () => {
    const root = document.createElement('div');
    const editor = new MarkdownDraftEditor(root, {
      ariaLabel: 'Description',
      initialValue: 'Related # next',
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
      ticketSuggestions: [{ number: 17, title: 'Ticket' }],
    });
    editor.setSelection('Related #'.length);
    const view = markdownEditor(root);
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));

    expect(editor.getValue()).toBe('Related #17 next');
    expect(editor.getSelection()).toEqual({
      anchor: 'Related #17 '.length,
      head: 'Related #17 '.length,
    });
    expect(root.querySelector('.claudian-collab-markdown-suggestion')).toBeNull();
    editor.destroy();
  });

  it('offers and inserts active Member display names without exposing IDs', () => {
    const root = document.createElement('div');
    const editor = new MarkdownDraftEditor(root, {
      ariaLabel: 'Description',
      initialValue: 'Please check with @ali',
      memberSuggestions: [
        { displayName: 'Alice Chen' },
        { displayName: 'Bob' },
      ],
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
    });
    editor.setSelection(editor.getValue().length);

    const suggestions = root.querySelectorAll<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.textContent).toBe('Alice Chen');
    suggestions[0]?.click();

    expect(editor.getValue()).toBe('Please check with @Alice Chen ');
    expect(editor.getSelection()).toEqual({ anchor: 30, head: 30 });
    expect(root.querySelector('.claudian-collab-markdown-suggestion')).toBeNull();
    editor.destroy();
  });

  it('does not offer Member completion from the middle of an email-like token', () => {
    const root = document.createElement('div');
    const editor = new MarkdownDraftEditor(root, {
      ariaLabel: 'Description',
      initialValue: 'mail@example',
      memberSuggestions: [{ displayName: 'Example' }],
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
    });
    editor.setSelection(editor.getValue().length);

    expect(root.querySelector('.claudian-collab-markdown-suggestion')).toBeNull();
    editor.destroy();
  });
});

function markdownEditor(root: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!);
  if (!view) throw new Error('CodeMirror editor not found');
  return view;
}

function selectedSuggestions(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(
    '.claudian-collab-markdown-suggestion',
  )].map(item => item.getAttribute('aria-selected') ?? 'missing');
}

function setEditorValue(root: HTMLElement, value: string): void {
  const view = markdownEditor(root);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
