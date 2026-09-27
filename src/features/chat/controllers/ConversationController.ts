import { Notice } from 'obsidian';

import type {
  ChatRewindConflict,
  ChatRewindMode,
  ConversationBranchResult,
} from '../../../core/execution';
import type {
  ChatMessage,
  Conversation,
  ConversationMutablePatch,
  ProviderId,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { extractUserDisplayContent } from '../../../utils/context';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import type { ComposerDraft, ComposerDraftController } from '../composer/ComposerDraftController';
import type { ChatExecutionCoordinator } from '../execution/ChatExecutionCoordinator';
import type { LinkedContentController } from '../linked-content';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { createWelcomeElement, renderWelcomeContent } from '../rendering/WelcomeRenderer';
import { findRewindContext } from '../rewind';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { TabSession } from '../tabs/TabSession';

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
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  drafts: ComposerDraftController;
  navigation: Pick<TabSession, 'canNavigateConversation' | 'runConversationNavigation'>;
  getLinkedContentController: () => LinkedContentController;
  clearQueuedMessage: () => void;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  ensureExecutionInitialized?: () => Promise<boolean>;
  getProviderId?: () => ProviderId;
  getSelectedModel?: () => string | null;
  ensureExecutionForConversation?: (conversation: Conversation | null) => Promise<void>;
  dismissPendingInlinePrompts?: () => void;
  awaitBackgroundWork?: () => Promise<void>;
  /** True once the owning tab has begun teardown. */
  isDisposed?: () => boolean;
  isConversationHydrated?: () => boolean;
}

type SaveOptions = {
  resumeAtMessageId?: string;
  resetProviderSession?: boolean;
};

type BranchDraft = { conversationId: string; message: ChatMessage; previousDraft: ComposerDraft; scrollTop: number };
type BranchState =
  | { kind: 'idle' }
  | { kind: 'preview'; draft: BranchDraft }
  | { kind: 'committing'; draft?: BranchDraft }
  | { kind: 'recovery'; draft?: BranchDraft };

