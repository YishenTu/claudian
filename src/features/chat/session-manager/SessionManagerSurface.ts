import { Menu, Notice, setIcon, TFile } from 'obsidian';

import { StartupProfiler } from '@/core/performance/StartupProfiler';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getObsidianLanguage } from '@/features/chat/session-manager/ProvisionalNoteNames';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { renderSessionGroupToggleIcon } from '@/features/chat/session-manager/SessionManagerIcons';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import type { ChatTab } from '@/features/chat/tabs/ChatTab';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';

type SessionSearchScrollState = {
  pinnedScrollTop: number;
  sessionScrollTop: number;
};

type NavigationMode = 'history' | 'sessions';

/** The session-opening policy the surface delegates to. */
export interface SessionSurfaceNavigation {
  getConversationStatus(conversationId: string): HistoryConversationStatus;
  openConversation(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void>;
  openSessionConversation(conversationId: string): Promise<void>;
  startLinkedContentConversation(contentPath: string): Promise<void>;
  contentExists(contentPath: string): boolean;
  hasUnboundDraft(): boolean;
}

export interface SessionManagerSurfaceDeps {
  plugin: ChatFeatureHost;
  navigation: SessionSurfaceNavigation;
  getActiveTab(): ChatTab | null;
  isWide(): boolean;
  /** Whether another tab fits; null while the view has no tabs. */
  canCreateTab(): boolean | null;
  requestNew(): void;
  /** Session presentation settings changed; other views must re-render their lists. */
  notifyOtherViews(): void;
}

/** Shows or hides a New control while keeping it out of the accessibility tree when hidden. */
export function setControlAvailability(button: HTMLElement | null, isAvailable: boolean): void {
  if (!button) return;

  button.toggleClass('claudian-hidden', !isAvailable);
  if (isAvailable) {
    button.removeAttribute('aria-disabled');
    button.removeAttribute('aria-hidden');
    return;
  }

  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('aria-hidden', 'true');
}

/**
 * The view's session manager presentation: the single-pane history dropdown and
 * the dual-pane session sidebar, with their search, archive, grouping, and
 * coalesced rendering. It owns the session browser that renders both.
 */
export class SessionManagerSurface {
  private readonly sessionBrowser: SessionBrowser;

  private historyDropdownEl: HTMLElement | null = null;
  private sidebarEl: HTMLElement | null = null;
  private sessionSurfaceEl: HTMLElement | null = null;
  private sessionNewButtonEl: HTMLElement | null = null;
  private searchFieldEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private groupToggleButtonEl: HTMLElement | null = null;

  private historyRenderAbortController: AbortController | null = null;
  private sidebarRenderAbortController: AbortController | null = null;
  private historyDropdownDirty = true;
  private sidebarDirty = true;
  private historySurfaceRendered = false;

  private isArchiveView = false;
  private isSearchActive = false;
  private isSearchComposing = false;
  private searchQuery = '';
  private searchRestoreState: SessionSearchScrollState | null = null;
  private searchDismissCleanup: (() => void) | null = null;
  private searchCollapsedGroupKeys = new Set<string>();
  private readonly collapsedGroupKeys = new Set<string>();
  private groupKeys = new Set<string>();

  constructor(private readonly deps: SessionManagerSurfaceDeps) {
    this.sessionBrowser = new SessionBrowser({
      plugin: deps.plugin,
      getCurrentConversationId: () => deps.getActiveTab()?.conversationId ?? null,
      getTitleGenerationService: () => deps.getActiveTab()?.services.titleGenerationService ?? null,
      onListChanged: () => this.invalidate(),
    });
  }

  /** True while session search is composing IME input; Escape belongs to the composition. */
  get isComposing(): boolean {
    return this.isSearchComposing;
  }

