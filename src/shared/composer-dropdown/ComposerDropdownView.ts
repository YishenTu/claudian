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

interface ItemRow {
  readonly el: HTMLElement;
  readonly iconEl: HTMLElement | null;
  readonly labelEl: HTMLElement;
  readonly detailEl: HTMLElement | null;
  icon: string | undefined;
  selectable: boolean;
}

export class ComposerDropdownView {
  private dropdownEl: HTMLElement | null = null;
  private rows: ItemRow[] = [];
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
    this.rows = [];
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

    // Rewrite rows in place across keystrokes; rebuilding each row and its icon dominates large lists.
    let rebuilt = items.length !== this.rows.length;
    this.rows = items.map((item, index) => {
      const icon = item.kind === 'status' ? undefined : item.icon;
      const row = this.rows[index];
      if (row && Boolean(row.iconEl) === Boolean(icon) && Boolean(row.detailEl) === Boolean(item.detail)) {
        this.#updateRow(row, item, index === selectedIndex);
        return row;
      }
      rebuilt = true;
      return this.#createRow(dropdown, item, index, index === selectedIndex);
    });
    if (rebuilt) dropdown.replaceChildren(...this.rows.map(row => row.el));

    dropdown.addClass('is-visible');
    this.#setInputAttribute('aria-controls', this.listboxId);
    this.updateSelection(selectedIndex);
    this.#positionFixed();
    if (!wasVisible) this.options.onVisibilityChange?.();
  }

  #createRow(dropdown: HTMLElement, item: ComposerDropdownItem, index: number, selected: boolean): ItemRow {
    const el = dropdown.createDiv();
    el.setAttribute('id', `${this.listboxId}-option-${index}`);
    el.setAttribute('role', 'option');
    const icon = item.kind === 'status' ? undefined : item.icon;
    const iconEl = icon ? el.createSpan({ cls: 'claudian-composer-dropdown-icon' }) : null;
    const copyEl = el.createDiv({ cls: 'claudian-composer-dropdown-copy' });
    const row: ItemRow = {
      el,
      iconEl,
      labelEl: copyEl.createDiv({ cls: 'claudian-composer-dropdown-label' }),
      detailEl: item.detail ? copyEl.createDiv({ cls: 'claudian-composer-dropdown-detail' }) : null,
      icon: undefined,
      selectable: false,
    };
    el.addEventListener('mouseenter', () => {
      if (row.selectable) this.options.onHover(index);
    });
    el.addEventListener('click', event => {
      if (!row.selectable) return;
      event.stopPropagation();
      this.options.onSelect(index);
    });
    this.#updateRow(row, item, selected);
    return row;
  }

  #updateRow(row: ItemRow, item: ComposerDropdownItem, selected: boolean): void {
    row.selectable = item.kind !== 'status' && !item.disabled;
    row.el.className = [
      'claudian-composer-dropdown-item',
      item.className ?? '',
      item.kind === 'status' ? `is-${item.state}` : '',
      selected ? 'is-selected' : '',
    ].filter(Boolean).join(' ');
    if (row.selectable) row.el.removeAttribute('aria-disabled');
    else row.el.setAttribute('aria-disabled', 'true');
    const icon = item.kind === 'status' ? undefined : item.icon;
    if (row.iconEl && icon && icon !== row.icon) {
      setIcon(row.iconEl, icon);
      row.icon = icon;
    }
    row.labelEl.textContent = item.label;
    if (row.detailEl) row.detailEl.textContent = item.detail ?? '';
  }

  updateSelection(selectedIndex: number): void {
    this.#releaseInputAttribute('aria-activedescendant');
    for (let index = 0; index < this.rows.length; index++) {
      const itemEl = this.rows[index].el;
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
