import { triggerResize } from '@test/helpers/dom/ResizeObserver';

/**
 * Browser scroll geometry for a transcript in jsdom, which has no layout: each shown message
 * row is `rowHeight(row)` tall, the viewport is `viewportHeight`, and `scrollTop` clamps to
 * the content as a browser does. jsdom never delivers ResizeObserver entries; `layout()` and
 * `resizeViewport()` stand in for the browser's layout pass after a size change.
 */
export function useTranscriptGeometry(messagesEl: HTMLElement, {
  rowHeight = (_row: HTMLElement): number => 100,
  viewportHeight = 400,
} = {}) {
  let top = 0;
  let viewport = viewportHeight;
  const isShownRow = (el: Element): el is HTMLElement => el instanceof HTMLElement
    && el.matches('.claudian-message') && !el.closest('[hidden]');
  const contentHeight = () => Array.from(messagesEl.querySelectorAll('.claudian-message'))
    .filter(isShownRow)
    .reduce((height, row) => height + rowHeight(row), 0);
  const scrollHeight = () => Math.max(viewport, contentHeight());
  const maxTop = () => scrollHeight() - viewport;
  Object.defineProperties(messagesEl, {
    clientHeight: { configurable: true, get: () => viewport },
    scrollHeight: { configurable: true, get: scrollHeight },
    scrollTop: {
      configurable: true,
      // Content or a viewport that shrinks pulls the position up with it.
      get: () => (top = Math.min(top, maxTop())),
      set: (value: number) => { top = Math.max(0, Math.min(value, maxTop())); },
    },
  });
  const entry = (height: number) => {
    const size = { inlineSize: 800, blockSize: height };
    return {
      contentRect: new DOMRectReadOnly(0, 0, size.inlineSize, size.blockSize),
      contentBoxSize: [size], borderBoxSize: [size], devicePixelContentBoxSize: [size],
    };
  };
  return {
    /** The farthest scroll position the current content allows. */
    bottom: maxTop,
    /** Resizes the transcript viewport, as a growing composer or a pane resize does. */
    resizeViewport(height: number): void {
      viewport = height;
      triggerResize(messagesEl, entry(height));
    },
    /** Delivers the observations a browser layout pass makes after the transcript's rows change size. */
    layout(): void {
      for (const child of Array.from(messagesEl.children)) triggerResize(child, entry(isShownRow(child) ? rowHeight(child) : 0));
    },
  };
}

/**
 * Whether the transcript currently follows growth: grows its content past the reader, delivers
 * the layout pass's resize observation with the viewport unchanged, and reports whether the
 * reader was moved to the new end (clamped or not). It checks follow intent, not delivery timing;
 * restores the geometry and position it found.
 */
export function followsGrowth(messagesEl: HTMLElement): boolean {
  const top = messagesEl.scrollTop;
  const own = Object.getOwnPropertyDescriptor(messagesEl, 'scrollHeight');
  const grown = messagesEl.scrollHeight + 10_000;
  Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, get: () => grown });
  try {
    triggerResize(messagesEl, {
      contentRect: new DOMRectReadOnly(0, 0, 800, messagesEl.clientHeight),
      contentBoxSize: [], borderBoxSize: [], devicePixelContentBoxSize: [],
    });
    return messagesEl.scrollTop >= grown - messagesEl.clientHeight;
  } finally {
    if (own) Object.defineProperty(messagesEl, 'scrollHeight', own);
    else Reflect.deleteProperty(messagesEl, 'scrollHeight');
    messagesEl.scrollTop = top;
  }
}
