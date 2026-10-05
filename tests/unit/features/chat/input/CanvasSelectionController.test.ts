import { createMockEl } from '@test/helpers/MockElement';

import { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';

function createMockContextTray() {
  return {
    setItems: jest.fn(),
    clearItems: jest.fn(),
  };
}

function createMockCanvasNode(id: string) {
  return { id };
}


/** The selection runs under the tab's shared poll cadence; the other sources stay idle. */
let polling: ComposerSelections | null = null;
function startPolling(source: CanvasSelectionController): ComposerSelections {
  const idle = { clear: jest.fn(), getContext: () => null, poll: jest.fn(), start: jest.fn(), stop: jest.fn() };
  polling = new ComposerSelections({ editor: idle, browser: idle, canvas: source });
  polling.start();
  return polling;
}
function stopPolling(): void {
  polling?.stop();
  polling = null;
}

describe('CanvasSelectionController', () => {
  let controller: CanvasSelectionController;
  let app: any;
  let contextTray: ReturnType<typeof createMockContextTray>;
  let inputEl: any;
  let canvasView: any;
  let originalDocument: any;

  beforeEach(() => {
    jest.useFakeTimers();

    contextTray = createMockContextTray();
    inputEl = createMockEl();

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
        getMostRecentLeaf: jest.fn().mockReturnValue({ view: canvasView }),
        getLeavesOfType: jest.fn().mockReturnValue([{ view: canvasView }]),
      },
    };

    controller = new CanvasSelectionController(app, contextTray as any, inputEl);

    originalDocument = (global as any).document;
    (global as any).document = { activeElement: null };
  });

  afterEach(() => {
    stopPolling();
    jest.useRealTimers();
    (global as any).document = originalDocument;
  });

  it('captures canvas selection and updates indicator', () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      canvasPath: 'my-canvas.canvas',
      nodeIds: expect.arrayContaining(['abc123', 'def456']),
    });
    expect(contextTray.setItems).toHaveBeenLastCalledWith('canvas-selection', [
      expect.objectContaining({ label: '2 nodes selected' }),
    ]);
    expect(contextTray.setItems.mock.calls[0][1][0]).not.toHaveProperty('title');
  });

  it('shows node ID for single selection', () => {
    const singleNode = createMockCanvasNode('single1');
    canvasView.canvas.selection = new Set([singleNode]);

    startPolling(controller);
    jest.advanceTimersByTime(250);

    expect(controller.getContext()?.nodeIds).toEqual(['single1']);
    expect(contextTray.setItems).toHaveBeenLastCalledWith('canvas-selection', [
      expect.objectContaining({ label: '1 node selected' }),
    ]);
  });

  it('clears selection when no nodes selected and input not focused', () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    canvasView.canvas.selection = new Set();
    (global as any).document.activeElement = null;

    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('canvas-selection');
  });

  it('preserves selection when input is focused (sticky)', () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    canvasView.canvas.selection = new Set();
    (global as any).document.activeElement = inputEl;

    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('canvas-selection');
  });

  it('returns null context when no selection', () => {
    canvasView.canvas.selection = new Set();
    startPolling(controller);
    jest.advanceTimersByTime(250);

    expect(controller.getContext()).toBeNull();
  });

  it('does not update when selection unchanged', () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);

    contextTray.setItems.mockClear();

    jest.advanceTimersByTime(250);

    expect(contextTray.setItems).not.toHaveBeenCalled();
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
    app.workspace.getMostRecentLeaf.mockReturnValue({ view: activeCanvasView });

    startPolling(controller);
    jest.advanceTimersByTime(250);

    expect(controller.getContext()).toEqual({
      canvasPath: 'active.canvas',
      nodeIds: ['active-node'],
    });
  });

  it('handles no canvas view gracefully', () => {
    app.workspace.getMostRecentLeaf.mockReturnValue(null);
    app.workspace.getLeavesOfType.mockReturnValue([]);

    startPolling(controller);
    jest.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(controller.getContext()).toBeNull();
  });

  it('clear() resets state and indicator', () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('canvas-selection');
  });

  it('clears selection from the tray remove action', () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);

    const items = contextTray.setItems.mock.calls[0][1];
    items[0].onRemove();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('canvas-selection');
  });
});
