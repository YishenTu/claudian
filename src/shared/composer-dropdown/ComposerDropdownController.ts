import { ComposerDropdownView } from './ComposerDropdownView';
import type {
  ComposerDropdownFolderItem,
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerInputElement,
  ComposerTriggerMatch,
} from './types';

interface ActiveFolder {
  readonly item: ComposerDropdownFolderItem;
}

const INPUT_LOAD_DEBOUNCE_MS = 200;

export interface ComposerDropdownControllerOptions {
  readonly fixed?: boolean;
}

export class ComposerDropdownController {
  private readonly sourceUnsubscribers: Array<() => void> = [];
  private readonly view: ComposerDropdownView;
  private activeController: AbortController | null = null;
  private activeFolder: ActiveFolder | null = null;
  private activeMatch: ComposerTriggerMatch | null = null;
  private activeSource: ComposerDropdownSource | null = null;
  private destroyed = false;
  private enabled = true;
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
      onHover: index => this.setSelectedIndex(index),
      onSelect: index => this.selectIndex(index),
    });
    for (const source of sources) {
      const unsubscribe = source.subscribeInvalidation?.(() => {
        if (this.activeSource?.id === source.id) this.rematchInput();
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
    this.invalidateActiveLoad();
    for (const unsubscribe of this.sourceUnsubscribers.splice(0)) unsubscribe();
    this.view.destroy();
  }

  handleInputChange(): void {
    this.rematchAndLoad(true);
  }

  private rematchAndLoad(inputDriven: boolean): void {
    if (!this.enabled || this.destroyed) {
      this.hide();
      return;
    }
    const cursor = this.inputEl.selectionStart ?? 0;
    const folderMatch = this.matchActiveFolder(this.inputEl.value, cursor);
    let sourceMatch: { match: ComposerTriggerMatch; source: ComposerDropdownSource } | undefined;
    if (folderMatch && this.activeSource) {
      sourceMatch = { match: folderMatch, source: this.activeSource };
    } else {
      for (const source of this.sources) {
        const match = source.match(this.inputEl.value, cursor);
        if (match && (!sourceMatch || match.start > sourceMatch.match.start)) {
          sourceMatch = { match, source };
        }
      }
    }
    if (!sourceMatch?.match) {
      this.hide();
      return;
    }

    if (this.activeSource?.id !== sourceMatch.source.id) this.activeFolder = null;
    this.activeSource = sourceMatch.source;
    this.activeMatch = sourceMatch.match;
    this.requestActiveLoad(inputDriven);
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.enabled || !this.view.isVisible() || event.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveSelection(1);
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.moveSelection(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.selectedIndex < 0) return false;
        event.preventDefault();
        this.selectIndex(this.selectedIndex);
        return true;
      case 'Escape':
        event.preventDefault();
        if (this.activeFolder) {
          this.returnToRoot();
        } else {
          this.hide();
        }
        return true;
      default:
        return false;
    }
  }

  hide(): void {
    this.invalidateActiveLoad();
    this.activeFolder = null;
    this.activeMatch = null;
    this.activeSource = null;
    this.items = [];
    this.selectedIndex = -1;
    this.view.hide();
  }

  isVisible(): boolean {
    return this.view.isVisible();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.hide();
  }

  private currentFolderQuery(match: ComposerTriggerMatch): string | null {
    const prefix = this.activeFolder?.item.inputPrefix;
    if (!prefix) return match.query;
    if (!match.query.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return null;
    return match.query.slice(prefix.length);
  }

  private matchActiveFolder(input: string, cursor: number): ComposerTriggerMatch | null {
    const prefix = this.activeFolder?.item.inputPrefix;
    const match = this.activeMatch;
    if (!prefix || !match || cursor < match.start) return null;
    const segment = input.slice(match.start, cursor);
    const expected = `${match.trigger}${prefix}`;
    if (!segment.toLocaleLowerCase().startsWith(expected.toLocaleLowerCase())) return null;
    return {
      ...match,
      end: cursor,
      query: segment.slice(match.trigger.length),
    };
  }

  private rematchInput(): void {
    if (!this.activeSource || !this.activeMatch || this.destroyed) return;
    this.rematchAndLoad(false);
  }

  private requestActiveLoad(inputDriven: boolean): void {
    const source = this.activeSource;
    const match = this.activeMatch;
    if (!source || !match || this.destroyed || !this.enabled) return;

    const folderQuery = this.currentFolderQuery(match);
    if (this.activeFolder && folderQuery === null) {
      this.activeFolder = null;
    }

    const generation = this.invalidateActiveLoad();
    this.items = [{ id: 'loading', kind: 'status', label: 'Loading…', state: 'loading' }];
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
      || !this.enabled
      || generation !== this.generation
    ) return;

    const controller = new AbortController();
    this.activeController = controller;

    try {
      const items = await (this.activeFolder
        ? this.activeFolder.item.load(this.currentFolderQuery(match) ?? '', controller.signal)
        : source.load(match, controller.signal));
      if (this.destroyed || controller.signal.aborted || generation !== this.generation) return;
      this.items = items.length > 0
        ? items
        : [{ id: 'empty', kind: 'status', label: 'No matches', state: 'empty' }];
      this.selectedIndex = this.findSelectable(0, 1, true);
      this.view.render(this.items, this.selectedIndex);
    } catch {
      if (this.destroyed || controller.signal.aborted || generation !== this.generation) return;
      this.items = [{
        id: 'error',
        kind: 'status',
        label: 'Could not load suggestions',
        detail: 'Type again to retry',
        state: 'error',
      }];
      this.selectedIndex = -1;
      this.view.render(this.items, this.selectedIndex);
    }
  }

  private invalidateActiveLoad(): number {
    this.generation++;
    if (this.inputLoadTimer !== null) {
      window.clearTimeout(this.inputLoadTimer);
      this.inputLoadTimer = null;
    }
    this.activeController?.abort();
    this.activeController = null;
    return this.generation;
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    const start = this.selectedIndex < 0 ? (delta > 0 ? 0 : this.items.length - 1) : this.selectedIndex + delta;
    const next = this.findSelectable(start, delta, false);
    if (next >= 0) this.setSelectedIndex(next);
  }

  private findSelectable(start: number, delta: number, clamp: boolean): number {
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

  private returnToRoot(): void {
    const folder = this.activeFolder;
    const match = this.activeMatch;
    this.activeFolder = null;
    if (folder?.item.inputPrefix && match) {
      this.replaceRange(match, match.trigger);
      this.activeMatch = {
        ...match,
        end: match.start + match.trigger.length,
        query: '',
      };
    }
    this.requestActiveLoad(false);
  }

  private selectIndex(index: number): void {
    const item = this.items[index];
    const source = this.activeSource;
    const match = this.activeMatch;
    if (!item || item.kind === 'status' || item.disabled || !source || !match) return;
    if (item.kind === 'folder') {
      this.activeFolder = { item };
      if (item.inputPrefix !== undefined) {
        const replacement = `${match.trigger}${item.inputPrefix}`;
        this.replaceRange(match, replacement);
        this.activeMatch = {
          ...match,
          end: match.start + replacement.length,
          query: item.inputPrefix,
        };
      }
      this.requestActiveLoad(false);
      return;
    }

    const action = source.select(item, match);
    if (action.kind === 'invoke') {
      action.onApplied();
      return;
    }
    if (action.kind === 'replace') {
      this.replaceRange(match, action.text);
      this.hide();
      action.onApplied?.();
      this.inputEl.focus();
    }
  }

  private replaceRange(match: ComposerTriggerMatch, replacement: string): void {
    let after = this.inputEl.value.slice(match.end);
    if (/\s$/.test(replacement) && /^\s/.test(after)) after = after.slice(1);
    const before = this.inputEl.value.slice(0, match.start);
    this.inputEl.value = before + replacement + after;
    const cursor = before.length + replacement.length;
    this.inputEl.selectionStart = cursor;
    this.inputEl.selectionEnd = cursor;
  }

  private setSelectedIndex(index: number): void {
    const item = this.items[index];
    if (!item || item.kind === 'status' || item.disabled) return;
    this.selectedIndex = index;
    this.view.updateSelection(index);
  }
}
