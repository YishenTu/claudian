/** @jest-environment jsdom */

import { BrowserSelectionController } from '@/features/chat/controllers/BrowserSelectionController';

function createMockIndicator() {
  const indicatorEl = document.createElement('div');
  indicatorEl.style.display = 'none';
  return indicatorEl;
}

function createMockContextRow(browserIndicator: HTMLElement) {
  const fileIndicator = { style: { display: 'none' } };
  const imagePreview = { style: { display: 'none' } };
  const elements: Record<string, any> = {
    '.claudian-selection-indicator': { style: { display: 'none' } },
    '.claudian-browser-selection-indicator': browserIndicator,
    '.claudian-canvas-indicator': { style: { display: 'none' } },
    '.claudian-file-indicator': fileIndicator,
    '.claudian-image-preview': imagePreview,
  };

  return {
    classList: {
      toggle: jest.fn(),
    },
    querySelector: jest.fn((selector: string) => elements[selector] ?? null),
  } as any;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('BrowserSelectionController', () => {
  let controller: BrowserSelectionController;
  let app: any;
  let indicatorEl: any;
  let inputEl: HTMLTextAreaElement;
  let contextRowEl: any;
  let containerEl: HTMLElement;
  let selectionText = 'selected web snippet';
  let getSelectionSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    selectionText = 'selected web snippet';

    indicatorEl = createMockIndicator();
    inputEl = document.createElement('textarea');
    document.body.appendChild(inputEl);
    contextRowEl = createMockContextRow(indicatorEl);
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

    controller = new BrowserSelectionController(app, indicatorEl, inputEl, contextRowEl);
  });

  afterEach(() => {
    controller.stop();
    inputEl.remove();
    getSelectionSpy.mockRestore();
    jest.useRealTimers();
  });

  it('captures browser selection and updates indicator', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.getContext()).toEqual({
      source: 'browser:https://example.com',
      selectedText: 'selected web snippet',
      title: 'Surfing',
      url: 'https://example.com',
    });
    expect(indicatorEl.style.display).toBe('block');
    expect(indicatorEl.textContent).toBe('1 line selected');
    expect(indicatorEl.textContent).not.toContain('source=');
    expect(indicatorEl.getAttribute('title')).toContain('chars selected');
    expect(indicatorEl.getAttribute('title')).toContain('source=browser:https://example.com');
    expect(indicatorEl.getAttribute('title')).toContain('title=Surfing');
    expect(indicatorEl.getAttribute('title')).toContain('https://example.com');
  });

  it('shows line-based indicator text for multi-line browser selection', async () => {
    selectionText = 'line 1\nline 2';
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(indicatorEl.textContent).toBe('2 lines selected');
  });

  it('clears selection when text is deselected and input is not focused', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
  });

  it('keeps selection while input is focused', async () => {
    controller.start();
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
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
  });

  it('handles polling errors without unhandled rejection', async () => {
    const extractSpy = jest.spyOn(controller as any, 'extractSelectedText')
      .mockRejectedValueOnce(new Error('poll failed'));

    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(extractSpy).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(false);
  });
});
