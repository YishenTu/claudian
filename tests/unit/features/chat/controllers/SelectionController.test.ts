import { SelectionController } from '@/features/chat/controllers/SelectionController';
import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';

jest.mock('@/shared/components/SelectionHighlight', () => ({
  showSelectionHighlight: jest.fn(),
  hideSelectionHighlight: jest.fn(),
}));

function createMockIndicator() {
  return {
    textContent: '',
    style: { display: 'none' },
  } as any;
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
  let contextRowEl: any;
  let editor: any;
  let editorView: any;
  let originalDocument: any;

  beforeEach(() => {
    jest.useFakeTimers();
    (showSelectionHighlight as jest.Mock).mockClear();
    (hideSelectionHighlight as jest.Mock).mockClear();

    indicatorEl = createMockIndicator();
    inputEl = {};
    contextRowEl = createMockContextRow();

    editorView = { id: 'editor-view' };
    editor = {
      getSelection: jest.fn().mockReturnValue('selected text'),
      getCursor: jest.fn((which: 'from' | 'to') => {
        if (which === 'from') return { line: 0, ch: 0 };
        return { line: 0, ch: 4 };
      }),
      posToOffset: jest.fn((pos: { line: number; ch: number }) => pos.line * 100 + pos.ch),
      cm: editorView,
    };

    const view = { editor, file: { path: 'notes/test.md' } };
    app = {
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(view),
      },
    };

    controller = new SelectionController(app, indicatorEl, inputEl, contextRowEl);

    originalDocument = (global as any).document;
    (global as any).document = { activeElement: null };
  });

  afterEach(() => {
    controller.stop();
    jest.useRealTimers();
    (global as any).document = originalDocument;
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

  it('clears selection when selection is removed and input is not focused', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    editor.getSelection.mockReturnValue('');
    (global as any).document.activeElement = null;

    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
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
