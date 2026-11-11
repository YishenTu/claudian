import { Menu } from 'obsidian';

import { normalizeTabLabel } from '@/core/bootstrap/tabManagerState';
import type { TabId } from '@/features/chat/ChatFeatureHost';
import type { TabBarItem } from '@/features/chat/tabs/ChatTab';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';
import { t } from '@/i18n/i18n';
import { LiveListSorter } from '@/shared/components/LiveListSorter';

const EXPANDED_TITLE_MAX_LENGTH = 32;
const TRUNCATED_TITLE_SUFFIX = '...';
const MIDDLE_MOUSE_BUTTON = 1;
/** How long a held rename editor waits for the click after a pointer release before yielding. */
const HELD_EDITOR_CLICK_GRACE_MS = 100;

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when a tab is closed from its menu or by middle click. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the user renames a tab (a normalized label) or resets its name (null). */
  onTabLabelChange: (tabId: TabId, label: string | null) => void;

  /** Called when the user moves a tab before another tab, or to the end (null). */
  onTabMove: (tabId: TabId, beforeTabId: TabId | null) => void;

  /** Called when persisted badge display state (title expansion) changes. */
  onDisplayStateChanged?: () => void;
}

interface TabLabelEditor {
  tabId: TabId;
  editorEl: HTMLElement;
  inputEl: HTMLInputElement;
  /** Ends the editor's document listeners and pending timer. */
  listeners: AbortController;
  /** A pointer press outside the editor is in progress, so a blur now comes from that press. */
  isPointerPressed: boolean;
  /**
   * The rename is committed, but the editor keeps its slot until the press that blurred it
   * finishes: the narrower badge would shift the pressed target before its click lands.
   */
  isHeld: boolean;
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
  /** Drags a badge along the bar while the others slide aside; idle while a rename editor is open. */
  readonly #sorter = new LiveListSorter({
    axis: 'x',
    canStart: () => !this.labelEditor,
    onDrop: (tabId, targetId, placement) => {
      this.#moveNextTo(tabId, targetId, placement);
      return Promise.resolve();
    },
  });
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
    // A lifted badge and the badges sliding beside it stay put until the drop settles.
    if (this.#sorter.deferRender(() => this.update(items))) return;
    this.#captureStableScrollPosition();
    const activeElement = this.containerEl.ownerDocument.activeElement;
    const focusedTabId = [...this.badgeEls].find(([, badgeEl]) => badgeEl === activeElement)?.[0];
    this.#pruneDisplayState(items);
    this.items = items;

    // An in-progress rename keeps its input node so focus and the typed draft survive refreshes.
    const editor = this.labelEditor;
    if (editor && !items.some(item => item.id === editor.tabId)) {
      this.#closeEditor(editor, false);
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
    for (const staleEl of previousBadgeEls.values()) this.#removeBadge(staleEl);

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
    if (this.labelEditor?.tabId === tabId && !this.labelEditor.isHeld) {
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
        'aria-label': t('chat.tabNavigation.tabName'),
        placeholder: item.title,
        spellcheck: 'false',
      },
    });
    inputEl.value = item.label ?? '';
    badgeEl.replaceWith(editorEl);
    this.#sorter.detach(badgeEl);
    this.badgeEls.delete(tabId);
    const editor: TabLabelEditor = {
      tabId, editorEl, inputEl, listeners: new AbortController(),
      isPointerPressed: false, isHeld: false,
    };
    this.labelEditor = editor;
    this.#trackPointer(editor);

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
    inputEl.addEventListener('blur', () => this.#finishRename(true, false, editor.isPointerPressed));

    inputEl.focus();
    inputEl.select();
    return true;
  }

  /**
   * Cancels a tab drag or an open rename, for the view's Escape chain; returns whether Escape was consumed. The
   * view's keymap can see Escape before the drag does, so the drag is cancelled here rather than the active turn.
   */
  handleEscape(): boolean {
    if (this.#sorter.cancelDrag()) return true;
    if (!this.labelEditor || this.labelEditor.isHeld) return false;
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
    // Re-registering restores the sort class the state class assignment cleared.
    this.#sorter.attach([badgeEl], { id: item.id });
  }

  #removeBadge(badgeEl: HTMLElement): void {
    this.#sorter.detach(badgeEl);
    badgeEl.remove();
  }

  /** Moves a dragged tab beside the tab it was dropped on. */
  #moveNextTo(tabId: TabId, targetId: TabId, placement: 'before' | 'after'): void {
    if (placement === 'before') {
      this.callbacks.onTabMove(tabId, targetId);
      return;
    }
    const remaining = this.items.filter(candidate => candidate.id !== tabId);
    const targetIndex = remaining.findIndex(candidate => candidate.id === targetId);
    if (targetIndex < 0) return;
    this.callbacks.onTabMove(tabId, remaining[targetIndex + 1]?.id ?? null);
  }

  /** Moves a tab one slot toward the start (-1) or the end (1), as the menu's keyboard path. */
  #moveBy(tabId: TabId, offset: -1 | 1): void {
    const index = this.items.findIndex(candidate => candidate.id === tabId);
    if (index < 0) return;
    const beforeIndex = offset < 0 ? index - 1 : index + 2;
    if (beforeIndex < 0 || beforeIndex > this.items.length) return;
    this.callbacks.onTabMove(tabId, this.items[beforeIndex]?.id ?? null);
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
    const status = this.#getBadgeStatusLabel(item);
    badgeEl.setAttribute('aria-label', label === undefined
      ? t('chat.tabNavigation.badge', { title: item.title, status })
      : t('chat.tabNavigation.namedBadge', { label, title: item.title, status }));
  }

  #openBadgeMenu(item: TabBarItem, event: MouseEvent): void {
    const hasLabel = item.label !== undefined;
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem(menuItem => menuItem
      .setTitle(t('chat.tabNavigation.renameTab'))
      .setIcon('pencil')
      .onClick(() => {
        this.beginRename(item.id);
      }));
    if (hasLabel) {
      menu.addItem(menuItem => menuItem
        .setTitle(t('chat.tabNavigation.resetName'))
        .setIcon('rotate-ccw')
        .onClick(() => this.callbacks.onTabLabelChange(item.id, null)));
    }
    const isTitleExpanded = this.expandedTitleTabIds.has(item.id);
    menu.addItem(menuItem => menuItem
      .setTitle(isTitleExpanded ? t('chat.tabNavigation.showNumber') : hasLabel ? t('chat.tabNavigation.showName') : t('chat.tabNavigation.showTitle'))
      .setIcon(isTitleExpanded ? 'hash' : 'type')
      .onClick(() => this.#toggleBadgeTitle(item.id)));
    const index = this.items.findIndex(candidate => candidate.id === item.id);
    if (index > 0) {
      menu.addItem(menuItem => menuItem
        .setTitle(t('chat.tabNavigation.moveLeft'))
        .setIcon('arrow-left')
        .onClick(() => this.#moveBy(item.id, -1)));
    }
    if (index >= 0 && index < this.items.length - 1) {
      menu.addItem(menuItem => menuItem
        .setTitle(t('chat.tabNavigation.moveRight'))
        .setIcon('arrow-right')
        .onClick(() => this.#moveBy(item.id, 1)));
    }
    if (item.canClose) {
      menu.addItem(menuItem => menuItem
        .setTitle(t('chat.tabNavigation.closeTab'))
        .setIcon('x')
        .onClick(() => this.callbacks.onTabClose(item.id)));
    }
    menu.showAtMouseEvent(event);
  }

  /**
   * Ends the rename, committing the input when asked. A rename blurred by a pointer press
   * commits now but holds its slot until that press finishes; keyboard commits swap at once.
   */
  #finishRename(commit: boolean, restoreFocus: boolean, holdSlot = false): void {
    const editor = this.labelEditor;
    if (!editor) return;
    // A held rename already committed; finishing it only returns the badge.
    if (editor.isHeld) {
      this.#closeEditor(editor, restoreFocus);
      return;
    }

    const itemIndex = this.items.findIndex(candidate => candidate.id === editor.tabId);
    const item = this.items[itemIndex];
    const label = commit ? normalizeTabLabel(editor.inputEl.value) : null;
    const changed = commit && !!item && (item.label ?? null) !== label;
    if (changed) {
      // Shown until the owner's next update confirms the tab's label.
      const labelled = { ...item };
      if (label === null) delete labelled.label;
      else labelled.label = label;
      this.items[itemIndex] = labelled;
    }
    // Reveal a newly saved name; double click still returns the badge to its number.
    const revealsLabel = changed && label !== null && !this.expandedTitleTabIds.has(editor.tabId);
    if (revealsLabel) this.expandedTitleTabIds.add(editor.tabId);
    if (holdSlot && item) {
      editor.isHeld = true;
      editor.inputEl.readOnly = true;
    } else {
      this.#closeEditor(editor, restoreFocus);
    }
    if (revealsLabel) this.callbacks.onDisplayStateChanged?.();
    // The tab owns its label; the next update renders it.
    if (changed) this.callbacks.onTabLabelChange(editor.tabId, label);
  }

  /** Removes the editor, returning the tab's current badge to its slot when the tab remains. */
  #closeEditor(editor: TabLabelEditor, restoreFocus: boolean): void {
    if (this.labelEditor === editor) this.labelEditor = null;
    editor.listeners.abort();

    const item = this.#findItem(editor.tabId);
    if (!item) {
      editor.editorEl.remove();
      return;
    }
    const badgeEl = this.#createBadge(item.id);
    this.#applyBadgeState(badgeEl, item);
    this.badgeEls.set(item.id, badgeEl);
    editor.editorEl.replaceWith(badgeEl);
    if (restoreFocus) badgeEl.focus();
  }

  /**
   * Follows pointer presses while the editor exists. A held editor yields once the click that
   * ends its press has reached its target, or shortly after a release that produces no click.
   */
  #trackPointer(editor: TabLabelEditor): void {
    const doc = this.containerEl.ownerDocument;
    const view = doc.defaultView;
    const { signal } = editor.listeners;
    const capture = { capture: true, signal };
    let graceTimer: number | undefined;
    signal.addEventListener('abort', () => view?.clearTimeout(graceTimer));
    const release = (): void => {
      if (editor.isHeld) this.#closeEditor(editor, false);
    };
    const press = (event: Event): void => {
      if (!event.composedPath().includes(editor.editorEl)) editor.isPointerPressed = true;
    };
    const lift = (): void => {
      editor.isPointerPressed = false;
      if (!editor.isHeld || !view) return;
      view.clearTimeout(graceTimer);
      graceTimer = view.setTimeout(release, HELD_EDITOR_CLICK_GRACE_MS);
    };
    // Touch focuses on the compatibility mousedown that follows pointerup, so track both.
    doc.addEventListener('pointerdown', press, capture);
    doc.addEventListener('mousedown', press, capture);
    doc.addEventListener('pointerup', lift, capture);
    doc.addEventListener('mouseup', lift, capture);
    doc.addEventListener('pointercancel', () => {
      editor.isPointerPressed = false;
      release();
    }, capture);
    // Bubbling to the window, the click has already run its target's handlers.
    view?.addEventListener('click', release, { signal });
    view?.addEventListener('blur', release, { signal });
  }

  /** Destroys the tab bar. */
  destroy(): void {
    // Drop an open rename before emptying so its blur cannot publish display state.
    this.labelEditor?.listeners.abort();
    this.labelEditor = null;
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-badges');
    this.containerEl.removeEventListener('scroll', this.handleScroll);
    this.#sorter.dispose();
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
    if (item.isActive) return t('chat.tabNavigation.active');
    if (item.attention?.kind === 'action-required') return t('chat.tabNavigation.needsInput');
    if (item.isWorking) return t('chat.tabNavigation.working');
    if (item.attention?.kind === 'review') {
      return item.attention.outcome === 'error'
        ? t('chat.tabNavigation.errorReview')
        : t('chat.tabNavigation.finishedReview');
    }
    return t('chat.tabNavigation.idle');
  }

  #truncateExpandedTitle(title: string): string {
    const chars = Array.from(title);
    if (chars.length <= EXPANDED_TITLE_MAX_LENGTH) {
      return title;
    }

    return `${chars.slice(0, EXPANDED_TITLE_MAX_LENGTH - TRUNCATED_TITLE_SUFFIX.length).join('')}${TRUNCATED_TITLE_SUFFIX}`;
  }
}
