import { setIcon } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionGroupCollapse } from '@/features/chat/session-manager/SessionGroupCollapse';
import {
  archiveScopeOptions,
  beginInlineRenameNextFrame,
  bindSessionSearchInput,
  createSessionHeaderAction,
  type SessionSurfaceNavigation,
  type SessionSurfaceShared,
} from '@/features/chat/session-manager/SessionSurfaceShared';
import { t } from '@/i18n/i18n';

const VIEW_HEIGHT_SHARE = 0.6;
const OPENABLE_ROW_SELECTOR = '.claudian-history-item-content[role="button"]';
const ACTIVE_ROW_CLASS = 'claudian-history-item--keyboard-active';

/** Unique ids for `aria-controls` and `aria-activedescendant`, across every view's dropdown. */
let nextElementId = 0;

export interface HistoryDropdownDeps {
  plugin: ChatFeatureHost;
  navigation: Pick<SessionSurfaceNavigation, 'getConversationStatus' | 'openConversation' | 'startProjectConversation'>;
  shared: SessionSurfaceShared;
}

/** The drop-up's search; each opening of the menu starts a fresh one. */
interface DropdownSearch {
  query: string;
  /** Filtering shows matches inside expanded groups without changing the saved expansion. */
  readonly collapse: SessionGroupCollapse;
  /** The row Enter opens; while filtering, the first match unless the arrow keys chose another. */
  activeConversationId: string | null;
}

interface SearchBar {
  input: HTMLInputElement;
  clearButton: HTMLElement;
  archiveButton: HTMLElement;
}

function newSearch(): DropdownSearch {
  return {
    query: '',
    collapse: new SessionGroupCollapse({ projectsStartExpanded: true }),
    activeConversationId: null,
  };
}

/**
 * The compact layout's history button and drop-up session menu: a search field over the list, tab-aware open
 * states, open-in-new-tab, close-on-select, archive navigation, and the same projects section as the sidebar.
 */
export class HistoryDropdown {
  private containerEl: HTMLElement | null = null;
  private buttonEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  /** The list renders here, so re-rendering keeps the search field and its focus. */
  private listHostEl: HTMLElement | null = null;
  private searchBar: SearchBar | null = null;
  private search = newSearch();
  /** Composition belongs to the persistent field, so it outlives the search an opening discards. */
  private readonly input = { composing: false };
  private renderAbortController: AbortController | null = null;
  private dirty = true;
  private readonly collapse: SessionGroupCollapse;

  constructor(private readonly deps: HistoryDropdownDeps) {
    this.collapse = new SessionGroupCollapse({ host: deps.plugin });
  }

  /** True while the search composes IME input; Escape belongs to the composition. */
  get isComposing(): boolean {
    return this.input.composing;
  }

