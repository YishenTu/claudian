import { CanvasSelectionController } from '@/features/chat/controllers/CanvasSelectionController';

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

function createMockCanvasNode(id: string) {
  return { id };
}

describe('CanvasSelectionController', () => {
  let controller: CanvasSelectionController;
  let app: any;
  let indicatorEl: any;
  let inputEl: any;
  let contextRowEl: any;
  let canvasView: any;
  let originalDocument: any;

  beforeEach(() => {
    jest.useFakeTimers();

    indicatorEl = createMockIndicator();
    inputEl = {};
    contextRowEl = createMockContextRow();

    const node1 = createMockCanvasNode('abc123');
    const node2 = createMockCanvasNode('def456');

    canvasView = {
      getViewType: () => 'canvas',
      canvas: {
        selection: new Set([node1, node2]),
      },
      file: { path: 'my-canvas.canvas' },
    };

    app = {
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(null),
        getLeavesOfType: jest.fn().mockReturnValue([{ view: canvasView }]),
      },
    };

    controller = new CanvasSelectionController(app, indicatorEl, inputEl, contextRowEl);

    originalDocument = (global as any).document;
    (global as any).document = { activeElement: null };
  });

  afterEach(() => {
    controller.stop();
    jest.useRealTimers();
    (global as any).document = originalDocument;
  });

  it('captures canvas selection and updates indicator', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      canvasPath: 'my-canvas.canvas',
      nodeIds: expect.arrayContaining(['abc123', 'def456']),
    });
    expect(indicatorEl.textContent).toBe('2 nodes selected');
    expect(indicatorEl.style.display).toBe('block');
  });

  it('shows node ID for single selection', () => {
    const singleNode = createMockCanvasNode('single1');
    canvasView.canvas.selection = new Set([singleNode]);

    controller.start();
    jest.advanceTimersByTime(250);

    expect(controller.getContext()?.nodeIds).toEqual(['single1']);
    expect(indicatorEl.textContent).toBe('node "single1" selected');
  });

  it('clears selection when no nodes selected and input not focused', () => {
    controller.start();
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    canvasView.canvas.selection = new Set();
    (global as any).document.activeElement = null;

    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
  });

  it('preserves selection when input is focused (sticky)', () => {
    controller.start();
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    canvasView.canvas.selection = new Set();
    (global as any).document.activeElement = inputEl;

    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(indicatorEl.textContent).toBe('2 nodes selected');
  });

  it('returns null context when no selection', () => {
    canvasView.canvas.selection = new Set();
    controller.start();
    jest.advanceTimersByTime(250);

    expect(controller.getContext()).toBeNull();
  });

  it('does not update when selection unchanged', () => {
    controller.start();
    jest.advanceTimersByTime(250);

    contextRowEl.classList.toggle.mockClear();

    jest.advanceTimersByTime(250);

    // toggle should not be called again (no change)
    expect(contextRowEl.classList.toggle).not.toHaveBeenCalled();
  });

  it('keeps context row visible when editor selection indicator is visible', () => {
    const editorIndicator = { style: { display: 'block' } };
    contextRowEl.querySelector.mockImplementation((selector: string) => {
      if (selector === '.claudian-selection-indicator') return editorIndicator;
      return null;
    });

    controller.updateContextRowVisibility();

    expect(contextRowEl.classList.toggle).toHaveBeenCalledWith('has-content', true);
  });

  it('prefers active canvas leaf when multiple canvases are open', () => {
    const activeNode = createMockCanvasNode('active-node');
    const inactiveNode = createMockCanvasNode('inactive-node');
    const inactiveCanvasView = {
      getViewType: () => 'canvas',
      canvas: { selection: new Set([inactiveNode]) },
      file: { path: 'inactive.canvas' },
    };
    const activeCanvasView = {
      getViewType: () => 'canvas',
      canvas: { selection: new Set([activeNode]) },
      file: { path: 'active.canvas' },
    };

    app.workspace.getLeavesOfType.mockReturnValue([
      { view: inactiveCanvasView },
      { view: activeCanvasView },
    ]);
    app.workspace.activeLeaf = { view: activeCanvasView };

    controller.start();
    jest.advanceTimersByTime(250);

    expect(controller.getContext()).toEqual({
      canvasPath: 'active.canvas',
      nodeIds: ['active-node'],
    });
  });

  it('handles no canvas view gracefully', () => {
    app.workspace.activeLeaf = null;
    app.workspace.getLeavesOfType.mockReturnValue([]);

    controller.start();
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(controller.getContext()).toBeNull();
  });

  it('clear() resets state and indicator', () => {
    controller.start();
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
  });
});
