import { createMockEl } from '@test/helpers/MockElement';
import { Notice } from 'obsidian';

import { DualPaneLayout,type DualPaneLayoutSettings } from '@/features/chat/view/DualPaneLayout';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
}

function createLayoutHarness(options: {
  settings?: DualPaneLayoutSettings;
  width?: number;
  discardProvisionalTabs?: () => Promise<void> | void;
} = {}) {
  let width = options.width ?? 400;
  const containerEl = createMockEl();
  containerEl.getBoundingClientRect = jest.fn(() => ({ width }));
  containerEl.style.setProperty = jest.fn();
  const resizerEl = createMockEl();
  const sidebarEl = createMockEl();
  sidebarEl.getBoundingClientRect = jest.fn().mockReturnValue({ width: 240 });
  const calls: string[] = [];
  const hooks = {
    getSettings: () => options.settings ?? {},
    onWideChanged: jest.fn(() => { calls.push('wide-changed'); }),
    onEnterWide: jest.fn(() => { calls.push('enter-wide'); }),
    renderSidebar: jest.fn(() => { calls.push('render-sidebar'); }),
    onLeaveWideRequested: jest.fn(() => { calls.push('leave-wide'); }),
    discardProvisionalTabs: jest.fn(() => {
      calls.push('discard');
      return options.discardProvisionalTabs?.();
    }),
  };
  const layout = new DualPaneLayout(hooks);
  return {
    calls,
    containerEl,
    hooks,
    layout,
    resizerEl,
    setWidth: (next: number) => { width = next; },
    sidebarEl,
    initialize: () => layout.initialize({ containerEl, resizerEl, sidebarEl }),
  };
}

/** Initializes compact, then observes a wide container through the resize observer. */
function observeWidths(harness: ReturnType<typeof createLayoutHarness>) {
  let resizeCallback: ResizeObserverCallback = () => {};
  const observe = jest.fn();
  const disconnect = jest.fn();
  harness.containerEl.ownerDocument.defaultView.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe = observe;
    disconnect = disconnect;
  };
  harness.initialize();
  harness.layout.startObserving();
  return {
    disconnect,
    observe,
    resize: (width: number) => resizeCallback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  };
}