  /** Builds the dual-pane sidebar surface inside `sidebarEl`. */
  mountSidebar(sidebarEl: HTMLElement): void {
    this.sidebarEl = sidebarEl;
    const trackEl = sidebarEl.createDiv({ cls: 'claudian-sidebar-surface-track' });
    this.sessionSurfaceEl = trackEl.createDiv({ cls: 'claudian-session-surface' });
  }

  /** Builds the single-pane history button and its drop-up menu inside `parentEl`. */
  mountHistoryControl(parentEl: HTMLElement): void {
    const historyContainer = parentEl.createDiv({
      cls: 'claudian-history-container claudian-nav-dropup-container',
    });
    const historyBtn = historyContainer.createEl('button', {
      cls: 'claudian-input-nav-btn',
      attr: { type: 'button' },
    });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.historyDropdownEl = historyContainer.createDiv({
      cls: 'claudian-history-menu claudian-nav-dropup-menu',
    });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });
  }

  /** Marks both surfaces stale and re-renders whichever is showing. */
  invalidate(): void {
    this.historyDropdownDirty = true;
    this.sidebarDirty = true;
    if (this.historyDropdownEl?.hasClass('visible')) {
      this.renderHistoryDropdown();
    }
    if (this.deps.isWide()) this.renderSidebar();
  }

  toggleDropdown(): void {
    if (!this.historyDropdownEl) return;

    if (this.historyDropdownEl.hasClass('visible')) {
      this.closeDropdown();
    } else {
      this.historyDropdownEl.addClass('visible');
      this.renderHistoryDropdown();
    }
  }

  /** Hides the dropdown and abandons its in-flight render. */
  closeDropdown(): void {
    this.historyDropdownEl?.removeClass('visible');
    this.cancelHistoryRendering();
  }

  /** Hides the dropdown for an outside click, keeping its rendered list. */
  dismissDropdown(): void {
    this.historyDropdownEl?.removeClass('visible');
  }

  /** The wide layout replaces the dropdown with the sidebar. */
  enterWide(): void {
    this.closeDropdown();
  }

  /** Leaving the wide layout ends sidebar search and rendering. */
  leaveWide(): void {
    this.closeSearch();
    this.cancelSidebarRendering();
  }

  renderSidebar(): void {
    const surfaceEl = this.sessionSurfaceEl ?? this.sidebarEl;
    if (!surfaceEl || !this.sidebarDirty || !this.deps.isWide()) return;
    if (this.isSearchComposing) return;

    const previousSearchInput = this.searchInputEl;
    const shouldRestoreSearchFocus = previousSearchInput?.ownerDocument.activeElement
      === previousSearchInput;

    this.cancelSidebarRendering();
    const abortController = new AbortController();
    this.sidebarRenderAbortController = abortController;

    const span = this.historySurfaceRendered ? null : StartupProfiler.start('history-list-render');
    this.historySurfaceRendered = true;

    try {
      this.sessionNewButtonEl = null;
      this.searchFieldEl = null;
      this.searchInputEl = null;
      this.groupToggleButtonEl = null;
      this.renderHistorySurface(surfaceEl, abortController.signal, 'sessions');
      this.buildSessionHeaderActions(surfaceEl);
      if (shouldRestoreSearchFocus) {
        this.focusSearchInput();
      }
      this.sidebarDirty = false;
    } finally {
      if (span) StartupProfiler.finish(span);
    }
  }

  /** Handles Escape for inline rename and search; returns whether it was consumed. */
  handleEscape(): boolean {
    if (this.sessionBrowser.cancelInlineRename()) return true;
    if (!this.isSearchActive) return false;
    this.closeSearch();
    return true;
  }

  /** New stays available at capacity while an unbound draft can be resumed instead. */
  refreshNewAvailability(): void {
    const canCreateTab = this.deps.canCreateTab();
    if (canCreateTab === null) return;
    setControlAvailability(
      this.sessionNewButtonEl,
      canCreateTab || this.deps.navigation.hasUnboundDraft(),
    );
  }

  dispose(): void {
    this.sessionBrowser.dispose();
    this.clearSearchDismissHandlers();
    this.cancelHistoryRendering();
    this.cancelSidebarRendering();
  }

  private renderHistoryDropdown(): void {
    if (!this.historyDropdownEl || !this.historyDropdownDirty) return;

    this.cancelHistoryRendering();
    const abortController = new AbortController();
    this.historyRenderAbortController = abortController;

    const span = this.historySurfaceRendered ? null : StartupProfiler.start('history-list-render');
    this.historySurfaceRendered = true;

    try {
      this.renderHistorySurface(this.historyDropdownEl, abortController.signal, 'history');
      this.historyDropdownDirty = false;
    } finally {
      if (span) StartupProfiler.finish(span);
    }
  }

  private renderHistorySurface(
    container: HTMLElement,
    signal: AbortSignal,
    navigationMode: NavigationMode,
  ): void {
    const { navigation, plugin } = this.deps;
    const isArchiveView = this.isArchiveView;
    this.sessionBrowser.renderHistoryDropdown(container, {
      onSelectConversation: (id) => navigationMode === 'sessions'
        ? navigation.openSessionConversation(id)
        : this.openFromDropdown(id),
      ...(navigationMode === 'history' && !isArchiveView
        ? {
            onOpenConversationInNewTab: (id: string, activate = true) =>
              this.openFromDropdown(id, { preferNewTab: true, activate }),
          }
        : {}),
      getConversationStatus: (id) => navigation.getConversationStatus(id),
      onRerender: () => this.invalidate(),
      showOpenStateLabels: navigationMode === 'history',
      showOpenStateActions: navigationMode === 'history' && !isArchiveView,
      preserveListState: true,
      showInlinePinAction: navigationMode === 'sessions',
      onRequestInlineRename: ({ beginRename, conversationId }) => {
        if (navigationMode === 'sessions' && this.isSearchActive) {
          this.closeSearch();
        }
        const restoreAndRename = () => {
          if (
            navigationMode === 'history'
            && (signal.aborted || this.historyDropdownEl !== container)
          ) return;
          const targetItem = Array.from(
            container.querySelectorAll<HTMLElement>('.claudian-history-item'),
          ).find(item => item.getAttribute('data-conversation-id') === conversationId);
          if (!targetItem) return;

          if (navigationMode === 'history') {
            container.addClass('visible');
          }
          beginRename(targetItem);
        };
        scheduleAnimationFrame(
          restoreAndRename,
          container.ownerDocument.defaultView,
        );
      },
      sessionScope: isArchiveView ? 'archived' : 'active',
      sessionActionMode: isArchiveView ? 'archived' : 'active',
      historyHeaderLabel: isArchiveView ? 'Archived' : 'Sessions',
      allowConversationSelection: !isArchiveView,
      onAssignConversationToDevice: async (id: string) => {
        await plugin.assignConversationToCurrentDevice(id);
      },
      ...(navigationMode === 'history'
        ? {
            onBeforeRestoreListState: (target: HTMLElement) => (
              this.buildHistoryArchiveNavigation(target)
            ),
          }
        : {}),
      ...(navigationMode === 'sessions'
        ? {
            organization: this.getOrganization(),
            groupByRecency: this.getOrganization() === 'list',
            sort: this.getSort(),
            language: getObsidianLanguage(plugin.settings.locale),
            contentExists: (contentPath: string) => navigation.contentExists(contentPath),
            contentIsNote: (contentPath: string) => this.contentIsNote(contentPath),
            searchQuery: this.isSearchActive ? this.searchQuery : undefined,
            showMetadataPopover: true,
            showOpenStateActions: false,
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
              this.setArchiveView(false);
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
          }
        : {}),
      signal,
    });
  }

  private async openFromDropdown(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void> {
    await this.deps.navigation.openConversation(conversationId, options);
    this.closeDropdown();
  }

  private buildSessionHeaderActions(container: HTMLElement): void {
    const header = container.querySelector<HTMLElement>('.claudian-session-list-header');
    const list = container.querySelector<HTMLElement>('.claudian-history-list');
    if (!header || !list) return;

    const newControl = container.createDiv({ cls: 'claudian-session-new-control' });
    newControl.setAttribute('role', 'button');
    newControl.setAttribute('tabindex', '0');
    const newIcon = newControl.createSpan({ cls: 'claudian-session-new-icon' });
    setIcon(newIcon, 'square-pen');
    newControl.createSpan({ cls: 'claudian-session-new-label', text: 'New' });
    const requestNew = (): void => {
      this.setArchiveView(false);
      this.deps.requestNew();
    };
    newControl.addEventListener('click', requestNew);
    newControl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      requestNew();
    });
    container.insertBefore(newControl, list);
    this.sessionNewButtonEl = newControl;

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
    setIcon(archiveIcon, this.isArchiveView ? 'arrow-left' : 'archive');
    archiveControl.createSpan({
      cls: 'claudian-session-nav-label',
      text: this.isArchiveView ? 'Sessions' : 'Archive',
    });
    const toggleArchiveView = (): void => this.setArchiveView(!this.isArchiveView);
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
    const label = this.isArchiveView ? 'Search archived sessions' : 'Search sessions';
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
    this.sidebarDirty = true;
    this.renderSidebar();
    this.focusSearchInput();
    this.scheduleSearchDismissHandlers();
  }

  private updateSearchQuery(query: string): void {
    const wasFiltering = this.isSearchFiltering();
    this.searchQuery = query;
    this.sidebarDirty = true;
    this.renderSidebar();
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
    this.sidebarDirty = true;
    this.renderSidebar();
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

  /** Switches between active and archived sessions; the switch always ends search. */
  private setArchiveView(isArchiveView: boolean): void {
    if (this.isArchiveView === isArchiveView) return;
    this.clearSearchDismissHandlers();
    this.isSearchActive = false;
    this.isSearchComposing = false;
    this.searchQuery = '';
    this.searchFieldEl = null;
    this.searchInputEl = null;
    this.searchRestoreState = null;
    this.searchCollapsedGroupKeys = new Set<string>();
    this.isArchiveView = isArchiveView;
    this.historyDropdownDirty = true;
    this.sidebarDirty = true;
    if (this.deps.isWide()) {
      this.renderSidebar();
    } else if (this.historyDropdownEl?.hasClass('visible')) {
      this.renderHistoryDropdown();
    }
  }

  private buildHistoryArchiveNavigation(container: HTMLElement): void {
    const list = container.querySelector<HTMLElement>('.claudian-history-list');
    if (!list) return;

    const label = this.isArchiveView ? 'Sessions' : 'Archive';
    const control = list.createDiv({ cls: 'claudian-history-archive-control' });
    control.setAttribute('role', 'button');
    control.setAttribute('tabindex', '0');
    control.setAttribute('aria-label', label);
    const icon = control.createSpan({ cls: 'claudian-session-nav-icon' });
    setIcon(icon, this.isArchiveView ? 'arrow-left' : 'archive');
    control.createSpan({ cls: 'claudian-session-nav-label', text: label });
    const toggleArchiveView = (): void => this.setArchiveView(!this.isArchiveView);
    control.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleArchiveView();
    });
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggleArchiveView();
    });
    list.insertBefore(control, list.firstChild);
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
    this.sidebarDirty = true;
    this.renderSidebar();
    this.deps.notifyOtherViews();
  }

  private cancelHistoryRendering(): void {
    this.historyRenderAbortController?.abort();
    this.historyRenderAbortController = null;
    this.historyDropdownDirty = true;
  }

  private cancelSidebarRendering(): void {
    this.sidebarRenderAbortController?.abort();
    this.sidebarRenderAbortController = null;
  }
}
