import { setIcon } from 'obsidian';

import type { ComposerDropdownItem } from './types';

export interface ComposerDropdownViewOptions {
  readonly fixed?: boolean;
  readonly inputEl: HTMLInputElement | HTMLTextAreaElement;
  readonly onHover: (index: number) => void;
  readonly onSelect: (index: number) => void;
}

export class ComposerDropdownView {
  private dropdownEl: HTMLElement | null = null;
  private itemEls: HTMLElement[] = [];

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly options: ComposerDropdownViewOptions,
  ) {}

  contains(element: Node): boolean {
    return this.dropdownEl?.contains(element) ?? false;
  }

  destroy(): void {
    this.dropdownEl?.remove();
    this.dropdownEl = null;
    this.itemEls = [];
  }

  hide(): void {
    this.dropdownEl?.removeClass('is-visible');
    this.options.inputEl.removeAttribute?.('aria-activedescendant');
    this.options.inputEl.setAttribute?.('aria-expanded', 'false');
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('is-visible') ?? false;
  }

  render(items: readonly ComposerDropdownItem[], selectedIndex: number): void {
    const dropdown = this.ensureDropdown();
    dropdown.empty();
    this.itemEls = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const selectable = item.kind !== 'status' && !item.disabled;
      const itemEl = dropdown.createDiv({
        cls: [
          'claudian-composer-dropdown-item',
          item.className ?? '',
          item.kind === 'status' ? `is-${item.state}` : '',
          index === selectedIndex ? 'is-selected' : '',
        ].filter(Boolean).join(' '),
      });
      const itemId = `claudian-composer-dropdown-item-${index}`;
      itemEl.setAttribute('id', itemId);
      itemEl.setAttribute('role', 'option');
      itemEl.setAttribute('aria-selected', String(index === selectedIndex));
      if (!selectable) itemEl.setAttribute('aria-disabled', 'true');

      if (item.kind !== 'status' && item.icon) {
        const iconEl = itemEl.createSpan({ cls: 'claudian-composer-dropdown-icon' });
        setIcon(iconEl, item.icon);
      }

      const copyEl = itemEl.createDiv({ cls: 'claudian-composer-dropdown-copy' });
      copyEl.createDiv({ cls: 'claudian-composer-dropdown-label', text: item.label });
      if (item.detail) {
        copyEl.createDiv({ cls: 'claudian-composer-dropdown-detail', text: item.detail });
      }
      if (item.kind === 'folder') {
        const folderIcon = itemEl.createSpan({ cls: 'claudian-composer-dropdown-folder-icon' });
        setIcon(folderIcon, 'chevron-right');
      }

      if (selectable) {
        itemEl.addEventListener('mouseenter', () => this.options.onHover(index));
        itemEl.addEventListener('click', event => {
          event.stopPropagation();
          this.options.onSelect(index);
        });
      }
      this.itemEls.push(itemEl);
    }

    dropdown.addClass('is-visible');
    this.options.inputEl.setAttribute?.('aria-expanded', 'true');
    this.updateSelection(selectedIndex);
    this.positionFixed();
  }

  updateSelection(selectedIndex: number): void {
    for (let index = 0; index < this.itemEls.length; index++) {
      const itemEl = this.itemEls[index];
      const selected = index === selectedIndex;
      itemEl.toggleClass('is-selected', selected);
      itemEl.setAttribute('aria-selected', String(selected));
      if (selected) {
        this.options.inputEl.setAttribute?.('aria-activedescendant', itemEl.id);
        itemEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private ensureDropdown(): HTMLElement {
    if (this.dropdownEl) return this.dropdownEl;
    this.dropdownEl = this.containerEl.createDiv({
      cls: [
        'claudian-composer-dropdown',
        this.options.fixed ? 'claudian-composer-dropdown--fixed' : '',
      ].filter(Boolean).join(' '),
      attr: { role: 'listbox' },
    });
    this.options.inputEl.setAttribute?.('aria-autocomplete', 'list');
    this.options.inputEl.setAttribute?.('aria-expanded', 'false');
    return this.dropdownEl;
  }

  private positionFixed(): void {
    if (!this.dropdownEl || !this.options.fixed) return;
    const inputRect = this.options.inputEl.getBoundingClientRect();
    const viewportHeight = this.options.inputEl.ownerDocument.defaultView?.innerHeight
      ?? window.innerHeight;
    this.dropdownEl.setCssProps({
      '--claudian-fixed-dropdown-bottom': `${viewportHeight - inputRect.top + 4}px`,
      '--claudian-fixed-dropdown-left': `${inputRect.left}px`,
      '--claudian-fixed-dropdown-width': `${Math.max(inputRect.width, 280)}px`,
    });
  }
}
