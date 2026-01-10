/**
 * Generic selectable dropdown list view.
 *
 * Manages list rendering, selection state, and visibility.
 */

export interface SelectableDropdownOptions {
  listClassName: string;
  itemClassName: string;
  emptyClassName: string;
  fixed?: boolean;
  fixedClassName?: string;
}

export interface SelectableDropdownRenderOptions<T> {
  items: T[];
  selectedIndex: number;
  emptyText: string;
  renderItem: (item: T, itemEl: HTMLElement) => void;
  getItemClass?: (item: T) => string | string[] | undefined;
  onItemClick?: (item: T, index: number) => void;
  onItemHover?: (item: T, index: number) => void;
}

export class SelectableDropdown<T> {
  private containerEl: HTMLElement;
  private dropdownEl: HTMLElement | null = null;
  private options: SelectableDropdownOptions;
  private items: T[] = [];
  private itemEls: HTMLElement[] = [];
  private selectedIndex = 0;

  constructor(containerEl: HTMLElement, options: SelectableDropdownOptions) {
    this.containerEl = containerEl;
    this.options = options;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  getElement(): HTMLElement | null {
    return this.dropdownEl;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getSelectedItem(): T | null {
    return this.items[this.selectedIndex] ?? null;
  }

  getItems(): T[] {
    return this.items;
  }

  hide(): void {
    if (this.dropdownEl) {
      this.dropdownEl.removeClass('visible');
    }
  }

  destroy(): void {
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  render(options: SelectableDropdownRenderOptions<T>): void {
    this.items = options.items;
    this.selectedIndex = options.selectedIndex;

    if (!this.dropdownEl) {
      this.dropdownEl = this.createDropdownElement();
    }

    this.dropdownEl.empty();
    this.itemEls = [];

    if (options.items.length === 0) {
      const emptyEl = this.dropdownEl.createDiv({ cls: this.options.emptyClassName });
      emptyEl.setText(options.emptyText);
    } else {
      for (let i = 0; i < options.items.length; i++) {
        const item = options.items[i];
        const itemEl = this.dropdownEl.createDiv({ cls: this.options.itemClassName });

        const extraClass = options.getItemClass?.(item);
        if (Array.isArray(extraClass)) {
          extraClass.forEach(cls => itemEl.addClass(cls));
        } else if (extraClass) {
          itemEl.addClass(extraClass);
        }

        if (i === this.selectedIndex) {
          itemEl.addClass('selected');
        }

        options.renderItem(item, itemEl);

        itemEl.addEventListener('click', () => {
          this.selectedIndex = i;
          this.updateSelection();
          options.onItemClick?.(item, i);
        });

        itemEl.addEventListener('mouseenter', () => {
          this.selectedIndex = i;
          this.updateSelection();
          options.onItemHover?.(item, i);
        });

        this.itemEls.push(itemEl);
      }
    }

    this.dropdownEl.addClass('visible');
  }

  updateSelection(): void {
    this.itemEls.forEach((itemEl, index) => {
      if (index === this.selectedIndex) {
        itemEl.addClass('selected');
        itemEl.scrollIntoView({ block: 'nearest' });
      } else {
        itemEl.removeClass('selected');
      }
    });
  }

  moveSelection(delta: number): void {
    const maxIndex = this.items.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + delta));
    this.updateSelection();
  }

  private createDropdownElement(): HTMLElement {
    const className = this.options.fixed && this.options.fixedClassName
      ? `${this.options.listClassName} ${this.options.fixedClassName}`
      : this.options.listClassName;

    return this.containerEl.createDiv({ cls: className });
  }
}
