import { Menu, Notice, setIcon, TFile } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getObsidianLanguage } from '@/features/chat/session-manager/ProvisionalNoteNames';
import { renderSessionGroupToggleIcon } from '@/features/chat/session-manager/SessionManagerIcons';
import {
  archiveScopeOptions,
  beginInlineRenameNextFrame,
  type SessionSurfaceNavigation,
  type SessionSurfaceShared,
  setControlAvailability,
} from '@/features/chat/session-manager/SessionSurfaceShared';

type SessionSearchScrollState = {
  pinnedScrollTop: number;
  sessionScrollTop: number;
};

export interface SessionSidebarDeps {
  plugin: ChatFeatureHost;
  navigation: Omit<SessionSurfaceNavigation, 'openConversation'>;
  shared: SessionSurfaceShared;
  isWide(): boolean;
  /** Whether another tab fits; null while the view has no tabs. */
  canCreateTab(): boolean | null;
  requestNew(): void;
  /** Session presentation settings changed; other views must re-render their lists. */
  notifyOtherViews(): void;
}

/**
 * The wide layout's persistent session column: New/Search/Archive navigation,
 * IME-aware search with outside dismissal, organization, sorting and group
 * collapse, pinned Linked content, inline pins, and the metadata popover.
 */
export class SessionSidebar {
  private sidebarEl: HTMLElement | null = null;
  private surfaceEl: HTMLElement | null = null;
  private newButtonEl: HTMLElement | null = null;
  private searchFieldEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private groupToggleButtonEl: HTMLElement | null = null;

  private renderAbortController: AbortController | null = null;
  private dirty = true;

  private isSearchActive = false;
  private isSearchComposing = false;
  private searchQuery = '';
  private searchRestoreState: SessionSearchScrollState | null = null;
  private searchDismissCleanup: (() => void) | null = null;
  private searchCollapsedGroupKeys = new Set<string>();
  private readonly collapsedGroupKeys = new Set<string>();
  private groupKeys = new Set<string>();

  constructor(private readonly deps: SessionSidebarDeps) {}

  /** True while search is composing IME input; Escape belongs to the composition. */
  get isComposing(): boolean {
    return this.isSearchComposing;
  }

  /** Builds the sidebar surface inside `sidebarEl`. */
  mount(sidebarEl: HTMLElement): void {
    this.sidebarEl = sidebarEl;
    const trackEl = sidebarEl.createDiv({ cls: 'claudian-sidebar-surface-track' });
    this.surfaceEl = trackEl.createDiv({ cls: 'claudian-session-surface' });
  }

  markDirty(): void {
    this.dirty = true;
  }

  render(): void {
    const surfaceEl = this.surfaceEl ?? this.sidebarEl;
    if (!surfaceEl || !this.dirty || !this.deps.isWide()) return;
    if (this.isSearchComposing) return;

    const previousSearchInput = this.searchInputEl;
    const shouldRestoreSearchFocus = previousSearchInput?.ownerDocument.activeElement
      === previousSearchInput;

    this.cancelRendering();
    const abortController = new AbortController();
    this.renderAbortController = abortController;

    this.deps.shared.profileListRender(() => {
      this.newButtonEl = null;
      this.searchFieldEl = null;
      this.searchInputEl = null;
      this.groupToggleButtonEl = null;
      this.renderList(surfaceEl, abortController.signal);
      this.buildHeaderActions(surfaceEl);
      if (shouldRestoreSearchFocus) {
        this.focusSearchInput();
      }
      this.dirty = false;
    });
  }

  /** Leaving the wide layout ends search and rendering. */
  leave(): void {
    this.closeSearch();
    this.cancelRendering();
  }

  /** Closes an active search for Escape; returns whether there was one. */
  dismissSearch(): boolean {
    if (!this.isSearchActive) return false;
    this.closeSearch();
    return true;
  }

  /** Drops search without rendering or restoring scroll, for a switch to another list. */
  discardSearch(): void {
    this.clearSearchDismissHandlers();
    this.isSearchActive = false;
    this.isSearchComposing = false;
    this.searchQuery = '';
    this.searchFieldEl = null;
    this.searchInputEl = null;
    this.searchRestoreState = null;
    this.searchCollapsedGroupKeys = new Set<string>();
  }

  refreshNewAvailability(): void {
    const canCreateTab = this.deps.canCreateTab();
    if (canCreateTab === null) return;
    setControlAvailability(this.newButtonEl, canCreateTab);
  }

