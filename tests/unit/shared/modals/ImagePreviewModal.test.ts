import { createMockEl } from '@test/helpers/MockElement';
import type { Scope } from 'obsidian';
import type { Mock } from 'vitest';

import type { ImageAttachment } from '@/core/types';
import { ImagePreviewModal } from '@/shared/modals/ImagePreviewModal';



const IMAGE: ImageAttachment = {
  id: 'image-1',
  name: 'diagram.png',
  mediaType: 'image/png',
  data: 'abc123',
  size: 128,
  source: 'file',
};

function createDocumentHarness(previouslyFocusedElement: unknown = {
  focus: vi.fn(),
  isConnected: true,
}) {
  const overlayEl = createMockEl();
  const closeButtonFocus = vi.fn();
  const createModal = overlayEl.createDiv.bind(overlayEl);
  overlayEl.createDiv = vi.fn((options: { cls?: string }) => {
    const modalEl = createModal(options);
    const createModalChild = modalEl.createEl.bind(modalEl);
    modalEl.createEl = vi.fn((tag: string, childOptions?: unknown) => {
      const child = createModalChild(tag, childOptions);
      if (tag === 'button') child.focus = closeButtonFocus;
      return child;
    });
    return modalEl;
  });

  const keymap = { pushScope: vi.fn(), popScope: vi.fn() };
  const pressKey = (key: string, shiftKey = false) => {
    const scope = keymap.pushScope.mock.calls.at(-1)![0] as Scope & {
      handlers: Array<{ key: string; func: (event: unknown) => unknown }>;
    };
    return scope.handlers.find(handler => handler.key === key)!.func({ key, shiftKey });
  };
  const ownerDocument = {
    activeElement: previouslyFocusedElement,
    body: {
      createDiv: vi.fn().mockReturnValue(overlayEl),
    },
  } as unknown as Document;

  return {
    closeButtonFocus,
    keymap,
    pressKey,
    overlayEl,
    ownerDocument,
    previouslyFocusedElement,
  };
}

describe('ImagePreviewModal', () => {
  it('opens a named dialog with a focused native close button', () => {
    const harness = createDocumentHarness();
    const modal = new ImagePreviewModal();

    modal.open(harness.ownerDocument, IMAGE, harness.keymap);

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
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);
    expect(harness.pressKey('Tab', shiftKey)).toBe(false);
    expect(harness.closeButtonFocus).toHaveBeenCalledTimes(2);
  });

  it('closes idempotently, releases its scope, and restores connected focus', () => {
    const harness = createDocumentHarness();
    const previousFocus = (harness.previouslyFocusedElement as { focus: Mock }).focus;
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);
    const removeOverlay = vi.spyOn(harness.overlayEl, 'remove');

    modal.close();
    modal.close();

    expect(removeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.keymap.popScope).toHaveBeenCalledTimes(1);
    expect(harness.keymap.popScope).toHaveBeenCalledWith(harness.keymap.pushScope.mock.calls[0][0]);
    expect(previousFocus).toHaveBeenCalledTimes(1);
  });

  it('closes the current preview before opening its replacement', () => {
    const firstHarness = createDocumentHarness();
    const secondHarness = createDocumentHarness();
    const modal = new ImagePreviewModal();
    const removeFirstOverlay = vi.spyOn(firstHarness.overlayEl, 'remove');

    modal.open(firstHarness.ownerDocument, IMAGE, firstHarness.keymap);
    modal.open(secondHarness.ownerDocument, { ...IMAGE, name: 'replacement.png' }, secondHarness.keymap);

    expect(removeFirstOverlay).toHaveBeenCalledTimes(1);
    expect(firstHarness.keymap.popScope).toHaveBeenCalledWith(firstHarness.keymap.pushScope.mock.calls[0][0]);
    expect(secondHarness.overlayEl.children[0].getAttribute('aria-label'))
      .toBe('Image preview: replacement.png');
  });

  it('supports Escape, close-button, and overlay-background dismissal', () => {
    const escapeHarness = createDocumentHarness();
    const escapeModal = new ImagePreviewModal();
    escapeModal.open(escapeHarness.ownerDocument, IMAGE, escapeHarness.keymap);
    const removeEscapeOverlay = vi.spyOn(escapeHarness.overlayEl, 'remove');
    expect(escapeHarness.pressKey('Escape')).toBe(false);
    expect(removeEscapeOverlay).toHaveBeenCalledTimes(1);

    const buttonHarness = createDocumentHarness();
    const buttonModal = new ImagePreviewModal();
    buttonModal.open(buttonHarness.ownerDocument, IMAGE, buttonHarness.keymap);
    const removeButtonOverlay = vi.spyOn(buttonHarness.overlayEl, 'remove');
    buttonHarness.overlayEl.children[0].children[1].click();
    expect(removeButtonOverlay).toHaveBeenCalledTimes(1);

    const overlayHarness = createDocumentHarness();
    const overlayModal = new ImagePreviewModal();
    overlayModal.open(overlayHarness.ownerDocument, IMAGE, overlayHarness.keymap);
    const removeBackgroundOverlay = vi.spyOn(overlayHarness.overlayEl, 'remove');
    const overlayClick = overlayHarness.overlayEl._eventListeners.get('click')?.[0];
    overlayClick?.({ target: overlayHarness.overlayEl.children[0] });
    expect(removeBackgroundOverlay).not.toHaveBeenCalled();
    overlayClick?.({ target: overlayHarness.overlayEl });
    expect(removeBackgroundOverlay).toHaveBeenCalledTimes(1);
  });

  it('does not restore a disconnected prior focus target', () => {
    const priorFocusTarget = { focus: vi.fn(), isConnected: false };
    const harness = createDocumentHarness(priorFocusTarget);
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);

    expect(() => modal.close()).not.toThrow();
    expect(priorFocusTarget.focus).not.toHaveBeenCalled();
  });

  it('ignores an active element without a focus operation', () => {
    const harness = createDocumentHarness({ isConnected: true });
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);

    expect(() => modal.close()).not.toThrow();
  });
});
