import { createMockEl } from '@test/helpers/MockElement';
import type { Mock } from 'vitest';

import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { SelectionController } from '@/features/chat/input/SelectionController';
import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';



vi.mock('@/shared/components/SelectionHighlight', () => ({
  showSelectionHighlight: vi.fn(),
  hideSelectionHighlight: vi.fn(),
}));

function createMockDOMRange(overrides: Partial<{
  startContainer: { isConnected: boolean };
  startOffset: number;
  endContainer: { isConnected: boolean };
  endOffset: number;
}> = {}) {
  const container = { isConnected: true };
  const range: any = {
    startContainer: container,
    startOffset: 0,
    endContainer: container,
    endOffset: 0,
    ...overrides,
  };
  range.cloneRange = vi.fn(() => range);
  return range;
}

function createMockDOMSelection(text: string, anchorNode: any, focusNode?: any, range?: any) {
  const resolvedRange = range ?? createMockDOMRange();
  return {
    toString: () => text,
    anchorNode,
    focusNode: focusNode ?? anchorNode,
    rangeCount: 1,
    getRangeAt: vi.fn(() => resolvedRange),
    removeAllRanges: vi.fn(),
    _range: resolvedRange,
  };
}

function createMockEventTarget() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const containedNodes = new Set<unknown>();
  const el: any = {
    ownerDocument: createMockEl().ownerDocument,
    addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const handlers = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
      handlers.add(listener);
      listeners.set(event, handlers);
    }),
    removeEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    trigger: (event: string, eventData: unknown = {}) => {
      listeners.get(event)?.forEach(handler => handler(eventData));
    },
    contains: vi.fn((node: unknown) => node === el || containedNodes.has(node)),
    addContainedNode: (node: unknown) => {
      containedNodes.add(node);
    },
  };
  return el;
}

function createMockContextTray() {
  return {
    setItems: vi.fn(),
    clearItems: vi.fn(),
  };
}


/** The selection runs under the tab's shared poll cadence; the other sources stay idle. */
let polling: ComposerSelections | null = null;
function startPolling(source: SelectionController): ComposerSelections {
  const idle = { clear: vi.fn(), getContext: () => null, poll: vi.fn(), start: vi.fn(), stop: vi.fn() };
  polling = new ComposerSelections({ editor: source, browser: idle, canvas: idle });
  polling.start();
  return polling;
}
function stopPolling(): void {
  polling?.stop();
  polling = null;
}

