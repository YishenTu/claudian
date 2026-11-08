import { t } from '@/i18n/i18n';

import { ComposerDropdownView } from './ComposerDropdownView';
import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerInputElement,
  ComposerTriggerMatch,
} from './types';

export interface ComposerDropdownControllerOptions {
  readonly fixed?: boolean;
  /** Runs after the menu shows or hides. */
  readonly onVisibilityChange?: () => void;
}

/** The trigger the menu is open for, and the load answering it while one is pending. */
interface OpenTrigger {
  readonly source: ComposerDropdownSource;
  match: ComposerTriggerMatch;
  load: AbortController | null;
}

export class ComposerDropdownController {
  private readonly sourceUnsubscribers: Array<() => void> = [];
  private readonly view: ComposerDropdownView;
  #open: OpenTrigger | null = null;
  private destroyed = false;
  /** Trigger closed with Escape; it stays closed until the input no longer matches it. */
  private dismissed: { readonly sourceId: string; readonly start: number } | null = null;
  private items: readonly ComposerDropdownItem[] = [];
  private selectedIndex = -1;

  constructor(
    containerEl: HTMLElement,
    private readonly inputEl: ComposerInputElement,
    private readonly sources: readonly ComposerDropdownSource[],
    options: ComposerDropdownControllerOptions = {},
  ) {
    this.view = new ComposerDropdownView(containerEl, {
      fixed: options.fixed,
      inputEl,
      onVisibilityChange: options.onVisibilityChange,
      onHover: index => this.#setSelectedIndex(index, false),
      onSelect: index => this.#selectIndex(index),
    });
    for (const source of sources) {
      const unsubscribe = source.subscribeInvalidation?.(() => {
        if (this.#open?.source.id === source.id) this.#rematchInput();
      });
      if (unsubscribe) this.sourceUnsubscribers.push(unsubscribe);
    }
  }

  containsElement(element: Node): boolean {
    return this.view.contains(element);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#open?.source.onClose?.();
    this.#invalidateActiveLoad();
    for (const unsubscribe of this.sourceUnsubscribers.splice(0)) unsubscribe();
    this.view.destroy();
  }

  handleInputChange(): void {
    this.#rematchAndLoad();
  }

  #rematchAndLoad(preserveSelection = false): void {
    if (this.destroyed) {
      this.hide();
      return;
    }
    const sourceMatch = this.#findSourceMatch();
    if (!sourceMatch || this.dismissed) {
      this.hide();
      return;
    }
    const { match, source } = sourceMatch;
    const previous = this.#open;
    const opening = previous?.source.id !== source.id;
    if (opening) {
      previous?.source.onClose?.();
      this.#open = { load: previous?.load ?? null, match, source };
      source.onOpen?.();
    } else {
      previous.match = match;
    }
    this.#requestActiveLoad(preserveSelection);
  }

