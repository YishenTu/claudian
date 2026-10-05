import { setIcon } from 'obsidian';

import type { TitleGenerationService } from '@/core/providers/types';
import type {
  ConversationMeta,
  SessionManagerOrganization,
  SessionManagerSort,
} from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ConversationTitleGeneration } from '@/features/chat/conversation/ConversationTitleGeneration';
import {
  canMultiSelect,
  runSessionAction,
  type SessionActionOptions,
  SessionActions,
  type SessionRow,
} from '@/features/chat/session-manager/SessionActions';
import { SessionInlineRename } from '@/features/chat/session-manager/SessionInlineRename';
import { deriveSessionListModel, type SessionListSection } from '@/features/chat/session-manager/SessionListOrganizer';
import {
  captureSessionListPosition,
  INITIAL_SESSION_LIST_POSITION,
  recordVisibleCount,
  restoreSessionListPosition,
} from '@/features/chat/session-manager/SessionListPosition';
import { type SessionMetadataOptions, SessionMetadataPopover } from '@/features/chat/session-manager/SessionMetadataPopover';
import { SessionMultiSelection } from '@/features/chat/session-manager/SessionMultiSelection';
import {
  canShowAttention,
  groupIndicatorKind,
  type HistoryConversationOpenState,
  type HistoryConversationStatus,
  indicatorPresentation,
  isCompletedReview,
  sessionIndicatorKind,
  sessionItemIcon,
  type SessionStatusDisplay,
  type SessionStatusIndicatorKind,
  sessionStatusText,
} from '@/features/chat/session-manager/SessionStatusPresentation';

const DEFAULT_HISTORY_PAGE_SIZE = 100;

type HistoryRenderOptions = SessionActionOptions & SessionStatusDisplay & SessionMetadataOptions & {
  getConversationOpenState?: (id: string) => HistoryConversationOpenState;
  getConversationStatus?: (id: string) => HistoryConversationStatus;
  pageSize?: number;
  visibleCount?: number;
  showMetadataPopover?: boolean;
  organization?: SessionManagerOrganization;
  /** Divides an unpinned flat list into recency groups. */
  groupByRecency?: boolean;
  sort?: SessionManagerSort;
  collapsedGroupKeys?: ReadonlySet<string>;
  onGroupCollapseChange?: (groupKey: string, collapsed: boolean) => void;
  onGroupKeysChange?: (groupKeys: readonly string[]) => void;
  onStartLinkedContentConversation?: (contentPath: string) => Promise<void>;
  pinnedLinkedContentPaths?: ReadonlySet<string>;
  preserveListState?: boolean;
  showPinnedSection?: boolean;
  showArchivedSection?: boolean;
  historyHeaderLabel?: string;
  allowConversationSelection?: boolean;
  searchQuery?: string;
  onBeforeRestoreListState?: (container: HTMLElement) => void;
  onRequestInlineRename?: (request: {
    beginRename: (item: HTMLElement) => void;
    conversationId: string;
  }) => void;
};

type HistorySurfaceRenderOptions = Omit<HistoryRenderOptions, 'onRerender'> & {
  onRerender?: () => void;
};

export interface SessionBrowserDeps {
  plugin: ChatFeatureHost;
  getCurrentConversationId: () => string | null;
  getTitleGenerationService: () => TitleGenerationService | null;
  onListChanged: () => void;
}

function isNewTabModifierClick(event: MouseEvent): boolean {
  return !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey);
}

export class SessionBrowser {
  private readonly metadataPopover = new SessionMetadataPopover();
  private readonly selection = new SessionMultiSelection();
  private readonly inlineRename = new SessionInlineRename();
  private readonly actions: SessionActions;
  private readonly titles: ConversationTitleGeneration;

  constructor(private readonly deps: SessionBrowserDeps) {
    this.titles = new ConversationTitleGeneration({
      host: deps.plugin,
      getService: () => deps.getTitleGenerationService(),
      onChanged: () => deps.onListChanged(),
    });
    this.actions = new SessionActions({ plugin: deps.plugin, selection: this.selection });
  }

  dispose(): void {
    this.selection.clear();
    this.inlineRename.cancel();
    this.metadataPopover.dispose();
  }