  /** Builds the history button and its drop-up menu inside `parentEl`. */
  mount(parentEl: HTMLElement): void {
    const historyContainer = parentEl.createDiv({
      cls: 'claudian-history-container claudian-nav-dropup-container',
    });
    this.containerEl = historyContainer;
    const historyBtn = historyContainer.createEl('button', {
      cls: 'claudian-input-nav-btn',
      attr: { type: 'button' },
    });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');
    this.buttonEl = historyBtn;

    this.menuEl = historyContainer.createDiv({
      cls: 'claudian-history-menu claudian-nav-dropup-menu',
    });
    this.searchBar = this.buildSearchBar(this.menuEl);
    this.listHostEl = this.menuEl.createDiv({
      cls: 'claudian-history-menu-list',
      attr: { id: `claudian-history-list-${nextElementId++}` },
    });
    this.searchBar.input.setAttribute('aria-controls', this.listHostEl.id);

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Renders a stale list only while the menu is open; a hidden menu renders when opened. */
  renderIfVisible(): void {
    if (this.menuEl?.hasClass('visible')) this.render();
  }

  toggle(): void {
    if (!this.menuEl) return;

    if (this.menuEl.hasClass('visible')) {
      this.close();
    } else {
      this.discardSearch();
      this.fitToView(this.menuEl);
      this.menuEl.addClass('visible');
      this.render();
      // A list kept from an outside-click hide skips the render, so clear its keyboard choice here.
      this.presentActiveRow();
      this.searchBar?.input.focus();
    }
  }

  /** Clears a query, else closes the open menu; returns whether Escape was consumed. */
  handleEscape(): boolean {
    if (!this.menuEl?.hasClass('visible')) return false;
    if (this.search.query) {
      this.setQuery('');
      this.searchBar?.input.focus();
      return true;
    }
    this.close();
    this.buttonEl?.focus();
    return true;
  }

  /** Ends the search without rendering, for an opening or a switch to another list. */
  discardSearch(): void {
    if (this.search.query) this.dirty = true;
    this.search = newSearch();
    if (this.searchBar) this.searchBar.input.value = '';
  }

  /** Caps the drop-up at 60% of the chat view's height, measured as it opens. */
  private fitToView(menuEl: HTMLElement): void {
    const viewEl = menuEl.closest<HTMLElement>('.claudian-container');
    const height = viewEl?.clientHeight ?? 0;
    // An unmeasured view keeps the stylesheet's fallback cap.
    menuEl.setCssProps({
      '--claudian-history-menu-max-height': height > 0 ? `${Math.round(height * VIEW_HEIGHT_SHARE)}px` : '',
    });
  }

  /** Hides the menu and abandons its in-flight render. */
  close(): void {
    this.menuEl?.removeClass('visible');
    this.cancelRendering();
  }

  /**
   * Hides the menu for a click outside it, keeping its rendered list. The click's dispatch path decides, since a
   * toggle inside the menu may already be detached by the rerender it caused.
   */
  dismissFor(event: Event): void {
    if (this.containerEl && event.composedPath().includes(this.containerEl)) return;
    this.menuEl?.removeClass('visible');
  }

  dispose(): void {
    this.cancelRendering();
  }

  private buildSearchBar(menuEl: HTMLElement): SearchBar {
    const bar = menuEl.createDiv({ cls: 'claudian-history-search-bar' });
    const field = bar.createDiv({ cls: 'claudian-session-search-field' });
    const input = field.createEl('input', {
      cls: 'claudian-session-search-input',
      attr: {
        type: 'search',
        role: 'combobox',
        autocomplete: 'off',
        'aria-autocomplete': 'list',
        'aria-expanded': 'true',
      },
    });
    bindSessionSearchInput(input, this.input, query => this.setQuery(query));
    input.addEventListener('keydown', event => this.handleSearchKeydown(event));

    const clearButton = createSessionHeaderAction(bar, 'x', t('chat.sessions.clearSearch'), () => {
      this.setQuery('');
      input.focus();
    });
    clearButton.addClass('claudian-history-search-clear');
    clearButton.hidden = true;
    const archiveButton = createSessionHeaderAction(bar, 'archive', t('chat.sessions.showArchive'), () => {
      const { shared } = this.deps;
      shared.setArchiveView(!shared.isArchiveView());
    });
    return { input, clearButton, archiveButton };
  }

  /** Shows the search bar for the current query and archive view. */
  private syncSearchBar(): void {
    const bar = this.searchBar;
    if (!bar) return;
    const isArchiveView = this.deps.shared.isArchiveView();
    const placeholder = t(isArchiveView ? 'chat.sessions.searchArchived' : 'chat.sessions.search');
    bar.input.setAttribute('placeholder', placeholder);
    bar.input.setAttribute('aria-label', placeholder);
    bar.clearButton.hidden = !this.search.query;
    bar.archiveButton.setAttribute('aria-label', t(isArchiveView ? 'chat.sessions.showSessions' : 'chat.sessions.showArchive'));
    const icon = bar.archiveButton.querySelector<HTMLElement>('.claudian-session-header-icon');
    if (icon) setIcon(icon, isArchiveView ? 'arrow-left' : 'archive');
  }

  private setQuery(query: string): void {
    if (this.searchBar && this.searchBar.input.value !== query) this.searchBar.input.value = query;
    if (query === this.search.query) return;
    this.search.query = query;
    this.search.activeConversationId = null;
    this.dirty = true;
    this.render();
    const list = this.listHostEl?.querySelector<HTMLElement>('.claudian-history-list');
    if (list) list.scrollTop = 0;
  }

  private isFiltering(): boolean {
    return this.search.query.trim().length > 0;
  }

  private handleSearchKeydown(event: KeyboardEvent): void {
    if (event.isComposing || this.input.composing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveActiveRow(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      // A section collapsed since the last move may have hidden the active row.
      const row = this.presentActiveRow();
      if (!row) return;
      event.preventDefault();
      // The row's own handler opens it, so the browser keeps owning selection.
      row.click();
    }
  }

  /** Openable rows the reader can see; collapsed sections keep theirs mounted but hidden. */
  private openableRows(): HTMLElement[] {
    return Array.from(this.listHostEl?.querySelectorAll<HTMLElement>(OPENABLE_ROW_SELECTOR) ?? [])
      .filter(row => !row.closest('[hidden]'));
  }

  private rowConversationId(row: HTMLElement): string | null {
    return row.closest<HTMLElement>('.claudian-history-item')?.getAttribute('data-conversation-id') ?? null;
  }

  private findActiveRow(): HTMLElement | null {
    const activeId = this.search.activeConversationId;
    if (activeId === null) return null;
    return this.openableRows().find(row => this.rowConversationId(row) === activeId) ?? null;
  }

  private moveActiveRow(step: 1 | -1): void {
    const rows = this.openableRows();
    if (rows.length === 0) return;
    const current = this.findActiveRow();
    const index = current ? rows.indexOf(current) + step : 0;
    const next = rows[Math.max(0, Math.min(rows.length - 1, index))];
    this.search.activeConversationId = this.rowConversationId(next);
    this.presentActiveRow()?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Marks the active row after a render or a move and returns it; while filtering, a vanished choice falls back to
   * the first match. Only a move scrolls, so re-renders keep the reader's scroll position.
   */
  private presentActiveRow(): HTMLElement | null {
    const input = this.searchBar?.input;
    if (!input) return null;
    for (const item of Array.from(this.listHostEl?.querySelectorAll<HTMLElement>(`.${ACTIVE_ROW_CLASS}`) ?? [])) {
      item.removeClass(ACTIVE_ROW_CLASS);
    }
    let row = this.findActiveRow();
    if (!row && this.isFiltering()) row = this.openableRows()[0] ?? null;
    this.search.activeConversationId = row ? this.rowConversationId(row) : null;
    if (!row) {
      input.removeAttribute('aria-activedescendant');
      return null;
    }
    if (!row.id) row.id = `claudian-history-row-${nextElementId++}`;
    row.closest<HTMLElement>('.claudian-history-item')?.addClass(ACTIVE_ROW_CLASS);
    input.setAttribute('aria-activedescendant', row.id);
    return row;
  }

  private render(): void {
    const listHostEl = this.listHostEl;
    if (!listHostEl || !this.dirty) return;

    this.cancelRendering();
    const abortController = new AbortController();
    this.renderAbortController = abortController;

    this.deps.shared.profileListRender(() => {
      this.renderList(listHostEl, abortController.signal);
      this.syncSearchBar();
      this.presentActiveRow();
      this.dirty = false;
    });
  }

  private renderList(container: HTMLElement, signal: AbortSignal): void {
    const { navigation, plugin, shared } = this.deps;
    const isArchiveView = shared.isArchiveView();
    const collapse = this.isFiltering() ? this.search.collapse : this.collapse;
    shared.browser.renderHistoryDropdown(container, {
      onSelectConversation: (id) => this.openConversation(id),
      // Archived sessions cannot be opened, so only active rows offer a new tab.
      ...(isArchiveView
        ? {}
        : {
            onOpenConversationInNewTab: (id: string, activate = true) =>
              this.openConversation(id, { preferNewTab: true, activate }),
          }),
      getConversationStatus: (id) => navigation.getConversationStatus(id),
      onRerender: () => shared.invalidate(),
      showOpenStateLabels: true,
      showOpenStateActions: !isArchiveView,
      preserveListState: true,
      showInlinePinAction: false,
      onRequestInlineRename: (request) => beginInlineRenameNextFrame(container, request, {
        isCurrent: () => !signal.aborted && this.listHostEl === container,
        // Rename can start from a context menu after an outside click hid the menu.
        reveal: () => this.menuEl?.addClass('visible'),
      }),
      ...archiveScopeOptions(isArchiveView),
      searchQuery: this.search.query,
      onAssignConversationToDevice: async (id: string) => {
        await plugin.assignConversationToCurrentDevice(id);
      },
      isGroupCollapsed: groupKey => collapse.isCollapsed(groupKey),
      onGroupCollapseChange: (groupKey, collapsed) => collapse.setCollapsed(groupKey, collapsed),
      onStartProjectConversation: async (projectId: string) => {
        shared.setArchiveView(false);
        await navigation.startProjectConversation(projectId);
        this.close();
      },
      signal,
    });
  }

  private async openConversation(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void> {
    await this.deps.navigation.openConversation(conversationId, options);
    this.close();
  }

  private cancelRendering(): void {
    this.renderAbortController?.abort();
    this.renderAbortController = null;
    this.dirty = true;
  }
}
