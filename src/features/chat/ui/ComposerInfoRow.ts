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

type ComposerInfoItemKind = 'linked-content' | 'context-usage';

export interface ComposerInfoRowOptions {
  /** Composer element that also carries `data-info-items`, so a presentation can lay out around the row. */
  composerEl?: HTMLElement;
}

/**
 * Owns the borderless row under the input box. The toolbar holds what the user can
 * change; this row shows conversation facts. It collapses when nothing is visible.
 */
export class ComposerInfoRow {
  /** Mount point for the context usage meter, which shows and hides itself. */
  readonly usageSlotEl: HTMLElement;
  private readonly linkedSlotEl: HTMLElement;
  private hasLinkedContent = false;
  private usageObserver: MutationObserver | null = null;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly options: ComposerInfoRowOptions = {},
  ) {
    this.containerEl.addClass('claudian-input-info-row');
    this.linkedSlotEl = this.containerEl.createDiv({ cls: 'claudian-input-info-linked' });
    this.linkedSlotEl.dataset.infoItem = 'linked-content';
    this.usageSlotEl = this.containerEl.createDiv({ cls: 'claudian-input-info-usage' });
    this.usageSlotEl.dataset.infoItem = 'context-usage';

    const MutationObserverConstructor = this.containerEl.ownerDocument.defaultView?.MutationObserver;
    if (typeof MutationObserverConstructor === 'function') {
      this.usageObserver = new MutationObserverConstructor(() => this.#sync());
      this.usageObserver.observe(this.usageSlotEl, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true,
      });
    }
    this.#sync();
  }

  setLinkedContent(item: ComposerInfoItem | null): void {
    this.linkedSlotEl.empty();
    this.linkedSlotEl.removeClass('claudian-input-info-linked--missing');
    this.hasLinkedContent = item !== null;
    if (item) this.#renderLinkedContent(item);
    this.#sync();
  }

  destroy(): void {
    this.usageObserver?.disconnect();
    this.usageObserver = null;
    this.linkedSlotEl.empty();
    this.hasLinkedContent = false;
    if (this.options.composerEl) delete this.options.composerEl.dataset.infoItems;
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

  #isUsageVisible(): boolean {
    return Array.from(this.usageSlotEl.children).some(child => !child.classList.contains('claudian-hidden'));
  }

  #sync(): void {
    const items: ComposerInfoItemKind[] = [];
    if (this.hasLinkedContent) items.push('linked-content');
    if (this.#isUsageVisible()) items.push('context-usage');
    // Presentations can match on which items are shown; zen hides the linked note and makes room for the gauge.
    for (const el of [this.containerEl, this.options.composerEl]) {
      if (!el) continue;
      if (items.length > 0) el.dataset.infoItems = items.join(' ');
      else delete el.dataset.infoItems;
    }
    this.containerEl.toggleClass('claudian-hidden', items.length === 0);
  }
}
