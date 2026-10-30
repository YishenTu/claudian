import { createMockEl } from '@test/helpers/MockElement';
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
  const keymap = { pushScope: vi.fn(), popScope: vi.fn() };
  const ownerDocument = {
    activeElement: previouslyFocusedElement,
    body: {
      createDiv: vi.fn().mockReturnValue(overlayEl),
    },
  } as unknown as Document;

  return {
    keymap,
    overlayEl,
    ownerDocument,
    previouslyFocusedElement,
  };
}

describe('ImagePreviewModal', () => {
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

  it('ignores an active element without a focus operation', () => {
    const harness = createDocumentHarness({ isConnected: true });
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);

    expect(() => modal.close()).not.toThrow();
  });
});
