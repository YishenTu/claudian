export const TEXTAREA_BASE_MIN_HEIGHT = 60;
export const TEXTAREA_MIN_MAX_HEIGHT = 150;
export const TEXTAREA_MAX_HEIGHT_PERCENT = 0.55;

interface TextareaMinHeightInput {
  contentHeight: number;
  flexAllocatedHeight: number;
}

export function calculateTextareaMaxHeight(viewHeight: number): number {
  return Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);
}

export function calculateTextareaMinHeight({
  contentHeight,
  flexAllocatedHeight,
}: TextareaMinHeightInput): number {
  return contentHeight > flexAllocatedHeight ? contentHeight : TEXTAREA_BASE_MIN_HEIGHT;
}

/**
 * Auto-resizes a textarea based on its content.
 *
 * Logic:
 * - At minimum wrapper height: let flexbox allocate space (textarea fills available)
 * - When content exceeds flex allocation: set min-height to force wrapper growth
 * - When content shrinks: remove min-height override to let wrapper shrink
 * - Max height is capped at 55% of view height (minimum 150px)
 */
export function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  const viewHeight = textarea.closest('.claudian-container')?.clientHeight ?? window.innerHeight;
  const maxHeight = calculateTextareaMaxHeight(viewHeight);

  textarea.setCssProps({
    '--claudian-textarea-min-height': `${TEXTAREA_BASE_MIN_HEIGHT}px`,
    '--claudian-textarea-max-height': `${maxHeight}px`,
  });

  const flexAllocatedHeight = textarea.offsetHeight;
  const contentHeight = Math.min(textarea.scrollHeight, maxHeight);
  const minHeight = calculateTextareaMinHeight({ contentHeight, flexAllocatedHeight });

  textarea.setCssProps({
    '--claudian-textarea-min-height': `${minHeight}px`,
    '--claudian-textarea-max-height': `${maxHeight}px`,
  });
}
