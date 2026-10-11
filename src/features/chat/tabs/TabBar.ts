import { Menu } from 'obsidian';

import { normalizeTabLabel } from '@/core/bootstrap/tabManagerState';
import type { TabBarItem, TabId } from '@/features/chat/tabs/ChatTab';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';

const EXPANDED_TITLE_MAX_LENGTH = 32;
const TRUNCATED_TITLE_SUFFIX = '...';
const MIDDLE_MOUSE_BUTTON = 1;

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when a tab is closed from its menu or by middle click. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the user renames a tab (a normalized label) or resets its name (null). */
  onTabLabelChange: (tabId: TabId, label: string | null) => void;

  /** Called when persisted badge display state (title expansion) changes. */
  onDisplayStateChanged?: () => void;
}

interface TabLabelEditor {
  tabId: TabId;
  editorEl: HTMLElement;
  inputEl: HTMLInputElement;
}

/**
 * TabBar renders minimal numbered badge navigation and edits custom labels, which the tab
 * owns. It owns one piece of per-tab display state: whether a badge shows its title.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;
  private expandedTitleTabIds = new Set<TabId>();
  private items: TabBarItem[] = [];
  private badgeEls = new Map<TabId, HTMLElement>();
  private labelEditor: TabLabelEditor | null = null;
  private lastKnownScrollLeft = 0;
  private readonly handleScroll = (): void => {
    this.captureScrollPosition();
  };

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('claudian-tab-badges');
    this.containerEl.addEventListener('scroll', this.handleScroll);
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    this.#captureStableScrollPosition();
    const activeElement = this.containerEl.ownerDocument.activeElement;
    const focusedTabId = [...this.badgeEls].find(([, badgeEl]) => badgeEl === activeElement)?.[0];
    this.#pruneDisplayState(items);
    this.items = items;

    // An in-progress rename keeps its input node so focus and the typed draft survive refreshes.
    const editor = this.labelEditor;
    if (editor && !items.some(item => item.id === editor.tabId)) {
      this.labelEditor = null;
      editor.editorEl.remove();
    }
    const editorEl = this.labelEditor?.editorEl ?? null;

    // Badges are reconciled by tab id so a node under the pointer survives a refresh; a click
    // whose mousedown triggered the refresh (by committing a rename) still lands on it.
    const previousBadgeEls = this.badgeEls;
    this.badgeEls = new Map();
    const orderedEls: HTMLElement[] = [];
    for (const item of items) {
      if (editorEl && item.id === this.labelEditor?.tabId) {
        orderedEls.push(editorEl);
        continue;
      }
      const badgeEl = previousBadgeEls.get(item.id) ?? this.#createBadge(item.id);
      previousBadgeEls.delete(item.id);
      this.#applyBadgeState(badgeEl, item);
      this.badgeEls.set(item.id, badgeEl);
      orderedEls.push(badgeEl);
    }
    for (const staleEl of previousBadgeEls.values()) staleEl.remove();

    // Only out-of-place nodes move, so stable badges and the rename input stay attached.
    let nextEl = this.containerEl.firstElementChild;
    for (const el of orderedEls) {
      if (el === nextEl) {
        nextEl = nextEl.nextElementSibling;
      } else {
        this.containerEl.insertBefore(el, nextEl);
      }
    }
    while (nextEl) {
      const staleEl = nextEl;
      nextEl = nextEl.nextElementSibling;
      staleEl.remove();
    }

    // Re-rendering keeps keyboard focus on the badge that held it, even if it moved.
    const focusedBadgeEl = focusedTabId ? this.badgeEls.get(focusedTabId) : undefined;
    if (focusedBadgeEl && focusedBadgeEl !== this.containerEl.ownerDocument.activeElement) {
      focusedBadgeEl.focus();
    }
    this.restoreScrollPosition();
  }

  getExpandedTitleTabIds(): TabId[] {
    return Array.from(this.expandedTitleTabIds);
  }

  setExpandedTitleTabIds(tabIds: readonly TabId[]): void {
    this.expandedTitleTabIds = new Set(tabIds);
  }

  /** Replaces the tab's badge with an inline name input. Returns false for an unknown tab. */
  beginRename(tabId: TabId): boolean {
    const item = this.items.find(candidate => candidate.id === tabId);
    if (!item) return false;
    if (this.labelEditor?.tabId === tabId) {
      this.labelEditor.inputEl.focus();
      return true;
    }
    this.#finishRename(true, false);

    const badgeEl = this.badgeEls.get(tabId);
    if (!badgeEl) return false;

    const editorEl = this.containerEl.createDiv({ cls: 'claudian-tab-label-editor' });
    const inputEl = editorEl.createEl('input', {
      cls: 'claudian-tab-label-input',
      attr: {
        type: 'text',
        'aria-label': 'Tab name',
        placeholder: item.title,
        spellcheck: 'false',
      },
    });
    inputEl.value = item.label ?? '';
    badgeEl.replaceWith(editorEl);
    this.badgeEls.delete(tabId);
    this.labelEditor = { tabId, editorEl, inputEl };

    inputEl.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#finishRename(true, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.#finishRename(false, true);
      }
    });
    inputEl.addEventListener('blur', () => this.#finishRename(true, false));

    inputEl.focus();
    inputEl.select();
    return true;
  }

  /** Cancels an open rename, for the view's Escape chain; returns whether Escape was consumed. */
  handleEscape(): boolean {
    if (!this.labelEditor) return false;
    this.#finishRename(false, true);
    return true;
  }

  /** Creates a badge for a tab; listeners read the tab's current item, so updates reuse it. */
  #createBadge(tabId: TabId): HTMLElement {
    // Callers move the badge into place.
    const badgeEl = this.containerEl.createEl('button', { attr: { type: 'button' } });

    badgeEl.addEventListener('click', () => {
      this.captureScrollPosition();
      this.callbacks.onTabClick(tabId);
    });

    badgeEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#toggleBadgeTitle(tabId);
    });

    badgeEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const item = this.#findItem(tabId);
      if (item) this.#openBadgeMenu(item, e);
    });

    // Suppress middle-button autoscroll so the click can close the tab instead.
    badgeEl.addEventListener('mousedown', (e) => {
      if (e.button === MIDDLE_MOUSE_BUTTON && this.#findItem(tabId)?.canClose) e.preventDefault();
    });
    badgeEl.addEventListener('auxclick', (e) => {
      if (e.button !== MIDDLE_MOUSE_BUTTON || !this.#findItem(tabId)?.canClose) return;
      e.preventDefault();
      this.callbacks.onTabClose(tabId);
    });

    return badgeEl;
  }

  #findItem(tabId: TabId): TabBarItem | undefined {
    return this.items.find(candidate => candidate.id === tabId);
  }

  /** Applies a tab's state and display to its badge. */
  #applyBadgeState(badgeEl: HTMLElement, item: TabBarItem): void {
    // Determine state class (priority: active > action required > working > review > idle)
    let stateClass = 'claudian-tab-badge-idle';
    if (item.isActive) {
      stateClass = 'claudian-tab-badge-active';
    } else if (item.attention?.kind === 'action-required') {
      stateClass = 'claudian-tab-badge-action-required';
    } else if (item.isWorking) {
      stateClass = 'claudian-tab-badge-streaming';
    } else if (item.attention?.kind === 'review') {
      stateClass = item.attention.outcome === 'error'
        ? 'claudian-tab-badge-review-error'
        : 'claudian-tab-badge-review';
    }

    badgeEl.className = `claudian-tab-badge ${stateClass}`;
    this.#applyBadgeDisplay(badgeEl, item);
  }

  #applyBadgeDisplay(badgeEl: HTMLElement, item: TabBarItem): void {
    // Expanded badges show the custom label when set, otherwise the conversation title.
    const label = item.label;
    const isTitleExpanded = this.expandedTitleTabIds.has(item.id);
    badgeEl.textContent = isTitleExpanded
      ? label ?? this.#truncateExpandedTitle(item.title)
      : String(item.index);
    badgeEl.toggleClass('claudian-tab-badge-expanded', isTitleExpanded);
    badgeEl.setAttribute('data-title-expanded', isTitleExpanded ? 'true' : 'false');
    // Obsidian uses aria-label for hover tooltips here; adding title causes duplicate tooltip text.
    const name = label === undefined ? item.title : `${label} (${item.title})`;
    badgeEl.setAttribute('aria-label', `${name}, ${this.#getBadgeStatusLabel(item)}`);
  }

  #openBadgeMenu(item: TabBarItem, event: MouseEvent): void {
    const hasLabel = item.label !== undefined;
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem(menuItem => menuItem
      .setTitle('Rename tab…')
      .setIcon('pencil')
      .onClick(() => {
        this.beginRename(item.id);
      }));
    if (hasLabel) {
      menu.addItem(menuItem => menuItem
        .setTitle('Reset tab name')
        .setIcon('rotate-ccw')
        .onClick(() => this.callbacks.onTabLabelChange(item.id, null)));
    }
    const isTitleExpanded = this.expandedTitleTabIds.has(item.id);
    menu.addItem(menuItem => menuItem
      .setTitle(isTitleExpanded ? 'Show number' : hasLabel ? 'Show name' : 'Show title')
      .setIcon(isTitleExpanded ? 'hash' : 'type')
      .onClick(() => this.#toggleBadgeTitle(item.id)));
    if (item.canClose) {
      menu.addItem(menuItem => menuItem
        .setTitle('Close tab')
        .setIcon('x')
        .onClick(() => this.callbacks.onTabClose(item.id)));
    }
    menu.showAtMouseEvent(event);
  }

  #finishRename(commit: boolean, restoreFocus: boolean): void {
    const editor = this.labelEditor;
    if (!editor) return;
    this.labelEditor = null;

    const itemIndex = this.items.findIndex(candidate => candidate.id === editor.tabId);
    let item = this.items[itemIndex];
    const label = commit ? normalizeTabLabel(editor.inputEl.value) : null;
    const changed = commit && !!item && (item.label ?? null) !== label;
    if (changed) {
      // Shown until the owner's next update confirms the tab's label.
      item = { ...item };
      if (label === null) delete item.label;
      else item.label = label;
      this.items[itemIndex] = item;
    }
    // Reveal a newly saved name; double click still returns the badge to its number.
    const revealsLabel = changed && label !== null && !this.expandedTitleTabIds.has(editor.tabId);
    if (revealsLabel) this.expandedTitleTabIds.add(editor.tabId);
    if (item) {
      const badgeEl = this.#createBadge(item.id);
      this.#applyBadgeState(badgeEl, item);
      this.badgeEls.set(item.id, badgeEl);
      editor.editorEl.replaceWith(badgeEl);
      if (restoreFocus) badgeEl.focus();
    } else {
      editor.editorEl.remove();
    }
    if (revealsLabel) this.callbacks.onDisplayStateChanged?.();
    // The tab owns its label; the next update renders it.
    if (changed) this.callbacks.onTabLabelChange(editor.tabId, label);
  }

  /** Destroys the tab bar. */
  destroy(): void {
    // Drop an open rename before emptying so its blur cannot publish display state.
    this.labelEditor = null;
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-badges');
    this.containerEl.removeEventListener('scroll', this.handleScroll);
    this.expandedTitleTabIds.clear();
    this.badgeEls.clear();
    this.items = [];
    this.lastKnownScrollLeft = 0;
  }

  captureScrollPosition(): void {
    this.lastKnownScrollLeft = this.containerEl.scrollLeft;
  }

  restoreScrollPosition(): void {
    const scrollLeft = this.lastKnownScrollLeft;
    this.containerEl.scrollLeft = scrollLeft;
    if (scrollLeft <= 0) return;

    scheduleAnimationFrame(() => {
      if (this.containerEl.scrollLeft !== 0) return;
      this.containerEl.scrollLeft = scrollLeft;
    }, this.containerEl.ownerDocument.defaultView ?? null);
  }

  #captureStableScrollPosition(): void {
    const currentScrollLeft = this.containerEl.scrollLeft;
    if (currentScrollLeft > 0 || this.lastKnownScrollLeft === 0) {
      this.lastKnownScrollLeft = currentScrollLeft;
    }
  }

  #pruneDisplayState(items: TabBarItem[]): void {
    const visibleTabIds = new Set(items.map(item => item.id));
    for (const tabId of this.expandedTitleTabIds) {
      if (!visibleTabIds.has(tabId)) {
        this.expandedTitleTabIds.delete(tabId);
      }
    }
  }

  #toggleBadgeTitle(tabId: TabId): void {
    if (this.expandedTitleTabIds.has(tabId)) {
      this.expandedTitleTabIds.delete(tabId);
    } else {
      this.expandedTitleTabIds.add(tabId);
    }

    this.#refreshBadge(tabId);
    this.callbacks.onDisplayStateChanged?.();
  }

  /** Re-applies display state to the tab's current badge; menus may outlive the badge they opened on. */
  #refreshBadge(tabId: TabId): void {
    const item = this.#findItem(tabId);
    const badgeEl = this.badgeEls.get(tabId);
    if (item && badgeEl) this.#applyBadgeDisplay(badgeEl, item);
  }

  #getBadgeStatusLabel(item: TabBarItem): string {
    if (item.isActive) return 'active';
    if (item.attention?.kind === 'action-required') return 'needs your input';
    if (item.isWorking) return 'working';
    if (item.attention?.kind === 'review') {
      return item.attention.outcome === 'error'
        ? 'stopped with an error, ready to review'
        : 'finished, ready to review';
    }
    return 'idle';
  }

  #truncateExpandedTitle(title: string): string {
    const chars = Array.from(title);
    if (chars.length <= EXPANDED_TITLE_MAX_LENGTH) {
      return title;
    }

    return `${chars.slice(0, EXPANDED_TITLE_MAX_LENGTH - TRUNCATED_TITLE_SUFFIX.length).join('')}${TRUNCATED_TITLE_SUFFIX}`;
  }
}
