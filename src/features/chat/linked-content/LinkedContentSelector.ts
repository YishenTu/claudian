import { setIcon } from 'obsidian';

import type { LinkedContentPickerItem } from './LinkedContentPickerSource';

export interface LinkedContentSelectorState {
  readonly mode: 'auto-draft' | 'explicit-draft' | 'submitting' | 'locked';
  readonly path: string | null;
  readonly label: string | null;
}

export interface LinkedContentSelectorOptions {
  readonly listItems: () => readonly LinkedContentPickerItem[];
  readonly onSelect: (path: string | null) => void;
}

let linkedContentSelectorSequence = 0;

export class LinkedContentSelector {
  private readonly prefixId = `claudian-linked-content-prefix-${++linkedContentSelectorSequence}`;
  private selectorRow: HTMLElement | null = null;
  private selectorButton: HTMLButtonElement | null = null;
  private pickerEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private pickerKeyTarget: Window | null = null;
  private destroyed = false;
  private state: LinkedContentSelectorState | null = null;
  private items: readonly LinkedContentPickerItem[] = [];
  private filteredItems: readonly LinkedContentPickerItem[] = [];
  private activeIndex = 0;
  private readonly optionListeners: Array<{ element: HTMLElement; listener: () => void }> = [];

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly options: LinkedContentSelectorOptions,
  ) {}

  render(state: LinkedContentSelectorState): void {
    if (this.destroyed) return;
    this.state = state;
    if (state.mode === 'submitting' || state.mode === 'locked') {
      this.clearDom();
      return;
    }
    if (!this.selectorButton) this.buildSelectorButton();
    this.updateSelectorButton();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearDom();
    this.state = null;
  }

  private buildSelectorButton(): void {
    this.selectorRow = this.mountEl.createDiv({ cls: 'claudian-linked-content-selector-row' });
    const iconEl = this.selectorRow.createSpan({ cls: 'claudian-linked-content-selector-icon' });
    setIcon(iconEl, 'link');
    const prefixEl = this.selectorRow.createSpan({
      cls: 'claudian-linked-content-selector-prefix',
      text: 'Linked content:',
    });
    prefixEl.setAttribute('id', this.prefixId);
    this.selectorButton = this.selectorRow.createEl('button', {
      cls: 'claudian-linked-content-selector',
      attr: {
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
    });
    this.selectorButton.addEventListener('click', this.handleSelectorClick);
  }

  private updateSelectorButton(): void {
    if (!this.selectorButton || !this.state) return;
    const value = this.state.label ?? 'None';
    this.selectorButton.setText(value);
  }

  private readonly handleSelectorClick = (): void => {
    if (this.pickerEl) {
      this.closePicker(true);
      return;
    }
    this.openPicker();
  };

  private openPicker(): void {
    if (this.destroyed || !this.selectorButton || !this.selectorRow) return;
    const selectorRect = this.selectorButton.getBoundingClientRect();
    this.selectorButton.setAttribute('aria-expanded', 'true');
    this.selectorRow.addClass('is-editing');
    this.searchInput = this.selectorRow.createEl('input', {
      cls: 'claudian-linked-content-picker-search',
      attr: {
        type: 'text',
        'aria-labelledby': this.prefixId,
        autocomplete: 'off',
      },
    });
    this.searchInput.addEventListener('input', this.handleSearchInput);
    this.searchInput.addEventListener('keydown', this.handleSearchKeydown);
    this.sizeSearchInputToSelector(selectorRect);
    this.pickerEl = this.mountEl.createDiv({
      cls: 'claudian-composer-dropdown claudian-linked-content-picker',
    });
    this.pickerEl.addEventListener('keydown', this.handlePickerBoundaryKeydown);
    this.pickerKeyTarget = this.mountEl.ownerDocument.defaultView;
    this.pickerKeyTarget?.addEventListener('keydown', this.handleWindowKeydown, true);
    this.items = this.options.listItems();
    this.filteredItems = [];
    this.activeIndex = 0;
    this.searchInput.focus();
  }

  private readonly handleSearchInput = (): void => {
    if (!this.getSearchQuery()) {
      this.filteredItems = [];
      this.activeIndex = 0;
      this.hidePickerResults();
      return;
    }
    this.filterAndRenderItems();
  };

  private readonly handleSearchKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closePicker(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveActive(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = this.filteredItems[this.activeIndex];
      if (item) this.select(item);
    }
  };

  private readonly handlePickerBoundaryKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.target === this.searchInput) return;
    event.preventDefault();
    event.stopPropagation();
    this.closePicker(true);
  };

  private readonly handleWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.pickerEl) return;
    event.preventDefault();
    event.stopPropagation();
    this.closePicker(true);
  };

  private filterAndRenderItems(): void {
    if (!this.pickerEl) return;
    const query = this.getSearchQuery();
    if (!query) {
      this.filteredItems = [];
      this.activeIndex = 0;
      this.hidePickerResults();
      return;
    }
    this.filteredItems = this.items.filter(item => (
      item.label.toLocaleLowerCase().includes(query)
      || item.detail.toLocaleLowerCase().includes(query)
    ));
    const selectedIndex = this.filteredItems.findIndex(item => item.path === this.state?.path);
    this.activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.renderItems();
  }

  private renderItems(): void {
    if (!this.pickerEl) return;
    this.clearPickerResults();
    this.showPickerResults();
    const listEl = this.pickerEl.createDiv({ cls: 'claudian-linked-content-picker-list' });
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', 'Linked content choices');

    if (this.filteredItems.length === 0) {
      listEl.createDiv({
        cls: 'claudian-composer-dropdown-item is-empty claudian-linked-content-picker-empty',
        text: 'No matching files or folders',
      });
      return;
    }

    this.filteredItems.forEach((item, index) => {
      const optionEl = listEl.createEl('button', {
        cls: 'claudian-composer-dropdown-item claudian-linked-content-picker-option',
        attr: {
          type: 'button',
          role: 'option',
          'aria-selected': String(index === this.activeIndex),
          'aria-label': `${item.label}. ${item.detail}`,
        },
      });
      optionEl.toggleClass('is-selected', index === this.activeIndex);
      const iconEl = optionEl.createSpan({
        cls: 'claudian-composer-dropdown-icon claudian-linked-content-picker-option-icon',
      });
      setIcon(iconEl, item.icon);
      const textEl = optionEl.createSpan({
        cls: 'claudian-composer-dropdown-copy claudian-linked-content-picker-option-text',
      });
      textEl.createSpan({
        cls: 'claudian-composer-dropdown-label claudian-linked-content-picker-option-label',
        text: item.label,
      });
      textEl.createSpan({
        cls: 'claudian-composer-dropdown-detail claudian-linked-content-picker-option-path',
        text: item.detail,
      });
      const listener = (): void => this.select(item);
      optionEl.addEventListener('click', listener);
      this.optionListeners.push({ element: optionEl, listener });
    });
  }

  private moveActive(delta: number): void {
    if (this.filteredItems.length === 0) return;
    this.activeIndex = (
      this.activeIndex + delta + this.filteredItems.length
    ) % this.filteredItems.length;
    this.renderItems();
    const options = this.pickerEl?.querySelectorAll<HTMLElement>(
      '.claudian-linked-content-picker-option',
    );
    options?.[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private select(item: LinkedContentPickerItem): void {
    this.options.onSelect(item.path);
    this.closePicker(true);
  }

  private getSearchQuery(): string {
    return (this.searchInput?.value ?? '').trim().toLocaleLowerCase();
  }

  private sizeSearchInputToSelector(selectorRect: DOMRect): void {
    if (!this.searchInput) return;
    const fallbackWidth = Math.max(1, Array.from(this.state?.label || 'None').length);
    this.searchInput.style.width = selectorRect.width > 0
      ? `${selectorRect.width}px`
      : `${fallbackWidth}ch`;
    if (selectorRect.height > 0) {
      this.searchInput.style.height = `${selectorRect.height}px`;
    }
  }

  private showPickerResults(): void {
    this.pickerEl?.addClass('is-visible');
  }

  private hidePickerResults(): void {
    this.clearPickerResults();
    this.pickerEl?.removeClass('is-visible');
  }

  private clearPickerResults(): void {
    if (!this.pickerEl) return;
    this.clearOptionListeners();
    this.pickerEl.querySelector('.claudian-linked-content-picker-list')?.remove();
  }

  private closePicker(returnFocus: boolean): void {
    if (!this.pickerEl) return;
    this.clearOptionListeners();
    this.searchInput?.removeEventListener('input', this.handleSearchInput);
    this.searchInput?.removeEventListener('keydown', this.handleSearchKeydown);
    this.searchInput?.remove();
    this.selectorRow?.removeClass('is-editing');
    this.pickerEl.removeEventListener('keydown', this.handlePickerBoundaryKeydown);
    this.pickerKeyTarget?.removeEventListener('keydown', this.handleWindowKeydown, true);
    this.pickerKeyTarget = null;
    this.searchInput = null;
    this.pickerEl.remove();
    this.pickerEl = null;
    this.selectorButton?.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.selectorButton?.focus();
  }

  private clearOptionListeners(): void {
    for (const { element, listener } of this.optionListeners) {
      element.removeEventListener('click', listener);
    }
    this.optionListeners.length = 0;
  }

  private clearDom(): void {
    this.closePicker(false);
    this.selectorButton?.removeEventListener('click', this.handleSelectorClick);
    this.selectorButton = null;
    this.selectorRow = null;
    this.mountEl.empty();
  }
}
