/** Min/max input wrapper height in pixels. */
export const INPUT_WRAPPER_MIN_HEIGHT = 140;
export const INPUT_WRAPPER_MAX_HEIGHT_RATIO = 0.7;

export interface InputResizeHandleOptions {
  /** The element to insert the handle into (inputContainerEl). */
  container: HTMLElement;
  /** The input wrapper whose height is being controlled. */
  inputWrapper: HTMLElement;
  /** Viewport element for calculating max height (.claudian-container). */
  viewport: HTMLElement;
}

/**
 * Creates a drag handle at the top of the input container.
 * Returns a cleanup function to remove event listeners.
 */
export function createInputResizeHandle({ container, inputWrapper, viewport }: InputResizeHandleOptions): () => void {
  const handle = container.createDiv({ cls: 'claudian-input-resize-handle' });
  handle.setAttribute('aria-label', 'Drag to resize input');

  const doc = container.ownerDocument;
  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    isDragging = true;
    startY = e.clientY;
    startHeight = inputWrapper.offsetHeight;
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('mouseup', onMouseUp);
    if (doc.body) {
      doc.body.style.cursor = 'ns-resize';
      doc.body.style.userSelect = 'none';
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const delta = startY - e.clientY;
    const newHeight = Math.max(
      INPUT_WRAPPER_MIN_HEIGHT,
      Math.min(
        viewport.clientHeight * INPUT_WRAPPER_MAX_HEIGHT_RATIO,
        startHeight + delta,
      ),
    );
    inputWrapper.style.setProperty('--claudian-input-wrapper-height', `${newHeight}px`);
  };

  const onMouseUp = () => {
    isDragging = false;
    doc.removeEventListener('mousemove', onMouseMove);
    doc.removeEventListener('mouseup', onMouseUp);
    if (doc.body) {
      doc.body.style.cursor = '';
      doc.body.style.userSelect = '';
    }
  };

  handle.addEventListener('mousedown', onMouseDown);

  return () => {
    handle.removeEventListener('mousedown', onMouseDown);
    doc.removeEventListener('mousemove', onMouseMove);
    doc.removeEventListener('mouseup', onMouseUp);
    handle.remove();
  };
}
