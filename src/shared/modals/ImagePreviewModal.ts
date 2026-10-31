import { type Keymap, Scope } from 'obsidian';

import type { ImageAttachment } from '@/core/types';
import { t } from '@/i18n/i18n';
import { setModalAccessibility } from '@/shared/modals/AccessibleModal';

function getFocusableActiveElement(ownerDocument: Document): HTMLElement | null {
  const activeElement = ownerDocument.activeElement;
  if (!activeElement || typeof (activeElement as HTMLElement).focus !== 'function') {
    return null;
  }
  return activeElement as HTMLElement;
}

/** Owns the DOM and focus lifecycle of one open image preview. */
export class ImagePreviewModal {
  private closeCurrent: (() => void) | null = null;

  open(ownerDocument: Document, image: ImageAttachment, keymap: Keymap): void {
    this.close();

    const previouslyFocusedElement = getFocusableActiveElement(ownerDocument);
    const overlay = ownerDocument.body.createDiv({ cls: 'claudian-image-modal-overlay' });
    const modal = overlay.createDiv({ cls: 'claudian-image-modal' });
    setModalAccessibility(modal, t('chat.images.preview', { name: image.name }));

    modal.createEl('img', {
      attr: {
        src: `data:${image.mediaType};base64,${image.data}`,
        alt: image.name,
      },
    });

    const closeButton = modal.createEl('button', {
      cls: 'claudian-image-modal-close',
      attr: {
        'aria-label': t('chat.images.closePreview'),
        type: 'button',
      },
    });
    closeButton.setText('\u00D7');

    // A modal scope takes precedence over the view scope in Obsidian's window-capture keymap.
    const scope = new Scope();
    let isClosed = false;
    const close = () => {
      if (isClosed) return;
      isClosed = true;
      keymap.popScope(scope);
      overlay.remove();
      if (this.closeCurrent === close) {
        this.closeCurrent = null;
      }
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    };
    scope.register(null, 'Escape', () => {
      close();
      return false;
    });
    scope.register(null, 'Tab', () => {
      closeButton.focus();
      return false;
    });

    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    keymap.pushScope(scope);
    this.closeCurrent = close;
    closeButton.focus();
  }

  close(): void {
    this.closeCurrent?.();
  }
}
