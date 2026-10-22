import { type Menu, setIcon } from 'obsidian';

import type { TitleGenerationService } from '@/core/providers/types';
import type { ConversationMeta, SessionManagerOrganization, SessionManagerSort } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ConversationTitleGeneration } from '@/features/chat/conversation/ConversationTitleGeneration';
import { getProjectSort, renderProjectsHeaderActions } from '@/features/chat/session-manager/ProjectsHeaderActions';
import {
  canMultiSelect,
  type SessionActionOptions,
  SessionActions,
  type SessionRow,
} from '@/features/chat/session-manager/SessionActions';
import { SessionDrag } from '@/features/chat/session-manager/SessionDrag';
import { SessionInlineRename } from '@/features/chat/session-manager/SessionInlineRename';
import {
  deriveSessionListModel,
  type ProjectListSection,
  type SessionListSection,
  sessionManagerSectionKey,
} from '@/features/chat/session-manager/SessionListOrganizer';
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
import { bindMenuToggle, runSessionAction, showMenuAt } from '@/features/chat/session-manager/SessionSurfaceShared';
import { t } from '@/i18n/i18n';

const DEFAULT_HISTORY_PAGE_SIZE = 100;

let sectionLabelSequence = 0;

/**
 * Names a section region by its visible header label. An `aria-label` on the region would make Obsidian show
 * it as a hover tooltip over every row inside.
 */