  dispose(): void {
    this.clearSearchDismissHandlers();
    this.cancelRendering();
  }

  private renderList(container: HTMLElement, signal: AbortSignal): void {
    const { navigation, plugin, shared } = this.deps;
    const isArchiveView = shared.isArchiveView();
    const organization = this.getOrganization();
    shared.browser.renderHistoryDropdown(container, {
      onSelectConversation: (id) => navigation.openSessionConversation(id),
      getConversationStatus: (id) => navigation.getConversationStatus(id),
      onRerender: () => shared.invalidate(),
      showOpenStateLabels: false,
      showOpenStateActions: false,
      preserveListState: true,
      showInlinePinAction: true,
      onRequestInlineRename: (request) => {
        if (this.isSearchActive) {
          this.closeSearch();
        }
        beginInlineRenameNextFrame(container, request);
      },
      ...archiveScopeOptions(isArchiveView),
      onAssignConversationToDevice: async (id: string) => {
        await plugin.assignConversationToCurrentDevice(id);
      },
      organization,
      groupByRecency: organization === 'list',
      sort: this.getSort(),
      language: getObsidianLanguage(plugin.settings.locale),
      contentExists: (contentPath: string) => navigation.contentExists(contentPath),
      contentIsNote: (contentPath: string) => this.contentIsNote(contentPath),
      searchQuery: this.isSearchActive ? this.searchQuery : undefined,
      showMetadataPopover: true,
      showAttentionState: !isArchiveView,
      showPinnedSection: !isArchiveView,
      pinnedLinkedContentPaths: new Set(plugin.settings.pinnedLinkedContentPaths ?? []),
      showArchivedSection: isArchiveView,
      collapsedGroupKeys: this.getDisplayedCollapsedGroupKeys(),
      onGroupCollapseChange: (groupKey: string, collapsed: boolean) => {
        const collapsedGroupKeys = this.getDisplayedCollapsedGroupKeys();
        if (collapsed) {
          collapsedGroupKeys.add(groupKey);
        } else {
          collapsedGroupKeys.delete(groupKey);
        }
        this.updateGroupToggleButton();
      },
      onGroupKeysChange: (groupKeys: readonly string[]) => {
        this.groupKeys = new Set(groupKeys);
      },
      onSetLinkedContentPinned: (contentPath: string, isPinned: boolean) => (
        plugin.setLinkedContentPinned(contentPath, isPinned)
      ),
      onStartLinkedContentConversation: (contentPath: string) => {
        shared.setArchiveView(false);
        return navigation.startLinkedContentConversation(contentPath);
      },
      getProviderIcon: (conversation: ConversationMeta) => {
        try {
          return ProviderRegistry
            .getChatUIConfig(conversation.providerId)
            .getProviderIcon?.();
        } catch {
          return undefined;
        }
      },
      getModelLabel: (conversation: ConversationMeta) => this.getModelLabel(conversation),
      signal,
    });
  }

