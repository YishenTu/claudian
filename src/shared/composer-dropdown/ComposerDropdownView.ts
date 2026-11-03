import { setIcon } from 'obsidian';

import { t } from '@/i18n/i18n';

import type { ComposerDropdownItem, ComposerInputElement, ComposerTextMatch } from './types';

export interface ComposerDropdownViewOptions {
  readonly fixed?: boolean;
  readonly inputEl: ComposerInputElement;
  readonly onHover: (index: number) => void;
  readonly onSelect: (index: number) => void;
  readonly onVisibilityChange?: () => void;
}

let nextListboxId = 0;

/** Builds through the parent so rows in a pop-out window own their nodes. */
function appendMarkedText(parent: HTMLElement, text: string, match: ComposerTextMatch | undefined): void {
  if (!match || match.end <= match.start) {
    parent.appendText(text);
    return;
  }
  parent.appendText(text.slice(0, match.start));
  parent.createSpan({ cls: 'claudian-composer-dropdown-match', text: text.slice(match.start, match.end) });
  parent.appendText(text.slice(match.end));
}

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
  private labelEl: HTMLElement | null = null;
  private rows: ItemRow[] = [];
  private positioningWindow: Window | null = null;
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
    this.#stopPositioning();
    for (const attribute of [...this.writtenAttributes.keys()]) this.#releaseInputAttribute(attribute);
    this.dropdownEl?.remove();
    this.dropdownEl = null;
    this.labelEl?.remove();
    this.labelEl = null;
    this.rows = [];
    if (wasVisible) this.options.onVisibilityChange?.();
  }

  hide(): void {
    this.#stopPositioning();
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
    this.updateSelection(selectedIndex, !this.options.fixed);
    if (!wasVisible && this.options.fixed) {
      this.positioningWindow = this.options.inputEl.ownerDocument.defaultView;
      this.positioningWindow?.addEventListener('scroll', this.#positionFixed, true);
      this.positioningWindow?.addEventListener('resize', this.#positionFixed);
    }
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
    if (item.kind === 'value' && (item.labelMatch || item.labelNote)) {
      row.labelEl.empty();
      appendMarkedText(row.labelEl, item.label, item.labelMatch);
      if (item.labelNote) {
        row.labelEl.appendText(' ');
        const noteEl = row.labelEl.createSpan({ cls: 'claudian-composer-dropdown-label-note' });
        noteEl.appendText('(');
        appendMarkedText(noteEl, item.labelNote.text, item.labelNote.match);
        noteEl.appendText(')');
      }
    } else {
      row.labelEl.textContent = item.label;
    }
    if (row.detailEl) row.detailEl.textContent = item.detail ?? '';
  }

  updateSelection(selectedIndex: number, reveal = true): void {
    this.#releaseInputAttribute('aria-activedescendant');
    for (let index = 0; index < this.rows.length; index++) {
      const itemEl = this.rows[index].el;
      const selected = index === selectedIndex;
      itemEl.toggleClass('is-selected', selected);
      itemEl.setAttribute('aria-selected', String(selected));
      if (selected) {
        this.#setInputAttribute('aria-activedescendant', itemEl.id);
        if (reveal) this.#revealInList(itemEl);
      }
    }
  }

  /** As in the resume picker, reveal only inside the popup, not its workspace ancestors. */
  #revealInList(item: HTMLElement): void {
    const list = this.dropdownEl;
    if (!list) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }

  #ensureDropdown(): HTMLElement {
    if (this.dropdownEl) return this.dropdownEl;
    // Named through a hidden sibling: Obsidian shows an aria-label as a hover tooltip over the whole menu.
    this.labelEl = this.containerEl.createSpan({
      attr: { hidden: '', id: `${this.listboxId}-label` },
      text: t('common.inputSuggestions'),
    });
    this.dropdownEl = this.containerEl.createDiv({
      cls: [
        'claudian-composer-dropdown',
        this.options.fixed ? 'claudian-composer-dropdown--fixed' : '',
      ].filter(Boolean).join(' '),
      attr: { id: this.listboxId, role: 'listbox', 'aria-labelledby': this.labelEl.id },
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

  #stopPositioning(): void {
    this.positioningWindow?.removeEventListener('scroll', this.#positionFixed, true);
    this.positioningWindow?.removeEventListener('resize', this.#positionFixed);
    this.positioningWindow = null;
  }

  readonly #positionFixed = (event?: Event): void => {
    if (!this.dropdownEl || !this.options.fixed || !this.isVisible()) return;
    if (event?.type === 'scroll' && event.target && 'nodeType' in event.target
      && this.dropdownEl.contains(event.target as Node)) return;
    const inputRect = this.options.inputEl.getBoundingClientRect();
    const viewportHeight = this.options.inputEl.ownerDocument.defaultView?.innerHeight
      ?? window.innerHeight;
    const dropdown = this.dropdownEl;
    const previousHeight = dropdown.clientHeight;
    dropdown.setCssProps({
      '--claudian-fixed-dropdown-left': `${inputRect.left}px`,
      '--claudian-fixed-dropdown-width': `${Math.max(inputRect.width, 280)}px`,
    });
    const naturalHeight = Math.min(300, dropdown.scrollHeight + dropdown.offsetHeight - dropdown.clientHeight);
    const above = Math.max(0, inputRect.top - 8);
    const below = Math.max(0, viewportHeight - inputRect.bottom - 8);
    const openAbove = naturalHeight <= above || above >= below;
    dropdown.setCssProps({
      '--claudian-fixed-dropdown-top': openAbove ? 'auto' : `${inputRect.bottom + 8}px`,
      '--claudian-fixed-dropdown-bottom': openAbove ? `${viewportHeight - inputRect.top + 8}px` : 'auto',
      '--claudian-fixed-dropdown-max-height': `${Math.min(300, openAbove ? above : below)}px`,
    });
    const selected = this.rows.find(row => row.el.getAttribute('aria-selected') === 'true');
    if (selected && (!event || dropdown.clientHeight !== previousHeight)) this.#revealInList(selected.el);
  };
}
