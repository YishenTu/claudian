import '@/providers';

import { createMockEl } from '@test/helpers/MockElement';
import { MarkdownRenderer, Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { InlineEditSessionOwner } from '@/features/inline-edit/InlineEditSessionOwner';
import { type InlineEditContext, InlineEditModal } from '@/features/inline-edit/ui/InlineEditModal';
import { VaultFolderCache } from '@/shared/mention/VaultMentionCache';
import * as editorUtils from '@/utils/editor';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createInertInlineEditService() {
  return {
    cancel: jest.fn(),
    continueConversation: jest.fn(),
    editText: jest.fn(),
    resetConversation: jest.fn(),
    setModelOverride: jest.fn(),
  };
}

describe('InlineEditModal - openAndWait', () => {
  let owner: InlineEditSessionOwner;
  beforeEach(() => {
    owner = new InlineEditSessionOwner();
    jest.clearAllMocks();
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined);
    jest
      .spyOn(ProviderRegistry, 'createInlineEditService')
      .mockReturnValue(createInertInlineEditService() as any);
  });

  afterEach(() => {
    owner.dispose();
    jest.restoreAllMocks();
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

    const modal = new InlineEditModal(app, plugin, callbackEditor, view, editContext, 'note.md', owner);
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

  it('uses an enabled settings provider when no chat tab is open', async () => {
    const editor = {} as any;
    const app = {} as any;
    const plugin = {
      settings: {
        settingsProvider: 'claude',
        providerConfigs: {
          claude: { enabled: false },
          codex: { enabled: true },
        },
      },
      getView: jest.fn().mockReturnValue(null),
    } as any;
    plugin.providerHost = plugin;
    const view = { editor } as any;
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

    jest.spyOn(editorUtils, 'getEditorView').mockReturnValue({ dispatch: jest.fn() } as any);
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockRejectedValue(new Error('stop after provider resolution'));

    const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);

    await expect(modal.openAndWait()).resolves.toEqual({ decision: 'reject' });
    expect(ProviderWorkspaceRegistry.ensureInitialized).toHaveBeenCalledWith(
      plugin,
      'codex',
      'inline-edit',
    );
  });

  it('uses an enabled settings provider when the active conversation provider is disabled', async () => {
    const editor = {} as any;
    const app = {} as any;
    const plugin = {
      settings: {
        settingsProvider: 'codex',
        providerConfigs: {
          claude: { enabled: false },
          codex: { enabled: true },
        },
      },
      getConversationSync: jest.fn().mockReturnValue({
        id: 'claude-conversation',
        providerId: 'claude',
        selectedModel: 'sonnet',
      }),
      getView: jest.fn().mockReturnValue({
        getActiveTab: jest.fn().mockReturnValue({
          conversationId: 'claude-conversation',
          providerId: 'claude',
          selectedModel: 'sonnet',
        }),
      }),
    } as any;
    plugin.providerHost = plugin;
    const view = { editor } as any;
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

    jest.spyOn(editorUtils, 'getEditorView').mockReturnValue({ dispatch: jest.fn() } as any);
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockRejectedValue(new Error('stop after provider resolution'));

    const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);

    await expect(modal.openAndWait()).resolves.toEqual({ decision: 'reject' });
    expect(ProviderWorkspaceRegistry.ensureInitialized).toHaveBeenCalledWith(
      plugin,
      'codex',
      'inline-edit',
    );
  });

  it('debounces Inline Edit Vault mention loading through the shared dropdown', async () => {
    jest.useFakeTimers();
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
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

      const inputEl = widgetRef?.inputEl;
      inputEl.value = '@s';
      inputEl.selectionStart = inputEl.selectionEnd = 2;
      inputEl.dispatchEvent({ type: 'input' });
      jest.advanceTimersByTime(199);
      expect(getFoldersSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await Promise.resolve();

      expect(getFoldersSpy).toHaveBeenCalledTimes(1);
      const labels = (global as any).document.body
        .querySelectorAll('.claudian-composer-dropdown-label')
        .map((element: { textContent: string }) => element.textContent);
      expect(labels).toEqual(['@src/']);

      widgetRef?.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });

      getEditorViewSpy.mockRestore();
      getFoldersSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
      jest.useRealTimers();
    }
  });


  it('passes the active blank tab draft model into inline edit services', async () => {
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
          providerConfigs: {
            opencode: {
              enabled: true,
              visibleModels: ['anthropic/claude-sonnet-4'],
            },
          },
        },
        getActiveModelSelection: () => ({ providerId: 'opencode', model: 'opencode:openai/gpt-5.4' }),
        getConversationSync: jest.fn().mockReturnValue(null),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            conversationId: null,
            draftModel: 'opencode:openai/gpt-5.4',
            providerId: 'opencode',
          }),
        }),
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

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

  it('passes the bound conversation model into inline edit services before runtime initialization', async () => {
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
      const conversation = {
        id: 'conv-1',
        providerId: 'opencode',
        selectedModel: 'opencode:anthropic/claude-sonnet-4',
      };
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            opencode: [],
          },
          providerConfigs: {
            opencode: { enabled: true },
          },
        },
        getActiveModelSelection: () => ({ providerId: 'opencode', model: conversation.selectedModel }),
        getConversationSync: jest.fn().mockReturnValue(conversation),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            conversationId: 'conv-1',
            draftModel: null,
            providerId: 'opencode',
          }),
        }),
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

      expect(providerSpy).toHaveBeenCalledWith(plugin, 'opencode');
      expect(inlineEditService.setModelOverride).toHaveBeenCalledWith('opencode:anthropic/claude-sonnet-4');

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
      providerSpy.mockRestore();
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
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

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
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

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

  it('does not let stale clarification markdown renders overwrite newer replies', async () => {
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
          mediaFolder: '',
        },
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const firstRender = createDeferred();
      const secondRender = createDeferred();
      (MarkdownRenderer.renderMarkdown as jest.Mock)
        .mockImplementationOnce((markdown: string, container: any) => {
          container.createDiv({ text: markdown });
          return firstRender.promise;
        })
        .mockImplementationOnce((markdown: string, container: any) => {
          container.createDiv({ text: markdown });
          return secondRender.promise;
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'math/note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

      (MarkdownRenderer.renderMarkdown as jest.Mock).mockClear();
      widgetRef.showAgentReply('Should this use $Z(f)$?');
      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
        'Should this use $Z(f)$?',
        expect.anything(),
        'math/note.md',
        plugin,
      );
      widgetRef.showAgentReply('Second clarification');

      secondRender.resolve();
      await secondRender.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(widgetRef.agentReplyEl.children).toHaveLength(1);
      expect(widgetRef.agentReplyEl.children[0].textContent).toBe('Second clarification');

      firstRender.resolve();
      await firstRender.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(widgetRef.agentReplyEl.children).toHaveLength(1);
      expect(widgetRef.agentReplyEl.children[0].textContent).toBe('Second clarification');

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('renders accept and reject controls in the block preview', async () => {
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
          mediaFolder: '',
        },
      } as any;
      plugin.providerHost = plugin;
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
          field: jest.fn(() => undefined),
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

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'math/note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();

      const rejectSpy = jest.spyOn(widgetRef, 'reject').mockImplementation(() => {});
      const acceptSpy = jest.spyOn(widgetRef, 'accept').mockImplementation(() => {});

      const previewEl = widgetRef.createDiffPreviewDOM([
        { type: 'insert', text: 'Updated text' },
      ]);
      const actionBar = previewEl.querySelector('.claudian-inline-preview-actions');
      const actionButtons = previewEl.querySelectorAll('.claudian-inline-preview-action');

      expect(actionBar).not.toBeNull();
      expect(actionButtons).toHaveLength(2);
      expect(actionButtons[0].textContent).toBe('Reject');
      expect(actionButtons[1].textContent).toBe('Accept');

      actionButtons[0].click();
      actionButtons[1].click();

      expect(rejectSpy).toHaveBeenCalledTimes(1);
      expect(acceptSpy).toHaveBeenCalledTimes(1);

      rejectSpy.mockRestore();
      acceptSpy.mockRestore();
      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it.each([
    {
      name: 'fenced code with block context',
      expectedDiffOps: [
        { type: 'equal', text: '```ts\n' },
        { type: 'delete', text: 'const value = 1;\n' },
        { type: 'insert', text: 'const value = 2;\n' },
        { type: 'equal', text: '```' },
      ],
      oldMarkdown: '```ts\nconst value = 1;\n```',
      newMarkdown: '```ts\nconst value = 2;\n```',
      expectedKinds: ['del', 'ins'],
    },
    {
      name: 'unchanged text',
      expectedDiffOps: [
        { type: 'equal', text: 'Hello world' },
      ],
      oldMarkdown: 'Hello world',
      newMarkdown: 'Hello world',
      expectedKinds: ['equal'],
    },
    {
      name: 'insertion into empty text',
      expectedDiffOps: [
        { type: 'insert', text: 'New text' },
      ],
      oldMarkdown: '',
      newMarkdown: 'New text',
      expectedKinds: ['ins'],
    },
    {
      name: 'complete deletion',
      expectedDiffOps: [
        { type: 'delete', text: 'Removed text' },
      ],
      oldMarkdown: 'Removed text',
      newMarkdown: '',
      expectedKinds: ['del'],
    },
    {
      name: 'empty documents',
      expectedDiffOps: [
      ],
      oldMarkdown: '',
      newMarkdown: '',
      expectedKinds: [],
    },
    {
      name: 'word insertion',
      expectedDiffOps: [
        { type: 'delete', text: 'Hello world' },
        { type: 'insert', text: 'Hello beautiful world' },
      ],
      oldMarkdown: 'Hello world',
      newMarkdown: 'Hello beautiful world',
      expectedKinds: ['del', 'ins'],
    },
    {
      name: 'word deletion',
      expectedDiffOps: [
        { type: 'delete', text: 'Hello beautiful world' },
        { type: 'insert', text: 'Hello world' },
      ],
      oldMarkdown: 'Hello beautiful world',
      newMarkdown: 'Hello world',
      expectedKinds: ['del', 'ins'],
    },
    {
      name: 'whitespace and multiline markdown',
      expectedDiffOps: [
        { type: 'equal', text: '# Heading\n\n' },
        { type: 'delete', text: '  First paragraph.  \n' },
        { type: 'insert', text: '  Updated paragraph!  \n' },
        { type: 'equal', text: '\tSecond line.\n' },
      ],
      oldMarkdown: '# Heading\n\n  First paragraph.  \n\tSecond line.\n',
      newMarkdown: '# Heading\n\n  Updated paragraph!  \n\tSecond line.\n',
      expectedKinds: ['del', 'ins'],
    },
    {
      name: 'literal HTML and punctuation in code',
      expectedDiffOps: [
        { type: 'equal', text: '```html\n' },
        { type: 'delete', text: '<div title="old">Hello & goodbye.</div>\n' },
        { type: 'insert', text: '<div title="new">Hello, world!</div>\n' },
        { type: 'equal', text: '```' },
      ],
      oldMarkdown: '```html\n<div title="old">Hello & goodbye.</div>\n```',
      newMarkdown: '```html\n<div title="new">Hello, world!</div>\n```',
      expectedKinds: ['del', 'ins'],
    },
  ])('renders markdown diff documents for $name', async ({ oldMarkdown, newMarkdown, expectedKinds, expectedDiffOps }) => {
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
          mediaFolder: '',
        },
      } as any;
      plugin.providerHost = plugin;
      const editor = {
        getCursor: jest.fn((which: string) => which === 'from'
          ? { line: 0, ch: 0 }
          : { line: 0, ch: 3 }),
        getSelection: jest.fn().mockReturnValue(oldMarkdown),
      } as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      let diffOps: Array<{ type: string; text: string }> | undefined;
      let hasPreviewText = false;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          if (effect?.value?.diffOps) {
            diffOps = effect.value.diffOps;
          }
          if (effect?.value?.previewText) {
            hasPreviewText = true;
          }

          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function' && !widgetRef) {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          field: jest.fn(() => undefined),
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
        mode: 'selection',
        selectedText: oldMarkdown,
      };

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'math/note.md', owner);
      const resultPromise = modal.openAndWait();
      await Promise.resolve();
      widgetRef.inlineEditService = {
        editText: jest.fn().mockResolvedValue({
          success: true,
          editedText: newMarkdown,
        }),
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Improve the statement';
      await widgetRef.generate();

      expect(diffOps).toEqual(expectedDiffOps);
      expect(hasPreviewText).toBe(false);

      (MarkdownRenderer.renderMarkdown as jest.Mock).mockClear();
      const previewEl = widgetRef.createDiffPreviewDOM(diffOps);
      for (let i = 0; i < 5 && (MarkdownRenderer.renderMarkdown as jest.Mock).mock.calls.length < expectedKinds.length; i++) {
        await Promise.resolve();
      }

      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledTimes(expectedKinds.length);
      const diffBlocks = previewEl.querySelectorAll('.claudian-diff-block');
      expect(diffBlocks).toHaveLength(expectedKinds.length);
      expectedKinds.forEach((kind, index) => {
        expect(MarkdownRenderer.renderMarkdown).toHaveBeenNthCalledWith(
          index + 1,
          kind === 'del' ? oldMarkdown : newMarkdown,
          expect.anything(),
          'math/note.md',
          plugin
        );
        expect(diffBlocks[index].hasClass(`claudian-diff-${kind}`)).toBe(true);
      });

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });
});
