/** @jest-environment jsdom */

import { BrowserSelectionController } from '@/features/chat/input/BrowserSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';

function createMockContextTray() {
  return {
    setItems: jest.fn(),
    clearItems: jest.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}


/** The selection runs under the tab's shared poll cadence; the other sources stay idle. */
let polling: ComposerSelections | null = null;
function startPolling(source: BrowserSelectionController): ComposerSelections {
  const idle = { clear: jest.fn(), getContext: () => null, poll: jest.fn(), start: jest.fn(), stop: jest.fn() };
  polling = new ComposerSelections({ editor: idle, browser: source, canvas: idle });
  polling.start();
  return polling;
}
function stopPolling(): void {
  polling?.stop();
  polling = null;
}

describe('BrowserSelectionController', () => {
  let controller: BrowserSelectionController;
  let app: any;
  let contextTray: ReturnType<typeof createMockContextTray>;
  let inputEl: HTMLTextAreaElement;
  let containerEl: HTMLElement;
  let selectionText = 'selected web snippet';
  let getSelectionSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    selectionText = 'selected web snippet';

    contextTray = createMockContextTray();
    inputEl = document.createElement('textarea');
    document.body.appendChild(inputEl);
    containerEl = document.createElement('div');
    const selectionAnchor = document.createElement('span');
    containerEl.appendChild(selectionAnchor);

    getSelectionSpy = jest.spyOn(document, 'getSelection').mockImplementation(() => ({
      toString: () => selectionText,
      anchorNode: selectionAnchor,
      focusNode: selectionAnchor,
    } as unknown as Selection));

    const view = {
      getViewType: () => 'surfing-view',
      getDisplayText: () => 'Surfing',
      containerEl,
      currentUrl: 'https://example.com',
    };

    app = {
      workspace: {
        activeLeaf: { view },
        getMostRecentLeaf: jest.fn(() => ({ view })),
      },
    };

    controller = new BrowserSelectionController(app, contextTray as any, inputEl);
  });

  afterEach(() => {
    stopPolling();
    inputEl.remove();
    getSelectionSpy.mockRestore();
    jest.useRealTimers();
  });

  it.each(['stop', 'clear', 'restart'] as const)('discards pending webview selection across %s', async action => {
    selectionText = '';
    const webview = document.createElement('webview') as HTMLElement & { executeJavaScript: jest.Mock };
    let finishRead!: (value: string) => void;
    webview.executeJavaScript = jest.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { finishRead = resolve; }))
      .mockResolvedValue('current selection');
    containerEl.appendChild(webview);
    startPolling(controller);
    jest.advanceTimersByTime(250);
    if (action === 'clear') controller.clear();
    else stopPolling();
    if (action === 'restart') {
      startPolling(controller);
      await jest.advanceTimersByTimeAsync(250);
    }
    expect(controller.getContext()?.selectedText ?? null).toBe(action === 'restart' ? 'current selection' : null);
    const publications = contextTray.setItems.mock.calls.length;
    finishRead('stale selection');
    await jest.advanceTimersByTimeAsync(0);
    expect(controller.getContext()?.selectedText ?? null).toBe(action === 'restart' ? 'current selection' : null);
    expect(contextTray.setItems).toHaveBeenCalledTimes(publications);
  });

  it('captures browser selection and updates indicator', async () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.getContext()).toEqual({
      source: 'browser:https://example.com',
      selectedText: 'selected web snippet',
      title: 'Surfing',
      url: 'https://example.com',
    });
    expect(contextTray.setItems).toHaveBeenLastCalledWith('browser-selection', [
      expect.objectContaining({
        label: '1 line selected',
      }),
    ]);
    expect(contextTray.setItems.mock.calls[0][1][0]).not.toHaveProperty('title');
  });

  it('shows line-based indicator text for multi-line browser selection', async () => {
    selectionText = 'line 1\nline 2';
    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(contextTray.setItems).toHaveBeenLastCalledWith('browser-selection', [
      expect.objectContaining({ label: '2 lines selected' }),
    ]);
  });

  it('clears selection when text is deselected and input is not focused', async () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('keeps selection while input is focused', async () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    inputEl.focus();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(true);
  });

  it('clears selection when clear is called', async () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('clears selection from the tray remove action', async () => {
    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    const items = contextTray.setItems.mock.calls[0][1];
    items[0].onRemove();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('handles polling errors without unhandled rejection', async () => {
    const extractSpy = jest.spyOn(controller as any, 'extractSelectedText')
      .mockRejectedValueOnce(new Error('poll failed'));

    startPolling(controller);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(extractSpy).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(false);
  });
});