  private buildHeaderActions(container: HTMLElement): void {
    const header = container.querySelector<HTMLElement>('.claudian-session-list-header');
    const list = container.querySelector<HTMLElement>('.claudian-history-list');
    if (!header || !list) return;

    const { shared } = this.deps;
    const isArchiveView = shared.isArchiveView();
    const newControl = container.createDiv({ cls: 'claudian-session-new-control' });
    newControl.setAttribute('role', 'button');
    newControl.setAttribute('tabindex', '0');
    const newIcon = newControl.createSpan({ cls: 'claudian-session-new-icon' });
    setIcon(newIcon, 'square-pen');
    newControl.createSpan({ cls: 'claudian-session-new-label', text: 'New' });
    const requestNew = (): void => {
      shared.setArchiveView(false);
      this.deps.requestNew();
    };
    newControl.addEventListener('click', requestNew);
    newControl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      requestNew();
    });
    container.insertBefore(newControl, list);
    this.newButtonEl = newControl;

    if (this.isSearchActive) {
      this.buildSearchField(container, list);
    } else {
      const searchControl = container.createDiv({ cls: 'claudian-session-search-control' });
      searchControl.setAttribute('role', 'button');
      searchControl.setAttribute('tabindex', '0');
      const searchIcon = searchControl.createSpan({ cls: 'claudian-session-nav-icon' });
      setIcon(searchIcon, 'search');
      searchControl.createSpan({ cls: 'claudian-session-nav-label', text: 'Search' });
      const activateSearch = (): void => this.activateSearch();
      searchControl.addEventListener('click', activateSearch);
      searchControl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateSearch();
      });
      container.insertBefore(searchControl, list);
    }

    const archiveControl = container.createDiv({ cls: 'claudian-session-archive-control' });
    archiveControl.setAttribute('role', 'button');
    archiveControl.setAttribute('tabindex', '0');
    const archiveIcon = archiveControl.createSpan({ cls: 'claudian-session-nav-icon' });
    setIcon(archiveIcon, isArchiveView ? 'arrow-left' : 'archive');
    archiveControl.createSpan({
      cls: 'claudian-session-nav-label',
      text: isArchiveView ? 'Sessions' : 'Archive',
    });
    const toggleArchiveView = (): void => shared.setArchiveView(!shared.isArchiveView());
    archiveControl.addEventListener('click', toggleArchiveView);
    archiveControl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleArchiveView();
    });
    container.insertBefore(archiveControl, list);

    this.groupToggleButtonEl = null;
    const actions = header.createDiv({ cls: 'claudian-session-header-actions' });
    if (this.getOrganization() === 'linked-content' && this.groupKeys.size > 0) {
      const allCollapsed = this.areAllGroupsCollapsed();
      this.groupToggleButtonEl = this.createHeaderAction(
        actions,
        icon => renderSessionGroupToggleIcon(icon, allCollapsed ? 'expand' : 'collapse'),
        allCollapsed ? 'Expand all groups' : 'Collapse all groups',
        () => this.toggleAllGroups(),
      );
    }
    const optionsButton = this.createHeaderAction(
      actions,
      'ellipsis',
      'Session options',
      (event) => this.showOptionsMenu(optionsButton, event),
    );

    this.refreshNewAvailability();
  }

  private buildSearchField(container: HTMLElement, list: HTMLElement): void {
    const searchField = container.createDiv({ cls: 'claudian-session-search-field' });
    const searchIcon = searchField.createSpan({ cls: 'claudian-session-nav-icon' });
    setIcon(searchIcon, 'search');
    const label = this.deps.shared.isArchiveView() ? 'Search archived sessions' : 'Search sessions';
    const searchInput = searchField.createEl('input', {
      cls: 'claudian-session-search-input',
      attr: {
        type: 'search',
        autocomplete: 'off',
        placeholder: label,
        'aria-label': label,
      },
    });
    searchInput.value = this.searchQuery;
    let committedCompositionValue: string | null = null;
    searchInput.addEventListener('compositionstart', () => {
      this.isSearchComposing = true;
      committedCompositionValue = null;
    });
    searchInput.addEventListener('compositionend', () => {
      this.isSearchComposing = false;
      committedCompositionValue = searchInput.value;
      this.updateSearchQuery(searchInput.value);
      queueMicrotask(() => {
        committedCompositionValue = null;
      });
    });
    searchInput.addEventListener('input', (event) => {
      if (
        this.isSearchComposing
        || (event as InputEvent | undefined)?.isComposing
      ) return;
      if (committedCompositionValue === searchInput.value) {
        committedCompositionValue = null;
        return;
      }
      committedCompositionValue = null;
      this.updateSearchQuery(searchInput.value);
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.isSearchComposing || event.isComposing) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      this.closeSearch();
    });
    container.insertBefore(searchField, list);
    this.searchFieldEl = searchField;
    this.searchInputEl = searchInput;
  }

  private activateSearch(): void {
    if (this.isSearchActive) {
      this.focusSearchInput();
      return;
    }

    this.searchRestoreState = this.captureSearchScrollState();
    this.isSearchActive = true;
    this.isSearchComposing = false;
    this.searchQuery = '';
    this.searchCollapsedGroupKeys = new Set<string>();
    this.dirty = true;
    this.render();
    this.focusSearchInput();
    this.scheduleSearchDismissHandlers();
  }

  private updateSearchQuery(query: string): void {
    const wasFiltering = this.isSearchFiltering();
    this.searchQuery = query;
    this.dirty = true;
    this.render();
    if (wasFiltering && !this.isSearchFiltering()) {
      this.restoreSearchScrollState();
    }
    this.focusSearchInput();
  }

  private closeSearch(): void {
    if (!this.isSearchActive) return;

    this.clearSearchDismissHandlers();
    this.isSearchActive = false;
    this.isSearchComposing = false;
    this.searchQuery = '';
    this.searchFieldEl = null;
    this.searchInputEl = null;
    this.searchCollapsedGroupKeys = new Set<string>();
    this.dirty = true;
    this.render();
    this.restoreSearchScrollState();
    this.searchRestoreState = null;
  }

  private focusSearchInput(): void {
    const input = this.searchInputEl;
    if (!input) return;
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  }

  private scheduleSearchDismissHandlers(): void {
    queueMicrotask(() => {
      if (!this.isSearchActive || !this.searchInputEl) return;

      this.clearSearchDismissHandlers();
      const ownerDocument = this.searchInputEl.ownerDocument;
      const ownerWindow = ownerDocument.defaultView;
      let pointerDownOutsideSearch = false;
      const isOutsideSearch = (event: Event): boolean => {
        const searchField = this.searchFieldEl;
        const target = event.target;
        return !searchField || !target || !searchField.contains(target as Node);
      };
      const handlePointerDown = (event: Event): void => {
        pointerDownOutsideSearch = isOutsideSearch(event);
      };
      const handleFocusIn = (event: Event): void => {
        if (!pointerDownOutsideSearch && isOutsideSearch(event)) {
          this.closeSearch();
        }
      };
      const handleClick = (event: Event): void => {
        const shouldDismiss = isOutsideSearch(event);
        pointerDownOutsideSearch = false;
        if (shouldDismiss) {
          queueMicrotask(() => this.closeSearch());
        }
      };
      const handlePointerCancel = (): void => {
        pointerDownOutsideSearch = false;
      };
      const handleKeyDown = (): void => {
        pointerDownOutsideSearch = false;
      };
      const handleWindowBlur = (): void => this.closeSearch();

      ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
      ownerDocument.addEventListener('pointercancel', handlePointerCancel, true);
      ownerDocument.addEventListener('keydown', handleKeyDown, true);
      ownerDocument.addEventListener('focusin', handleFocusIn, true);
      ownerDocument.addEventListener('click', handleClick, true);
      ownerWindow?.addEventListener?.('blur', handleWindowBlur);
      this.searchDismissCleanup = () => {
        ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
        ownerDocument.removeEventListener('pointercancel', handlePointerCancel, true);
        ownerDocument.removeEventListener('keydown', handleKeyDown, true);
        ownerDocument.removeEventListener('focusin', handleFocusIn, true);
        ownerDocument.removeEventListener('click', handleClick, true);
        ownerWindow?.removeEventListener?.('blur', handleWindowBlur);
      };
    });
  }

  private clearSearchDismissHandlers(): void {
    this.searchDismissCleanup?.();
    this.searchDismissCleanup = null;
  }

  private findScrollLists(): { pinnedList: HTMLElement | null; sessionList: HTMLElement | null } {
    const list = this.sidebarEl?.querySelector<HTMLElement>('.claudian-history-list') ?? null;
    const sessionList = list?.querySelector<HTMLElement>('.claudian-session-list-items') ?? list;
    const pinnedSection = list?.querySelector<HTMLElement>('.claudian-history-section--pinned');
    const pinnedList = pinnedSection?.querySelector<HTMLElement>(
      '.claudian-history-section-items',
    ) ?? null;
    return { pinnedList, sessionList };
  }

  private captureSearchScrollState(): SessionSearchScrollState {
    const { pinnedList, sessionList } = this.findScrollLists();
    return {
      pinnedScrollTop: pinnedList?.scrollTop ?? 0,
      sessionScrollTop: sessionList?.scrollTop ?? 0,
    };
  }

  private restoreSearchScrollState(): void {
    const state = this.searchRestoreState;
    if (!state) return;

    const { pinnedList, sessionList } = this.findScrollLists();
    if (sessionList) sessionList.scrollTop = state.sessionScrollTop;
    if (pinnedList) pinnedList.scrollTop = state.pinnedScrollTop;
  }

  private isSearchFiltering(): boolean {
    return this.isSearchActive && this.searchQuery.trim().length > 0;
  }

  private getModelLabel(conversation: ConversationMeta): string {
    const selectedModel = typeof conversation.selectedModel === 'string'
      ? conversation.selectedModel.trim()
      : '';
    if (!selectedModel) return '';

    try {
      return ProviderRegistry
        .getChatUIConfig(conversation.providerId)
        .getModelOptions(this.deps.plugin.settings)
        .find(option => option.value === selectedModel)
        ?.label ?? selectedModel;
    } catch {
      return selectedModel;
    }
  }

  private contentIsNote(contentPath: string): boolean {
    const target = this.deps.plugin.app.vault.getAbstractFileByPath(contentPath);
    return target instanceof TFile && target.extension.toLocaleLowerCase() === 'md';
  }

  private createHeaderAction(
    parent: HTMLElement,
    icon: string | ((container: HTMLElement) => void),
    label: string,
    action: (event?: MouseEvent) => void,
  ): HTMLElement {
    const control = parent.createDiv({ cls: 'claudian-session-header-btn' });
    control.setAttribute('role', 'button');
    control.setAttribute('tabindex', '0');
    control.setAttribute('aria-label', label);

    const iconEl = control.createDiv({ cls: 'claudian-session-header-icon' });
    if (typeof icon === 'string') {
      setIcon(iconEl, icon);
    } else {
      icon(iconEl);
    }

    control.addEventListener('click', (event) => action(event));
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    });
    return control;
  }

  private getOrganization(): 'list' | 'linked-content' {
    return this.deps.plugin.settings.sessionManagerOrganization === 'linked-content'
      ? 'linked-content'
      : 'list';
  }

  private getSort(): 'last-updated' | 'created' {
    const sort = this.deps.plugin.settings.sessionManagerSort;
    return sort === 'created' ? sort : 'last-updated';
  }

  private getDisplayedCollapsedGroupKeys(): Set<string> {
    return this.isSearchFiltering() ? this.searchCollapsedGroupKeys : this.collapsedGroupKeys;
  }

  private areAllGroupsCollapsed(): boolean {
    const collapsedGroupKeys = this.getDisplayedCollapsedGroupKeys();
    return this.groupKeys.size > 0
      && [...this.groupKeys].every(groupKey => collapsedGroupKeys.has(groupKey));
  }

  private updateGroupToggleButton(): void {
    const button = this.groupToggleButtonEl;
    if (!button) return;

    const allCollapsed = this.areAllGroupsCollapsed();
    button.setAttribute('aria-label', allCollapsed ? 'Expand all groups' : 'Collapse all groups');
    const icon = button.querySelector<HTMLElement>('.claudian-session-header-icon');
    if (icon) {
      renderSessionGroupToggleIcon(icon, allCollapsed ? 'expand' : 'collapse');
    }
  }

  private toggleAllGroups(): void {
    if (this.groupKeys.size === 0) return;

    const collapsedGroupKeys = this.getDisplayedCollapsedGroupKeys();
    const shouldExpand = this.areAllGroupsCollapsed();
    for (const groupKey of this.groupKeys) {
      if (shouldExpand) {
        collapsedGroupKeys.delete(groupKey);
      } else {
        collapsedGroupKeys.add(groupKey);
      }
    }
    this.refreshPresentation();
  }

  private showOptionsMenu(anchor: HTMLElement, event?: MouseEvent): void {
    const menu = new Menu().setUseNativeMenu(false);
    const organization = this.getOrganization();
    const sort = this.getSort();

    menu.addItem(item => item
      .setTitle('Organize sessions')
      .setIsLabel(true));
    menu.addItem(item => item
      .setTitle('In one list')
      .setChecked(organization === 'list')
      .onClick(() => this.setOrganization('list')));
    menu.addItem(item => item
      .setTitle('By linked content')
      .setChecked(organization === 'linked-content')
      .onClick(() => this.setOrganization('linked-content')));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle('Sort sessions by')
      .setIsLabel(true));
    menu.addItem(item => item
      .setTitle('Last activity')
      .setChecked(sort === 'last-updated')
      .onClick(() => this.setSort('last-updated')));
    menu.addItem(item => item
      .setTitle('Created')
      .setChecked(sort === 'created')
      .onClick(() => this.setSort('created')));

    if (event) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
  }

  private setOrganization(organization: 'list' | 'linked-content'): void {
    void this.deps.plugin.mutateSettings((settings) => {
      settings.sessionManagerOrganization = organization;
    })
      .catch(() => new Notice('Failed to update session organization'));
  }

  private setSort(sort: 'last-updated' | 'created'): void {
    void this.deps.plugin.mutateSettings((settings) => {
      settings.sessionManagerSort = sort;
    })
      .catch(() => new Notice('Failed to update session sorting'));
  }

  private refreshPresentation(): void {
    this.dirty = true;
    this.render();
    this.deps.notifyOtherViews();
  }

  private cancelRendering(): void {
    this.renderAbortController?.abort();
    this.renderAbortController = null;
  }
}
