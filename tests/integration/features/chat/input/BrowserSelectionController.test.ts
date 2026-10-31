import { App, MarkdownView, WorkspaceLeaf } from 'obsidian';
/** @vitest-environment jsdom */
import type { Mock, MockInstance } from 'vitest';

import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { BrowserSelectionController } from '@/features/chat/input/BrowserSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';

function createMockContextTray() {
  const tray = new ComposerContextTray(document.createElement('div'));
  return Object.assign(tray, { setItems: vi.spyOn(tray, 'setItems'), clearItems: vi.spyOn(tray, 'clearItems') });

}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}


/** The selection runs under the tab's shared poll cadence; the other sources stay idle. */
let polling: ComposerSelections | null = null;
function startPolling(source: BrowserSelectionController): ComposerSelections {
  const idle = { clear: vi.fn(), getContext: () => null, poll: vi.fn(), start: vi.fn(), stop: vi.fn() };
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
  let app: App;
  let browserView: MarkdownView & { currentUrl: string };
  let contextTray: ReturnType<typeof createMockContextTray>;
  let inputEl: HTMLTextAreaElement;
  let containerEl: HTMLElement;
  let selectionText = 'selected web snippet';
  let getSelectionSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    selectionText = 'selected web snippet';

    contextTray = createMockContextTray();
    inputEl = document.createElement('textarea');
    document.body.appendChild(inputEl);
    containerEl = document.createElement('div');
    const selectionAnchor = document.createElement('span');
    containerEl.appendChild(selectionAnchor);

    getSelectionSpy = vi.spyOn(document, 'getSelection').mockImplementation(() => ({
      toString: () => selectionText,
      anchorNode: selectionAnchor,
      focusNode: selectionAnchor,
    } as unknown as Selection));

    const view = browserView = Object.assign(new MarkdownView(new WorkspaceLeaf()), {
      getViewType: () => 'surfing-view',
      getDisplayText: () => 'Surfing',
      containerEl,
      currentUrl: 'https://example.com',
    });

    app = new App();
    const leaf = Object.assign(new WorkspaceLeaf(), { view });
    app.workspace.activeLeaf = leaf;
    app.workspace.getMostRecentLeaf = vi.fn(() => leaf);


    controller = new BrowserSelectionController(app, contextTray, inputEl);
  });

  afterEach(() => {
    stopPolling();
    inputEl.remove();
    contextTray.destroy();
    getSelectionSpy.mockRestore();
    vi.useRealTimers();
  });

  it.each(['stop', 'clear', 'restart'] as const)('discards pending webview selection across %s', async action => {
    selectionText = '';
    const webview = document.createElement('webview') as HTMLElement & { executeJavaScript: Mock };
    let finishRead!: (value: string) => void;
    webview.executeJavaScript = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { finishRead = resolve; }))
      .mockResolvedValue('current selection');
    containerEl.appendChild(webview);
    startPolling(controller);
    vi.advanceTimersByTime(250);
    if (action === 'clear') controller.clear();
    else stopPolling();
    if (action === 'restart') {
      startPolling(controller);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(controller.getContext()?.selectedText ?? null).toBe(action === 'restart' ? 'current selection' : null);
    const publications = contextTray.setItems.mock.calls.length;
    finishRead('stale selection');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getContext()?.selectedText ?? null).toBe(action === 'restart' ? 'current selection' : null);
    expect(contextTray.setItems).toHaveBeenCalledTimes(publications);
  });

  it('captures browser selection and updates indicator', async () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
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

  it.each(['view replacement', 'page navigation', 'unchanged page'])('fences a pending native selection across %s', async action => {
    selectionText = '';
    const view = browserView;
    const webview = document.createElement('webview') as HTMLElement & { executeJavaScript: Mock };
    let finish!: (value: string) => void;
    webview.executeJavaScript = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    containerEl.appendChild(webview);
    const pending = controller.poll();
    expect(webview.executeJavaScript).toHaveBeenCalledTimes(1);
    if (action === 'view replacement') {
      vi.mocked(app.workspace.getMostRecentLeaf).mockReturnValue(Object.assign(new WorkspaceLeaf(), { view: Object.assign(new MarkdownView(new WorkspaceLeaf()), { containerEl: document.createElement('div'), currentUrl: 'https://different.example/' }) }));
    }
    if (action === 'page navigation') view.currentUrl = 'https://different.example/';
    finish('native selected text');
    await pending;
    expect(controller.getContext()).toEqual(action === 'unchanged page' ? {
      source: 'browser:https://example.com', selectedText: 'native selected text', title: 'Surfing', url: 'https://example.com',
    } : null);
    expect(contextTray.setItems).toHaveBeenCalledTimes(action === 'unchanged page' ? 1 : 0);
  });

  it('shows line-based indicator text for multi-line browser selection', async () => {
    selectionText = 'line 1\nline 2';
    startPolling(controller);
    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(contextTray.setItems).toHaveBeenLastCalledWith('browser-selection', [
      expect.objectContaining({ label: '2 lines selected' }),
    ]);
  });

  it('clears selection when text is deselected and input is not focused', async () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('keeps selection while input is focused', async () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    inputEl.focus();
    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(true);
  });

  it('clears selection when clear is called', async () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('clears selection from the tray remove action', async () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    const items = contextTray.setItems.mock.calls[0][1];
    items[0].onRemove!();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('handles polling errors without unhandled rejection', async () => {
    selectionText = '';
    const extractSpy = vi.fn().mockRejectedValueOnce(new Error('poll failed'));
    const webview = Object.assign(document.createElement('webview'), { executeJavaScript: extractSpy });
    containerEl.appendChild(webview);

    startPolling(controller);
    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(extractSpy).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(false);
  });
});
