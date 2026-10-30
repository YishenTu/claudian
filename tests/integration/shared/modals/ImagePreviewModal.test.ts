/** @vitest-environment jsdom */
import { screen } from '@testing-library/dom';
import { App } from 'obsidian';

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

function createDocumentHarness() {
  const previouslyFocusedElement = document.body.createEl('button');
  previouslyFocusedElement.focus();
  const previousFocus = vi.spyOn(previouslyFocusedElement, 'focus');
  const keymap = new App().keymap;
  return { keymap, ownerDocument: document, previouslyFocusedElement, previousFocus };
}

afterEach(() => { document.body.replaceChildren(); });

describe('ImagePreviewModal', () => {
  it('closes idempotently, releases its scope, and restores connected focus', () => {
    const harness = createDocumentHarness();
    const { previousFocus } = harness;
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);
    const removeOverlay = vi.spyOn(screen.getByRole('dialog').parentElement!, 'remove');

    modal.close();
    modal.close();

    expect(removeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.keymap.popScope).toHaveBeenCalledTimes(1);
    expect(harness.keymap.popScope).toHaveBeenCalledWith(vi.mocked(harness.keymap.pushScope).mock.calls[0][0]);
    expect(previousFocus).toHaveBeenCalledTimes(1);
  });

  it('ignores an active element without a focus operation', () => {
    const harness = createDocumentHarness();
    // Deliberately malformed host input retains the compatibility guard.
    Object.defineProperty(harness.previouslyFocusedElement, 'focus', { value: undefined });
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);

    expect(() => modal.close()).not.toThrow();
  });
});
