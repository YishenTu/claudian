export const TEXTAREA_MIN_MAX_HEIGHT = 150;
export const TEXTAREA_MAX_HEIGHT_PERCENT = 0.55;

export function calculateTextareaMaxHeight(viewHeight: number): number {
  return Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);
}

export function installTextareaSizing(textarea: HTMLTextAreaElement): () => void {
  const container = textarea.closest<HTMLElement>('.claudian-container');
  const ownerWindow = textarea.ownerDocument.defaultView;
  let currentMaxHeight = '';

  const updateMaxHeight = (viewHeight: number): void => {
    const maxHeight = `${calculateTextareaMaxHeight(viewHeight)}px`;
    if (maxHeight === currentMaxHeight) return;
    currentMaxHeight = maxHeight;
    textarea.setCssProps({ '--claudian-textarea-max-height': maxHeight });
  };

  updateMaxHeight(container?.clientHeight || ownerWindow?.innerHeight || TEXTAREA_MIN_MAX_HEIGHT);

  const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
  if (!container || !ResizeObserverConstructor) return () => {};

  const observer = new ResizeObserverConstructor((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) updateMaxHeight(entry.contentRect.height);
  });
  observer.observe(container);

  return () => observer.disconnect();
}
