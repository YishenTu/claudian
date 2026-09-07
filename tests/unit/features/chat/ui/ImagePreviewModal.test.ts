import { createMockEl } from '@test/helpers/MockElement';

import type { ImageAttachment } from '@/core/types';
import { ImagePreviewModal } from '@/features/chat/ui/ImagePreviewModal';

const IMAGE: ImageAttachment = {
  id: 'image-1',
  name: 'diagram.png',
  mediaType: 'image/png',
  data: 'abc123',
  size: 128,
  source: 'file',
};

function createDocumentHarness(previouslyFocusedElement: unknown = {
  focus: jest.fn(),
  isConnected: true,
}) {
  const overlayEl = createMockEl();
  const closeButtonFocus = jest.fn();
  const createModal = overlayEl.createDiv.bind(overlayEl);
  overlayEl.createDiv = jest.fn((options: { cls?: string }) => {
    const modalEl = createModal(options);
    const createModalChild = modalEl.createEl.bind(modalEl);
    modalEl.createEl = jest.fn((tag: string, childOptions?: unknown) => {
      const child = createModalChild(tag, childOptions);
      if (tag === 'button') child.focus = closeButtonFocus;
      return child;
    });
    return modalEl;
  });

  const listeners = new Map<string, Array<(event: any) => void>>();
  const ownerDocument = {
    activeElement: previouslyFocusedElement,
    body: {
      createDiv: jest.fn().mockReturnValue(overlayEl),
    },
    addEventListener: jest.fn((event: string, handler: (event: any) => void) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    }),
    removeEventListener: jest.fn((event: string, handler: (event: any) => void) => {
      const handlers = listeners.get(event) ?? [];
      listeners.set(event, handlers.filter(candidate => candidate !== handler));
    }),
  } as unknown as Document;

  return {
    closeButtonFocus,
    listeners,
    overlayEl,
    ownerDocument,
    previouslyFocusedElement,
  };
}

describe('ImagePreviewModal', () => {
  it('opens a named dialog with a focused native close button', () => {
    const harness = createDocumentHarness();
    const modal = new ImagePreviewModal();

    modal.open(harness.ownerDocument, IMAGE);

    const modalEl = harness.overlayEl.children[0];
    const imageEl = modalEl.children[0];
    const closeButton = modalEl.children[1];
    expect(modalEl.getAttribute('role')).toBe('dialog');
    expect(modalEl.getAttribute('aria-modal')).toBe('true');
    expect(modalEl.getAttribute('aria-label')).toBe('Image preview: diagram.png');
    expect(imageEl.getAttribute('src')).toBe('data:image/png;base64,abc123');
    expect(imageEl.getAttribute('alt')).toBe('diagram.png');
    expect(closeButton.tagName).toBe('BUTTON');
    expect(closeButton.getAttribute('type')).toBe('button');
    expect(closeButton.getAttribute('aria-label')).toBe('Close image preview');
    expect(harness.closeButtonFocus).toHaveBeenCalledTimes(1);
  });

  it.each([
    { shiftKey: false },
    { shiftKey: true },
  ])('contains $shiftKey Tab navigation on its only control', ({ shiftKey }) => {
    const harness = createDocumentHarness();
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE);
    const event = {
      key: 'Tab',
      shiftKey,
      preventDefault: jest.fn(),
    };

    harness.listeners.get('keydown')?.[0](event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.closeButtonFocus).toHaveBeenCalledTimes(2);
  });

  it('closes idempotently, removes its listener, and restores connected focus', () => {
    const harness = createDocumentHarness();
    const previousFocus = (harness.previouslyFocusedElement as { focus: jest.Mock }).focus;
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE);
    const removeOverlay = jest.spyOn(harness.overlayEl, 'remove');

    modal.close();
    modal.close();

    expect(removeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.listeners.get('keydown')).toEqual([]);
    expect(previousFocus).toHaveBeenCalledTimes(1);
  });

  it('closes the current preview before opening its replacement', () => {
    const firstHarness = createDocumentHarness();
    const secondHarness = createDocumentHarness();
    const modal = new ImagePreviewModal();
    const removeFirstOverlay = jest.spyOn(firstHarness.overlayEl, 'remove');

    modal.open(firstHarness.ownerDocument, IMAGE);
    modal.open(secondHarness.ownerDocument, { ...IMAGE, name: 'replacement.png' });

    expect(removeFirstOverlay).toHaveBeenCalledTimes(1);
    expect(firstHarness.listeners.get('keydown')).toEqual([]);
    expect(secondHarness.overlayEl.children[0].getAttribute('aria-label'))
      .toBe('Image preview: replacement.png');
  });

  it('supports Escape, close-button, and overlay-background dismissal', () => {
    const escapeHarness = createDocumentHarness();
    const escapeModal = new ImagePreviewModal();
    escapeModal.open(escapeHarness.ownerDocument, IMAGE);
    const removeEscapeOverlay = jest.spyOn(escapeHarness.overlayEl, 'remove');
    escapeHarness.listeners.get('keydown')?.[0]({ key: 'Escape' });
    expect(removeEscapeOverlay).toHaveBeenCalledTimes(1);

    const buttonHarness = createDocumentHarness();
    const buttonModal = new ImagePreviewModal();
    buttonModal.open(buttonHarness.ownerDocument, IMAGE);
    const removeButtonOverlay = jest.spyOn(buttonHarness.overlayEl, 'remove');
    buttonHarness.overlayEl.children[0].children[1].click();
    expect(removeButtonOverlay).toHaveBeenCalledTimes(1);

    const overlayHarness = createDocumentHarness();
    const overlayModal = new ImagePreviewModal();
    overlayModal.open(overlayHarness.ownerDocument, IMAGE);
    const removeBackgroundOverlay = jest.spyOn(overlayHarness.overlayEl, 'remove');
    const overlayClick = overlayHarness.overlayEl._eventListeners.get('click')?.[0];
    overlayClick?.({ target: overlayHarness.overlayEl.children[0] });
    expect(removeBackgroundOverlay).not.toHaveBeenCalled();
    overlayClick?.({ target: overlayHarness.overlayEl });
    expect(removeBackgroundOverlay).toHaveBeenCalledTimes(1);
  });

  it('does not restore a disconnected prior focus target', () => {
    const priorFocusTarget = { focus: jest.fn(), isConnected: false };
    const harness = createDocumentHarness(priorFocusTarget);
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE);

    expect(() => modal.close()).not.toThrow();
    expect(priorFocusTarget.focus).not.toHaveBeenCalled();
  });

  it('ignores an active element without a focus operation', () => {
    const harness = createDocumentHarness({ isConnected: true });
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE);

    expect(() => modal.close()).not.toThrow();
  });
});
