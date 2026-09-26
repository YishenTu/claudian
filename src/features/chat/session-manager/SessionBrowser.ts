import { Menu, Notice, setIcon } from 'obsidian';

import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderIconSvg, TitleGenerationService } from '../../../core/providers/types';
import type {
  ConversationMeta,
  SessionManagerOrganization,
  SessionManagerSort,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { createProviderIconSvg } from '../../../shared/icons';
import { extractUserDisplayContent } from '../../../utils/context';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import type { TabAttention } from '../state/types';
import {
  getLinkedContentTitle,
  isLegacyProvisionalLinkedContent,
  organizeSessionList,
  type SessionListSection,
} from './SessionListOrganizer';

function runConversationAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
}

const DEFAULT_HISTORY_PAGE_SIZE = 100;
export type HistoryConversationOpenState = 'closed' | 'open' | 'current';

export type HistoryConversationStatus = {
  openState: HistoryConversationOpenState;
  isRunning: boolean;
  attention?: TabAttention;
  location?: 'current-view' | 'other-view';
  tabIndex?: number;
};

type SessionStatusIndicatorKind = 'action-required' | 'error' | 'running';

type HistoryRenderOptions = {
  onSelectConversation: (id: string) => Promise<void>;
  onOpenConversationInNewTab?: (id: string, activate?: boolean) => Promise<void>;
  getConversationOpenState?: (id: string) => HistoryConversationOpenState;
  getConversationStatus?: (id: string) => HistoryConversationStatus;
  getProviderIcon?: (conversation: ConversationMeta) => ProviderIconSvg | null | undefined;
  getModelLabel?: (conversation: ConversationMeta) => string;
  onRerender: () => void;
  signal?: AbortSignal;
  pageSize?: number;
  visibleCount?: number;
  showOpenStateActions?: boolean;
  showOpenStateLabels?: boolean;
  showMetadataPopover?: boolean;
  organization?: SessionManagerOrganization;
  sort?: SessionManagerSort;
  language?: string;
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
  collapsedGroupKeys?: ReadonlySet<string>;
  onGroupCollapseChange?: (groupKey: string, collapsed: boolean) => void;
  onGroupKeysChange?: (groupKeys: readonly string[]) => void;
  onSetConversationsArchived?: (ids: readonly string[]) => Promise<void>;
  onSetLinkedContentPinned?: (contentPath: string, isPinned: boolean) => Promise<void>;
  onStartLinkedContentConversation?: (contentPath: string) => Promise<void>;
  pinnedLinkedContentPaths?: ReadonlySet<string>;
  preserveListState?: boolean;
  showAttentionState?: boolean;
  showPinnedSection?: boolean;
  showArchivedSection?: boolean;
  sessionScope?: 'active' | 'archived';
  sessionActionMode?: 'active' | 'archived';
  historyHeaderLabel?: string;
  allowConversationSelection?: boolean;
  searchQuery?: string;
  onSetConversationPinned?: (id: string, isPinned: boolean) => Promise<void>;
  onSetConversationArchived?: (id: string, isArchived: boolean) => Promise<void>;
  onAssignConversationToDevice?: (id: string) => Promise<void>;
  onBeforeRestoreListState?: (container: HTMLElement) => void;
  onRequestInlineRename?: (request: {
    beginRename: (item: HTMLElement) => void;
    conversationId: string;
  }) => void;
  showInlinePinAction?: boolean;
};

type HistorySurfaceRenderOptions = Omit<HistoryRenderOptions, 'onRerender'> & {
  onRerender?: () => void;
};

type HistoryScrollAnchor = {
  conversationId: string;
  viewportOffset: number;
};

export interface SessionBrowserDeps {
  plugin: ChatFeatureHost;
  getCurrentConversationId: () => string | null;
  isStreaming: () => boolean;
  reloadActiveConversation: () => Promise<void>;
  getTitleGenerationService: () => TitleGenerationService | null;
  onListChanged: () => void;
}

export class SessionBrowser {
  private activeInlineRename: {
    cancel: () => void;
    input: HTMLInputElement;
  } | null = null;
  private metadataPopoverCleanup: (() => void) | null = null;
  private metadataPopoverCloseTimer: number | null = null;
  private metadataPopoverEl: HTMLElement | null = null;
  private metadataPopoverTarget: HTMLElement | null = null;
  private metadataPopoverSequence = 0;
  private metadataPopoverView: {
    el: HTMLElement;
    linkedContent: HTMLElement;
    provider: HTMLElement;
    created: HTMLElement;
    lastActive: HTMLElement;
    providerIcon: SVGElement | null;
    providerIconKey: string;
  } | null = null;

  constructor(private readonly deps: SessionBrowserDeps) {}

  dispose(): void {
    this.cancelInlineRename();
    this.#closeSessionMetadataPopover();
    this.metadataPopoverView = null;
  }

  cancelInlineRename(): boolean {
    const activeInlineRename = this.activeInlineRename;
    if (!activeInlineRename) return false;
    if (activeInlineRename.input.isConnected === false) {
      this.activeInlineRename = null;
      return false;
    }

    this.activeInlineRename = null;
    activeInlineRename.cancel();
    return true;
  }

