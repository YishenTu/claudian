import { t } from '@/i18n/i18n';

import { ComposerDropdownView } from './ComposerDropdownView';
import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerInputElement,
  ComposerTriggerMatch,
} from './types';

const INPUT_LOAD_DEBOUNCE_MS = 200;

export interface ComposerDropdownControllerOptions {
  readonly fixed?: boolean;
  /** Runs after the menu shows or hides. */
  readonly onVisibilityChange?: () => void;
}

export class ComposerDropdownController {
  private readonly sourceUnsubscribers: Array<() => void> = [];
  private readonly view: ComposerDropdownView;
  private activeController: AbortController | null = null;
  private activeMatch: ComposerTriggerMatch | null = null;
  private activeSource: ComposerDropdownSource | null = null;
  private destroyed = false;
  private generation = 0;
  private inputLoadTimer: number | null = null;
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
      onHover: index => this.#setSelectedIndex(index),
      onSelect: index => this.#selectIndex(index),
    });
    for (const source of sources) {
      const unsubscribe = source.subscribeInvalidation?.(() => {
        if (this.activeSource?.id === source.id) this.#rematchInput();
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
    this.#invalidateActiveLoad();
    for (const unsubscribe of this.sourceUnsubscribers.splice(0)) unsubscribe();
    this.view.destroy();
  }

  handleInputChange(): void {
    this.#rematchAndLoad(true);
  }

  #rematchAndLoad(inputDriven: boolean): void {
    if (this.destroyed) {
      this.hide();
      return;
    }
    const cursor = this.inputEl.selectionStart ?? 0;
    let sourceMatch: { match: ComposerTriggerMatch; source: ComposerDropdownSource } | undefined;
    for (const source of this.sources) {
      const match = source.match(this.inputEl.value, cursor);
      if (match && !this.inputEl.isChipRange?.(match.start, match.end)
        && (!sourceMatch || match.start > sourceMatch.match.start)) {
        sourceMatch = { match, source };
      }
    }
    if (!sourceMatch) {
      this.hide();
      return;
    }
    const { match, source } = sourceMatch;
    const opening = this.activeSource?.id !== source.id;
    this.activeSource = source;
    this.activeMatch = match;
    if (opening) source.onOpen?.();
    this.#requestActiveLoad(inputDriven);
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.view.isVisible() || event.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.#moveSelection(1);
        return true;
      case 'ArrowUp':
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
        this.hide();
        return true;
      default:
        return false;
    }
  }

  hide(): void {
    this.#invalidateActiveLoad();
    this.activeMatch = null;
    this.activeSource = null;
    this.items = [];
    this.selectedIndex = -1;
    this.view.hide();
  }

  isVisible(): boolean {
    return this.view.isVisible();
  }

  #rematchInput(): void {
    if (!this.activeSource || !this.activeMatch || this.destroyed) return;
    this.#rematchAndLoad(false);
  }

  #requestActiveLoad(inputDriven: boolean): void {
    const source = this.activeSource;
    const match = this.activeMatch;
    if (!source || !match || this.destroyed) return;

    const generation = this.#invalidateActiveLoad();
    this.items = [{ id: 'loading', kind: 'status', label: t('chat.suggestions.loading'), state: 'loading' }];
    this.selectedIndex = -1;
    this.view.render(this.items, this.selectedIndex);

    if (inputDriven && source.inputLoadPolicy === 'debounced') {
      this.inputLoadTimer = window.setTimeout(() => {
        this.inputLoadTimer = null;
        void this.loadActive(generation);
      }, INPUT_LOAD_DEBOUNCE_MS);
      return;
    }

    void this.loadActive(generation);
  }

  private async loadActive(generation: number): Promise<void> {
    const source = this.activeSource;
    const match = this.activeMatch;
    if (
      !source
      || !match
      || this.destroyed
      || generation !== this.generation
    ) return;

    const controller = new AbortController();
    this.activeController = controller;

    try {
      const items = await source.load(match, controller.signal);
      if (this.destroyed || controller.signal.aborted || generation !== this.generation) return;
      this.items = items.length > 0
        ? items
        : [{ id: 'empty', kind: 'status', label: t('chat.suggestions.noMatches'), state: 'empty' }];
      this.selectedIndex = this.#findSelectable(0, 1, true);
      this.view.render(this.items, this.selectedIndex);
    } catch {
      if (this.destroyed || controller.signal.aborted || generation !== this.generation) return;
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
  }

  #invalidateActiveLoad(): number {
    this.generation++;
    if (this.inputLoadTimer !== null) {
      window.clearTimeout(this.inputLoadTimer);
      this.inputLoadTimer = null;
    }
    this.activeController?.abort();
    this.activeController = null;
    return this.generation;
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
    const source = this.activeSource;
    const match = this.activeMatch;
    if (!item || item.kind === 'status' || item.disabled || !source || !match) return;
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
    const duplicateSpace = /\s$/.test(replacement) && /^\s/.test(this.inputEl.value.slice(match.end));
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

  #setSelectedIndex(index: number): void {
    const item = this.items[index];
    if (!item || item.kind === 'status' || item.disabled) return;
    this.selectedIndex = index;
    this.view.updateSelection(index);
  }
}
