import { SelectionController } from '@/features/chat/controllers/SelectionController';
import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';

jest.mock('@/shared/components/SelectionHighlight', () => ({
  showSelectionHighlight: jest.fn(),
  hideSelectionHighlight: jest.fn(),
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
  range.cloneRange = jest.fn(() => range);
  return range;
}

function createMockDOMSelection(text: string, anchorNode: any, focusNode?: any, range?: any) {
  const resolvedRange = range ?? createMockDOMRange();
  return {
    toString: () => text,
    anchorNode,
    focusNode: focusNode ?? anchorNode,
    rangeCount: 1,
    getRangeAt: jest.fn(() => resolvedRange),
    removeAllRanges: jest.fn(),
    _range: resolvedRange,
  };
}

function createMockIndicator() {
  return {
    textContent: '',
    style: { display: 'none' },
  } as any;
}

function createMockEventTarget() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const containedNodes = new Set<unknown>();
  const el: any = {
    addEventListener: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      const handlers = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
      handlers.add(listener);
      listeners.set(event, handlers);
    }),
    removeEventListener: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    trigger: (event: string) => {
      listeners.get(event)?.forEach(handler => handler());
    },
    contains: jest.fn((node: unknown) => node === el || containedNodes.has(node)),
    addContainedNode: (node: unknown) => {
      containedNodes.add(node);
    },
  };
  return el;
}

function createMockContextRow() {
  const elements: Record<string, any> = {
    '.claudian-selection-indicator': { style: { display: 'none' } },
    '.claudian-canvas-indicator': { style: { display: 'none' } },
    '.claudian-file-indicator': null,
    '.claudian-image-preview': null,
  };

  return {
    classList: {
      toggle: jest.fn(),
    },
    querySelector: jest.fn((selector: string) => elements[selector] ?? null),
  } as any;
}