  #findSourceMatch(): { match: ComposerTriggerMatch; source: ComposerDropdownSource } | undefined {
    const cursor = this.inputEl.selectionStart ?? 0;
    let sourceMatch: { match: ComposerTriggerMatch; source: ComposerDropdownSource } | undefined;
    for (const source of this.sources) {
      const match = source.match(this.inputEl.value, cursor);
      if (match && !this.inputEl.isChipRange?.(match.start, match.end)
        && (!sourceMatch || match.start > sourceMatch.match.start)) {
        sourceMatch = { match, source };
      }
    }
    // A dismissal lasts only while the same trigger keeps matching.
    if (sourceMatch?.source.id !== this.dismissed?.sourceId || sourceMatch?.match.start !== this.dismissed?.start) {
      this.dismissed = null;
    }
    return sourceMatch;
  }

  handleKeydown(event: KeyboardEvent): boolean {
    // Sends and caret moves change the input without an input event; each key observes them before it applies.
    if (this.dismissed) this.#findSourceMatch();
    if (!this.view.isVisible() || event.isComposing) return false;
    if (event.key === 'Tab' && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) return false;
    switch (event.key) {
      case 'ArrowDown':
        if (this.selectedIndex < 0) return false;
        event.preventDefault();
        this.#moveSelection(1);
        return true;
      case 'ArrowUp':
        if (this.selectedIndex < 0) return false;
        event.preventDefault();
        this.#moveSelection(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.selectedIndex < 0) return false;
        event.preventDefault();
        this.#selectIndex(this.selectedIndex);
        return true;
      case 'Escape':
        event.preventDefault();
        if (this.#open) {
          this.dismissed = { sourceId: this.#open.source.id, start: this.#open.match.start };
        }
        this.hide();
        return true;
      default:
        return false;
    }
  }

  hide(): void {
    this.#open?.source.onClose?.();
    this.#invalidateActiveLoad();
    this.#open = null;
    this.items = [];
    this.selectedIndex = -1;
    this.view.hide();
  }

  isVisible(): boolean {
    return this.view.isVisible();
  }

  #rematchInput(): void {
    if (!this.#open || this.destroyed) return;
    this.#rematchAndLoad(true);
  }

  #requestActiveLoad(preserveSelection: boolean): void {
    const open = this.#open;
    if (!open || this.destroyed) return;
    const { source, match } = open;
    const selectedId = preserveSelection ? this.items[this.selectedIndex]?.id : undefined;

    this.#invalidateActiveLoad();
    const controller = new AbortController();
    open.load = controller;
    let result: ReturnType<ComposerDropdownSource['load']>;
    try {
      result = source.load(match, controller.signal);
    } catch {
      this.#renderLoadFailure();
      return;
    }
    // Synchronous results replace the list directly; only pending loads show a placeholder.
    if (!(result instanceof Promise)) {
      this.#renderLoaded(result, selectedId);
      return;
    }
    this.items = [{ id: 'loading', kind: 'status', label: t('chat.suggestions.loading'), state: 'loading' }];
    this.selectedIndex = -1;
    this.view.render(this.items, this.selectedIndex);
    result.then(
      items => { if (!controller.signal.aborted) this.#renderLoaded(items, selectedId); },
      () => { if (!controller.signal.aborted) this.#renderLoadFailure(); },
    );
  }

  #renderLoaded(items: readonly ComposerDropdownItem[], selectedId?: string): void {
    this.items = items.length > 0
      ? items
      : [{ id: 'empty', kind: 'status', label: t('chat.suggestions.noMatches'), state: 'empty' }];
    const retained = selectedId === undefined ? -1 : this.items.findIndex(item =>
      item.id === selectedId && item.kind === 'value' && !item.disabled);
    this.selectedIndex = retained >= 0 ? retained : this.#findSelectable(0, 1, true);
    this.view.render(this.items, this.selectedIndex);
  }

  #renderLoadFailure(): void {
    this.items = [{
      id: 'error',
      kind: 'status',
      label: t('chat.suggestions.loadFailed'),
      detail: t('chat.suggestions.retryHint'),
      state: 'error',
    }];
    this.selectedIndex = -1;
    this.view.render(this.items, this.selectedIndex);
  }

  #invalidateActiveLoad(): void {
    const open = this.#open;
    open?.load?.abort();
    if (open) open.load = null;
  }

  #moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    const start = this.selectedIndex < 0 ? (delta > 0 ? 0 : this.items.length - 1) : this.selectedIndex + delta;
    const next = this.#findSelectable(start, delta, false);
    if (next >= 0) this.#setSelectedIndex(next);
  }

  #findSelectable(start: number, delta: number, clamp: boolean): number {
    if (this.items.length === 0) return -1;
    let index = clamp ? Math.max(0, Math.min(this.items.length - 1, start)) : start;
    for (let seen = 0; seen < this.items.length; seen++) {
      if (index < 0) index = this.items.length - 1;
      if (index >= this.items.length) index = 0;
      const item = this.items[index];
      if (item.kind !== 'status' && !item.disabled) return index;
      index += delta;
    }
    return -1;
  }

  #selectIndex(index: number): void {
    const item = this.items[index];
    const open = this.#open;
    if (!item || item.kind === 'status' || item.disabled || !open) return;
    const { source, match } = open;
    const action = source.select(item, match);
    if (action.kind === 'invoke') {
      action.onApplied();
      return;
    }
    if (action.kind === 'replace') {
      this.replaceRange(match, action.text);
      this.hide();
      this.inputEl.focus();
    }
  }

  private replaceRange(match: ComposerTriggerMatch, replacement: string): void {
    const duplicateSpace = /[^\S\r\n]$/.test(replacement) && /^[^\S\r\n]/.test(this.inputEl.value.slice(match.end));
    const end = match.end + (duplicateSpace ? 1 : 0);
    if (this.inputEl.replaceText) {
      this.inputEl.replaceText(match.start, end, replacement);
      return;
    }
    const before = this.inputEl.value.slice(0, match.start);
    this.inputEl.value = before + replacement + this.inputEl.value.slice(end);
    const cursor = before.length + replacement.length;
    this.inputEl.selectionStart = cursor;
    this.inputEl.selectionEnd = cursor;
  }

  #setSelectedIndex(index: number, reveal = true): void {
    const item = this.items[index];
    if (!item || item.kind === 'status' || item.disabled) return;
    this.selectedIndex = index;
    this.view.updateSelection(index, reveal);
  }
}
