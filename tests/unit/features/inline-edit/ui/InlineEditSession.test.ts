import { Text } from '@codemirror/state';
import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';

jest.mock('@/shared/components/SelectionHighlight', () => ({
  hideSelectionHighlight: jest.fn(),
  showSelectionHighlight: jest.fn(),
}));

function createSession() {
  const sourceDoc = Text.of(['hello']);
  const editorView: any = {
    dispatch: jest.fn(),
    dom: createMockEl(),
    focus: jest.fn(),
    state: { doc: sourceDoc },
  };
  const editor = {
    getCursor: jest.fn((which: string) => which === 'from'
      ? { line: 0, ch: 0 }
      : { line: 0, ch: 5 }),
    getSelection: jest.fn(() => 'hello'),
    replaceRange: jest.fn(),
  };
  const service = {
    cancel: jest.fn(),
    resetConversation: jest.fn(),
    setModelOverride: jest.fn(),
  };
  jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue(service as any);
  const resolve = jest.fn();
  const plugin: any = {
    providerHost: {},
    settings: { hiddenProviderCommands: {} },
    getView: jest.fn(() => null),
  };
  const app: any = {
    metadataCache: {},
    vault: { getMarkdownFiles: jest.fn(() => []) },
  };
  const session = new InlineEditSession(
    app,
    plugin,
    editorView,
    editor as any,
    { mode: 'selection', selectedText: 'hello' },
    'note.md',
    () => [],
    resolve,
  );
  Object.assign(session as any, {
    editedText: 'world',
    sourceSnapshot: { doc: sourceDoc, from: 0, to: 5, text: 'hello' },
  });
  return { editor, editorView, resolve, session, sourceDoc };
}

describe('InlineEditSession', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses a result when the captured source document changed', () => {
    const { editor, editorView, resolve, session } = createSession();
    editorView.state.doc = Text.of(['HELLO']);

    session.accept();

    expect(editor.replaceRange).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(
      'Inline edit was not applied because the source document or selection changed.',
    );
  });

  it('settles, edits, and focuses only once', () => {
    const { editor, editorView, resolve, session } = createSession();

    session.accept();
    session.accept();
    session.reject();

    expect(editor.replaceRange).toHaveBeenCalledTimes(1);
    expect(editorView.focus).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ decision: 'accept', editedText: 'world' });
  });

  it('scopes keyboard handling to its preview or editor DOM', () => {
    const { editorView, session } = createSession();
    const preview = createMockEl();
    const previewChild = createMockEl('button');
    const outside = createMockEl();
    preview.appendChild(previewChild);
    (session as any).containerEl = preview;

    expect((session as any).isKeyboardEventInContext({ target: previewChild })).toBe(true);
    expect((session as any).isKeyboardEventInContext({ target: editorView.dom })).toBe(true);
    expect((session as any).isKeyboardEventInContext({ target: outside })).toBe(false);
  });
});
