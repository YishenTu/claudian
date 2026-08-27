import { Menu, Notice, setIcon } from 'obsidian';

import type {
  ChatRewindConflict,
  ChatRewindMode,
} from '../../../core/execution';
import type { ProviderIconSvg, TitleGenerationService } from '../../../core/providers/types';
import type {
  ChatMessage,
  Conversation,
  ConversationMeta,
  ConversationMutablePatch,
  ProviderId,
  SessionManagerOrganization,
  SessionManagerSort,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { createProviderIconSvg } from '../../../shared/icons';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { extractUserDisplayContent } from '../../../utils/context';
import type { FeatureHost } from '../../FeatureHost';
import type { ChatExecutionCoordinator } from '../execution/ChatExecutionCoordinator';
import type { LinkedContentController } from '../linked-content';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { createWelcomeElement, renderWelcomeContent } from '../rendering/WelcomeRenderer';
import { findRewindContext } from '../rewind';
import type { SubagentManager } from '../services/SubagentManager';
import {
  getLinkedContentTitle,
  isLegacyProvisionalLinkedContent,
  organizeSessionList,
  type SessionListSection,
} from '../session-manager/SessionListOrganizer';
import type { ChatState } from '../state/ChatState';
import type { TabAttention } from '../state/types';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { ExternalContextSelector } from '../ui/InputToolbar';
import type { StatusPanel } from '../ui/StatusPanel';

function runConversationAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
}

const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_REWIND_CONFLICT_PATHS = 5;

function buildRewindConflictConfirmation(conflicts: readonly ChatRewindConflict[]): string {
  const visiblePaths = conflicts
    .slice(0, MAX_REWIND_CONFLICT_PATHS)
    .map(conflict => `- ${conflict.path}`);
  const omitted = conflicts.length - visiblePaths.length;
  if (omitted > 0) visiblePaths.push(`- +${omitted} more`);
  return t('chat.rewind.confirmMessageConflicts', {
    count: conflicts.length,
    files: visiblePaths.join('\n'),
  });
}

export interface ConversationCallbacks {
  onNewConversation?: () => void;
  onConversationLoaded?: () => void;
  onConversationSwitched?: () => void;
}

export interface ConversationControllerDeps {
  plugin: FeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getHistoryDropdown: () => HTMLElement | null;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  getInputEl: () => HTMLTextAreaElement;
  restoreMessageToComposer?: (message: Pick<ChatMessage, 'content' | 'images'>) => void;
  getFileContextManager: () => FileContextManager | null;
  getLinkedContentController: () => LinkedContentController;
  getImageContextManager: () => ImageContextManager | null;
  getExternalContextSelector: () => ExternalContextSelector | null;
  clearQueuedMessage: () => void;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  ensureExecutionInitialized?: () => Promise<boolean>;
  getProviderId?: () => ProviderId;
  getSelectedModel?: () => string | null;
  ensureExecutionForConversation?: (conversation: Conversation | null) => Promise<void>;
  dismissPendingInlinePrompts?: () => void;
  awaitBackgroundWork?: () => Promise<void>;
  /** True once the owning tab has begun teardown. */
  isDisposed?: () => boolean;
}

type SaveOptions = {
  resumeAtMessageId?: string;
  resetProviderSession?: boolean;
};

export type HistoryConversationOpenState = 'closed' | 'open' | 'current';

export type HistoryConversationStatus = {
  openState: HistoryConversationOpenState;
  isRunning: boolean;
  attention?: TabAttention;
  location?: 'current-view' | 'other-view';
  tabIndex?: number;
};

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