function labelSectionBy(section: HTMLElement, labelEl: HTMLElement): void {
  const id = `claudian-session-section-label-${++sectionLabelSequence}`;
  labelEl.setAttribute('id', id);
  section.setAttribute('aria-labelledby', id);
}

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
  /**
   * Whether a group (Linked content, project) or a whole section (`sessionManagerSectionKey`) is collapsed, by its
   * key; the surface owns the state and each kind's default. Without it everything is expanded.
   */
  isGroupCollapsed?: (groupKey: string) => boolean;
  onGroupCollapseChange?: (groupKey: string, collapsed: boolean) => void;
  onGroupKeysChange?: (groupKeys: readonly string[]) => void;
  onStartLinkedContentConversation?: (contentPath: string) => Promise<void>;
  pinnedLinkedContentPaths?: ReadonlySet<string>;
  preserveListState?: boolean;
  /**
   * Which elements the surface's stylesheet scrolls: each section on its own (the persistent sidebar), or the whole
   * list (the default, as the compact menu does). Scroll capture and restoration follow it.
   */
  scrollLayout?: 'sections' | 'list';
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
  private readonly metadataPopover = new SessionMetadataPopover(() => this.drag.isDragging);
  private readonly selection = new SessionMultiSelection();
  private readonly inlineRename = new SessionInlineRename();
  private readonly drag = new SessionDrag({
    onDragStart: () => this.metadataPopover.close(),
    onDrop: (conversationIds, target) => this.actions.placeSessions(conversationIds, target),
  });
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
    this.drag.end();
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
    const canDrag = this.#canDrag(options);
    if (canDrag) this.drag.beginRender(container); else this.drag.end();

    const sectionScrolling = options.scrollLayout === 'sections';
    const previousPosition = options.preserveListState
      ? captureSessionListPosition(container, sectionScrolling)
      : INITIAL_SESSION_LIST_POSITION;
    const organization = options.organization ?? 'list';
    const isGrouped = organization === 'linked-content';

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
      projects: plugin.projects,
      projectSort: getProjectSort(plugin),
      isGroupCollapsed: options.isGroupCollapsed,
      contentExists: options.contentExists,
      contentIsNote: options.contentIsNote,
      groupByRecency: options.groupByRecency ? { now: Date.now() } : undefined,
    });
    const { conversationsByLinkedContent, pinnedContentSections, sections } = model;
    const showSessionSections = options.showPinnedSection || options.showArchivedSection || model.projectSections !== null;

    let list: HTMLElement;
    let sessionList: HTMLElement;
    let pinnedList: HTMLElement | null = null;
    let projectsList: HTMLElement | null = null;
    if (showSessionSections) {
      list = container.createDiv({ cls: 'claudian-history-list' });
      const hasPinned = model.pinnedProjectSections.length > 0
        || model.pinnedConversations.length > 0
        || pinnedContentSections.length > 0;
      // With nothing pinned, the header alone is a drop target that shows only while a drag is in progress.
      if (hasPinned || canDrag) {
        const pinnedSection = list.createDiv({
          cls: ['claudian-history-section', hasPinned ? 'claudian-history-section--pinned' : ''].filter(Boolean).join(' '),
          attr: { role: 'region' },
        });
        const pinnedHeader = pinnedSection.createDiv({
          cls: 'claudian-history-header claudian-session-section-header',
        });
        labelSectionBy(pinnedSection, pinnedHeader.createSpan({
          cls: 'claudian-history-section-label',
          text: 'Pinned',
        }));
        if (hasPinned) {
          pinnedList = pinnedSection.createDiv({
            cls: 'claudian-history-section-items',
          });
          if (canDrag) this.drag.attachTarget(pinnedSection, { kind: 'pinned' });
          // Like the Projects section, pinned projects show even when no session matches.
          for (const projectSection of model.pinnedProjectSections) {
            this.#renderProjectSection(pinnedList, projectSection, options, model.conversationsByProject);
          }
        } else {
          this.drag.attachPinnedPlaceholder(pinnedSection);
        }
      }
      if (model.projectSections) {
        projectsList = this.#renderProjectsSection(list, model.projectSections, options, model.conversationsByProject);
      }

      const sessionsLabel = options.showArchivedSection ? 'Archived' : 'Sessions';
      const sessionsSection = list.createDiv({
        cls: [
          'claudian-history-section',
          options.showArchivedSection
            ? 'claudian-history-section--archived'
            : 'claudian-history-section--sessions',
        ].join(' '),
        attr: { role: 'region' },
      });
      const sessionsHeader = sessionsSection.createDiv({
        cls: [
          'claudian-history-header',
          'claudian-session-section-header',
          'claudian-session-list-header',
        ].join(' '),
      });
      sessionList = sessionsSection.createDiv({
        cls: 'claudian-history-section-items claudian-session-list-items',
      });
      if (canDrag) this.drag.attachTarget(sessionsSection, { kind: 'sessions' });
      this.#renderSectionToggle(
        sessionsSection,
        sessionsHeader,
        sessionsLabel,
        sessionList,
        sessionManagerSectionKey(options.showArchivedSection ? 'archived' : 'sessions'),
        options,
      );
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
      restoreSessionListPosition(
        previousPosition,
        sectionScrolling ? sessionList : list,
        pinnedList,
        sectionScrolling ? projectsList : null,
      );
    };

    if (model.groupKeys) options.onGroupKeysChange?.(model.groupKeys);
    if (model.isEmpty) {
      sessionList.createDiv({
        cls: 'claudian-history-empty',
        text: model.hasSearchTerms ? t('chat.sessions.noMatch') : t('chat.sessions.empty'),
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
        const isCollapsed = options.isGroupCollapsed?.(section.key) ?? false;
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
      const isCollapsed = isGrouped
        && (options.isGroupCollapsed?.(section.key) ?? false);
      const visibleConversations = isCollapsed || remainingVisibleCount <= 0
        ? []
        : section.conversations.slice(0, remainingVisibleCount);
      if (!isGrouped && visibleConversations.length === 0) break;

      if (isGrouped) {
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
    const { groupHeader, groupStatusKind, showGroupReviewState } = this.#createGroupHeader(
      list,
      section,
      isCollapsed,
      options,
      [`claudian-session-group-header--${section.kind}`],
    );
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
    if (buildGroupMenu) this.#openMenuOnContextMenu(groupHeader, buildGroupMenu);

    for (const conversation of visibleConversations) {
      this.#renderHistoryConversationItem(groupBody, conversation, options);
    }
  }

  /**
   * A group's header row: its kind, and its members' status for the indicator and review attention a collapsed
   * group shows. The caller fills the row and places the indicator.
   */
  #createGroupHeader(
    list: HTMLElement,
    section: SessionListSection,
    isCollapsed: boolean,
    options: HistoryRenderOptions,
    modifierClasses: readonly string[],
  ): {
    groupHeader: HTMLElement;
    groupStatusKind: SessionStatusIndicatorKind | null;
    showGroupReviewState: boolean;
  } {
    const conversationStatuses = section.conversations.map(conversation => (
      this.#statusOf(conversation, options)
    ));
    const groupStatusKind = groupIndicatorKind(conversationStatuses, options);
    const hasReviewConversation = canShowAttention(options)
      && conversationStatuses.some(({ attention }) => isCompletedReview(attention));
    const showGroupReviewState = (groupStatusKind === null || groupStatusKind === 'unread')
      && hasReviewConversation;
    const groupHeader = list.createDiv({
      cls: [
        'claudian-session-group-header',
        ...modifierClasses,
        showGroupReviewState && isCollapsed
          ? 'claudian-session-group-header--attention'
          : '',
      ].filter(Boolean).join(' '),
    });
    groupHeader.setAttribute('data-group-kind', section.kind);
    return { groupHeader, groupStatusKind, showGroupReviewState };
  }

  /** Right-click opens the menu as a shortcut; a focusable control keeps it reachable by keyboard. */
  #openMenuOnContextMenu(el: HTMLElement, buildMenu: () => Menu): void {
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      buildMenu().showAtMouseEvent(event);
    });
  }

  /**
   * A section header's label as a native toggle that hides the section's items in place, so keyboard focus
   * stays on it; the surface keeps the state with its group collapse. The header actions are its siblings.
   */
  #renderSectionToggle(
    section: HTMLElement,
    header: HTMLElement,
    label: string,
    items: HTMLElement,
    key: string,
    options: HistoryRenderOptions,
  ): void {
    const isCollapsed = options.isGroupCollapsed?.(key) ?? false;
    const toggle = header.createEl('button', {
      cls: 'claudian-history-section-toggle',
      attr: { type: 'button', 'aria-expanded': isCollapsed ? 'false' : 'true' },
    });
    labelSectionBy(section, toggle.createSpan({ cls: 'claudian-history-section-label', text: label }));
    items.hidden = isCollapsed;
    toggle.addEventListener('click', () => {
      const collapsed = !items.hidden;
      items.hidden = collapsed;
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      options.onGroupCollapseChange?.(key, collapsed);
    });
  }

  /** The projects section: its header with the project actions, and one collapsible row per project. */
  #renderProjectsSection(
    list: HTMLElement,
    projectSections: readonly ProjectListSection[],
    options: HistoryRenderOptions,
    conversationsByProject: ReadonlyMap<string, readonly ConversationMeta[]>,
  ): HTMLElement {
    const label = t('chat.projects.header');
    const section = list.createDiv({
      cls: 'claudian-history-section claudian-history-section--projects',
      attr: { role: 'region' },
    });
    const header = section.createDiv({
      cls: 'claudian-history-header claudian-session-section-header claudian-session-projects-header',
    });
    const items = section.createDiv({ cls: 'claudian-history-section-items claudian-session-project-items' });
    this.#renderSectionToggle(section, header, label, items, sessionManagerSectionKey('projects'), options);
    renderProjectsHeaderActions(header, this.deps.plugin);
    for (const projectSection of projectSections) {
      this.#renderProjectSection(items, projectSection, options, conversationsByProject);
    }
    return items;
  }

  /**
   * One project: a header of native buttons (the toggle, New session, and the actions menu, so each stays
   * reachable by keyboard without nesting) over its member rows.
   */
  #renderProjectSection(
    list: HTMLElement,
    section: ProjectListSection,
    options: HistoryRenderOptions,
    conversationsByProject: ReadonlyMap<string, readonly ConversationMeta[]>,
  ): void {
    const { project } = section;
    const label = project.name;
    const isCollapsed = options.isGroupCollapsed?.(section.key) ?? false;
    const { groupHeader, groupStatusKind } = this.#createGroupHeader(
      list,
      section,
      isCollapsed,
      options,
      ['claudian-session-group-header--project'],
    );
    groupHeader.setAttribute('data-project-id', project.id);
    const dropTarget = { kind: 'project', projectId: project.id } as const;
    if (this.#canDrag(options)) this.drag.attachTarget(groupHeader, dropTarget);

    // Named by its visible label: an aria-label would show Obsidian's hover tooltip.
    const toggle = groupHeader.createEl('button', {
      cls: 'claudian-session-group-toggle',
      attr: {
        type: 'button',
        'aria-expanded': isCollapsed ? 'false' : 'true',
      },
    });
    const icon = toggle.createSpan({ cls: 'claudian-session-group-icon' });
    icon.setAttribute('aria-hidden', 'true');
    // Obsidian aliases the legacy `folder` id to an open folder; explicit Lucide ids keep the states distinct.
    setIcon(icon, isCollapsed ? 'lucide-folder' : 'lucide-folder-open');
    toggle.createSpan({ cls: 'claudian-session-group-label', text: label });

    if (groupStatusKind !== null) {
      this.#createSessionStatusIndicator(groupHeader, groupStatusKind, true, isCollapsed);
    }

    const buildMenu = (): Menu => this.actions.projectMenu(
      project,
      conversationsByProject.get(project.id) ?? [],
      conversation => this.#statusOf(conversation, options).isRunning,
    );
    const actionsButton = groupHeader.createEl('button', {
      cls: 'claudian-session-group-menu-action',
      attr: {
        type: 'button',
        'aria-label': t('chat.projects.actionsFor', { name: label }),
        'aria-haspopup': 'menu',
      },
    });
    setIcon(actionsButton, 'more-horizontal');
    actionsButton.addEventListener('click', event => event.stopPropagation());
    bindMenuToggle(actionsButton, () => {
      const menu = buildMenu();
      showMenuAt(menu, actionsButton);
      return menu;
    });
    this.#openMenuOnContextMenu(groupHeader, buildMenu);

    const startProjectConversation = options.onStartProjectConversation;
    if (startProjectConversation) {
      const newButton = groupHeader.createEl('button', {
        cls: 'claudian-session-group-new-action',
        attr: { type: 'button', 'aria-label': t('chat.projects.newSessionIn', { name: label }) },
      });
      setIcon(newButton, 'square-pen');
      newButton.addEventListener('click', (event) => {
        event.stopPropagation();
        runSessionAction(
          () => startProjectConversation(project.id),
          t('chat.projects.errors.start'),
        );
      });
    }

    toggle.addEventListener('click', () => {
      options.onGroupCollapseChange?.(section.key, !isCollapsed);
      options.onRerender();
    });

    if (isCollapsed) return;
    const groupBody = list.createDiv({ cls: 'claudian-session-group-body' });
    groupBody.setAttribute('data-group-key', section.key);
    if (this.#canDrag(options)) this.drag.attachTarget(groupBody, dropTarget);
    if (section.conversations.length === 0) {
      groupBody.createDiv({ cls: 'claudian-session-project-empty', text: t('chat.projects.noSessions') });
      return;
    }
    for (const conversation of section.conversations) {
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
    const attention = canShowAttention(options) ? conversationStatus.attention ?? null : null;
    const showReviewState = attention !== null && isCompletedReview(attention);
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
    if (options.showMetadataPopover) {
      const focusTarget = isSelectable ? content : item;
      focusTarget.setAttribute('tabindex', '0');
      this.metadataPopover.attach(item, focusTarget, conversation, options);
    } else {
      // Without the metadata popover, a native tooltip shows the full title.
      titleEl.setAttribute('title', conversation.title);
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
    if (this.#canDrag(options)) {
      this.drag.attachSource(item, () => this.#draggedConversationIds(conversation.id));
    }

    const row = (status: HistoryConversationStatus): SessionRow => ({
      conversation,
      status,
      attention: canShowAttention(options) ? status.attention ?? null : null,
      beginRename: () => this.#beginRename(item, conversation, options),
    });

    // A right-press must not focus the row: Obsidian returns focus there when Esc closes the menu, and focus
    // arriving by key draws the focus ring.
    item.addEventListener('mousedown', (event) => {
      if (event.button === 2) event.preventDefault();
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.selection.isPartOfMultiple(conversation.id)) {
        this.actions.selectionMenu(
          options,
          candidate => this.#statusOf(candidate, options).isRunning,
          item,
        ).showAtMouseEvent(event);
        return;
      }
      this.selection.clear();
      // The menu reflects the session's status when it opens, not when the row rendered.
      const menuStatus = this.#lookUpStatus(conversation.id, isCurrent ? 'current' : 'closed', options);
      this.actions.rowMenu(row(menuStatus), options, item).showAtMouseEvent(event);
    });

    const actionsEl = item.createDiv({ cls: 'claudian-history-item-actions' });
    this.#renderTitleGenerationAction(actionsEl, conversation);
    this.actions.renderRowButtons(actionsEl, row(conversationStatus), options);

    if (sessionStatusKind) {
      this.#createSessionStatusIndicator(item, sessionStatusKind);
    }
  }

  /** Drag and drop places sessions in the persistent sidebar's active view only. */
  #canDrag(options: HistoryRenderOptions): boolean {
    return options.sessionActionMode === 'active' && options.showPinnedSection === true;
  }

  /** A selected row drags the whole multi-selection of active sessions; any other row drags itself. */
  #draggedConversationIds(conversationId: string): readonly string[] {
    if (!this.selection.isPartOfMultiple(conversationId)) return [conversationId];
    return this.deps.plugin.getConversationList()
      .filter(conversation => !conversation.isArchived && this.selection.has(conversation.id))
      .map(conversation => conversation.id);
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
    content.setAttribute('tabindex', '0');
    content.setAttribute('role', 'button');
    content.addEventListener('keydown', (event) => {
      if (event.target !== content || (event.key !== 'Enter' && event.key !== ' ')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectConversation();
    });

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
    if (icon) setIcon(indicator, icon);
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
    actionsButton.addEventListener('click', event => event.stopPropagation());
    bindMenuToggle(actionsButton, () => {
      const menu = buildMenu();
      showMenuAt(menu, actionsButton);
      return menu;
    });
    this.#openMenuOnContextMenu(divider, buildMenu);
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