export class ConversationController {
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private branchState: BranchState = { kind: 'idle' };
  private switchRequestRevision = 0;
  private switchTail: Promise<void> = Promise.resolve();

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
  }

  #getExecutionCoordinator(): ChatExecutionCoordinator | null {
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
    this.cancelBranchDraft();
    state.isCreatingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();

      if (isCancellingForegroundTurn) {
        state.cancelRequested = true;
        state.bumpStreamGeneration();
        this.#getExecutionCoordinator()?.cancel();
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
      this.branchState = { kind: 'idle' };
      state.currentConversationId = null;
      state.clearMessages();
      state.usage = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      await this.#getExecutionCoordinator()?.bindConversation(null);

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.empty();

      const welcomeEl = createWelcomeElement(messagesEl, this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);

      this.deps.drafts.restore('main', { content: '', images: [] });

      this.deps.getLinkedContentController().resetAutoDraft();

      this.deps.clearQueuedMessage();

      this.callbacks.onNewConversation?.();
    } finally {
      state.isCreatingConversation = false;
      this.deps.renderer.refreshBranchButtonState();
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
      this.branchState = { kind: 'idle' };
      state.currentConversationId = null;
      state.clearMessages();
      state.usage = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      await this.#getExecutionCoordinator()?.bindConversation(null);

      this.deps.getLinkedContentController().resetAutoDraft();

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
    this.#restoreConversation(conversation);
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
        await this.#switchToImmediately(id);
      });
    this.switchTail = request.then(
      () => undefined,
      () => undefined,
    );
    await request;
  }

  async #switchToImmediately(id: string): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;

    if (this.deps.isDisposed?.()) return;
    if (id === state.currentConversationId && this.deps.isConversationHydrated?.() !== false) return;
    if (state.isStreaming) return;
    if (state.isRewinding) return;
    if (state.isSwitchingConversation) return;
    if (state.isCreatingConversation) return;

    this.cancelBranchDraft();
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

      this.deps.drafts.restore('main', { content: '', images: [] });
      this.deps.clearQueuedMessage();

      this.#restoreConversation(conversation);

      this.updateWelcomeVisibility();
    } finally {
      state.isSwitchingConversation = false;
      this.deps.renderer.refreshBranchButtonState();
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

      const coordinator = this.#getExecutionCoordinator();
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
        if (!isTargetCurrent() || this.#getExecutionCoordinator() !== coordinator) {
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
      if (!isTargetCurrent() || this.#getExecutionCoordinator() !== coordinator) {
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
      if (!isTargetCurrent() || this.#getExecutionCoordinator() !== coordinator) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      state.truncateAt(userMessageId);
      state.usage = null;

      const restoredContent = userMsg.displayContent
        ?? extractUserDisplayContent(userMsg.content)
        ?? userMsg.content;
      this.deps.drafts.restore('main', { content: restoredContent, images: userMsg.images }, { focus: true, notify: true });

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

  async navigateBranch(messageId: string, branchMessageId?: string): Promise<void> {
    const { state, renderer, drafts, navigation } = this.deps;
    if (drafts.destination !== 'main') {
      new Notice('Collapse side chat before changing conversation branches.');
      return;
    }
    if (!navigation.canNavigateConversation) return;
    if (this.branchState.kind === 'recovery') {
      await navigation.runConversationNavigation(signal => this.#changeBranch(undefined, undefined, signal));
      return;
    }
    const message = state.messages.find(item => item.id === messageId);
    const conversationId = state.currentConversationId;
    if (!conversationId || !message || message.role !== 'user' || message.isInterrupt || message.isRebuiltContext) return;
    if (state.messages.find(item => item.role === 'user' && !item.isInterrupt && !item.isRebuiltContext) === message) return;
    if (!message.userMessageId) {
      new Notice('Branching is available after this prompt is saved.');
      return;
    }
    const previousDraft = drafts.capture('main');
    if (previousDraft.content.trim() || previousDraft.images.length) {
      new Notice('Save or clear your draft before changing conversation branches.');
      return;
    }
    if (!branchMessageId) {
      this.branchState = { kind: 'preview', draft: { conversationId, message, previousDraft,
        scrollTop: this.deps.getMessagesEl().scrollTop } };
      const content = message.displayContent ?? extractUserDisplayContent(message.content) ?? message.content;
      this.deps.setWelcomeEl(renderer.renderMessages(state.messages.slice(0, state.messages.indexOf(message)), () => this.getGreeting()));
      drafts.restore('main', { content, images: message.images }, { focus: true, notify: true });
      return;
    }
    await navigation.runConversationNavigation(signal => this.#changeBranch(message, branchMessageId, signal));
  }

  cancelBranchDraft(): void {
    if (this.branchState.kind !== 'preview') return;
    const { draft } = this.branchState;
    this.branchState = { kind: 'idle' };
    const { state, renderer } = this.deps;
    if (this.deps.isDisposed?.() || state.currentConversationId !== draft.conversationId) return;
    this.deps.drafts.restore('main', draft.previousDraft);
    this.deps.setWelcomeEl(renderer.renderMessages(state.messages, () => this.getGreeting()));
    this.updateWelcomeVisibility();
    this.deps.getMessagesEl().scrollTop = draft.scrollTop;
  }

  get hasBranchDraft(): boolean {
    return this.branchState.kind !== 'idle';
  }

  /** Runs inside the already admitted main turn, without taking a second operation. */
  async commitBranchDraft(signal?: AbortSignal): Promise<ConversationBranchResult> {
    const branch = this.branchState;
    if (branch.kind === 'idle') return { status: 'committed', messages: this.deps.state.messages };
    if (branch.kind === 'committing') return { status: 'failed', error: 'Branch navigation is in progress.' };
    if (branch.kind === 'recovery') return this.#changeBranch(undefined, undefined, signal);
    if (this.deps.state.currentConversationId !== branch.draft.conversationId
      || !this.deps.state.messages.includes(branch.draft.message)) return { status: 'failed', error: 'Conversation changed.' };
    return this.#changeBranch(branch.draft.message, undefined, signal);
  }

  async #changeBranch(message?: ChatMessage, branchMessageId?: string, signal?: AbortSignal): Promise<ConversationBranchResult> {
    const { state, renderer } = this.deps;
    const conversationId = state.currentConversationId;
    if (!conversationId) return { status: 'failed', error: 'Conversation is missing.' };
    const previous = this.branchState;
    let draft = previous.kind === 'idle' ? undefined : previous.draft;
    let coordinator: ChatExecutionCoordinator | null = null;
    const isCurrent = () => !this.deps.isDisposed?.() && state.currentConversationId === conversationId
      && (!coordinator || coordinator === this.#getExecutionCoordinator());
    this.branchState = { kind: 'committing', draft };
    state.isRewinding = true;
    let result: ConversationBranchResult = { status: 'failed', error: 'Execution is unavailable.' };
    try {
      if (this.deps.ensureExecutionInitialized && !await this.deps.ensureExecutionInitialized()) return result;
      coordinator = this.#getExecutionCoordinator();
      if (!coordinator || !isCurrent()) return result;
      const request = { configuration: { model: this.deps.getSelectedModel?.() ?? undefined,
        systemInstructions: { kind: 'provider-default' as const } }, signal };
      result = message
        ? await coordinator.navigateConversationBranch({ ...request, userMessageId: message.userMessageId!, branchMessageId })
        : await coordinator.reconcileConversationBranch(request);
      if (!isCurrent()) return { status: 'failed', error: 'Conversation changed.' };
      // Recover once immediately. Further retries use reconciliation, never replay the navigation.
      if (result.status === 'recovery-required') {
        const recovered = await coordinator.reconcileConversationBranch(request);
        result = recovered.status === 'committed' || recovered.status === 'cancelled' ? recovered : { status: 'recovery-required',
          error: 'error' in recovered ? recovered.error : 'Branch recovery was cancelled.' };
      }
      if (!isCurrent()) return { status: 'failed', error: 'Conversation changed.' };
      if ((result.status === 'committed' || result.status === 'cancelled') && result.messages) {
        state.messages = result.messages;
        state.usage = result.usage ?? null;
        if (result.status === 'cancelled' && draft) {
          const restored = state.messages.find(item => item.userMessageId === draft!.message.userMessageId);
          draft = restored ? { ...draft, message: restored } : undefined;
        }
        const visible = result.status === 'cancelled' && draft
          ? state.messages.slice(0, state.messages.indexOf(draft.message)) : state.messages;
        this.deps.setWelcomeEl(renderer.renderMessages(visible, () => this.getGreeting()));
        this.updateWelcomeVisibility();
        try { await this.save(); }
        catch (error) { result = { status: 'recovery-required', messages: result.messages, error: String(error) }; }
      }
      if (!isCurrent()) return { status: 'failed', error: 'Conversation changed.' };
      if (result.status === 'failed' || result.status === 'recovery-required') new Notice(result.error);
      return result;
    } catch (error) {
      result = { status: 'recovery-required', error: String(error) };
      new Notice(`Could not reconcile conversation branch: ${result.error}`);
      return result;
    } finally {
      if (!isCurrent()) this.branchState = { kind: 'idle' };
      else if (result.status === 'committed') this.branchState = { kind: 'idle' };
      else if (result.status === 'recovery-required' || (previous.kind === 'recovery' && result.status === 'failed')) {
        this.branchState = { kind: 'recovery', draft };
      } else this.branchState = draft ? { kind: 'preview', draft } : { kind: 'idle' };
      state.isRewinding = false;
      renderer.refreshBranchButtonState();
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
    if (this.deps.isConversationHydrated?.() === false) return;
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

    const updates: ConversationMutablePatch = {
      messages: state.messages,
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
    const conversationId = state.currentConversationId;
    const coordinator = this.#getExecutionCoordinator();
    if (coordinator?.supportsConversationBranches && !state.isStreaming) {
      const branchState = await coordinator.getConversationBranches(state.messages).catch(() => null);
      if (!branchState) return;
      const { branches, userMessageIds } = branchState;
      if (state.currentConversationId === conversationId && coordinator === this.#getExecutionCoordinator()) {
        for (const message of state.messages) {
          if (!message.userMessageId && userMessageIds[message.id]) message.userMessageId = userMessageIds[message.id];
          if (message.userMessageId && branches[message.userMessageId]) message.treeBranches = branches[message.userMessageId];
        }
        this.deps.renderer.refreshBranchButtons(state.messages);
      }
    }
  }

  /**
   * Shared logic for restoring a conversation into the current tab.
   * Used by both loadActive() and switchTo() to avoid duplication.
   */
  #restoreConversation(conversation: Conversation): void {
    const { plugin, state, renderer } = this.deps;

    this.branchState = { kind: 'idle' };
    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    this.deps.getLinkedContentController().lock(conversation.linkedContentPath);

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);
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

}