describe('SelectionController', () => {
  let controller: SelectionController;
  let app: any;
  let indicatorEl: any;
  let inputEl: any;
  let focusScopeEl: any;
  let contextRowEl: any;
  let editor: any;
  let editorView: any;
  let originalDocument: any;
  let originalCSS: any;

  beforeEach(() => {
    // Mock Highlight constructor for CSS Custom Highlight API tests
    (global as any).Highlight = jest.fn((...ranges: any[]) => ({ ranges }));
    originalCSS = (global as any).CSS;
    jest.useFakeTimers();
    (showSelectionHighlight as jest.Mock).mockClear();
    (hideSelectionHighlight as jest.Mock).mockClear();

    indicatorEl = createMockIndicator();
    inputEl = createMockEventTarget();
    focusScopeEl = createMockEventTarget();
    focusScopeEl.addContainedNode(inputEl);
    contextRowEl = createMockContextRow();

    editorView = {
      id: 'editor-view',
      state: { selection: { main: { head: 4 } } },
      dispatch: jest.fn(),
    };
    editor = {
      getSelection: jest.fn().mockReturnValue('selected text'),
      getCursor: jest.fn((which: 'from' | 'to') => {
        if (which === 'from') return { line: 0, ch: 0 };
        return { line: 0, ch: 4 };
      }),
      posToOffset: jest.fn((pos: { line: number; ch: number }) => pos.line * 100 + pos.ch),
      cm: editorView,
    };

    const view = { editor, getMode: () => 'source', file: { path: 'notes/test.md' } };
    app = {
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(view),
      },
    };

    controller = new SelectionController(app, indicatorEl, inputEl, contextRowEl, undefined, focusScopeEl);

    originalDocument = (global as any).document;
    (global as any).document = { activeElement: null };
  });

  afterEach(() => {
    controller.stop();
    jest.useRealTimers();
    (global as any).document = originalDocument;
    (global as any).CSS = originalCSS;
    delete (global as any).Highlight;
  });

  it('captures selection and updates indicator', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      notePath: 'notes/test.md',
      mode: 'selection',
      selectedText: 'selected text',
      lineCount: 1,
      startLine: 1,
    });
    expect(indicatorEl.textContent).toBe('1 line selected');
    expect(indicatorEl.style.display).toBe('block');

    controller.showHighlight();
    expect(showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 4);
  });

  it('clears selection immediately when deselected without input handoff intent', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('preserves selection when focus moves into the chat sidebar', () => {
    controller.start();
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    const sidebarButton = {};
    focusScopeEl.addContainedNode(sidebarButton);
    (global as any).document.activeElement = sidebarButton;
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(indicatorEl.style.display).toBe('block');
  });

  it('clears selection when focus leaves markdown and the chat sidebar is not focused', () => {
    controller.start();
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    (global as any).document.activeElement = null;
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('preserves selection when input focus arrives after a slow editor blur handoff', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    inputEl.trigger('pointerdown');
    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;

    // Simulate delayed focus handoff under UI load.
    jest.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);

    (global as any).document.activeElement = inputEl;
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(hideSelectionHighlight).not.toHaveBeenCalled();
  });

  it('clears selection after handoff grace expires when input never receives focus', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    inputEl.trigger('pointerdown');
    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;

    jest.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);

    jest.advanceTimersByTime(750);
    expect(controller.hasSelection()).toBe(false);
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  describe('Reading mode (preview)', () => {
    let readingView: any;
    let containerEl: any;

    beforeEach(() => {
      containerEl = {
        contains: jest.fn().mockReturnValue(true),
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
        getSelection: jest.fn().mockReturnValue(mockSel),
      };

      controller.start();
      jest.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
      expect(controller.getContext()).toEqual({
        notePath: 'notes/reading.md',
        mode: 'selection',
        selectedText: 'reading selection',
        lineCount: 1,
      });
      expect(indicatorEl.textContent).toBe('1 line selected');
      expect(indicatorEl.style.display).toBe('block');
    });

    it('preserves raw reading mode text and omits line metadata', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('  reading selection\nsecond line  ', anchorNode),
        ),
      };

      controller.start();
      jest.advanceTimersByTime(250);

      expect(controller.getContext()).toEqual({
        notePath: 'notes/reading.md',
        mode: 'selection',
        selectedText: '  reading selection\nsecond line  ',
        lineCount: 2,
      });
      expect(indicatorEl.textContent).toBe('2 lines selected');
    });

    it('prefers native DOM selection in reading mode, falls back to CSS Highlight API when lost', () => {
      const anchorNode = {};
      const mockSel = createMockDOMSelection('reading selection', anchorNode);
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(mockSel),
      };
      const mockHighlights = { set: jest.fn(), delete: jest.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      controller.start();
      jest.advanceTimersByTime(250);

      controller.showHighlight();
      expect(mockHighlights.set).not.toHaveBeenCalled();

      const differentRange: any = {
        startContainer: {}, startOffset: 0,
        endContainer: {}, endOffset: 0,
      };
      (global as any).document.getSelection = jest.fn().mockReturnValue({
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

    it('clears selection when deselected in reading mode', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };

      controller.start();
      jest.advanceTimersByTime(250);
      expect(controller.hasSelection()).toBe(true);

      (global as any).document.getSelection.mockReturnValue(
        createMockDOMSelection('', null),
      );
      jest.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(false);
      expect(indicatorEl.style.display).toBe('none');
    });

    it('preserves reading mode selection when input is focused', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };

      controller.start();
      jest.advanceTimersByTime(250);
      expect(controller.hasSelection()).toBe(true);

      (global as any).document.getSelection.mockReturnValue(
        createMockDOMSelection('', null),
      );
      (global as any).document.activeElement = inputEl;
      jest.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
    });

    it('preserves reading mode selection when sidebar gets focus', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };

      controller.start();
      jest.advanceTimersByTime(250);
      expect(controller.hasSelection()).toBe(true);

      app.workspace.getActiveViewOfType.mockReturnValue(null);
      const sidebarButton = {};
      focusScopeEl.addContainedNode(sidebarButton);
      (global as any).document.activeElement = sidebarButton;
      jest.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
      expect(indicatorEl.style.display).toBe('block');
    });

    it('clears CSS highlight when reading mode selection is deselected', () => {
      const anchorNode = {};
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode),
        ),
      };
      const mockHighlights = { set: jest.fn(), delete: jest.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      controller.start();
      jest.advanceTimersByTime(250);

      (global as any).document.getSelection.mockReturnValue(
        createMockDOMSelection('', null),
      );
      jest.advanceTimersByTime(250);

      expect(mockHighlights.delete).toHaveBeenCalledWith('claudian-selection');
    });

    it('skips CSS highlight for disconnected DOM ranges', () => {
      const anchorNode = {};
      const mockSel = createMockDOMSelection('reading selection', anchorNode);
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(mockSel),
      };

      controller.start();
      jest.advanceTimersByTime(250);

      mockSel._range.startContainer.isConnected = false;
      const mockHighlights = { set: jest.fn(), delete: jest.fn() };
      (global as any).CSS = { highlights: mockHighlights };

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
        getSelection: jest.fn(() => currentSelection),
      };
      const mockHighlights = { set: jest.fn(), delete: jest.fn() };
      (global as any).CSS = { highlights: mockHighlights };

      controller.start();
      jest.advanceTimersByTime(250);

      currentSelection = createMockDOMSelection('repeat', secondAnchorNode, undefined, secondRange);
      jest.advanceTimersByTime(250);

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
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('outside selection', anchorNode),
        ),
      };

      controller.start();
      jest.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(false);
    });

    it('uses focusNode when anchorNode is outside the view container', () => {
      const anchorNode = {};
      const focusNode = {};
      containerEl.contains.mockImplementation((node: unknown) => node === focusNode);
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('reading selection', anchorNode, focusNode),
        ),
      };

      controller.start();
      jest.advanceTimersByTime(250);

      expect(controller.hasSelection()).toBe(true);
    });

    it('replaces source selection metadata when switching the same text into preview mode', () => {
      const sourceView = { editor, getMode: () => 'source', file: { path: 'notes/test.md' } };
      app.workspace.getActiveViewOfType.mockReturnValue(sourceView);

      controller.start();
      jest.advanceTimersByTime(250);

      const previewAnchorNode = {};
      readingView.file.path = 'notes/test.md';
      app.workspace.getActiveViewOfType.mockReturnValue(readingView);
      (global as any).document = {
        activeElement: null,
        getSelection: jest.fn().mockReturnValue(
          createMockDOMSelection('selected text', previewAnchorNode),
        ),
      };
      (showSelectionHighlight as jest.Mock).mockClear();

      jest.advanceTimersByTime(250);
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

  it('keeps context row visible when canvas selection indicator is visible', () => {
    const canvasIndicator = { style: { display: 'block' } };
    contextRowEl.querySelector.mockImplementation((selector: string) => {
      if (selector === '.claudian-canvas-indicator') return canvasIndicator;
      return null;
    });

    controller.updateContextRowVisibility();

    expect(contextRowEl.classList.toggle).toHaveBeenCalledWith('has-content', true);
  });
});