describe('DualPaneLayout', () => {
  it('measures on initialize without rendering the sidebar', () => {
    const harness = createLayoutHarness({ width: 640 });

    harness.initialize();

    expect(harness.layout.isWide).toBe(true);
    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(harness.hooks.onWideChanged).toHaveBeenCalledTimes(1);
    expect(harness.hooks.onEnterWide).toHaveBeenCalledTimes(1);
    expect(harness.hooks.renderSidebar).not.toHaveBeenCalled();
    expect(harness.resizerEl.getAttribute('role')).toBe('separator');
    expect(harness.resizerEl.getAttribute('aria-label')).toBe('Resize conversation sessions');
  });

  it('observes the container width and disconnects the observer on dispose', () => {
    const harness = createLayoutHarness({ width: 400 });
    const observer = observeWidths(harness);

    expect(observer.observe).toHaveBeenCalledWith(harness.containerEl);
    expect(harness.layout.isWide).toBe(false);

    observer.resize(900);
    expect(harness.layout.isWide).toBe(true);
    expect(harness.calls).toEqual(['wide-changed', 'enter-wide', 'render-sidebar']);

    harness.layout.dispose();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refreshes the sidebar on later wide measurements', () => {
    const harness = createLayoutHarness({ width: 900 });
    const observer = observeWidths(harness);
    harness.hooks.renderSidebar.mockClear();

    observer.resize(1000);

    expect(harness.hooks.renderSidebar).toHaveBeenCalledTimes(1);
    expect(harness.hooks.onEnterWide).toHaveBeenCalledTimes(1);
  });

  it('keeps the single-panel layout when dual-pane mode is disabled', () => {
    const harness = createLayoutHarness({
      settings: { enableDualPane: false, dualPaneSide: 'right' },
      width: 900,
    });
    observeWidths(harness);

    expect(harness.layout.isWide).toBe(false);
    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(harness.hooks.renderSidebar).not.toHaveBeenCalled();
  });

  it('attaches the session column to the configured left side', () => {
    const harness = createLayoutHarness({
      settings: { enableDualPane: true, dualPaneSide: 'left' },
      width: 900,
    });
    harness.initialize();

    expect(harness.containerEl.hasClass('claudian-session-sidebar-left')).toBe(true);
    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(true);
  });

  it('keeps dual-mode controls in place until provisional cleanup finishes', async () => {
    const cleanup = deferred();
    const harness = createLayoutHarness({
      width: 900,
      discardProvisionalTabs: () => cleanup.promise,
    });
    const observer = observeWidths(harness);
    harness.calls.length = 0;

    observer.resize(599);

    expect(harness.layout.isWide).toBe(true);
    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(harness.calls).toEqual(['leave-wide', 'discard']);

    cleanup.resolve();
    await flushPromises();

    expect(harness.layout.isWide).toBe(false);
    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(harness.calls).toEqual(['leave-wide', 'discard', 'wide-changed']);
  });

  it('keeps dual mode and its previews while the view has no width, as in a collapsed sidebar', async () => {
    const harness = createLayoutHarness({ width: 900 });
    const observer = observeWidths(harness);

    observer.resize(0);
    await flushPromises();

    expect(harness.hooks.discardProvisionalTabs).not.toHaveBeenCalled();
    expect(harness.layout.isWide).toBe(true);
    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(true);
  });

  it('reports one failure when overlapping compact transitions share a failed preview cleanup', async () => {
    const sharedCleanup = deferred();
    const harness = createLayoutHarness({
      width: 900,
      discardProvisionalTabs: () => sharedCleanup.promise,
    });
    const observer = observeWidths(harness);
    (Notice as unknown as jest.Mock).mockClear();

    observer.resize(599);
    observer.resize(600);
    observer.resize(599);
    sharedCleanup.reject(new Error('close failed'));
    await flushPromises();

    expect(harness.hooks.discardProvisionalTabs).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith('Failed to close the provisional session preview');
    expect(harness.layout.isWide).toBe(false);
  });

  it('cancels a pending compact transition when the view becomes wide again', async () => {
    const cleanup = deferred();
    const harness = createLayoutHarness({
      width: 900,
      discardProvisionalTabs: () => cleanup.promise,
    });
    const observer = observeWidths(harness);
    harness.hooks.renderSidebar.mockClear();

    observer.resize(599);
    observer.resize(600);
    cleanup.resolve();
    await flushPromises();

    expect(harness.containerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(harness.layout.isWide).toBe(true);
    expect(harness.hooks.renderSidebar).toHaveBeenCalledTimes(1);
  });

  it('abandons a pending compact transition once disposed', async () => {
    const cleanup = deferred();
    const harness = createLayoutHarness({
      width: 900,
      discardProvisionalTabs: () => cleanup.promise,
    });
    const observer = observeWidths(harness);

    observer.resize(599);
    harness.layout.dispose();
    cleanup.resolve();
    await flushPromises();

    expect(harness.layout.isWide).toBe(true);
  });

  it('resizes chat and session columns without changing the total view width', () => {
    const harness = createLayoutHarness({ width: 800 });
    harness.initialize();
    const documentListeners = new Map<string, EventListener>();
    const ownerDocument = {
      addEventListener: jest.fn((event: string, listener: EventListener) => {
        documentListeners.set(event, listener);
      }),
      removeEventListener: jest.fn((event: string) => {
        documentListeners.delete(event);
      }),
    };

    harness.resizerEl.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      clientX: 500,
      currentTarget: { ownerDocument },
      preventDefault: jest.fn(),
    });
    documentListeners.get('pointermove')?.({ clientX: 450 } as unknown as Event);

    expect(harness.containerEl.style.setProperty).toHaveBeenLastCalledWith(
      '--claudian-session-sidebar-width',
      '290px',
    );
    expect(harness.resizerEl.getAttribute('aria-valuenow')).toBe('290');
    expect(harness.containerEl.hasClass('claudian-resizing-session-sidebar')).toBe(true);

    documentListeners.get('pointerup')?.({} as Event);
    expect(harness.containerEl.hasClass('claudian-resizing-session-sidebar')).toBe(false);
    expect(ownerDocument.removeEventListener).toHaveBeenCalledWith(
      'pointermove',
      expect.any(Function),
    );
  });

  it('uses the opposite drag direction when the session column is on the left', () => {
    const harness = createLayoutHarness({ settings: { dualPaneSide: 'left' }, width: 800 });
    harness.initialize();
    const documentListeners = new Map<string, EventListener>();
    const ownerDocument = {
      addEventListener: jest.fn((event: string, listener: EventListener) => {
        documentListeners.set(event, listener);
      }),
      removeEventListener: jest.fn(),
    };

    harness.resizerEl.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      clientX: 500,
      currentTarget: { ownerDocument },
      preventDefault: jest.fn(),
    });
    documentListeners.get('pointermove')?.({ clientX: 550 } as unknown as Event);

    expect(harness.containerEl.style.setProperty).toHaveBeenLastCalledWith(
      '--claudian-session-sidebar-width',
      '290px',
    );
  });

  it('clamps the resized session column to preserve the minimum chat width', () => {
    const harness = createLayoutHarness({ width: 700 });
    harness.initialize();
    const preventDefault = jest.fn();

    for (let step = 0; step < 20; step += 1) {
      harness.resizerEl.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault });
    }

    expect(preventDefault).toHaveBeenCalled();
    expect(harness.containerEl.style.setProperty).toHaveBeenLastCalledWith(
      '--claudian-session-sidebar-width',
      '375px',
    );
    expect(harness.resizerEl.getAttribute('aria-valuemax')).toBe('375');
  });

  it('ignores resize input while compact', () => {
    const harness = createLayoutHarness({ width: 400 });
    harness.initialize();
    const preventDefault = jest.fn();

    harness.resizerEl.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.containerEl.style.setProperty).not.toHaveBeenCalled();
  });
});