export class ConversationController {
  private activeInlineRename: {
    cancel: () => void;
    input: HTMLInputElement;
  } | null = null;
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private metadataPopoverCleanup: (() => void) | null = null;
  private metadataPopoverCloseTimer: number | null = null;
  private metadataPopoverEl: HTMLElement | null = null;
  private metadataPopoverTarget: HTMLElement | null = null;
  private metadataPopoverSequence = 0;
  private switchRequestRevision = 0;
  private switchTail: Promise<void> = Promise.resolve();

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
  }

  private getExecutionCoordinator(): ChatExecutionCoordinator | null {
    return this.deps.getExecutionCoordinator();
  }

  // ============================================
  // Conversation Lifecycle
  // ============================================

  /**
   * Resets to entry point state (New Chat).
   *
   * Entry point is a blank UI state - no conversation is created until the
   * first message is sent. This prevents empty conversations cluttering history.
   */
  async createNew(options: { force?: boolean } = {}): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;
    const force = !!options.force;
    const isCancellingForegroundTurn = force && state.isStreaming;
    if (state.isStreaming && !force) return;
    if (state.isRewinding) return;
    if (state.isCreatingConversation) return;
    if (state.isSwitchingConversation) return;

    // Set flag to block message sending during reset
    state.isCreatingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();

      if (isCancellingForegroundTurn) {
        state.cancelRequested = true;
        state.bumpStreamGeneration();
        this.getExecutionCoordinator()?.cancel();
      }

      if (this.deps.awaitBackgroundWork) {
        await this.deps.awaitBackgroundWork();
      }

      subagentManager.orphanAllActive();

      // Persist terminalized background tasks before clearing their runtime state.
      if (state.currentConversationId && state.messages.length > 0) {
        await this.save(isCancellingForegroundTurn);
      }

      subagentManager.clear();

      // Clear streaming state and related DOM references
      cleanupThinkingBlock(state.currentThinkingState);
      state.currentContentEl = null;
      state.currentTextEl = null;
      state.currentTextContent = '';
      state.currentThinkingState = null;
      state.toolCallElements.clear();
      state.writeEditStates.clear();
      state.isStreaming = false;

      // Reset to entry point state - no conversation created yet
      state.currentConversationId = null;
      state.clearMessages();
      state.usage = null;
      state.currentTodos = null;
      state.pendingNewSessionPlan = null;
      state.planFilePath = null;
      state.prePlanPermissionMode = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      await this.getExecutionCoordinator()?.bindConversation(null);

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.empty();

      // Recreate welcome element first (before StatusPanel for consistent ordering)
      const welcomeEl = createWelcomeElement(messagesEl, this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);

      // Remount StatusPanel to restore state for new conversation
      this.deps.getStatusPanel()?.remount();

      this.deps.getInputEl().value = '';

      this.deps.getFileContextManager()?.clearAttachments();
      this.deps.getLinkedContentController().resetAutoDraft();

      this.deps.getImageContextManager()?.clearImages();
      // Pass current settings to ensure we have the most up-to-date persistent paths
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
      this.deps.clearQueuedMessage();

      this.callbacks.onNewConversation?.();
    } finally {
      state.isCreatingConversation = false;
    }
  }

  /**
   * Loads the current tab conversation, or starts at entry point if none.
   *
   * Entry point (no conversation) shows welcome screen without
   * creating a conversation. Conversation is created lazily on first message.
   */
  async loadActive(): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    const conversationId = state.currentConversationId;
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;

    // No active conversation - start at entry point
    if (!conversation) {
      state.currentConversationId = null;
      state.clearMessages();
      state.usage = null;
      state.currentTodos = null;
      state.pendingNewSessionPlan = null;
      state.planFilePath = null;
      state.prePlanPermissionMode = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      await this.getExecutionCoordinator()?.bindConversation(null);

      this.deps.getFileContextManager()?.clearAttachments();
      this.deps.getLinkedContentController().resetAutoDraft();

      // Initialize external contexts with persistent paths from settings
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );

      const welcomeEl = renderer.renderMessages(
        [],
        () => this.getGreeting()
      );
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      this.callbacks.onConversationLoaded?.();
      return;
    }

    await this.deps.ensureExecutionForConversation?.(conversation);
    this.restoreConversation(conversation);
    this.updateWelcomeVisibility();

    this.callbacks.onConversationLoaded?.();
  }

  /** Switches to a different conversation. */
  async switchTo(id: string): Promise<void> {
    const requestRevision = ++this.switchRequestRevision;
    const request = this.switchTail
      .catch(() => undefined)
      .then(async () => {
        if (requestRevision !== this.switchRequestRevision) return;
        await this.switchToImmediately(id);
      });
    this.switchTail = request.then(
      () => undefined,
      () => undefined,
    );
    await request;
  }

  private async switchToImmediately(id: string): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;

    if (this.deps.isDisposed?.()) return;
    if (id === state.currentConversationId) return;
    if (state.isStreaming) return;
    if (state.isRewinding) return;
    if (state.isSwitchingConversation) return;
    if (state.isCreatingConversation) return;

    state.isSwitchingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();
      if (this.deps.awaitBackgroundWork) {
        await this.deps.awaitBackgroundWork();
      }
      if (this.deps.isDisposed?.()) return;
      subagentManager.orphanAllActive();
      await this.save();
      if (this.deps.isDisposed?.()) return;

      subagentManager.clear();

      const conversation = await plugin.switchConversation(id);
      if (!conversation || this.deps.isDisposed?.()) {
        return;
      }

      await this.deps.ensureExecutionForConversation?.(conversation);
      if (this.deps.isDisposed?.()) return;

      this.deps.getInputEl().value = '';
      this.deps.clearQueuedMessage();

      this.restoreConversation(conversation);

      this.deps.getHistoryDropdown()?.removeClass('visible');
      this.updateWelcomeVisibility();
    } finally {
      state.isSwitchingConversation = false;
    }
    this.callbacks.onConversationSwitched?.();
  }

  async rewind(
    userMessageId: string,
    mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      return;
    }
    if (state.isStreaming) {
      new Notice(t('chat.rewind.unavailableStreaming'));
      return;
    }

    const msgs = state.messages;
    const userIdx = msgs.findIndex(m => m.id === userMessageId);
    if (userIdx === -1) {
      new Notice(t('chat.rewind.failed', { error: 'Message not found' }));
      return;
    }
    const userMsg = msgs[userIdx];
    if (!userMsg.userMessageId) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }

    const rewindCtx = findRewindContext(msgs, userIdx);
    if (!rewindCtx.hasResponse) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }
    const prevAssistantUuid = rewindCtx.prevAssistantUuid;

    const conversationId = state.currentConversationId;
    const isTargetCurrent = (): boolean => {
      if (state.currentConversationId !== conversationId) return false;
      const currentMessages = state.messages;
      const currentUserIdx = currentMessages.findIndex(message => message.id === userMessageId);
      if (currentUserIdx < 0) return false;
      const currentUser = currentMessages[currentUserIdx];
      if (currentUser.userMessageId !== userMsg.userMessageId) return false;
      const currentContext = findRewindContext(currentMessages, currentUserIdx);
      return currentContext.hasResponse
        && currentContext.prevAssistantUuid === prevAssistantUuid;
    };

    state.isRewinding = true;
    try {
      if (this.deps.ensureExecutionInitialized) {
        let initialized = false;
        try {
          initialized = await this.deps.ensureExecutionInitialized();
        } catch (e) {
          new Notice(t('chat.rewind.failed', {
            error: e instanceof Error ? e.message : 'Failed to initialize agent service',
          }));
          return;
        }
        if (this.deps.isDisposed?.()) return;
        if (!initialized) {
          new Notice(t('chat.rewind.failed', { error: 'Agent service not available' }));
          return;
        }
      }

      const coordinator = this.getExecutionCoordinator();
      if (!coordinator) {
        new Notice(t('chat.rewind.failed', { error: 'Agent execution not available' }));
        return;
      }
      if (!isTargetCurrent()) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      let confirmationMessage = mode === 'conversation'
        ? t('chat.rewind.confirmMessageConversationOnly')
        : t('chat.rewind.confirmMessage');
      if (mode === 'code-and-conversation') {
        let preview;
        try {
          preview = await coordinator.previewRewind(
            userMsg.userMessageId,
            prevAssistantUuid,
            mode,
          );
        } catch (e) {
          new Notice(t('chat.rewind.failed', {
            error: e instanceof Error ? e.message : 'Unknown error',
          }));
          return;
        }
        if (!preview.canRewind) {
          new Notice(t('chat.rewind.cannot', { error: preview.error ?? 'Unknown error' }));
          return;
        }
        if (preview.conflicts && preview.conflicts.length > 0) {
          confirmationMessage = buildRewindConflictConfirmation(preview.conflicts);
        }
        if (state.isStreaming) {
          new Notice(t('chat.rewind.unavailableStreaming'));
          return;
        }
        if (!isTargetCurrent() || this.getExecutionCoordinator() !== coordinator) {
          new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
          return;
        }
      }

      const confirmed = await confirm(
        plugin.app,
        confirmationMessage,
        t('chat.rewind.confirmButton')
      );
      if (!confirmed) return;

      if (state.isStreaming) {
        new Notice(t('chat.rewind.unavailableStreaming'));
        return;
      }
      if (!isTargetCurrent() || this.getExecutionCoordinator() !== coordinator) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      let result;
      try {
        result = await coordinator.rewind(
          userMsg.userMessageId,
          prevAssistantUuid,
          mode,
        );
      } catch (e) {
        new Notice(t('chat.rewind.failed', { error: e instanceof Error ? e.message : 'Unknown error' }));
        return;
      }
      if (!result.canRewind) {
        new Notice(t('chat.rewind.cannot', { error: result.error ?? 'Unknown error' }));
        return;
      }
      if (!isTargetCurrent() || this.getExecutionCoordinator() !== coordinator) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      state.truncateAt(userMessageId);
      state.usage = null;

      const restoredContent = userMsg.displayContent
        ?? extractUserDisplayContent(userMsg.content)
        ?? userMsg.content;
      if (this.deps.restoreMessageToComposer) {
        this.deps.restoreMessageToComposer({
          content: restoredContent,
          images: userMsg.images,
        });
      } else {
        const inputEl = this.deps.getInputEl();
        inputEl.value = restoredContent;
        inputEl.focus();
      }

      const welcomeEl = renderer.renderMessages(state.messages, () => this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      const filesChanged = result.filesChanged?.length ?? 0;
      let saveError: string | null = null;
      try {
        await this.save(
          true,
          result.sessionStrategy === 'preserve-provider-session'
            ? { resumeAtMessageId: undefined }
            : {
              resumeAtMessageId: prevAssistantUuid,
              resetProviderSession: !prevAssistantUuid,
            },
        );
      } catch (e) {
        saveError = e instanceof Error ? e.message : 'Failed to save';
      }

      if (saveError) {
        new Notice(
          mode === 'conversation'
            ? t('chat.rewind.noticeConversationOnlySaveFailed', { error: saveError })
            : t('chat.rewind.noticeSaveFailed', { count: String(filesChanged), error: saveError })
        );
        return;
      }

      new Notice(
        mode === 'conversation'
          ? t('chat.rewind.noticeConversationOnly')
          : t('chat.rewind.notice', { count: String(filesChanged) })
      );
    } finally {
      state.isRewinding = false;
    }
  }

  /**
   * Saves the current conversation.
   *
   * If we're at an entry point (no conversation yet) and have messages,
   * creates a new conversation first (lazy creation).
   *
   * For native sessions (new conversations with sessionId from SDK),
   * only metadata is saved - the SDK handles message persistence.
   */
  async save(updateLastActivity = false, options?: SaveOptions): Promise<void> {
    const { plugin, state } = this.deps;

    // Entry point with no messages - nothing to save
    if (!state.currentConversationId && state.messages.length === 0) {
      return;
    }

    // Entry point with messages - create conversation lazily
    // New conversations always use SDK-native storage.
    if (!state.currentConversationId && state.messages.length > 0) {
      throw new Error('Cannot save messages before the Conversation shell is created');
    }

    const externalContextSelector = this.deps.getExternalContextSelector();
    const externalContextPaths = externalContextSelector?.getExternalContexts() ?? [];
    const updates: ConversationMutablePatch = {
      messages: state.messages,
      externalContextPaths: externalContextPaths.length > 0 ? externalContextPaths : undefined,
      usage: state.usage ?? undefined,
    };

    if (updateLastActivity) {
      updates.lastActivityAt = Date.now();
    }

    if (options && 'resumeAtMessageId' in options) {
      updates.resumeAtMessageId = options.resumeAtMessageId;
    }
    if (options?.resetProviderSession) {
      updates.sessionId = null;
      updates.providerState = undefined;
    }

    await plugin.updateConversation(state.currentConversationId!, updates);
    state.hasPendingConversationSave = false;
  }

  /**
   * Shared logic for restoring a conversation into the current tab.
   * Used by both loadActive() and switchTo() to avoid duplication.
   */
  private restoreConversation(conversation: Conversation): void {
    const { plugin, state, renderer } = this.deps;

    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    // Clear status panels (auto-hide: panels reappear when agent creates new todos)
    state.currentTodos = null;

    const hasMessages = state.messages.length > 0;

    // Determine external context paths for this session
    // Empty session: use persistent paths; session with messages: use saved paths
    this.deps.getFileContextManager()?.clearAttachments();
    this.deps.getLinkedContentController().lock(conversation.linkedContentPath);

    this.restoreExternalContextPaths(conversation.externalContextPaths, !hasMessages);

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);
  }

  /**
   * Restores external context paths based on session state.
   * New or empty sessions get current persistent paths from settings.
   * Sessions with messages restore exactly what was saved.
   */
  private restoreExternalContextPaths(
    savedPaths: string[] | undefined,
    isEmptySession: boolean
  ): void {
    const { plugin } = this.deps;
    const externalContextSelector = this.deps.getExternalContextSelector();
    if (!externalContextSelector) {
      return;
    }

    if (isEmptySession) {
      // Empty session: use current persistent paths from settings
      externalContextSelector.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
    } else {
      // Session with messages: restore exactly what was saved
      externalContextSelector.setExternalContexts(savedPaths || []);
    }
  }

  // ============================================
  // History Dropdown
  // ============================================

  toggleHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    const isVisible = dropdown.hasClass('visible');
    if (isVisible) {
      dropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      dropdown.addClass('visible');
    }
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

  updateHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    this.renderHistoryItems(dropdown, {
      onSelectConversation: (id) => this.switchTo(id),
      onRerender: () => this.updateHistoryDropdown(),
    });
  }

  /**
   * Renders history dropdown items to a container.
   * Shared implementation for updateHistoryDropdown() and renderHistoryDropdown().
   */
  private renderHistoryItems(
    container: HTMLElement,
    options: HistoryRenderOptions
  ): void {
    const { plugin } = this.deps;
    if (options.signal?.aborted) return;
    if (options.showMetadataPopover) {
      this.closeSessionMetadataPopover();
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
      ? this.captureHistoryScrollAnchors(previousSessionList)
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
        this.renderLinkedContentSection(
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
        this.renderHistoryConversationItem(pinnedList, conversation, options);
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
        this.renderLinkedContentSection(
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
          this.renderHistoryConversationItem(sessionList, conversation, options);
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
        this.renderHistoryItems(container, {
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

  private renderLinkedContentSection(
    list: HTMLElement,
    section: SessionListSection,
    visibleConversations: readonly ConversationMeta[],
    isCollapsed: boolean,
    options: HistoryRenderOptions,
    linkedContentConversations: readonly ConversationMeta[],
  ): void {
    const conversationStatuses = section.conversations.map(conversation => (
      this.getHistoryConversationStatusForMetadata(conversation, options)
    ));
    const hasRunningConversation = conversationStatuses.some(({ isRunning }) => isRunning);
    const hasAttentionConversation = options.showAttentionState === true
      && options.sessionScope !== 'archived'
      && conversationStatuses.some(({ attention }) => (
        attention !== null && attention !== undefined
      ));
    const groupHeader = list.createDiv({
      cls: [
        'claudian-session-group-header',
        `claudian-session-group-header--${section.kind}`,
        hasAttentionConversation && isCollapsed
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
    const groupRunningIndicator = hasRunningConversation
      ? groupHeader.createSpan({
          cls: [
            'claudian-session-group-running-indicator',
            isCollapsed
              ? 'claudian-session-group-running-indicator--visible'
              : '',
          ].filter(Boolean).join(' '),
        })
      : null;
    if (groupRunningIndicator) {
      setIcon(groupRunningIndicator, 'loader-2');
      groupRunningIndicator.setAttribute('aria-label', 'Running');
    }
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
      groupRunningIndicator?.toggleClass(
        'claudian-session-group-running-indicator--visible',
        collapsed,
      );
      if (hasAttentionConversation) {
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
              !this.getHistoryConversationStatusForMetadata(conversation, options).isRunning
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
      this.renderHistoryConversationItem(groupBody, conversation, options);
    }
  }

  private captureHistoryScrollAnchors(list: HTMLElement): HistoryScrollAnchor[] {
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

  private renderHistoryConversationItem(
    list: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    if (options.signal?.aborted) return;

    const conversationStatus = this.getHistoryConversationStatusForMetadata(
      conversation,
      options,
    );
    const { openState, isRunning } = conversationStatus;
    const showAttentionState = options.showAttentionState === true
      && options.sessionScope !== 'archived'
      && conversationStatus.attention !== null
      && conversationStatus.attention !== undefined;
    const isCurrent = openState === 'current';
    const isOpen = openState === 'open';
    const isSelectable = !isCurrent && options.allowConversationSelection !== false;
    const item = list.createDiv({
      cls: [
        'claudian-history-item',
        isCurrent ? 'active' : '',
        isOpen ? 'open' : '',
        isRunning ? 'running' : '',
        showAttentionState ? 'claudian-history-item--attention' : '',
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
    setIcon(iconEl, this.getHistoryItemIcon(openState, isRunning));

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
      this.attachSessionMetadataPopover(item, focusTarget, conversation, options);
    } else {
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: this.getHistoryItemStatusText(
          conversationStatus,
          this.getHistoryItemTimestamp(conversation, options),
          options.showOpenStateLabels ?? true,
        ),
      });
    }

    if (isSelectable) {
      const selectConversation = (): void => {
        runConversationAction(
          () => this.runHistoryAction(
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
        if (this.isHistoryNewTabModifierClick(event) && options.onOpenConversationInNewTab) {
          event.preventDefault();
          runConversationAction(
            () => this.runHistoryAction(
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
            () => this.runHistoryAction(
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
      this.showHistoryContextMenu(
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
    } else if (conversation.titleGenerationStatus === 'failed') {
      const regenerateBtn = actions.createEl('button', { cls: 'claudian-action-btn' });
      setIcon(regenerateBtn, 'refresh-cw');
      regenerateBtn.setAttribute('aria-label', 'Regenerate title');
      regenerateBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        runConversationAction(
          () => this.regenerateTitle(conversation.id),
          'Failed to regenerate response',
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
          () => this.runHistoryAction(
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
          () => this.runHistoryAction(
            () => this.deleteHistoryConversation(conversation.id, options),
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
          () => this.runHistoryAction(
            () => options.onAssignConversationToDevice?.(conversation.id),
            'Failed to assign session to this device',
          ),
          'Failed to assign session to this device',
        );
      });
    }

    if (options.sessionActionMode === 'active') {
      if (!showAttentionState) {
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
              () => this.runHistoryAction(
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
              () => this.runHistoryAction(
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
          () => this.runHistoryAction(
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
        this.showRenameEditor(item, conversation.id, conversation.title, options);
      });
      createDeleteButton();
    }

    if (isRunning && options.showOpenStateLabels === false) {
      const runningIndicator = item.createSpan({
        cls: 'claudian-session-running-indicator',
      });
      setIcon(runningIndicator, 'loader-2');
      runningIndicator.setAttribute('aria-label', 'Running');
    }
  }

  private getHistoryConversationStatusForMetadata(
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): HistoryConversationStatus {
    const fallbackOpenState: HistoryConversationOpenState =
      conversation.id === this.deps.state.currentConversationId ? 'current' : 'closed';
    return this.getHistoryConversationStatus(
      conversation.id,
      fallbackOpenState,
      options,
    );
  }

  private attachSessionMetadataPopover(
    item: HTMLElement,
    focusTarget: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    item.addEventListener('mouseenter', () => {
      this.showSessionMetadataPopover(item, focusTarget, conversation, options);
    });
    item.addEventListener('mouseleave', () => {
      this.scheduleSessionMetadataPopoverClose(item);
    });
    focusTarget.addEventListener('focusin', () => {
      this.showSessionMetadataPopover(item, focusTarget, conversation, options);
    });
    focusTarget.addEventListener('focusout', () => {
      queueMicrotask(() => {
        const activeElement = item.ownerDocument.activeElement;
        if (activeElement && focusTarget.contains(activeElement)) return;
        if (typeof item.matches === 'function' && item.matches(':hover')) return;
        if (this.metadataPopoverTarget === item) {
          this.scheduleSessionMetadataPopoverClose(item);
        }
      });
    });
    focusTarget.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.metadataPopoverTarget !== item) return;
      event.stopPropagation();
      this.closeSessionMetadataPopover();
    });
  }

  private showSessionMetadataPopover(
    item: HTMLElement,
    descriptionTarget: HTMLElement,
    conversation: ConversationMeta,
    options: HistoryRenderOptions,
  ): void {
    if (this.metadataPopoverEl && this.metadataPopoverTarget === item) {
      this.cancelSessionMetadataPopoverClose();
      return;
    }
    this.closeSessionMetadataPopover();

    const document = item.ownerDocument;
    const body = document.body;
    if (!body) return;

    const hoverEl = body.createDiv({ cls: 'claudian-session-metadata-popover' });
    this.metadataPopoverEl = hoverEl;
    this.metadataPopoverTarget = item;

    const popoverId = `claudian-session-metadata-${++this.metadataPopoverSequence}`;
    hoverEl.setAttribute('id', popoverId);
    hoverEl.setAttribute('role', 'tooltip');
    descriptionTarget.setAttribute('aria-describedby', popoverId);

    const language = options.language ?? 'en';
    const linkedContentPath = conversation.linkedContentPath;
    const hasLinkedContent = !!linkedContentPath
      && !isLegacyProvisionalLinkedContent(linkedContentPath, {
        contentExists: options.contentExists,
        contentIsNote: options.contentIsNote,
        language,
      });
    if (hasLinkedContent) {
      this.renderSessionMetadataRow(
        hoverEl,
        'file-text',
        null,
        getLinkedContentTitle(linkedContentPath),
        {
          className: 'claudian-session-metadata-value--content',
          title: linkedContentPath,
        },
      );
    }
    this.renderSessionMetadataProviderRow(
      hoverEl,
      conversation,
      options.getProviderIcon?.(conversation),
      options.getModelLabel?.(conversation) ?? conversation.selectedModel ?? '',
    );
    this.renderSessionMetadataRow(
      hoverEl,
      'calendar-days',
      'Created',
      this.formatMetadataDate(conversation.createdAt),
    );
    this.renderSessionMetadataRow(
      hoverEl,
      'clock-3',
      'Last active',
      this.formatMetadataDateTime(conversation.lastActivityAt),
    );

    this.positionSessionMetadataPopover(item, hoverEl);
    const cancelClose = (): void => this.cancelSessionMetadataPopoverClose();
    const scheduleClose = (): void => this.scheduleSessionMetadataPopoverClose(item);
    const closeForViewportChange = (): void => {
      if (this.metadataPopoverEl === hoverEl) this.closeSessionMetadataPopover();
    };
    hoverEl.addEventListener('mouseenter', cancelClose);
    hoverEl.addEventListener('mouseleave', scheduleClose);
    document.addEventListener('scroll', closeForViewportChange, true);
    document.defaultView?.addEventListener('resize', closeForViewportChange);

    const signal = options.signal;
    const closeOnAbort = (): void => {
      if (this.metadataPopoverEl === hoverEl) {
        this.closeSessionMetadataPopover();
      }
    };
    signal?.addEventListener('abort', closeOnAbort, { once: true });
    this.metadataPopoverCleanup = () => {
      hoverEl.removeEventListener('mouseenter', cancelClose);
      hoverEl.removeEventListener('mouseleave', scheduleClose);
      document.removeEventListener('scroll', closeForViewportChange, true);
      document.defaultView?.removeEventListener('resize', closeForViewportChange);
      signal?.removeEventListener('abort', closeOnAbort);
      if (descriptionTarget.getAttribute('aria-describedby') === popoverId) {
        descriptionTarget.removeAttribute('aria-describedby');
      }
    };
  }

  private positionSessionMetadataPopover(target: HTMLElement, popover: HTMLElement): void {
    const document = target.ownerDocument;
    const targetRect = target.getBoundingClientRect();
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

  private scheduleSessionMetadataPopoverClose(target: HTMLElement): void {
    if (this.metadataPopoverTarget !== target) return;
    this.cancelSessionMetadataPopoverClose();
    const window = target.ownerDocument.defaultView;
    if (!window) {
      this.closeSessionMetadataPopover();
      return;
    }
    this.metadataPopoverCloseTimer = window.setTimeout(() => {
      if (this.metadataPopoverTarget === target) {
        this.closeSessionMetadataPopover();
      }
    }, 120);
  }

  private cancelSessionMetadataPopoverClose(): void {
    if (this.metadataPopoverCloseTimer === null) return;
    this.metadataPopoverTarget?.ownerDocument.defaultView?.clearTimeout(
      this.metadataPopoverCloseTimer,
    );
    this.metadataPopoverCloseTimer = null;
  }

  private renderSessionMetadataRow(
    parent: HTMLElement,
    icon: string,
    label: string | null,
    value: string,
    options: { className?: string; title?: string } = {},
  ): void {
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
  }

  private renderSessionMetadataProviderRow(
    parent: HTMLElement,
    conversation: ConversationMeta,
    icon: ProviderIconSvg | null | undefined,
    value: string,
  ): void {
    const row = parent.createDiv({
      cls: [
        'claudian-session-metadata-row',
        'claudian-session-metadata-row--provider',
        icon ? '' : 'claudian-session-metadata-row--provider-no-icon',
      ].filter(Boolean).join(' '),
    });
    if (icon) {
      createProviderIconSvg(icon, {
        className: 'claudian-session-metadata-provider-icon',
        dataProvider: conversation.providerId,
        height: 14,
        parent: row,
        width: 14,
      });
    }
    row.createSpan({
      cls: 'claudian-session-metadata-value claudian-session-metadata-value--provider',
      text: value,
    });
  }

  private closeSessionMetadataPopover(): void {
    this.cancelSessionMetadataPopoverClose();
    const popover = this.metadataPopoverEl;
    this.metadataPopoverCleanup?.();
    this.metadataPopoverCleanup = null;
    this.metadataPopoverEl = null;
    this.metadataPopoverTarget = null;
    popover?.addClass('claudian-hidden');
    popover?.remove();
  }

  private getHistoryItemTimestamp(
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

  private getHistoryItemStatusText(
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
      return `Running in ${this.getHistoryTabLabel(status)}`;
    }

    switch (openState) {
      case 'current':
        return typeof status.tabIndex === 'number'
          ? `Current tab ${status.tabIndex}`
          : 'Current session';
      case 'open':
        return `Open in ${this.getHistoryTabLabel(status)}`;
      case 'closed':
        return this.formatDate(timestamp);
    }
  }

  private getHistoryTabLabel(status: HistoryConversationStatus): string {
    if (typeof status.tabIndex === 'number') {
      return `tab ${status.tabIndex}`;
    }

    if (status.openState === 'current') {
      return 'current tab';
    }

    return 'tab';
  }

  private getHistoryItemIcon(
    openState: HistoryConversationOpenState,
    isRunning: boolean,
  ): string {
    if (isRunning) return 'loader-2';
    if (openState === 'current') return 'message-square-dot';
    return 'message-square';
  }

  private isHistoryNewTabModifierClick(event: MouseEvent): boolean {
    return !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey);
  }

  private async runHistoryAction(
    action: () => Promise<void> | void,
    errorMessage: string,
  ): Promise<void> {
    try {
      await action();
    } catch {
      new Notice(errorMessage);
    }
  }

  private showHistoryContextMenu(
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
            void this.runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversationId, true),
              'Failed to load conversation',
            );
          }));
        menu.addItem((menuItem) => menuItem
          .setTitle('Open in background tab')
          .onClick(() => {
            void this.runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversationId, false),
              'Failed to load conversation',
            );
          }));
      } else if (openState === 'open') {
        menu.addItem((menuItem) => menuItem
          .setTitle('Switch to open session')
          .onClick(() => {
            void this.runHistoryAction(
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
          void this.runHistoryAction(
            () => options.onSetConversationArchived?.(conversationId, false),
            'Failed to restore session',
          );
        }));
      menu.addItem((menuItem) => menuItem
        .setTitle('Delete')
        .onClick(() => {
          void this.runHistoryAction(
            () => this.deleteHistoryConversation(conversationId, options),
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
          void this.runHistoryAction(
            () => options.onSetConversationPinned?.(conversationId, !isPinned),
            isPinned ? 'Failed to unpin session' : 'Failed to pin session',
          );
        }));
    }

    if (options.sessionActionMode === 'active') {
      menu.addItem((menuItem) => menuItem
        .setTitle('Rename')
        .onClick(() => {
          this.showRenameEditor(item, conversationId, title, options);
        }));
      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Archive')
          .setDisabled(isRunning);
        if (!isRunning) {
          menuItem.onClick(() => {
            void this.runHistoryAction(
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
        this.showRenameEditor(item, conversationId, title, options);
      }));
    menu.addItem((menuItem) => menuItem
      .setTitle('Delete')
      .onClick(() => {
        void this.runHistoryAction(
          () => this.deleteHistoryConversation(conversationId, options),
          'Failed to delete conversation',
        );
      }));

    menu.showAtMouseEvent(event);
  }

  private async deleteHistoryConversation(
    conversationId: string,
    options: HistoryRenderOptions,
  ): Promise<void> {
    const { plugin, state } = this.deps;
    if (state.isStreaming && options.sessionActionMode !== 'archived') return;

    await plugin.deleteConversation(conversationId);
    options.onRerender();

    if (conversationId === state.currentConversationId) {
      await this.loadActive();
    }
  }

  private showRenameEditor(
    item: HTMLElement,
    convId: string,
    currentTitle: string,
    options: HistoryRenderOptions,
  ): void {
    const beginRename = (targetItem: HTMLElement) => {
      this.showRenameInput(targetItem, convId, currentTitle, options);
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
  private showRenameInput(
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

  // ============================================
  // Welcome & Greeting
  // ============================================

  /** Generates a dynamic greeting based on time/day. */
  getGreeting(): string {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const name = this.deps.plugin.settings.userName?.trim();

    // Helper to optionally personalize a greeting (with fallback for no-name case)
    const personalize = (base: string, noNameFallback?: string): string =>
      name ? `${base}, ${name}` : (noNameFallback ?? base);

    // Day-specific greetings (some personalized, some universal)
    const dayGreetings: Record<number, string[]> = {
      0: [personalize('Happy Sunday'), 'Sunday session?', 'Welcome to the weekend'],
      1: [personalize('Happy Monday'), personalize('Back at it', 'Back at it!')],
      2: [personalize('Happy Tuesday')],
      3: [personalize('Happy Wednesday')],
      4: [personalize('Happy Thursday')],
      5: [personalize('Happy Friday'), personalize('That Friday feeling')],
      6: [personalize('Happy Saturday', 'Happy Saturday!'), personalize('Welcome to the weekend')],
    };

    // Time-specific greetings
    const getTimeGreetings = (): string[] => {
      if (hour >= 5 && hour < 12) {
        return [personalize('Good morning'), 'Coffee and Claudian time?'];
      } else if (hour >= 12 && hour < 18) {
        return [personalize('Good afternoon'), personalize('Hey there'), personalize("How's it going") + '?'];
      } else if (hour >= 18 && hour < 22) {
        return [personalize('Good evening'), personalize('Evening'), personalize('How was your day') + '?'];
      } else {
        return ['Hello, night owl', personalize('Evening')];
      }
    };

    // General greetings
    const generalGreetings = [
      personalize('Hey there'),
      name ? `Hi ${name}, how are you?` : 'Hi, how are you?',
      personalize("How's it going") + '?',
      personalize('Welcome back') + '!',
      personalize("What's new") + '?',
      ...(name ? [`${name} returns!`] : []),
      'You are absolutely right!',
    ];

    // Combine day + time + general greetings, pick randomly
    const allGreetings = [
      ...(dayGreetings[day] || []),
      ...getTimeGreetings(),
      ...generalGreetings,
    ];

    return allGreetings[Math.floor(Math.random() * allGreetings.length)];
  }

  /** Updates welcome element visibility based on message count. */
  updateWelcomeVisibility(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    if (this.deps.state.messages.length === 0) {
      welcomeEl.removeClass('claudian-hidden');
    } else {
      welcomeEl.addClass('claudian-hidden');
    }
  }

  /**
   * Initializes the welcome greeting for a new tab without a conversation.
   * Called when a new tab is activated and has no conversation loaded.
   */
  initializeWelcome(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    // Only add greeting if not already present
    if (!welcomeEl.querySelector('.claudian-welcome-greeting')) {
      renderWelcomeContent(welcomeEl, this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);
    }

    this.updateWelcomeVisibility();
  }

  // ============================================
  // Utilities
  // ============================================

  /** Generates a fallback title from the first message (used when AI fails). */
  generateFallbackTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
  }

  /** Regenerates AI title for a conversation. */
  async regenerateTitle(conversationId: string): Promise<void> {
    const { plugin } = this.deps;
    if (!plugin.settings.enableAutoTitleGeneration) return;

    // Title generation is delegated to the active provider service
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
    this.updateHistoryDropdown();

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
        this.updateHistoryDropdown();
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
    this.renderHistoryItems(container, {
      ...options,
      onRerender: options.onRerender
        ?? (() => this.renderHistoryDropdown(container, options)),
    });
  }
}
