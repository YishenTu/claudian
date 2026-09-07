/**
 * @jest-environment jsdom
 */

import {
  calculateTextareaMaxHeight,
  installTextareaSizing,
  TEXTAREA_MAX_HEIGHT_PERCENT,
  TEXTAREA_MIN_MAX_HEIGHT,
} from '@/features/chat/ui/textareaSizing';

describe('textareaSizing', () => {
  let resizeCallback: ResizeObserverCallback;
  let disconnect: jest.Mock;
  let observe: jest.Mock;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    disconnect = jest.fn();
    observe = jest.fn();
    globalThis.ResizeObserver = jest.fn().mockImplementation((callback) => {
      resizeCallback = callback;
      return { disconnect, observe };
    }) as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
    document.body.replaceChildren();
  });

  it('caps max height by viewport percentage with a minimum usable cap', () => {
    expect(calculateTextareaMaxHeight(100)).toBe(TEXTAREA_MIN_MAX_HEIGHT);
    expect(calculateTextareaMaxHeight(1000)).toBe(1000 * TEXTAREA_MAX_HEIGHT_PERCENT);
  });

  it('sets the initial cap from the containing view and observes later resizes', () => {
    const { container, textarea } = createComposer(1000);

    installTextareaSizing(textarea);

    expect(textarea.style.getPropertyValue('--claudian-textarea-max-height')).toBe('550px');
    expect(observe).toHaveBeenCalledWith(container);
  });

  it('keeps a usable minimum cap in a short view', () => {
    const { textarea } = createComposer(100);

    installTextareaSizing(textarea);

    expect(textarea.style.getPropertyValue('--claudian-textarea-max-height')).toBe('150px');
  });

  it('updates from resize observer data without rereading layout', () => {
    const { container, textarea, readContainerHeight } = createComposer(1000);
    installTextareaSizing(textarea);
    readContainerHeight.mockClear();

    resizeCallback([
      {
        target: container,
        contentRect: { height: 600 } as DOMRectReadOnly,
      } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver);

    expect(textarea.style.getPropertyValue('--claudian-textarea-max-height')).toBe('330px');
    expect(readContainerHeight).not.toHaveBeenCalled();
  });

  it('does not rewrite an unchanged cap', () => {
    const { container, textarea, setCssProps } = createComposer(1000);
    installTextareaSizing(textarea);

    resizeCallback([
      {
        target: container,
        contentRect: { height: 1000 } as DOMRectReadOnly,
      } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver);

    expect(setCssProps).toHaveBeenCalledTimes(1);
  });

  it('disconnects its observer during cleanup', () => {
    const { textarea } = createComposer(1000);

    const cleanup = installTextareaSizing(textarea);
    cleanup();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

function createComposer(height: number): {
  container: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  readContainerHeight: jest.Mock;
  setCssProps: jest.Mock;
} {
  const container = document.createElement('div');
  container.className = 'claudian-container';
  const textarea = document.createElement('textarea');
  const setCssProps = jest.fn((properties: Record<string, string>) => {
    for (const [name, value] of Object.entries(properties)) {
      textarea.style.setProperty(name, value);
    }
  });
  textarea.setCssProps = setCssProps;
  const readContainerHeight = jest.fn(() => height);
  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    get: readContainerHeight,
  });
  container.appendChild(textarea);
  document.body.appendChild(container);
  return { container, textarea, readContainerHeight, setCssProps };
}
