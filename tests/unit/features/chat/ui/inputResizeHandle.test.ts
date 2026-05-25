/**
 * @jest-environment jsdom
 */

import {
  createInputResizeHandle,
  INPUT_WRAPPER_MAX_HEIGHT_RATIO,
  INPUT_WRAPPER_MIN_HEIGHT,
} from '@/features/chat/ui/inputResizeHandle';

function createMockDom() {
  const container = document.createElement('div');
  container.classList.add('claudian-input-container');

  const viewport = document.createElement('div');
  viewport.classList.add('claudian-container');
  Object.defineProperty(viewport, 'clientHeight', { value: 600, configurable: true });
  viewport.appendChild(container);

  const inputWrapper = document.createElement('div');
  inputWrapper.classList.add('claudian-input-wrapper');
  // Polyfill Obsidian's createDiv + insertBefore for jsdom
  (inputWrapper as any).createDiv = (opts?: { cls?: string }) => {
    const div = document.createElement('div');
    if (opts?.cls) div.className = opts.cls;
    inputWrapper.appendChild(div);
    return div;
  };
  container.appendChild(inputWrapper);

  return { container, inputWrapper, viewport };
}

describe('createInputResizeHandle', () => {
  it('should create a resize handle element inside input wrapper', () => {
    const { inputWrapper, viewport } = createMockDom();
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle');
    expect(handle).toBeTruthy();

    cleanup();
  });

  it('should set aria-label on the handle', () => {
    const { inputWrapper, viewport } = createMockDom();
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle')!;
    expect(handle.getAttribute('aria-label')).toBe('Drag to resize input');

    cleanup();
  });

  it('should resize input wrapper on drag (mouse moves up)', () => {
    const { inputWrapper, viewport } = createMockDom();
    Object.defineProperty(inputWrapper, 'offsetHeight', { value: 140, configurable: true });
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle') as HTMLElement;

    handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 240 }));

    const setHeight = inputWrapper.style.getPropertyValue('--claudian-input-wrapper-height');
    expect(setHeight).toBe('200px');

    document.dispatchEvent(new MouseEvent('mouseup'));
    cleanup();
  });

  it('should clamp to minimum height', () => {
    const { inputWrapper, viewport } = createMockDom();
    Object.defineProperty(inputWrapper, 'offsetHeight', { value: 140, configurable: true });
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle') as HTMLElement;

    handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 500 }));

    const setHeight = inputWrapper.style.getPropertyValue('--claudian-input-wrapper-height');
    expect(parseInt(setHeight)).toBe(INPUT_WRAPPER_MIN_HEIGHT);

    document.dispatchEvent(new MouseEvent('mouseup'));
    cleanup();
  });

  it('should clamp to max height based on viewport', () => {
    const { inputWrapper, viewport } = createMockDom();
    Object.defineProperty(inputWrapper, 'offsetHeight', { value: 140, configurable: true });
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle') as HTMLElement;
    const maxExpected = Math.floor(600 * INPUT_WRAPPER_MAX_HEIGHT_RATIO);

    handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: -200 }));

    const setHeight = parseInt(inputWrapper.style.getPropertyValue('--claudian-input-wrapper-height'));
    expect(setHeight).toBeLessThanOrEqual(maxExpected);

    document.dispatchEvent(new MouseEvent('mouseup'));
    cleanup();
  });

  it('should clean up event listeners on cleanup', () => {
    const { inputWrapper, viewport } = createMockDom();
    Object.defineProperty(inputWrapper, 'offsetHeight', { value: 140, configurable: true });
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle') as HTMLElement;
    handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }));

    cleanup();

    const before = inputWrapper.style.getPropertyValue('--claudian-input-wrapper-height');
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 240 }));
    const after = inputWrapper.style.getPropertyValue('--claudian-input-wrapper-height');
    expect(after).toBe(before);

    document.dispatchEvent(new MouseEvent('mouseup'));
  });

  it('should remove handle element from DOM on cleanup', () => {
    const { inputWrapper, viewport } = createMockDom();
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    expect(inputWrapper.querySelector('.claudian-input-resize-handle')).toBeTruthy();
    cleanup();
    expect(inputWrapper.querySelector('.claudian-input-resize-handle')).toBeNull();
  });

  it('should reset body cursor and user-select on mouseup', () => {
    const { inputWrapper, viewport } = createMockDom();
    Object.defineProperty(inputWrapper, 'offsetHeight', { value: 140, configurable: true });
    const cleanup = createInputResizeHandle({ inputWrapper, viewport });

    const handle = inputWrapper.querySelector('.claudian-input-resize-handle') as HTMLElement;

    handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }));
    expect(document.body.style.cursor).toBe('ns-resize');
    expect(document.body.style.userSelect).toBe('none');

    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    cleanup();
  });
});
