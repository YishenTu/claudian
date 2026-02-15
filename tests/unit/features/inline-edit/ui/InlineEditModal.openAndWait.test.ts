import { Notice } from 'obsidian';

import { type InlineEditContext,InlineEditModal } from '@/features/inline-edit/ui/InlineEditModal';
import * as editorUtils from '@/utils/editor';

describe('InlineEditModal - openAndWait', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses editorCallback references first and falls back to view.editor before rejecting', async () => {
    const callbackEditor = {} as any;
    const fallbackEditor = {} as any;

    const app = {
      workspace: {
        getActiveViewOfType: jest.fn(),
      },
    } as any;
    const plugin = {} as any;
    const view = { editor: fallbackEditor } as any;

    const editContext: InlineEditContext = {
      mode: 'cursor',
      cursorContext: {
        beforeCursor: '',
        afterCursor: '',
        isInbetween: true,
        line: 0,
        column: 0,
      },
    };

    const getEditorViewSpy = jest
      .spyOn(editorUtils, 'getEditorView')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined);

    const modal = new InlineEditModal(app, plugin, callbackEditor, view, editContext, 'note.md');
    const result = await modal.openAndWait();

    expect(result).toEqual({ decision: 'reject' });
    expect(getEditorViewSpy).toHaveBeenNthCalledWith(1, callbackEditor);
    expect(getEditorViewSpy).toHaveBeenNthCalledWith(2, fallbackEditor);
    expect(app.workspace.getActiveViewOfType).not.toHaveBeenCalled();

    const noticeMock = Notice as unknown as jest.Mock;
    expect(noticeMock).toHaveBeenCalledWith(
      'Inline edit unavailable: could not access the active editor. Try reopening the note.'
    );
  });
});
