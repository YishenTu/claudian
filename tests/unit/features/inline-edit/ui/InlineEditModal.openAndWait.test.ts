import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { type InlineEditContext, InlineEditModal } from '@/features/inline-edit/ui/InlineEditModal';
import { VaultFolderCache } from '@/shared/mention/VaultMentionCache';
import * as editorUtils from '@/utils/editor';

const mentionDropdownCtor = jest.fn();
jest.mock('@/shared/mention/MentionDropdownController', () => ({
  MentionDropdownController: function MockMentionDropdownController(...args: any[]) {
    mentionDropdownCtor(...args);
    return {
      handleInputChange: jest.fn(),
      handleKeydown: jest.fn().mockReturnValue(false),
      destroy: jest.fn(),
    };
  },
}));

jest.mock('@/shared/components/SlashCommandDropdown', () => ({
  SlashCommandDropdown: jest.fn().mockImplementation(() => ({
    handleKeydown: jest.fn().mockReturnValue(false),
    destroy: jest.fn(),
  })),
}));

jest.mock('@/utils/externalContextScanner', () => ({
  externalContextScanner: {
    scanPaths: jest.fn().mockReturnValue([]),
  },
}));

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

  it('wires mention getCachedVaultFolders through VaultFolderCache.getFolders', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);
      const getFoldersSpy = jest
        .spyOn(VaultFolderCache.prototype, 'getFolders')
        .mockReturnValue([{ name: 'src', path: 'src' } as any]);

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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      expect(mentionDropdownCtor).toHaveBeenCalled();
      const callbacks = mentionDropdownCtor.mock.calls[0]?.[2];
      expect(callbacks).toBeDefined();
      expect(callbacks.getCachedVaultFolders()).toEqual([{ name: 'src', path: 'src' }]);
      expect(getFoldersSpy).toHaveBeenCalledTimes(1);

      widgetRef?.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });

      getEditorViewSpy.mockRestore();
      getFoldersSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('uses provider-scoped hidden commands for Codex inline edit dropdowns', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: ['commit'],
            codex: ['analyze'],
          },
        },
        getConversationSync: jest.fn().mockReturnValue(null),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            providerId: 'codex',
            service: null,
            conversationId: null,
          }),
        }),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      jest.spyOn(editorUtils, 'getEditorView').mockReturnValue(editorView);

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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      const { SlashCommandDropdown } = jest.requireMock('@/shared/components/SlashCommandDropdown');
      const constructorCall = SlashCommandDropdown.mock.calls[0];
      expect(Array.from(constructorCall[3].hiddenCommands)).toEqual(['analyze']);

      widgetRef?.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('passes the active chat runtime model into inline edit services when available', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const inlineEditService = {
        cancel: jest.fn(),
        continueConversation: jest.fn(),
        editText: jest.fn(),
        resetConversation: jest.fn(),
        setModelOverride: jest.fn(),
      };
      const providerSpy = jest
        .spyOn(ProviderRegistry, 'createInlineEditService')
        .mockReturnValue(inlineEditService as any);
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            opencode: [],
          },
        },
        getConversationSync: jest.fn().mockReturnValue(null),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            conversationId: null,
            draftModel: 'opencode:openai/gpt-5.4',
            providerId: 'opencode',
            service: {
              getAuxiliaryModel: jest.fn().mockReturnValue('opencode:openai/gpt-5.4'),
              providerId: 'opencode',
            },
          }),
        }),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      expect(providerSpy).toHaveBeenCalledWith(plugin, 'opencode');
      expect(inlineEditService.setModelOverride).toHaveBeenCalledWith('opencode:openai/gpt-5.4');

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
      providerSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('shows a single notice and degrades gracefully when getFiles throws', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockImplementation(() => {
            throw new Error('vault unavailable');
          }),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const { externalContextScanner } = jest.requireMock('@/utils/externalContextScanner');
      (externalContextScanner.scanPaths as jest.Mock).mockImplementation((paths: string[]) => {
        if (paths[0] === '/external') {
          return [
            {
              path: '/external/src/app.md',
              name: 'app.md',
              relativePath: 'src/app.md',
              contextRoot: '/external',
              mtime: 1000,
            },
          ];
        }
        return [];
      });

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

      const modal = new InlineEditModal(
        app,
        plugin,
        editor,
        view,
        editContext,
        'note.md',
        () => ['/external']
      );
      const resultPromise = modal.openAndWait();

      const callbacks = mentionDropdownCtor.mock.calls[0]?.[2];
      expect(callbacks.getCachedVaultFiles()).toEqual([]);
      expect(callbacks.getCachedVaultFiles()).toEqual([]);

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @external/src/app.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['/external/src/app.md']);

      const noticeMock = Notice as unknown as jest.Mock;
      expect(noticeMock).toHaveBeenCalledTimes(1);
      expect(noticeMock).toHaveBeenCalledWith(
        'Failed to load vault files. Vault @-mentions may be unavailable.'
      );

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('parses @mentions into contextFiles at send time without dropdown attachment state', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([
            { path: 'notes/a.md' },
            { path: 'notes/b.md' },
          ]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @notes/a.md and @notes/a.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['notes/a.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('resolves external context @mentions into contextFiles at send time', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([{ path: 'notes/local.md' }]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

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

      const { externalContextScanner } = jest.requireMock('@/utils/externalContextScanner');
      (externalContextScanner.scanPaths as jest.Mock).mockImplementation((paths: string[]) => {
        if (paths[0] === '/external') {
          return [
            {
              path: '/external/src/app.md',
              name: 'app.md',
              relativePath: 'src/app.md',
              contextRoot: '/external',
              mtime: 1000,
            },
          ];
        }
        return [];
      });

      const modal = new InlineEditModal(
        app,
        plugin,
        editor,
        view,
        editContext,
        'note.md',
        () => ['/external']
      );
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @external/src/app.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['/external/src/app.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('parses vault @mentions with spaces into contextFiles at send time', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([
            { path: 'notes/my note.md' },
          ]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @notes/my note.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['notes/my note.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('resolves external @mentions when vault has no files', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          ownerDocument: (global as any).document,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

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

      const { externalContextScanner } = jest.requireMock('@/utils/externalContextScanner');
      (externalContextScanner.scanPaths as jest.Mock).mockImplementation((paths: string[]) => {
        if (paths[0] === '/external') {
          return [
            {
              path: '/external/src/my file.md',
              name: 'my file.md',
              relativePath: 'src/my file.md',
              contextRoot: '/external',
              mtime: 1000,
            },
          ];
        }
        return [];
      });

      const modal = new InlineEditModal(
        app,
        plugin,
        editor,
        view,
        editContext,
        'note.md',
        () => ['/external']
      );
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @external/src/my file.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['/external/src/my file.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });
});
