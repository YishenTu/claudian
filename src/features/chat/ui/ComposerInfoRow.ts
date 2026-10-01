import { setIcon } from 'obsidian';

/** Read-only conversation fact shown in the info row; it may still be opened or, before the first message, removed. */
export interface ComposerInfoItem {
  label: string;
  icon?: string;
  ariaLabel?: string;
  missing?: boolean;
  onActivate: () => void;
  onRemove?: () => void;
}

/**
 * Owns the borderless row under the input box. The toolbar holds what the user can
 * change; this row shows conversation facts. It keeps its height while empty so the
 * composer does not shift as linked content comes and goes.
 */
export class ComposerInfoRow {
  private readonly linkedSlotEl: HTMLElement;

  constructor(private readonly containerEl: HTMLElement) {
    this.containerEl.addClass('claudian-input-info-row');
    this.linkedSlotEl = this.containerEl.createDiv({ cls: 'claudian-input-info-linked' });
  }

  setLinkedContent(item: ComposerInfoItem | null): void {
    this.linkedSlotEl.empty();
    this.linkedSlotEl.removeClass('claudian-input-info-linked--missing');
    if (item) this.#renderLinkedContent(item);
  }

  destroy(): void {
    this.linkedSlotEl.empty();
  }

  #renderLinkedContent(item: ComposerInfoItem): void {
    this.linkedSlotEl.toggleClass('claudian-input-info-linked--missing', item.missing === true);
    const label = item.ariaLabel ?? item.label;
    const mainEl = this.linkedSlotEl.createEl('button', {
      cls: 'claudian-input-info-linked-main',
      attr: { type: 'button', 'aria-label': label },
    });
    mainEl.addEventListener('click', item.onActivate);
    if (item.icon) {
      const iconEl = mainEl.createSpan({ cls: 'claudian-input-info-linked-icon' });
      iconEl.setAttribute('aria-hidden', 'true');
      setIcon(iconEl, item.icon);
    }
    mainEl.createSpan({ cls: 'claudian-input-info-linked-label', text: item.label });

    if (item.onRemove) {
      const removeEl = this.linkedSlotEl.createEl('button', {
        cls: 'claudian-input-info-linked-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': `Remove ${label}` },
      });
      removeEl.addEventListener('click', item.onRemove);
    }
  }
}