describe('SelectionController', () => {
  let controller: SelectionController;
  let app: any;
  let contextTray: ReturnType<typeof createMockContextTray>;
  let inputEl: any;
  let focusScopeEl: any;
  let editor: any;
  let editorView: any;
  let originalDocument: any;
  let originalCSS: any;

  beforeEach(() => {
    // Mock Highlight constructor for CSS Custom Highlight API tests
    (global as any).Highlight = vi.fn(function (...ranges: any[]) { return ({ ranges }); });
    originalCSS = (global as any).CSS;
    vi.useFakeTimers();
    (showSelectionHighlight as Mock).mockClear();
    (hideSelectionHighlight as Mock).mockClear();

    contextTray = createMockContextTray();
    inputEl = createMockEventTarget();
    focusScopeEl = createMockEventTarget();
    focusScopeEl.addContainedNode(inputEl);

    editorView = {
      id: 'editor-view',
      dom: createMockEventTarget(),
      state: { selection: { main: { head: 4 } } },
      dispatch: vi.fn(),
    };
    editor = {
      getSelection: vi.fn().mockReturnValue('selected text'),
      getCursor: vi.fn((which: 'from' | 'to') => {
        if (which === 'from') return { line: 0, ch: 0 };
        return { line: 0, ch: 4 };
      }),
      posToOffset: vi.fn((pos: { line: number; ch: number }) => pos.line * 100 + pos.ch),
      cm: editorView,
    };

    const view = { editor, getMode: () => 'source', file: { path: 'notes/test.md' } };
    app = {
      workspace: {
        getActiveViewOfType: vi.fn().mockReturnValue(view),
      },
    };

    controller = new SelectionController(app, contextTray as any, inputEl, focusScopeEl);

    originalDocument = (global as any).document;
    (global as any).document = { activeElement: null };
  });

  afterEach(() => {
    stopPolling();
    vi.useRealTimers();
    (global as any).document = originalDocument;
    (global as any).CSS = originalCSS;
    delete (global as any).Highlight;
  });

  it('captures selection and updates indicator', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      notePath: 'notes/test.md',
      mode: 'selection',
      selectedText: 'selected text',
      lineCount: 1,
      startLine: 1,
    });
    expect(contextTray.setItems).toHaveBeenLastCalledWith('editor-selection', [
      expect.objectContaining({ label: '1 line selected' }),
    ]);
    expect(contextTray.setItems.mock.calls[0][1][0]).not.toHaveProperty('title');

    controller.showHighlight();
    expect(showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 4);
  });

  it('clears selection immediately when deselected without input handoff intent', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('clears a sticky selection from the tray remove action', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    const items = contextTray.setItems.mock.calls[0][1];
    items[0].onRemove();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when focus moves into the chat sidebar', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    const sidebarButton = {};
    focusScopeEl.addContainedNode(sidebarButton);
    (global as any).document.activeElement = sidebarButton;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when the owning chat view is active in a detached window', () => {
    const owningLeaf = {};
    app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue(owningLeaf);
    controller = new SelectionController(
      app,
      contextTray as any,
      inputEl,
      focusScopeEl,
      undefined,
      owningLeaf as any,
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    (global as any).document.activeElement = null;
    vi.advanceTimersByTime(250);

    expect(app.workspace.getMostRecentLeaf).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('clears selection when a different chat leaf is active', () => {
    const owningLeaf = {};
    app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({});
    controller = new SelectionController(
      app,
      contextTray as any,
      inputEl,
      focusScopeEl,
      undefined,
      owningLeaf as any,
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    (global as any).document.activeElement = null;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when a relocated composer outside tab content has focus', () => {
    const contentScopeEl = createMockEventTarget();
    const composerScopeEl = createMockEventTarget();
    composerScopeEl.addContainedNode(inputEl);
    controller = new SelectionController(
      app,
      contextTray as any,
      inputEl,
      [contentScopeEl, composerScopeEl],
    );

    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    (global as any).document.activeElement = inputEl;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when shared footer controls have focus', () => {
    const contentScopeEl = createMockEventTarget();
    const composerScopeEl = createMockEventTarget();
    const footerScopeEl = createMockEventTarget();
    const historyButton = {};
    footerScopeEl.addContainedNode(historyButton);
    controller = new SelectionController(
      app,
      contextTray as any,
      inputEl,
      [contentScopeEl, composerScopeEl, footerScopeEl],
    );

    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    (global as any).document.activeElement = historyButton;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('shows selection highlight when focus enters shared footer controls', () => {
    const footerScopeEl = createMockEventTarget();
    controller = new SelectionController(
      app,
      contextTray as any,
      inputEl,
      [focusScopeEl, footerScopeEl],
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    (showSelectionHighlight as Mock).mockClear();

    footerScopeEl.trigger('focusin', { relatedTarget: null });

    expect(showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 4);
  });

  it('does not re-show selection highlight when focus moves inside chat focus scopes', () => {
    const footerScopeEl = createMockEventTarget();
    const footerButton = {};
    footerScopeEl.addContainedNode(footerButton);
    controller = new SelectionController(
      app,
      contextTray as any,
      inputEl,
      [focusScopeEl, footerScopeEl],
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    (showSelectionHighlight as Mock).mockClear();

    focusScopeEl.trigger('focusin', { relatedTarget: footerButton });

    expect(showSelectionHighlight).not.toHaveBeenCalled();
  });

  it('shows fake highlight when focus moves to another sidebar control in edit mode', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    const sidebarButton = {};
    focusScopeEl.addContainedNode(sidebarButton);
    editorView.state.selection.main = { from: 0, to: 4, head: 4 };
    (global as any).document.activeElement = sidebarButton;

    controller.showHighlight();

    expect(showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 4);
    expect(hideSelectionHighlight).not.toHaveBeenCalled();
  });

  it('clears selection when focus leaves markdown and the chat sidebar is not focused', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    (global as any).document.activeElement = null;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('preserves selection when input focus arrives after a slow editor blur handoff', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    inputEl.trigger('pointerdown');
    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;

    // Simulate delayed focus handoff under UI load.
    vi.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);

    (global as any).document.activeElement = inputEl;
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(hideSelectionHighlight).not.toHaveBeenCalled();
  });

  it('clears selection after handoff grace expires when input never receives focus', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    inputEl.trigger('pointerdown');
    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;

    vi.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);

    vi.advanceTimersByTime(750);
    expect(controller.hasSelection()).toBe(false);
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  describe('Reading mode (preview)', () => {
    let readingView: any;
    let containerEl: any;

    beforeEach(() => {
      containerEl = {
        contains: vi.fn().mockReturnValue(true),
      };
      readingView = {
        editor,
        getMode: () => 'preview',
        file: { path: 'notes/reading.md' },
        containerEl,
      };
      app.workspace.getActiveViewOfType.mockReturnValue(readingView);
    });

    it('captures selection via document.getSelection() in reading mode', () => {
      const anchorNode = {};
      const mockSel = createMockDOMSelection('reading selection', anchorNode);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(mockSel),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
      expect(controller.getContext()).toEqual({
        notePath: 'notes/reading.md',
        mode: 'selection',
        selectedText: 'reading selection',
        lineCount: 1,
      });
      expect(contextTray.setItems).toHaveBeenLastCalledWith('editor-selection', [
        expect.objectContaining({ label: '1 line selected' }),
      ]);
    });

    it('preserves raw reading mode text and omits line metadata', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('  reading selection\nsecond line  ', anchorNode),
        ),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      expect(controller.getContext()).toEqual({
        notePath: 'notes/reading.md',
        mode: 'selection',
        selectedText: '  reading selection\nsecond line  ',
        lineCount: 2,
      });
      expect(contextTray.setItems).toHaveBeenLastCalledWith('editor-selection', [
        expect.objectContaining({ label: '2 lines selected' }),
      ]);
    });

    it('prefers native DOM selection in reading mode, falls back to CSS Highlight API when lost', () => {
      const anchorNode = {};
      const mockSel = createMockDOMSelection('reading selection', anchorNode);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(mockSel),
      };
      const mockHighlights = { set: vi.fn(), delete: vi.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      controller.showHighlight();
      expect(mockHighlights.set).not.toHaveBeenCalled();

      const differentRange: any = {
        startContainer: {}, startOffset: 0,
        endContainer: {}, endOffset: 0,
      };
      (global as any).document.getSelection = vi.fn().mockReturnValue({
        rangeCount: 1,
        getRangeAt: () => differentRange,
      });
      controller.showHighlight();

      expect(showSelectionHighlight).not.toHaveBeenCalled();
      expect(mockHighlights.set).toHaveBeenCalledWith(
        'claudian-selection',
        expect.any(Object),
      );
    });

    it('shows CSS highlight when focus moves to another sidebar control in reading mode', () => {
      const anchorNode = {};
      const mockSel = createMockDOMSelection('reading selection', anchorNode);
      const sidebarButton = {};
      focusScopeEl.addContainedNode(sidebarButton);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(mockSel),
      };
      const mockHighlights = { set: vi.fn(), delete: vi.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      (global as any).document.activeElement = sidebarButton;
      controller.showHighlight();

      expect(mockHighlights.set).toHaveBeenCalledWith(
        'claudian-selection',
        expect.any(Object),
      );
    });

    it('clears selection when deselected in reading mode', () => {
      const anchorNode = {};
      const mockHighlights = { set: vi.fn(), delete: vi.fn() };
      (global as any).CSS = { highlights: mockHighlights };
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);
      expect(controller.hasSelection()).toBe(true);

      mockHighlights.delete.mockClear();
      (global as any).document.getSelection.mockReturnValue(
        createMockDOMSelection('', null),
      );
      vi.advanceTimersByTime(250);

      expect(mockHighlights.delete).toHaveBeenCalledWith('claudian-selection');
      expect(controller.hasSelection()).toBe(false);
      expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
    });

    it('preserves reading mode selection when input is focused', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);
      expect(controller.hasSelection()).toBe(true);

      (global as any).document.getSelection.mockReturnValue(
        createMockDOMSelection('', null),
      );
      (global as any).document.activeElement = inputEl;
      vi.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
    });

    it('preserves reading mode selection when sidebar gets focus', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);
      expect(controller.hasSelection()).toBe(true);

      app.workspace.getActiveViewOfType.mockReturnValue(null);
      const sidebarButton = {};
      focusScopeEl.addContainedNode(sidebarButton);
      (global as any).document.activeElement = sidebarButton;
      vi.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
      expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
    });

    it('skips CSS highlight for disconnected DOM ranges', () => {
      const anchorNode = {};
      const mockSel = createMockDOMSelection('reading selection', anchorNode);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(mockSel),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      const mockHighlights = { set: vi.fn(), delete: vi.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      (global as any).document.activeElement = inputEl;
      controller.showHighlight();
      expect(mockHighlights.set).toHaveBeenCalledWith(
        'claudian-selection',
        { ranges: [mockSel._range] },
      );
      mockHighlights.set.mockClear();

      mockSel._range.startContainer.isConnected = false;
      controller.showHighlight();
      expect(mockHighlights.set).not.toHaveBeenCalled();
    });

    it('refreshes preview ranges when the same text is reselected elsewhere', () => {
      const firstAnchorNode = {};
      const secondAnchorNode = {};
      const firstRange = createMockDOMRange({
        startContainer: { isConnected: true },
        endContainer: { isConnected: true },
        startOffset: 1,
        endOffset: 4,
      });
      const secondRange = createMockDOMRange({
        startContainer: { isConnected: true },
        endContainer: { isConnected: true },
        startOffset: 7,
        endOffset: 10,
      });
      let currentSelection = createMockDOMSelection('repeat', firstAnchorNode, undefined, firstRange);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn(() => currentSelection),
      };
      const mockHighlights = { set: vi.fn(), delete: vi.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      currentSelection = createMockDOMSelection('repeat', secondAnchorNode, undefined, secondRange);
      vi.advanceTimersByTime(250);

      (global as any).document.activeElement = inputEl;
      controller.showHighlight();

      expect(mockHighlights.set).toHaveBeenCalledWith(
        'claudian-selection',
        { ranges: [secondRange] },
      );
    });

    it('ignores selection outside the view container', () => {
      containerEl.contains.mockReturnValue(false);
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('outside selection', anchorNode),
        ),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(false);
    });

    it('uses focusNode when anchorNode is outside the view container', () => {
      const anchorNode = {};
      const focusNode = {};
      containerEl.contains.mockImplementation((node: unknown) => node === focusNode);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode, focusNode),
        ),
      };

      startPolling(controller);
      vi.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
    });

    it('replaces source selection metadata when switching the same text into preview mode', () => {
      const sourceView = { editor, getMode: () => 'source', file: { path: 'notes/test.md' } };
      app.workspace.getActiveViewOfType.mockReturnValue(sourceView);

      startPolling(controller);
      vi.advanceTimersByTime(250);

      const previewAnchorNode = {};
      readingView.file.path = 'notes/test.md';
      app.workspace.getActiveViewOfType.mockReturnValue(readingView);
      (global as any).document = {
        activeElement: null,
        getSelection: vi.fn().mockReturnValue(
          createMockDOMSelection('selected text', previewAnchorNode),
        ),
      };
      (showSelectionHighlight as Mock).mockClear();

      vi.advanceTimersByTime(250);
      controller.showHighlight();

      expect(controller.getContext()).toEqual({
        notePath: 'notes/test.md',
        mode: 'selection',
        selectedText: 'selected text',
        lineCount: 1,
      });
      expect(showSelectionHighlight).not.toHaveBeenCalled();
    });
  });
});
