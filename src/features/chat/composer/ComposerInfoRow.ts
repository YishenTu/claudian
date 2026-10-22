import { setIcon } from 'obsidian';

import { t } from '@/i18n/i18n';

/** Read-only conversation fact shown in the info row; it may still be opened or, before the first message, removed. */
export interface ComposerInfoItem {
  label: string;
  icon?: string;
  ariaLabel?: string;
  missing?: boolean;
  /** The item opens a menu anchored to its button. */
  hasPopup?: 'menu';
  /** Shown but not operable for now. */
  disabled?: boolean;
  onActivate: (anchorEl: HTMLElement) => void;
  onRemove?: () => void;
}

/**
 * Owns the borderless row under the input box. The toolbar holds what the user can
 * change; this row shows conversation facts: the project (its chip opens a menu to change it),
 * then Linked content. It keeps its height while empty so the composer does not shift as
 * facts come and go.
 */
export class ComposerInfoRow {
  private readonly linkedSlotEl: HTMLElement;
  private readonly projectSlotEl: HTMLElement;

  constructor(private readonly containerEl: HTMLElement) {
    this.containerEl.addClass('claudian-input-info-row');
    this.projectSlotEl = this.containerEl.createDiv({
      cls: 'claudian-input-info-linked claudian-input-info-project',
    });
    this.linkedSlotEl = this.containerEl.createDiv({ cls: 'claudian-input-info-linked' });
  }

  setLinkedContent(item: ComposerInfoItem | null): void {
    this.#renderSlot(this.linkedSlotEl, item);
  }

  setProject(item: ComposerInfoItem | null): void {
    this.#renderSlot(this.projectSlotEl, item);
  }

  destroy(): void {
    this.linkedSlotEl.empty();
    this.projectSlotEl.empty();
  }

  #renderSlot(slotEl: HTMLElement, item: ComposerInfoItem | null): void {
    slotEl.empty();
    slotEl.toggleClass('claudian-input-info-linked--missing', item?.missing === true);
    if (!item) return;
    const label = item.ariaLabel ?? item.label;
    const mainEl = slotEl.createEl('button', {
      cls: 'claudian-input-info-linked-main',
      attr: { type: 'button', 'aria-label': label, ...(item.hasPopup ? { 'aria-haspopup': item.hasPopup } : {}) },
    });
    mainEl.disabled = item.disabled === true;
    mainEl.addEventListener('click', () => {
      if (!mainEl.disabled) item.onActivate(mainEl);
    });
    if (item.icon) {
      const iconEl = mainEl.createSpan({ cls: 'claudian-input-info-linked-icon' });
      iconEl.setAttribute('aria-hidden', 'true');
      setIcon(iconEl, item.icon);
    }
    mainEl.createSpan({ cls: 'claudian-input-info-linked-label', text: item.label });

    if (item.onRemove) {
      const removeEl = slotEl.createEl('button', {
        cls: 'claudian-input-info-linked-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': t('chat.removeItem', { item: label }) },
      });
      removeEl.addEventListener('click', item.onRemove);
    }
  }
}