  #renderHistoryItems(
    container: HTMLElement,
    options: HistoryRenderOptions
  ): void {
    const { plugin } = this.deps;
    if (options.signal?.aborted) return;
    if (options.showMetadataPopover) {
      this.#closeSessionMetadataPopover();
    }

    const previousList = options.preserveListState
      ? container.querySelector<HTMLElement>('.claudian-history-list')
      : null;
    const previousSessionList = previousList?.querySelector<HTMLElement>(
      '.claudian-session-list-items',
    ) ?? previousList;
    const previousPinnedSection = previousList?.querySelector<HTMLElement>(
      '.claudian-history-section--pinned',
    );
    const previousPinnedList = previousPinnedSection?.querySelector<HTMLElement>(
      '.claudian-history-section-items',
    );
    const previousSessionScrollTop = previousSessionList?.scrollTop ?? 0;
    const previousPinnedScrollTop = previousPinnedList?.scrollTop ?? 0;
    const previousVisibleCountFromState = Number(previousList?.dataset.visibleCount);
    const previousVisibleCount = Number.isFinite(previousVisibleCountFromState)
      && previousVisibleCountFromState > 0
      ? previousVisibleCountFromState
      : previousList?.querySelectorAll('.claudian-history-item').length ?? 0;
    const previousScrollAnchors = previousSessionList
      ? this.#captureHistoryScrollAnchors(previousSessionList)
      : [];
    const organization = options.organization ?? 'list';

    if (
      this.activeInlineRename
      && container.contains(this.activeInlineRename.input)
    ) {
      this.activeInlineRename = null;
    }
    container.empty();

    const allConversations = plugin.getConversationList();
    const scopedConversations = options.sessionScope === 'archived'
      ? allConversations.filter(conversation => conversation.isArchived)
      : options.sessionScope === 'active'
        ? allConversations.filter(conversation => !conversation.isArchived)
        : allConversations;
    const searchTerms = (options.searchQuery ?? '')
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const filteredConversations = searchTerms.length === 0
      ? scopedConversations
      : scopedConversations.filter((conversation) => {
          const searchableText = [conversation.title, conversation.linkedContentPath ?? '']
            .join('\n')
            .toLocaleLowerCase();
          return searchTerms.every(term => searchableText.includes(term));
        });
    const conversationsByLinkedContent = new Map<string, ConversationMeta[]>();
    for (const conversation of scopedConversations) {
      if (!conversation.linkedContentPath) continue;
      const noteConversations = conversationsByLinkedContent.get(conversation.linkedContentPath) ?? [];
      noteConversations.push(conversation);
      conversationsByLinkedContent.set(conversation.linkedContentPath, noteConversations);
    }
    const pinnedLinkedContentPaths = organization === 'linked-content'
      && options.showPinnedSection
      && options.sessionScope !== 'archived'
      ? options.pinnedLinkedContentPaths ?? new Set<string>()
      : new Set<string>();
    const isInPinnedContentGroup = (conversation: ConversationMeta): boolean => (
      !!conversation.linkedContentPath
      && pinnedLinkedContentPaths.has(conversation.linkedContentPath)
    );
    const pinnedContentConversations = filteredConversations.filter(isInPinnedContentGroup);
    const pinnedConversations = options.showPinnedSection
      ? filteredConversations.filter(conversation => (
          conversation.isPinned && !isInPinnedContentGroup(conversation)
        ))
      : [];
    const sessionConversations = options.showPinnedSection
      ? filteredConversations.filter(conversation => (
          !conversation.isPinned && !isInPinnedContentGroup(conversation)
        ))
      : filteredConversations;
    const pinnedPathsWithMatchingSessions = new Set(
      pinnedContentConversations.flatMap(conversation => (
        conversation.linkedContentPath ? [conversation.linkedContentPath] : []
      )),
    );
    const visiblePinnedContentPaths = [...pinnedLinkedContentPaths].filter((contentPath) => (
      searchTerms.length === 0
      || pinnedPathsWithMatchingSessions.has(contentPath)
      || searchTerms.every(term => contentPath.toLocaleLowerCase().includes(term))
    ));
    const pinnedContentSections = organizeSessionList(pinnedContentConversations, {
      organization: 'linked-content',
      sort: options.sort ?? 'last-updated',
      language: options.language ?? 'en',
      includeContentPaths: visiblePinnedContentPaths,
      contentExists: options.contentExists,
      contentIsNote: options.contentIsNote,
    }).filter(section => section.contentPath !== undefined);
    const showSessionSections = options.showPinnedSection || options.showArchivedSection;

    let list: HTMLElement;
    let sessionList: HTMLElement;
    let pinnedList: HTMLElement | null = null;
    if (showSessionSections) {
      list = container.createDiv({ cls: 'claudian-history-list' });
      if (pinnedConversations.length > 0 || pinnedContentSections.length > 0) {
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
      options.visibleCount ?? previousVisibleCount,
    );
    list.dataset.visibleCount = String(visibleCount);

    if (filteredConversations.length === 0 && pinnedContentSections.length === 0) {
      if (organization === 'linked-content') {
        options.onGroupKeysChange?.([]);
      }
      sessionList.createDiv({
        cls: 'claudian-history-empty',
        text: searchTerms.length > 0 ? 'No matching sessions' : 'No conversations',
      });
      options.onBeforeRestoreListState?.(container);
      if (pinnedList) pinnedList.scrollTop = previousPinnedScrollTop;
      this.restoreHistoryListPosition(
        sessionList,
        previousSessionScrollTop,
        previousScrollAnchors,
      );
      return;
    }

    const sortedPinnedConversations = organizeSessionList(pinnedConversations, {
      organization: 'list',
      sort: options.sort ?? 'last-updated',
      language: options.language ?? 'en',
    })[0]?.conversations ?? [];
    const sections = organizeSessionList(sessionConversations, {
      organization,
      sort: options.sort ?? 'last-updated',
      language: options.language ?? 'en',
      contentExists: options.contentExists,
      contentIsNote: options.contentIsNote,
    });
    if (organization === 'linked-content') {
      options.onGroupKeysChange?.([
        ...pinnedContentSections.map(({ key }) => key),
        ...sections.map(({ key }) => key),
      ]);
    }
    const visiblePinnedContentConversationTotal = pinnedContentSections.reduce((total, section) => (
      options.collapsedGroupKeys?.has(section.key)
        ? total
        : total + section.conversations.length
    ), 0);
    const visibleSessionConversationTotal = organization === 'linked-content'
      ? sections.reduce((total, section) => (
          options.collapsedGroupKeys?.has(section.key)
            ? total
            : total + section.conversations.length
        ), 0)
      : sessionConversations.length;
    const visibleConversationTotal = visiblePinnedContentConversationTotal
      + pinnedConversations.length
      + visibleSessionConversationTotal;
    let renderedConversationCount = 0;

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
          section.contentPath
            ? conversationsByLinkedContent.get(section.contentPath) ?? []
            : section.conversations,
        );
        renderedConversationCount += visibleConversations.length;
      }

      const visiblePinnedConversations = sortedPinnedConversations.slice(
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
          section.contentPath
            ? conversationsByLinkedContent.get(section.contentPath) ?? []
            : section.conversations,
        );
      } else {
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
          list.dataset.visibleCount = String(nextVisibleCount);
          options.onRerender();
          return;
        }
        this.#renderHistoryItems(container, {
          ...options,
          visibleCount: nextVisibleCount,
        });
      });
    }

    options.onBeforeRestoreListState?.(container);
    if (pinnedList) pinnedList.scrollTop = previousPinnedScrollTop;
    this.restoreHistoryListPosition(
      sessionList,
      previousSessionScrollTop,
      previousScrollAnchors,
    );
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
      this.#getHistoryConversationStatusForMetadata(conversation, options)
    ));
    const groupStatusKind = this.#getGroupSessionStatusIndicatorKind(
      conversationStatuses,
      options,
    );
    const hasReviewConversation = options.showAttentionState === true
      && options.sessionScope !== 'archived'
      && conversationStatuses.some(({ attention }) => (
        attention?.kind === 'review' && attention.outcome === 'completed'
      ));
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
      newConversationButton.setAttribute(
        'title',
        `New chat for ${section.label ?? contentPath}`,
      );
      const startConversation = (): void => {
        runConversationAction(
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
    const onSetLinkedContentPinned = options.onSetLinkedContentPinned;
    const onSetConversationsArchived = options.onSetConversationsArchived;
    const isPinnedLinkedContent = contentPath
      ? options.pinnedLinkedContentPaths?.has(contentPath) ?? false
      : false;
    const canToggleLinkedContentPin = !!(
      contentPath
      && onSetLinkedContentPinned
      && (section.kind === 'content' || section.kind === 'missing' || isPinnedLinkedContent)
    );
    const canArchiveLinkedContentSessions = !!(
      contentPath
      && onSetConversationsArchived
      && options.sessionActionMode === 'active'
    );
    if (
      contentPath
      && (canToggleLinkedContentPin || canArchiveLinkedContentSessions)
    ) {
      groupHeader.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu().setUseNativeMenu(false);
        if (canToggleLinkedContentPin && onSetLinkedContentPinned) {
          menu.addItem(menuItem => menuItem
            .setTitle(isPinnedLinkedContent ? 'Unpin Linked content' : 'Pin Linked content')
            .onClick(() => {
              runConversationAction(
                () => onSetLinkedContentPinned(contentPath, !isPinnedLinkedContent),
                isPinnedLinkedContent
                  ? 'Failed to unpin Linked content'
                  : 'Failed to pin Linked content',
              );
            }));
        }
        if (canArchiveLinkedContentSessions && onSetConversationsArchived) {
          const archivableConversationIds = linkedContentConversations
            .filter(conversation => (
              !this.#getHistoryConversationStatusForMetadata(conversation, options).isRunning
            ))
            .map(conversation => conversation.id);
          if (canToggleLinkedContentPin) menu.addSeparator();
          menu.addItem((menuItem) => {
            menuItem
              .setTitle('Archive all sessions')
              .setDisabled(archivableConversationIds.length === 0);
            if (archivableConversationIds.length > 0) {
              menuItem.onClick(() => {
                runConversationAction(
                  () => onSetConversationsArchived(archivableConversationIds),
                  'Failed to archive Linked content sessions',
                );
              });
            }
          });
        }
        menu.showAtMouseEvent(event);
      });
    }

    for (const conversation of visibleConversations) {
      this.#renderHistoryConversationItem(groupBody, conversation, options);
    }
  }

  #captureHistoryScrollAnchors(list: HTMLElement): HistoryScrollAnchor[] {
    const listRect = list.getBoundingClientRect();
    if (listRect.height <= 0) return [];

    return Array.from(list.querySelectorAll<HTMLElement>('.claudian-history-item'))
      .map((item): HistoryScrollAnchor | null => {
        const conversationId = item.getAttribute('data-conversation-id');
        const itemRect = item.getBoundingClientRect();
        if (
          !conversationId
          || itemRect.height <= 0
          || itemRect.bottom <= listRect.top
          || itemRect.top >= listRect.bottom
        ) return null;
        return {
          conversationId,
          viewportOffset: itemRect.top - listRect.top,
        };
      })
      .filter((anchor): anchor is HistoryScrollAnchor => anchor !== null);
  }

  private restoreHistoryListPosition(
    list: HTMLElement,
    previousScrollTop: number,
    anchors: readonly HistoryScrollAnchor[],
  ): void {
    list.scrollTop = previousScrollTop;
    if (anchors.length === 0) return;

    const items = Array.from(
      list.querySelectorAll<HTMLElement>('.claudian-history-item'),
    );
    const listTop = list.getBoundingClientRect().top;
    for (const anchor of anchors) {
      const item = items.find(candidate => (
        candidate.getAttribute('data-conversation-id') === anchor.conversationId
      ));
      if (!item) continue;

      const itemRect = item.getBoundingClientRect();
      if (itemRect.height <= 0) continue;
      list.scrollTop += itemRect.top - listTop - anchor.viewportOffset;
      return;
    }
  }

  #renderHistoryConversationItem(
    list: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    if (options.signal?.aborted) return;

    const conversationStatus = this.#getHistoryConversationStatusForMetadata(
      conversation,
      options,
    );
    const { openState, isRunning } = conversationStatus;
    const hasAttentionState = options.showAttentionState === true
      && options.sessionScope !== 'archived'
      && conversationStatus.attention !== null
      && conversationStatus.attention !== undefined;
    const showReviewState = hasAttentionState
      && conversationStatus.attention?.kind === 'review'
      && conversationStatus.attention.outcome === 'completed';
    const sessionStatusKind = this.#getSessionStatusIndicatorKind(
      conversationStatus,
      options,
    );
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
    setIcon(iconEl, this.#getHistoryItemIcon(openState, showRunningPresentation));

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
      this.#attachSessionMetadataPopover(item, focusTarget, conversation, options);
    } else {
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: this.#getHistoryItemStatusText(
          conversationStatus,
          this.#getHistoryItemTimestamp(conversation, options),
          options.showOpenStateLabels ?? true,
        ),
      });
    }

    if (isSelectable) {
      const selectConversation = (): void => {
        runConversationAction(
          () => this.#runHistoryAction(
            () => options.onSelectConversation(conversation.id),
            'Failed to load conversation',
          ),
          'Failed to load conversation',
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
        if (this.#isHistoryNewTabModifierClick(event) && options.onOpenConversationInNewTab) {
          event.preventDefault();
          runConversationAction(
            () => this.#runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversation.id, true),
              'Failed to load conversation',
            ),
            'Failed to load conversation',
          );
          return;
        }

        selectConversation();
      });

      if (options.onOpenConversationInNewTab) {
        content.addEventListener('auxclick', (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          runConversationAction(
            () => this.#runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversation.id, true),
              'Failed to load conversation',
            ),
            'Failed to load conversation',
          );
        });
      }
    }

    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#showHistoryContextMenu(
        item,
        conversation,
        isCurrent,
        options,
        event,
      );
    });

    const actions = item.createDiv({ cls: 'claudian-history-item-actions' });
    if (conversation.titleGenerationStatus === 'pending') {
      const loadingEl = actions.createSpan({
        cls: 'claudian-action-btn claudian-action-loading',
      });
      setIcon(loadingEl, 'loader-2');
      loadingEl.setAttribute('aria-label', 'Generating title...');
    } else if (conversation.titleGenerationStatus === 'failed'
      || (!conversation.titleGenerationStatus && this.deps.plugin.settings.enableAutoTitleGeneration)) {
      const regenerateBtn = actions.createEl('button', { cls: 'claudian-action-btn', attr: { type: 'button' } });
      setIcon(regenerateBtn, 'refresh-cw');
      regenerateBtn.setAttribute('aria-label', conversation.titleGenerationStatus === 'failed'
        ? 'Regenerate title' : 'Generate title');
      regenerateBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        runConversationAction(
          () => this.regenerateTitle(conversation.id),
          'Failed to generate title',
        );
      });
    }

    if (openState === 'closed' && options.onOpenConversationInNewTab) {
      const openInNewTabBtn = actions.createEl('button', {
        cls: 'claudian-action-btn claudian-open-new-tab-btn',
      });
      setIcon(openInNewTabBtn, 'square-plus');
      openInNewTabBtn.setAttribute('aria-label', 'Open in new tab');
      openInNewTabBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        runConversationAction(
          () => this.#runHistoryAction(
            () => options.onOpenConversationInNewTab?.(conversation.id, true),
            'Failed to load conversation',
          ),
          'Failed to load conversation',
        );
      });
    }

    const createDeleteButton = (): void => {
      const deleteBtn = actions.createEl('button', {
        cls: 'claudian-action-btn claudian-delete-btn',
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.setAttribute('aria-label', 'Delete');
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        runConversationAction(
          () => this.#runHistoryAction(
            () => this.#deleteHistoryConversation(conversation.id, options),
            'Failed to delete conversation',
          ),
          'Failed to delete conversation',
        );
      });
    };

    if (conversation.isLegacySession && options.onAssignConversationToDevice) {
      const assignDeviceBtn = actions.createEl('button', {
        cls: 'claudian-action-btn claudian-assign-device-btn',
      });
      setIcon(assignDeviceBtn, 'monitor-down');
      assignDeviceBtn.setAttribute('aria-label', 'Assign to this device');
      assignDeviceBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        runConversationAction(
          () => this.#runHistoryAction(
            () => options.onAssignConversationToDevice?.(conversation.id),
            'Failed to assign session to this device',
          ),
          'Failed to assign session to this device',
        );
      });
    }

    if (options.sessionActionMode === 'active') {
      if (!hasAttentionState) {
        const isPinned = conversation.isPinned === true;
        if (options.showInlinePinAction !== false) {
          const pinBtn = actions.createEl('button', {
            cls: 'claudian-action-btn claudian-pin-btn',
          });
          setIcon(pinBtn, isPinned ? 'pin-off' : 'pin');
          pinBtn.setAttribute('aria-label', isPinned ? 'Unpin' : 'Pin');
          pinBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            runConversationAction(
              () => this.#runHistoryAction(
                () => options.onSetConversationPinned?.(conversation.id, !isPinned),
                isPinned ? 'Failed to unpin session' : 'Failed to pin session',
              ),
              isPinned ? 'Failed to unpin session' : 'Failed to pin session',
            );
          });
        }

        const archiveBtn = actions.createEl('button', {
          cls: 'claudian-action-btn claudian-archive-btn',
        });
        setIcon(archiveBtn, 'archive');
        archiveBtn.setAttribute(
          'aria-label',
          isRunning ? 'Cannot archive a running session' : 'Archive',
        );
        if (isRunning) {
          archiveBtn.setAttribute('disabled', '');
        } else {
          archiveBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            runConversationAction(
              () => this.#runHistoryAction(
                () => options.onSetConversationArchived?.(conversation.id, true),
                'Failed to archive session',
              ),
              'Failed to archive session',
            );
          });
        }
      }
    } else if (options.sessionActionMode === 'archived') {
      const restoreBtn = actions.createEl('button', {
        cls: 'claudian-action-btn claudian-restore-btn',
      });
      setIcon(restoreBtn, 'undo-2');
      restoreBtn.setAttribute('aria-label', 'Restore');
      restoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        runConversationAction(
          () => this.#runHistoryAction(
            () => options.onSetConversationArchived?.(conversation.id, false),
            'Failed to restore session',
          ),
          'Failed to restore session',
        );
      });
      createDeleteButton();
    } else {
      const renameBtn = actions.createEl('button', { cls: 'claudian-action-btn' });
      setIcon(renameBtn, 'pencil');
      renameBtn.setAttribute('aria-label', 'Rename');
      renameBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#showRenameEditor(item, conversation.id, conversation.title, options);
      });
      createDeleteButton();
    }

    if (sessionStatusKind) {
      this.#createSessionStatusIndicator(item, sessionStatusKind);
    }
  }

  #getSessionStatusIndicatorKind(
    status: HistoryConversationStatus,
    options: HistoryRenderOptions,
  ): SessionStatusIndicatorKind | null {
    if (options.showOpenStateLabels !== false) return null;

    const canShowAttention = options.showAttentionState === true
      && options.sessionScope !== 'archived';
    if (canShowAttention && status.attention?.kind === 'action-required') {
      return 'action-required';
    }
    if (status.isRunning) return 'running';
    if (
      canShowAttention
      && status.attention?.kind === 'review'
      && status.attention.outcome === 'error'
    ) {
      return 'error';
    }
    return null;
  }

  #getGroupSessionStatusIndicatorKind(
    statuses: readonly HistoryConversationStatus[],
    options: HistoryRenderOptions,
  ): SessionStatusIndicatorKind | null {
    const kinds = statuses.map(status => (
      this.#getSessionStatusIndicatorKind(status, options)
    ));
    if (kinds.includes('action-required')) return 'action-required';
    if (kinds.includes('running')) return 'running';
    if (kinds.includes('error')) return 'error';
    return null;
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
    const icon = kind === 'action-required'
      ? 'alert-circle'
      : kind === 'error'
        ? 'x-circle'
        : 'loader-2';
    const label = kind === 'action-required'
      ? 'Needs your input'
      : kind === 'error'
        ? 'Stopped with an error'
        : 'Running';
    setIcon(indicator, icon);
    indicator.setAttribute('aria-label', label);
    return indicator;
  }

  #getHistoryConversationStatusForMetadata(
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): HistoryConversationStatus {
    const fallbackOpenState: HistoryConversationOpenState =
      conversation.id === this.deps.getCurrentConversationId() ? 'current' : 'closed';
    return this.getHistoryConversationStatus(
      conversation.id,
      fallbackOpenState,
      options,
    );
  }

  #attachSessionMetadataPopover(
    item: HTMLElement,
    focusTarget: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    item.addEventListener('mouseenter', () => {
      this.#showSessionMetadataPopover(item, focusTarget, conversation, options);
    });
    item.addEventListener('mouseleave', () => {
      this.#scheduleSessionMetadataPopoverClose(item);
    });
    focusTarget.addEventListener('focusin', () => {
      this.#showSessionMetadataPopover(item, focusTarget, conversation, options);
    });
    focusTarget.addEventListener('focusout', () => {
      queueMicrotask(() => {
        const activeElement = item.ownerDocument.activeElement;
        if (activeElement && focusTarget.contains(activeElement)) return;
        if (typeof item.matches === 'function' && item.matches(':hover')) return;
        if (this.metadataPopoverTarget === item) {
          this.#scheduleSessionMetadataPopoverClose(item);
        }
      });
    });
    focusTarget.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.metadataPopoverTarget !== item) return;
      event.stopPropagation();
      this.#closeSessionMetadataPopover();
    });
  }

  #showSessionMetadataPopover(
    item: HTMLElement,
    descriptionTarget: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    if (this.metadataPopoverEl && this.metadataPopoverTarget === item) {
      this.#cancelSessionMetadataPopoverClose();
      return;
    }
    // Measure the anchor before removing/inserting popover DOM.
    const targetRect = item.getBoundingClientRect();
    this.#closeSessionMetadataPopover();

    const document = item.ownerDocument;
    if (!document.body) return;
    const view = this.#getSessionMetadataPopoverView(document);
    const hoverEl = view.el;
    this.metadataPopoverEl = hoverEl;
    this.metadataPopoverTarget = item;

    const popoverId = `claudian-session-metadata-${++this.metadataPopoverSequence}`;
    hoverEl.setAttribute('id', popoverId);
    descriptionTarget.setAttribute('aria-describedby', popoverId);

    const language = options.language ?? 'en';
    const linkedContentPath = conversation.linkedContentPath;
    const hasLinkedContent = !!linkedContentPath
      && !isLegacyProvisionalLinkedContent(linkedContentPath, {
        contentExists: options.contentExists,
        contentIsNote: options.contentIsNote,
        language,
      });
    view.linkedContent.parentElement!.classList.toggle('claudian-hidden', !hasLinkedContent);
    view.linkedContent.textContent = hasLinkedContent ? getLinkedContentTitle(linkedContentPath) : '';
    view.linkedContent.title = hasLinkedContent ? linkedContentPath : '';
    view.provider.textContent = options.getModelLabel?.(conversation) ?? conversation.selectedModel ?? '';
    view.created.textContent = this.formatMetadataDate(conversation.createdAt);
    view.lastActive.textContent = this.formatMetadataDateTime(conversation.lastActivityAt);

    const icon = options.getProviderIcon?.(conversation);
    const iconKey = JSON.stringify([conversation.providerId, icon ?? null]);
    if (view.providerIconKey !== iconKey) {
      view.providerIcon?.remove();
      const row = view.provider.parentElement!;
      row.classList.toggle('claudian-session-metadata-row--provider-no-icon', !icon);
      view.providerIcon = icon ? createProviderIconSvg(icon, {
        className: 'claudian-session-metadata-provider-icon', dataProvider: conversation.providerId,
        height: 14, width: 14, parent: row,
      }) : null;
      if (view.providerIcon) row.prepend(view.providerIcon);
      view.providerIconKey = iconKey;
    }
    hoverEl.removeClass('claudian-hidden');
    document.body.appendChild(hoverEl);
    this.#positionSessionMetadataPopover(targetRect, hoverEl);
    const cancelClose = (): void => this.#cancelSessionMetadataPopoverClose();
    const scheduleClose = (): void => this.#scheduleSessionMetadataPopoverClose(item);
    const closeForViewportChange = (): void => {
      if (this.metadataPopoverEl === hoverEl) this.#closeSessionMetadataPopover();
    };
    const closeForExternalScroll = (event: Event): void => {
      if (event.composedPath().includes(hoverEl)) return;
      closeForViewportChange();
    };
    hoverEl.addEventListener('mouseenter', cancelClose);
    hoverEl.addEventListener('mouseleave', scheduleClose);
    document.addEventListener('scroll', closeForExternalScroll, true);
    document.defaultView?.addEventListener('resize', closeForViewportChange);

    const signal = options.signal;
    const closeOnAbort = (): void => {
      if (this.metadataPopoverEl === hoverEl) {
        this.#closeSessionMetadataPopover();
      }
    };
    signal?.addEventListener('abort', closeOnAbort, { once: true });
    this.metadataPopoverCleanup = () => {
      hoverEl.removeEventListener('mouseenter', cancelClose);
      hoverEl.removeEventListener('mouseleave', scheduleClose);
      document.removeEventListener('scroll', closeForExternalScroll, true);
      document.defaultView?.removeEventListener('resize', closeForViewportChange);
      signal?.removeEventListener('abort', closeOnAbort);
      if (descriptionTarget.getAttribute('aria-describedby') === popoverId) {
        descriptionTarget.removeAttribute('aria-describedby');
      }
    };
  }

  #positionSessionMetadataPopover(targetRect: DOMRect, popover: HTMLElement): void {
    const document = popover.ownerDocument;
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = document.defaultView?.innerWidth
      ?? document.documentElement?.clientWidth
      ?? 1024;
    const viewportHeight = document.defaultView?.innerHeight
      ?? document.documentElement?.clientHeight
      ?? 768;
    const gap = 8;
    const viewportMargin = 8;

    let left = targetRect.right + gap;
    if (left + popoverRect.width > viewportWidth - viewportMargin) {
      left = targetRect.left - popoverRect.width - gap;
    }
    left = Math.min(
      Math.max(viewportMargin, left),
      Math.max(viewportMargin, viewportWidth - popoverRect.width - viewportMargin),
    );

    const top = Math.min(
      Math.max(viewportMargin, targetRect.top),
      Math.max(viewportMargin, viewportHeight - popoverRect.height - viewportMargin),
    );
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  #scheduleSessionMetadataPopoverClose(target: HTMLElement): void {
    if (this.metadataPopoverTarget !== target) return;
    this.#cancelSessionMetadataPopoverClose();
    const window = target.ownerDocument.defaultView;
    if (!window) {
      this.#closeSessionMetadataPopover();
      return;
    }
    this.metadataPopoverCloseTimer = window.setTimeout(() => {
      if (this.metadataPopoverTarget === target) {
        this.#closeSessionMetadataPopover();
      }
    }, 120);
  }

  #cancelSessionMetadataPopoverClose(): void {
    if (this.metadataPopoverCloseTimer === null) return;
    this.metadataPopoverTarget?.ownerDocument.defaultView?.clearTimeout(
      this.metadataPopoverCloseTimer,
    );
    this.metadataPopoverCloseTimer = null;
  }

  #renderSessionMetadataRow(
    parent: HTMLElement,
    icon: string,
    label: string | null,
    value: string,
    options: { className?: string; title?: string } = {},
  ): HTMLElement {
    const row = parent.createDiv({
      cls: [
        'claudian-session-metadata-row',
        label ? '' : 'claudian-session-metadata-row--unlabeled',
      ].filter(Boolean).join(' '),
    });
    const iconEl = row.createSpan({ cls: 'claudian-session-metadata-icon' });
    setIcon(iconEl, icon);
    if (label) {
      row.createSpan({ cls: 'claudian-session-metadata-label', text: label });
    }
    const valueEl = row.createSpan({
      cls: [
        'claudian-session-metadata-value',
        options.className ?? '',
      ].filter(Boolean).join(' '),
      text: value,
    });
    if (options.title) valueEl.setAttribute('title', options.title);
    return valueEl;
  }

  #getSessionMetadataPopoverView(document: Document) {
    if (this.metadataPopoverView?.el.ownerDocument === document) return this.metadataPopoverView;
    const el = document.body.createDiv({ cls: 'claudian-session-metadata-popover' });
    el.setAttribute('role', 'tooltip');
    const linkedContent = this.#renderSessionMetadataRow(el, 'file-text', null, '', {
      className: 'claudian-session-metadata-value--content',
    });
    const providerRow = el.createDiv({ cls: 'claudian-session-metadata-row claudian-session-metadata-row--provider' });
    const provider = providerRow.createSpan({ cls: 'claudian-session-metadata-value claudian-session-metadata-value--provider' });
    this.metadataPopoverView = {
      el, linkedContent, provider,
      created: this.#renderSessionMetadataRow(el, 'calendar-days', 'Created', ''),
      lastActive: this.#renderSessionMetadataRow(el, 'clock-3', 'Last active', ''),
      providerIcon: null, providerIconKey: '',
    };
    return this.metadataPopoverView;
  }

  #closeSessionMetadataPopover(): void {
    this.#cancelSessionMetadataPopoverClose();
    const popover = this.metadataPopoverEl;
    this.metadataPopoverCleanup?.();
    this.metadataPopoverCleanup = null;
    this.metadataPopoverEl = null;
    this.metadataPopoverTarget = null;
    popover?.addClass('claudian-hidden');
    popover?.remove();
  }

  #getHistoryItemTimestamp(
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): number {
    if (options.sort === 'created') return conversation.createdAt;
    return conversation.lastActivityAt;
  }

  private getHistoryConversationStatus(
    conversationId: string,
    fallbackOpenState: HistoryConversationOpenState,
    options: HistoryRenderOptions,
  ): HistoryConversationStatus {
    const status = options.getConversationStatus?.(conversationId);
    if (status) return status;

    return {
      openState: options.getConversationOpenState?.(conversationId) ?? fallbackOpenState,
      isRunning: false,
    };
  }

  #getHistoryItemStatusText(
    status: HistoryConversationStatus,
    timestamp: number,
    showOpenStateLabels: boolean,
  ): string {
    const { openState, isRunning } = status;
    const location = status.location ?? 'current-view';

    if (!showOpenStateLabels) {
      return this.formatDate(timestamp);
    }

    if (openState !== 'closed' && location === 'other-view') {
      return isRunning ? 'Running in another pane' : 'Open in another pane';
    }

    if (isRunning) {
      if (openState === 'closed') return 'Running';
      return `Running in ${this.#getHistoryTabLabel(status)}`;
    }

    switch (openState) {
      case 'current':
        return typeof status.tabIndex === 'number'
          ? `Current tab ${status.tabIndex}`
          : 'Current session';
      case 'open':
        return `Open in ${this.#getHistoryTabLabel(status)}`;
      case 'closed':
        return this.formatDate(timestamp);
    }
  }

  #getHistoryTabLabel(status: HistoryConversationStatus): string {
    if (typeof status.tabIndex === 'number') {
      return `tab ${status.tabIndex}`;
    }

    if (status.openState === 'current') {
      return 'current tab';
    }

    return 'tab';
  }

  #getHistoryItemIcon(
    openState: HistoryConversationOpenState,
    isRunning: boolean,
  ): string {
    if (isRunning) return 'loader-2';
    if (openState === 'current') return 'message-square-dot';
    return 'message-square';
  }

  #isHistoryNewTabModifierClick(event: MouseEvent): boolean {
    return !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey);
  }

  async #runHistoryAction(
    action: () => Promise<void> | void,
    errorMessage: string,
  ): Promise<void> {
    try {
      await action();
    } catch {
      new Notice(errorMessage);
    }
  }

  #showHistoryContextMenu(
    item: HTMLElement,
    conversation: ConversationMeta,
    isCurrent: boolean,
    options: HistoryRenderOptions,
    event: MouseEvent,
  ): void {
    const { id: conversationId, title } = conversation;
    const menu = new Menu().setUseNativeMenu(false);
    const fallbackOpenState: HistoryConversationOpenState = isCurrent ? 'current' : 'closed';
    const { openState, isRunning } = this.getHistoryConversationStatus(
      conversationId,
      fallbackOpenState,
      options,
    );

    if (options.showOpenStateActions !== false && openState !== 'current') {
      if (openState === 'closed' && options.onOpenConversationInNewTab) {
        menu.addItem((menuItem) => menuItem
          .setTitle('Open in new tab')
          .onClick(() => {
            void this.#runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversationId, true),
              'Failed to load conversation',
            );
          }));
        menu.addItem((menuItem) => menuItem
          .setTitle('Open in background tab')
          .onClick(() => {
            void this.#runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversationId, false),
              'Failed to load conversation',
            );
          }));
      } else if (openState === 'open') {
        menu.addItem((menuItem) => menuItem
          .setTitle('Switch to open session')
          .onClick(() => {
            void this.#runHistoryAction(
              () => options.onSelectConversation(conversationId),
              'Failed to load conversation',
            );
          }));
      }
    }

    if (options.sessionActionMode === 'archived') {
      menu.addItem((menuItem) => menuItem
        .setTitle('Restore')
        .onClick(() => {
          void this.#runHistoryAction(
            () => options.onSetConversationArchived?.(conversationId, false),
            'Failed to restore session',
          );
        }));
      menu.addItem((menuItem) => menuItem
        .setTitle('Delete')
        .onClick(() => {
          void this.#runHistoryAction(
            () => this.#deleteHistoryConversation(conversationId, options),
            'Failed to delete conversation',
          );
        }));
      menu.showAtMouseEvent(event);
      return;
    }

    if (options.onSetConversationPinned) {
      const isPinned = conversation.isPinned === true;
      menu.addItem((menuItem) => menuItem
        .setTitle(isPinned ? 'Unpin' : 'Pin')
        .onClick(() => {
          void this.#runHistoryAction(
            () => options.onSetConversationPinned?.(conversationId, !isPinned),
            isPinned ? 'Failed to unpin session' : 'Failed to pin session',
          );
        }));
    }

    if (options.sessionActionMode === 'active') {
      menu.addItem((menuItem) => menuItem
        .setTitle('Rename')
        .onClick(() => {
          this.#showRenameEditor(item, conversationId, title, options);
        }));
      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Archive')
          .setDisabled(isRunning);
        if (!isRunning) {
          menuItem.onClick(() => {
            void this.#runHistoryAction(
              () => options.onSetConversationArchived?.(conversationId, true),
              'Failed to archive session',
            );
          });
        }
      });
      menu.showAtMouseEvent(event);
      return;
    }

    menu.addItem((menuItem) => menuItem
      .setTitle('Rename')
      .onClick(() => {
        this.#showRenameEditor(item, conversationId, title, options);
      }));
    menu.addItem((menuItem) => menuItem
      .setTitle('Delete')
      .onClick(() => {
        void this.#runHistoryAction(
          () => this.#deleteHistoryConversation(conversationId, options),
          'Failed to delete conversation',
        );
      }));

    menu.showAtMouseEvent(event);
  }

  async #deleteHistoryConversation(
    conversationId: string,
    options: HistoryRenderOptions,
  ): Promise<void> {
    const { plugin } = this.deps;
    if (this.deps.isStreaming() && options.sessionActionMode !== 'archived') return;

    await plugin.deleteConversation(conversationId);
    options.onRerender();

    if (conversationId === this.deps.getCurrentConversationId()) {
      await this.deps.reloadActiveConversation();
    }
  }

  #showRenameEditor(
    item: HTMLElement,
    convId: string,
    currentTitle: string,
    options: HistoryRenderOptions,
  ): void {
    const beginRename = (targetItem: HTMLElement) => {
      this.#showRenameInput(targetItem, convId, currentTitle, options);
    };
    if (options.onRequestInlineRename) {
      options.onRequestInlineRename({
        beginRename,
        conversationId: convId,
      });
      return;
    }

    beginRename(item);
  }

  /** Shows inline rename input for a conversation. */
  #showRenameInput(
    item: HTMLElement,
    convId: string,
    currentTitle: string,
    options: HistoryRenderOptions,
  ): void {
    const titleEl = item.querySelector('.claudian-history-item-title') as HTMLElement;
    if (!titleEl) return;

    const input = item.createEl('input', {
      cls: 'claudian-rename-input',
      attr: { type: 'text', value: currentTitle },
    });

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let isFinishing = false;
    const cancelRename = () => {
      input.value = currentTitle;
      input.blur();
    };
    this.activeInlineRename = { cancel: cancelRename, input };
    const finishRename = async () => {
      if (isFinishing) return;
      isFinishing = true;
      const newTitle = input.value.trim();
      if (!newTitle || newTitle === currentTitle) {
        isFinishing = false;
        options.onRerender();
        return;
      }

      try {
        await this.deps.plugin.renameConversation(convId, newTitle);
        options.onRerender();
      } catch {
        new Notice('Failed to rename conversation');
      } finally {
        isFinishing = false;
      }
    };

    input.addEventListener('blur', () => {
      if (this.activeInlineRename?.input === input) {
        this.activeInlineRename = null;
      }
      runConversationAction(finishRename, 'Failed to rename conversation');
    });
    input.addEventListener('keydown', (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.isComposing) {
        input.blur();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        cancelRename();
      }
    });
  }

  /** Regenerates AI title for a conversation. */
  async regenerateTitle(conversationId: string): Promise<void> {
    const { plugin } = this.deps;
    if (!plugin.settings.enableAutoTitleGeneration) return;
    if (!ProviderRegistry.resolveTitleGenerationSelection(plugin.settings)) {
      new Notice(t('chat.selectAvailableTitleModel'));
      return;
    }

    // Title generation uses the global explicit model selection.
    const fullConv = await plugin.getConversationById(conversationId);
    if (!fullConv || fullConv.messages.length < 1) return;

    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) return;

    // Find first user message by role (not by index)
    const firstUserMsg = fullConv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return;

    const userContent = firstUserMsg.displayContent
      ?? extractUserDisplayContent(firstUserMsg.content)
      ?? firstUserMsg.content;

    // Store current title to check if user renames during generation
    const expectedTitle = fullConv.title;

    // Set pending status before starting generation
    await plugin.updateConversation(conversationId, { titleGenerationStatus: 'pending' });
    this.deps.onListChanged();

    // Fire async AI title generation
    await titleService.generateTitle(
      conversationId,
      userContent,
      async (convId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = await plugin.getConversationById(convId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches expected)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && !userManuallyRenamed) {
          await plugin.renameConversation(convId, result.title);
          await plugin.updateConversation(convId, { titleGenerationStatus: 'success' });
        } else if (!userManuallyRenamed) {
          // Keep existing title, mark as failed (only if user hasn't renamed)
          await plugin.updateConversation(convId, { titleGenerationStatus: 'failed' });
        } else {
          // User manually renamed, clear the status (user's choice takes precedence)
          await plugin.updateConversation(convId, { titleGenerationStatus: undefined });
        }
        this.deps.onListChanged();
      }
    );
  }

  /** Formats a timestamp for display. */
  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  formatMetadataDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  formatMetadataDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString(undefined, {
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  // ============================================
  // History Dropdown Rendering (for ClaudianView)
  // ============================================

  /**
   * Renders the history dropdown content to a provided container.
   * Used by ClaudianView to render the dropdown with custom selection callback.
   */
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
}
