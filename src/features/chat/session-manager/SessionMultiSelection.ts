/**
 * Multi-selection of session rows within one rendered list. Option/Alt toggles rows; the
 * selection never outlives its container or search query.
 */
export class SessionMultiSelection {
  readonly #selectedIds = new Set<string>();
  #searchQuery = '';
  #container: HTMLElement | null = null;
  #dismissCleanup: (() => void) | null = null;

  /** Starts a list render, dropping the selection when it cannot carry over to this list. */
  beginRender(container: HTMLElement, searchQuery: string, enabled: boolean): void {
    if (
      !enabled
      || searchQuery !== this.#searchQuery
      || (this.#container !== null && this.#container !== container)
    ) {
      this.clear();
      this.#searchQuery = searchQuery;
    }
    this.#container = container;
  }

  /** True when the row belongs to a selection of more than one session. */
  isPartOfMultiple(conversationId: string): boolean {
    return this.#selectedIds.has(conversationId) && this.#selectedIds.size > 1;
  }

  has(conversationId: string): boolean {
    return this.#selectedIds.has(conversationId);
  }

  /**
   * Option/Alt+click or Option/Alt+Enter toggles selection. Any other click, Escape, or
   * pointer/focus moving outside the selected sessions clears it.
   */
  attach(item: HTMLElement, conversationId: string): void {
    if (this.#selectedIds.has(conversationId)) {
      this.#setItemSelected(item, true);
    }
    const toggle = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const selected = !this.#selectedIds.has(conversationId);
      if (selected) {
        this.#selectedIds.add(conversationId);
        this.#watchDismissal();
      } else {
        this.#selectedIds.delete(conversationId);
      }
      this.#setItemSelected(item, selected);
    };
    // Capture phase runs before the item's open/new-tab handlers.
    item.addEventListener('click', (event) => {
      if (event.altKey) {
        toggle(event);
      } else {
        this.clear();
      }
    }, { capture: true });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.altKey) {
        toggle(event);
      } else if (event.key === 'Escape') {
        this.clear();
      }
    }, { capture: true });
  }

  #watchDismissal(): void {
    const container = this.#container;
    if (this.#dismissCleanup || !container) return;
    // Popout windows have their own Element constructor.
    const ElementConstructor = container.ownerDocument.defaultView?.Element ?? Element;
    const isInsideSession = (target: EventTarget | null): boolean => (
      target instanceof ElementConstructor
      && container.contains(target)
      && target.closest('.claudian-history-item') !== null
    );
    const onPointerDown = (event: PointerEvent): void => {
      if (!isInsideSession(event.target)) this.clear();
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (!isInsideSession(event.target)) this.clear();
    };
    const doc = container.ownerDocument;
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('focusin', onFocusIn, true);
    this.#dismissCleanup = () => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('focusin', onFocusIn, true);
    };
  }

  #setItemSelected(item: HTMLElement, selected: boolean): void {
    item.classList.toggle('claudian-history-item--selected', selected);
    const label = item.querySelector('.claudian-history-item-selected-label');
    if (!selected) {
      label?.remove();
    } else if (!label) {
      item.querySelector<HTMLElement>('.claudian-history-item-content')
        ?.createSpan({ cls: 'claudian-history-item-selected-label', text: 'Selected' });
    }
  }

  clear(): void {
    this.#dismissCleanup?.();
    this.#dismissCleanup = null;
    if (this.#selectedIds.size === 0) return;
    this.#selectedIds.clear();
    this.#container
      ?.querySelectorAll<HTMLElement>('.claudian-history-item--selected')
      .forEach(selectedItem => this.#setItemSelected(selectedItem, false));
  }
}
