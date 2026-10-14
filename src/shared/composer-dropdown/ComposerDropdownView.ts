import { setIcon } from 'obsidian';

import { t } from '@/i18n/i18n';

import type { ComposerDropdownItem, ComposerInputElement } from './types';

export interface ComposerDropdownViewOptions {
  readonly fixed?: boolean;
  readonly inputEl: ComposerInputElement;
  readonly onHover: (index: number) => void;
  readonly onSelect: (index: number) => void;
  readonly onVisibilityChange?: () => void;
}

let nextListboxId = 0;

export class ComposerDropdownView {
  private dropdownEl: HTMLElement | null = null;
  private itemEls: HTMLElement[] = [];
  private readonly listboxId = `claudian-composer-listbox-${++nextListboxId}`;
  /** Textbox relationships this menu wrote; another popup may have replaced them since. */
  private readonly writtenAttributes = new Map<string, string>();

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly options: ComposerDropdownViewOptions,
  ) {}

  contains(element: Node): boolean {
    return this.dropdownEl?.contains(element) ?? false;
  }

  destroy(): void {
    const wasVisible = this.isVisible();
    for (const attribute of [...this.writtenAttributes.keys()]) this.#releaseInputAttribute(attribute);
    this.dropdownEl?.remove();
    this.dropdownEl = null;
    this.itemEls = [];
    if (wasVisible) this.options.onVisibilityChange?.();
  }

  hide(): void {
    this.#releaseInputAttribute('aria-activedescendant');
    this.#releaseInputAttribute('aria-controls');
    if (!this.isVisible()) return;
    this.dropdownEl?.removeClass('is-visible');
    this.options.onVisibilityChange?.();
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('is-visible') ?? false;
  }

  render(items: readonly ComposerDropdownItem[], selectedIndex: number): void {
    const dropdown = this.#ensureDropdown();
    const wasVisible = this.isVisible();
    this.#releaseInputAttribute('aria-activedescendant');
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
      itemEl.setAttribute('id', `${this.listboxId}-option-${index}`);
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
    this.#setInputAttribute('aria-controls', this.listboxId);
    this.updateSelection(selectedIndex);
    this.#positionFixed();
    if (!wasVisible) this.options.onVisibilityChange?.();
  }

  updateSelection(selectedIndex: number): void {
    this.#releaseInputAttribute('aria-activedescendant');
    for (let index = 0; index < this.itemEls.length; index++) {
      const itemEl = this.itemEls[index];
      const selected = index === selectedIndex;
      itemEl.toggleClass('is-selected', selected);
      itemEl.setAttribute('aria-selected', String(selected));
      if (selected) {
        this.#setInputAttribute('aria-activedescendant', itemEl.id);
        itemEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  #ensureDropdown(): HTMLElement {
    if (this.dropdownEl) return this.dropdownEl;
    this.dropdownEl = this.containerEl.createDiv({
      cls: [
        'claudian-composer-dropdown',
        this.options.fixed ? 'claudian-composer-dropdown--fixed' : '',
      ].filter(Boolean).join(' '),
      attr: { id: this.listboxId, role: 'listbox', 'aria-label': t('common.inputSuggestions') },
    });
    this.#setInputAttribute('aria-autocomplete', 'list');
    return this.dropdownEl;
  }

  get #textbox(): HTMLElement {
    return this.options.inputEl.getAccessibleTextbox?.() ?? this.options.inputEl;
  }

  #setInputAttribute(attribute: string, value: string): void {
    this.writtenAttributes.set(attribute, value);
    this.#textbox.setAttribute(attribute, value);
  }

  /** Leaves the attribute alone when another popup has since taken it over. */
  #releaseInputAttribute(attribute: string): void {
    const written = this.writtenAttributes.get(attribute);
    if (written === undefined) return;
    this.writtenAttributes.delete(attribute);
    if (this.#textbox.getAttribute(attribute) === written) this.#textbox.removeAttribute(attribute);
  }

  #positionFixed(): void {
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