  cancelInlineRename(): boolean {
    return this.inlineRename.cancel();
  }

  /** Renders the session list into a surface-owned container. */
  renderHistoryDropdown(
    container: HTMLElement,
    options: HistorySurfaceRenderOptions,
  ): void {
    this.#renderHistoryItems(container, {
      ...options,
      onRerender: options.onRerender
        ?? (() => this.renderHistoryDropdown(container, options)),
    });
  }

  #renderHistoryItems(
    container: HTMLElement,
    options: HistoryRenderOptions,
  ): void {
    const { plugin } = this.deps;
    if (options.signal?.aborted) return;
    if (options.showMetadataPopover) {
      this.metadataPopover.close();
    }
    this.selection.beginRender(container, options.searchQuery ?? '', canMultiSelect(options));

    const previousPosition = options.preserveListState
      ? captureSessionListPosition(container)
      : INITIAL_SESSION_LIST_POSITION;
    const organization = options.organization ?? 'list';

    this.inlineRename.releaseWithin(container);
    container.empty();

    const model = deriveSessionListModel(plugin.getConversationList(), {
      organization,
      sort: options.sort ?? 'last-updated',
      language: options.language ?? 'en',
      scope: options.sessionScope,
      searchQuery: options.searchQuery,
      showPinnedSection: options.showPinnedSection,
      pinnedLinkedContentPaths: options.pinnedLinkedContentPaths,
      collapsedGroupKeys: options.collapsedGroupKeys,
      contentExists: options.contentExists,
      contentIsNote: options.contentIsNote,
      groupByRecency: options.groupByRecency ? { now: Date.now() } : undefined,
    });
    const { conversationsByLinkedContent, pinnedContentSections, sections } = model;
    const showSessionSections = options.showPinnedSection || options.showArchivedSection;

    let list: HTMLElement;
    let sessionList: HTMLElement;
    let pinnedList: HTMLElement | null = null;
    if (showSessionSections) {
      list = container.createDiv({ cls: 'claudian-history-list' });
      if (model.pinnedConversations.length > 0 || pinnedContentSections.length > 0) {
        const pinnedSection = list.createDiv({
          cls: 'claudian-history-section claudian-history-section--pinned',
        });
        const pinnedHeader = pinnedSection.createDiv({
          cls: 'claudian-history-header claudian-session-section-header',
        });
        pinnedHeader.createSpan({
          cls: 'claudian-history-section-label',
          text: 'Pinned',
        });
        pinnedList = pinnedSection.createDiv({
          cls: 'claudian-history-section-items',
        });
      }

      const sessionsSection = list.createDiv({
        cls: [
          'claudian-history-section',
          options.showArchivedSection
            ? 'claudian-history-section--archived'
            : 'claudian-history-section--sessions',
        ].join(' '),
      });
      const sessionsHeader = sessionsSection.createDiv({
        cls: [
          'claudian-history-header',
          'claudian-session-section-header',
          'claudian-session-list-header',
        ].join(' '),
      });
      sessionsHeader.createSpan({
        cls: 'claudian-history-section-label',
        text: options.showArchivedSection ? 'Archived' : 'Sessions',
      });
      sessionList = sessionsSection.createDiv({
        cls: 'claudian-history-section-items claudian-session-list-items',
      });
    } else {
      const dropdownHeader = container.createDiv({ cls: 'claudian-history-header' });
      dropdownHeader.createSpan({ text: options.historyHeaderLabel ?? 'Sessions' });
      list = container.createDiv({ cls: 'claudian-history-list' });
      sessionList = list;
    }

    const pageSize = Math.max(1, options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE);
    const visibleCount = Math.max(
      pageSize,
      options.visibleCount ?? previousPosition.visibleCount,
    );
    recordVisibleCount(list, visibleCount);
    const restorePosition = (): void => {
      options.onBeforeRestoreListState?.(container);
      restoreSessionListPosition(previousPosition, sessionList, pinnedList);
    };

    if (model.groupKeys) options.onGroupKeysChange?.(model.groupKeys);
    if (model.isEmpty) {
      sessionList.createDiv({
        cls: 'claudian-history-empty',
        text: model.hasSearchTerms ? 'No matching sessions' : 'No conversations',
      });
      restorePosition();
      return;
    }

    const { visibleConversationTotal } = model;
    let renderedConversationCount = 0;
    const linkedContentConversations = (section: SessionListSection): readonly ConversationMeta[] => (
      section.contentPath
        ? conversationsByLinkedContent.get(section.contentPath) ?? []
        : section.conversations
    );

    if (pinnedList) {
      for (const section of pinnedContentSections) {
        const remainingVisibleCount = visibleCount - renderedConversationCount;
        const isCollapsed = options.collapsedGroupKeys?.has(section.key) ?? false;
        const visibleConversations = isCollapsed || remainingVisibleCount <= 0
          ? []
          : section.conversations.slice(0, remainingVisibleCount);
        this.#renderLinkedContentSection(
          pinnedList,
          section,
          visibleConversations,
          isCollapsed,
          options,
          linkedContentConversations(section),
        );
        renderedConversationCount += visibleConversations.length;
      }

      const visiblePinnedConversations = model.pinnedConversations.slice(
        0,
        Math.max(0, visibleCount - renderedConversationCount),
      );
      for (const conversation of visiblePinnedConversations) {
        this.#renderHistoryConversationItem(pinnedList, conversation, options);
      }
      renderedConversationCount += visiblePinnedConversations.length;
    }

    for (const section of sections) {
      const remainingVisibleCount = visibleCount - renderedConversationCount;
      const isCollapsed = organization === 'linked-content'
        && (options.collapsedGroupKeys?.has(section.key) ?? false);
      const visibleConversations = isCollapsed || remainingVisibleCount <= 0
        ? []
        : section.conversations.slice(0, remainingVisibleCount);
      if (organization !== 'linked-content' && visibleConversations.length === 0) break;

      if (organization === 'linked-content') {
        this.#renderLinkedContentSection(
          sessionList,
          section,
          visibleConversations,
          isCollapsed,
          options,
          linkedContentConversations(section),
        );
      } else {
        if (section.kind === 'recency') {
          this.#renderRecencyDivider(sessionList, section, options);
        }
        for (const conversation of visibleConversations) {
          this.#renderHistoryConversationItem(sessionList, conversation, options);
        }
      }
      renderedConversationCount += visibleConversations.length;
    }

    if (renderedConversationCount < visibleConversationTotal && !options.signal?.aborted) {
      const loadMoreButton = sessionList.createEl('button', {
        cls: 'claudian-history-load-more',
        text: `Load more (${visibleConversationTotal - renderedConversationCount} remaining)`,
      });
      loadMoreButton.addEventListener('click', () => {
        if (options.signal?.aborted) return;
        const nextVisibleCount = visibleCount + pageSize;
        if (options.preserveListState) {
          recordVisibleCount(list, nextVisibleCount);
          options.onRerender();
          return;
        }
        this.#renderHistoryItems(container, {
          ...options,
          visibleCount: nextVisibleCount,
        });
      });
    }

    restorePosition();
  }

  #renderLinkedContentSection(
    list: HTMLElement,
    section: SessionListSection,
    visibleConversations: readonly ConversationMeta[],
    isCollapsed: boolean,
    options: HistoryRenderOptions,
    linkedContentConversations: readonly ConversationMeta[],
  ): void {
    const conversationStatuses = section.conversations.map(conversation => (
      this.#statusOf(conversation, options)
    ));
    const groupStatusKind = groupIndicatorKind(conversationStatuses, options);
    const hasReviewConversation = canShowAttention(options)
      && conversationStatuses.some(({ attention }) => isCompletedReview(attention));
    const showGroupReviewState = groupStatusKind === null && hasReviewConversation;
    const groupHeader = list.createDiv({
      cls: [
        'claudian-session-group-header',
        `claudian-session-group-header--${section.kind}`,
        showGroupReviewState && isCollapsed
          ? 'claudian-session-group-header--attention'
          : '',
      ].filter(Boolean).join(' '),
    });
    groupHeader.setAttribute('data-group-kind', section.kind);
    groupHeader.setAttribute('role', 'button');
    groupHeader.setAttribute('tabindex', '0');
    groupHeader.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if (section.contentPath) {
      groupHeader.setAttribute('data-content-path', section.contentPath);
      groupHeader.setAttribute('title', section.contentPath);
      const contentIcon = groupHeader.createSpan({
        cls: 'claudian-session-group-icon',
      });
      setIcon(contentIcon, section.kind === 'missing' ? 'file-question' : 'link');
    } else if (section.kind === 'ungrouped') {
      const ungroupedIcon = groupHeader.createSpan({
        cls: 'claudian-session-group-icon',
      });
      setIcon(ungroupedIcon, 'inbox');
    }
    groupHeader.createSpan({
      cls: 'claudian-session-group-label',
      text: section.label ?? '',
    });
    if (section.kind === 'missing') {
      groupHeader.createSpan({
        cls: 'claudian-session-group-status',
        text: 'Missing',
      });
    }
    const groupStatusIndicator = groupStatusKind === null
      ? null
      : this.#createSessionStatusIndicator(
          groupHeader,
          groupStatusKind,
          true,
          isCollapsed,
        );
    if (
      section.kind === 'content'
      && section.contentPath
      && options.onStartLinkedContentConversation
      && options.sessionActionMode !== 'archived'
    ) {
      const contentPath = section.contentPath;
      const startLinkedContentConversation = options.onStartLinkedContentConversation;
      const newConversationButton = groupHeader.createSpan({
        cls: 'claudian-session-group-new-action',
      });
      newConversationButton.setAttribute('role', 'button');
      newConversationButton.setAttribute('tabindex', '0');
      setIcon(newConversationButton, 'square-pen');
      newConversationButton.setAttribute(
        'aria-label',
        `New chat for ${section.label ?? contentPath}`,
      );
      const startConversation = (): void => {
        runSessionAction(
          () => startLinkedContentConversation(contentPath),
          'Failed to start a chat for this Linked content',
        );
      };
      newConversationButton.addEventListener('click', (event) => {
        event.stopPropagation();
        startConversation();
      });
      newConversationButton.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        startConversation();
      });
    }

    const groupBody = list.createDiv({
      cls: [
        'claudian-session-group-body',
        isCollapsed ? 'claudian-session-group-body--collapsed' : '',
      ].filter(Boolean).join(' '),
    });
    groupBody.setAttribute('data-group-key', section.key);

    const toggleGroup = (): void => {
      const collapsed = groupHeader.getAttribute('aria-expanded') === 'true';
      groupHeader.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      groupBody.toggleClass('claudian-session-group-body--collapsed', collapsed);
      if (groupStatusIndicator) {
        groupStatusIndicator.toggleClass(
          groupStatusKind === 'running'
            ? 'claudian-session-group-running-indicator--visible'
            : 'claudian-session-group-status-indicator--visible',
          collapsed,
        );
      }
      if (showGroupReviewState) {
        groupHeader.toggleClass('claudian-session-group-header--attention', collapsed);
      }
      options.onGroupCollapseChange?.(section.key, collapsed);
      options.onRerender();
    };
    groupHeader.addEventListener('click', toggleGroup);
    groupHeader.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleGroup();
    });

    const contentPath = section.contentPath;
    const buildGroupMenu = contentPath
      ? this.actions.groupMenu(
          {
            conversations: linkedContentConversations,
            linkedContent: {
              path: contentPath,
              kind: section.kind,
              isPinned: options.pinnedLinkedContentPaths?.has(contentPath) ?? false,
            },
          },
          options,
          conversation => this.#statusOf(conversation, options).isRunning,
        )
      : null;
    if (buildGroupMenu) {
      groupHeader.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        buildGroupMenu().showAtMouseEvent(event);
      });
    }

    for (const conversation of visibleConversations) {
      this.#renderHistoryConversationItem(groupBody, conversation, options);
    }
  }

  #renderHistoryConversationItem(
    list: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    if (options.signal?.aborted) return;

    const conversationStatus = this.#statusOf(conversation, options);
    const { openState, isRunning } = conversationStatus;
    const hasAttentionState = canShowAttention(options)
      && conversationStatus.attention !== null
      && conversationStatus.attention !== undefined;
    const showReviewState = hasAttentionState && isCompletedReview(conversationStatus.attention);
    const sessionStatusKind = sessionIndicatorKind(conversationStatus, options);
    const showRunningPresentation = isRunning
      && sessionStatusKind !== 'action-required';
    const isCurrent = openState === 'current';
    const isOpen = openState === 'open';
    const isSelectable = !isCurrent && options.allowConversationSelection !== false;
    const item = list.createDiv({
      cls: [
        'claudian-history-item',
        isCurrent ? 'active' : '',
        isOpen ? 'open' : '',
        showRunningPresentation ? 'running' : '',
        showReviewState ? 'claudian-history-item--attention' : '',
        options.allowConversationSelection === false
          ? 'claudian-history-item--noninteractive'
          : '',
      ].filter(Boolean).join(' '),
    });
    item.setAttribute('data-open-state', openState);
    item.setAttribute('data-conversation-id', conversation.id);
    item.setAttribute('data-running', isRunning ? 'true' : 'false');
    item.setAttribute('data-tab-location', conversationStatus.location ?? 'current-view');
    if (typeof conversationStatus.tabIndex === 'number') {
      item.setAttribute('data-tab-index', String(conversationStatus.tabIndex));
    }

    const iconEl = item.createDiv({ cls: 'claudian-history-item-icon' });
    setIcon(iconEl, sessionItemIcon(openState, showRunningPresentation));

    const content = item.createDiv({ cls: 'claudian-history-item-content' });
    const titleEl = content.createDiv({
      cls: 'claudian-history-item-title',
      text: conversation.title,
    });
    titleEl.setAttribute('title', conversation.title);
    if (options.showMetadataPopover) {
      const focusTarget = isSelectable ? content : item;
      focusTarget.setAttribute('tabindex', '0');
      if (isSelectable) {
        focusTarget.setAttribute('role', 'button');
      }
      this.metadataPopover.attach(item, focusTarget, conversation, options);
    } else {
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: sessionStatusText(
          conversationStatus,
          options.sort === 'created' ? conversation.createdAt : conversation.lastActivityAt,
          options.showOpenStateLabels ?? true,
        ),
      });
    }

    if (isSelectable) {
      this.#attachConversationOpening(content, conversation.id, options);
    }

    if (canMultiSelect(options)) {
      this.selection.attach(item, conversation.id);
    }

    const row = (status: HistoryConversationStatus): SessionRow => ({
      conversation,
      status,
      hasAttention: hasAttentionState,
      beginRename: () => this.#beginRename(item, conversation, options),
    });

    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.selection.isPartOfMultiple(conversation.id)) {
        this.actions.selectionMenu(
          options,
          candidate => this.#statusOf(candidate, options).isRunning,
        ).showAtMouseEvent(event);
        return;
      }
      this.selection.clear();
      // The menu reflects the session's status when it opens, not when the row rendered.
      const menuStatus = this.#lookUpStatus(conversation.id, isCurrent ? 'current' : 'closed', options);
      this.actions.rowMenu(row(menuStatus), options).showAtMouseEvent(event);
    });

    const actionsEl = item.createDiv({ cls: 'claudian-history-item-actions' });
    this.#renderTitleGenerationAction(actionsEl, conversation);
    this.actions.renderRowButtons(actionsEl, row(conversationStatus), options);

    if (sessionStatusKind) {
      this.#createSessionStatusIndicator(item, sessionStatusKind);
    }
  }

  #attachConversationOpening(
    content: HTMLElement,
    conversationId: string,
    options: HistoryRenderOptions,
  ): void {
    const failureMessage = 'Failed to load conversation';
    const selectConversation = (): void => {
      runSessionAction(() => options.onSelectConversation(conversationId), failureMessage);
    };
    const openInNewTab = (): void => {
      runSessionAction(
        () => options.onOpenConversationInNewTab?.(conversationId, true),
        failureMessage,
      );
    };
    if (options.showMetadataPopover) {
      content.addEventListener('keydown', (event) => {
        if (event.target !== content || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        selectConversation();
      });
    }

    content.addEventListener('click', (event) => {
      event.stopPropagation();
      if (isNewTabModifierClick(event) && options.onOpenConversationInNewTab) {
        event.preventDefault();
        openInNewTab();
        return;
      }

      selectConversation();
    });

    if (options.onOpenConversationInNewTab) {
      content.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        openInNewTab();
      });
    }
  }

  #renderTitleGenerationAction(actionsEl: HTMLElement, conversation: ConversationMeta): void {
    if (conversation.titleGenerationStatus === 'pending') {
      const loadingEl = actionsEl.createSpan({
        cls: 'claudian-action-btn claudian-action-loading',
      });
      setIcon(loadingEl, 'loader-2');
      loadingEl.setAttribute('aria-label', 'Generating title...');
      return;
    }
    if (
      conversation.titleGenerationStatus !== 'failed'
      && (conversation.titleGenerationStatus || !this.deps.plugin.settings.enableAutoTitleGeneration)
    ) {
      return;
    }
    const regenerateBtn = actionsEl.createEl('button', {
      cls: 'claudian-action-btn',
      attr: { type: 'button' },
    });
    setIcon(regenerateBtn, 'refresh-cw');
    regenerateBtn.setAttribute('aria-label', conversation.titleGenerationStatus === 'failed'
      ? 'Regenerate title' : 'Generate title');
    regenerateBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      runSessionAction(
        () => this.titles.regenerate(conversation.id),
        'Failed to generate title',
      );
    });
  }

  #createSessionStatusIndicator(
    parent: HTMLElement,
    kind: SessionStatusIndicatorKind,
    isGroup = false,
    isVisible = true,
  ): HTMLElement {
    const isRunning = kind === 'running';
    const indicator = parent.createSpan({
      cls: isRunning
        ? [
            isGroup
              ? 'claudian-session-group-running-indicator'
              : 'claudian-session-running-indicator',
            isGroup && isVisible
              ? 'claudian-session-group-running-indicator--visible'
              : '',
          ].filter(Boolean).join(' ')
        : [
            'claudian-session-status-indicator',
            `claudian-session-status-indicator--${kind}`,
            isGroup ? 'claudian-session-group-status-indicator' : '',
            isGroup && isVisible
              ? 'claudian-session-group-status-indicator--visible'
              : '',
          ].filter(Boolean).join(' '),
    });
    const { icon, label } = indicatorPresentation(kind);
    setIcon(indicator, icon);
    indicator.setAttribute('aria-label', label);
    return indicator;
  }

  #statusOf(
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): HistoryConversationStatus {
    return this.#lookUpStatus(
      conversation.id,
      conversation.id === this.deps.getCurrentConversationId() ? 'current' : 'closed',
      options,
    );
  }

  #lookUpStatus(
    conversationId: string,
    fallbackOpenState: HistoryConversationOpenState,
    options: HistoryRenderOptions,
  ): HistoryConversationStatus {
    return options.getConversationStatus?.(conversationId) ?? {
      openState: options.getConversationOpenState?.(conversationId) ?? fallbackOpenState,
      isRunning: false,
    };
  }

  #renderRecencyDivider(
    list: HTMLElement,
    section: SessionListSection,
    options: HistoryRenderOptions,
  ): void {
    const divider = list.createDiv({ cls: 'claudian-session-recency-divider' });
    divider.createSpan({ cls: 'claudian-session-recency-divider-label', text: section.label });
    const buildMenu = this.actions.groupMenu(
      { conversations: section.conversations },
      options,
      conversation => this.#statusOf(conversation, options).isRunning,
    );
    if (!buildMenu) return;

    // A native button keeps the group actions reachable by keyboard; right-click stays a shortcut.
    const actionsButton = divider.createEl('button', {
      cls: 'claudian-session-recency-divider-action',
      attr: { type: 'button', 'aria-label': `Actions for ${section.label}`, 'aria-haspopup': 'menu' },
    });
    setIcon(actionsButton, 'more-horizontal');
    actionsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const rect = actionsButton.getBoundingClientRect();
      buildMenu().showAtPosition({ x: rect.left, y: rect.bottom });
    });
    divider.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      buildMenu().showAtMouseEvent(event);
    });
  }

  #beginRename(
    item: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    const beginRename = (targetItem: HTMLElement): void => {
      this.inlineRename.begin(targetItem, {
        currentTitle: conversation.title,
        rename: title => this.deps.plugin.renameConversation(conversation.id, title),
        onFinished: () => options.onRerender(),
      });
    };
    if (options.onRequestInlineRename) {
      options.onRequestInlineRename({
        beginRename,
        conversationId: conversation.id,
      });
      return;
    }

    beginRename(item);
  }
}
