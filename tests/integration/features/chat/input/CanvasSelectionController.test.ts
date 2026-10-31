// @vitest-environment jsdom
import { fireEvent, within } from '@testing-library/dom';
import { App, ItemView, WorkspaceLeaf } from 'obsidian';

import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';

class CanvasView extends ItemView {
  canvas: { selection: Set<{ id: string }> };
  file: { path: string };
  constructor(path: string, ids: string[]) {
    super(null as unknown as WorkspaceLeaf);
    this.file = { path };
    this.canvas = { selection: new Set(ids.map(id => ({ id }))) };
  }
  getViewType() { return 'canvas'; }
  getDisplayText() { return this.file.path; }
}

/** The selection runs under the tab's shared poll cadence; the other sources stay idle. */
let polling: ComposerSelections | null = null;
function startPolling(source: CanvasSelectionController): ComposerSelections {
  const idle = { clear: vi.fn(), getContext: () => null, poll: vi.fn(), start: vi.fn(), stop: vi.fn() };
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
  let app: App;
  let contextTray: ComposerContextTray;
  let trayEl: HTMLElement;
  let inputEl: HTMLTextAreaElement;
  let canvasView: CanvasView;

  beforeEach(() => {
    vi.useFakeTimers();

    trayEl = document.body.createDiv();
    contextTray = new ComposerContextTray(trayEl);
    vi.spyOn(contextTray, 'setItems');
    vi.spyOn(contextTray, 'clearItems');
    inputEl = document.body.createEl('textarea', { attr: { 'aria-label': 'Message' } });
    canvasView = new CanvasView('my-canvas.canvas', ['abc123', 'def456']);
    app = new App();
    app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({ view: canvasView });
    vi.mocked(app.workspace.getLeavesOfType).mockReturnValue([Object.assign(new WorkspaceLeaf(), { view: canvasView })]);
    controller = new CanvasSelectionController(app, contextTray, inputEl);
  });

  afterEach(() => {
    stopPolling();
    vi.useRealTimers();
    contextTray.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('captures canvas selection and updates indicator', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      canvasPath: 'my-canvas.canvas',
      nodeIds: expect.arrayContaining(['abc123', 'def456']),
    });
    expect(contextTray.setItems).toHaveBeenLastCalledWith('canvas-selection', [
      expect.objectContaining({ label: '2 nodes selected' }),
    ]);
    expect(within(trayEl).getByRole('button', { name: 'Remove 2 nodes selected' })).toBeDefined();
  });

  it('shows node ID for single selection', () => {
    const singleNode = { id: 'single1' };
    canvasView.canvas.selection = new Set([singleNode]);

    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.getContext()?.nodeIds).toEqual(['single1']);
    expect(contextTray.setItems).toHaveBeenLastCalledWith('canvas-selection', [
      expect.objectContaining({ label: '1 node selected' }),
    ]);
  });

  it('clears selection when no nodes selected and input not focused', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    canvasView.canvas.selection = new Set();
    inputEl.blur();

    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('canvas-selection');
  });

  it('preserves selection when input is focused (sticky)', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    canvasView.canvas.selection = new Set();
    inputEl.focus();

    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('canvas-selection');
  });

  it('returns null context when no selection', () => {
    canvasView.canvas.selection = new Set();
    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.getContext()).toBeNull();
  });

  it('does not update when selection unchanged', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    vi.mocked(contextTray.setItems).mockClear();

    vi.advanceTimersByTime(250);

    expect(contextTray.setItems).not.toHaveBeenCalled();
  });

  it('prefers active canvas leaf when multiple canvases are open', () => {
    const inactiveCanvasView = new CanvasView('inactive.canvas', ['inactive-node']);
    const activeCanvasView = new CanvasView('active.canvas', ['active-node']);
    vi.mocked(app.workspace.getLeavesOfType).mockReturnValue([
      Object.assign(new WorkspaceLeaf(), { view: inactiveCanvasView }),
      Object.assign(new WorkspaceLeaf(), { view: activeCanvasView }),
    ]);
    vi.mocked(app.workspace.getMostRecentLeaf).mockReturnValue(Object.assign(new WorkspaceLeaf(), { view: activeCanvasView }));

    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.getContext()).toEqual({
      canvasPath: 'active.canvas',
      nodeIds: ['active-node'],
    });
  });

  it('handles no canvas view gracefully', () => {
    vi.mocked(app.workspace.getMostRecentLeaf).mockReturnValue(null);
    vi.mocked(app.workspace.getLeavesOfType).mockReturnValue([]);

    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(controller.getContext()).toBeNull();
  });

  it('clear() resets state and indicator', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('canvas-selection');
  });

  it('clears selection from the tray remove action', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    fireEvent.click(within(trayEl).getByRole('button', { name: 'Remove 2 nodes selected' }));

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('canvas-selection');
  });
});
