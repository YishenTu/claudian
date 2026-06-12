/** Min/max input wrapper height in pixels. */
export const INPUT_WRAPPER_MIN_HEIGHT = 140;
export const INPUT_WRAPPER_MAX_HEIGHT_RATIO = 0.7;

export interface InputResizeHandleOptions {
  /** The input wrapper whose height is being controlled (handle inserts as first child). */
  inputWrapper: HTMLElement;
  /** Viewport element for calculating max height (.claudian-container). */
  viewport: HTMLElement;
}

/**
 * Creates a drag handle at the top of the input container.
 * Returns a cleanup function to remove event listeners.
 */
export function createInputResizeHandle({ inputWrapper, viewport }: InputResizeHandleOptions): () => void {
  const handle = inputWrapper.createDiv({ cls: 'claudian-input-resize-handle' });
  handle.setAttribute('aria-label', 'Drag to resize input');
  inputWrapper.insertBefore(handle, inputWrapper.firstChild);

  const doc = inputWrapper.ownerDocument;
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
      doc.body.classList.add('claudian-dragging-ns');
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
      doc.body.classList.remove('claudian-dragging-ns');
    }
  };

  handle.addEventListener('mousedown', onMouseDown);

  return () => {
    if (isDragging && doc.body) {
      doc.body.classList.remove('claudian-dragging-ns');
    }
    handle.removeEventListener('mousedown', onMouseDown);
    doc.removeEventListener('mousemove', onMouseMove);
    doc.removeEventListener('mouseup', onMouseUp);
    handle.remove();
  };
}
