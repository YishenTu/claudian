import type { ChatRewindMode, ConversationBranchResult } from '@/core/execution';
import type {
  ChatMessage,
  Conversation,
  ConversationMutablePatch,
  ProviderId,
} from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { ConversationBranching } from '@/features/chat/conversation/ConversationBranching';
import { ConversationRewind, type ConversationSaveOptions } from '@/features/chat/conversation/ConversationRewind';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { LinkedContentController, LinkedContentSubmissionToken } from '@/features/chat/linked-content';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import {
  createWelcomeElement,
  pickWelcomeGreeting,
  renderWelcomeContent,
} from '@/features/chat/rendering/WelcomeRenderer';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import type { TabSession } from '@/features/chat/tabs/TabSession';

/** Longest a progress-only change waits for its coalesced save. */
const PROGRESS_SAVE_DELAY_MS = 1_000;

export interface ConversationCallbacks {
  onNewConversation?: () => void;
  onConversationLoaded?: () => void;
  onConversationSwitched?: () => void;
}

/** The tab session capabilities conversation transitions coordinate with. */
export type ConversationSession = Pick<
  TabSession, 'canNavigateConversation' | 'runConversationNavigation' | 'hasActiveTurn' | 'cancelTurn'
>;

export interface ConversationControllerDeps {
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  drafts: ComposerDraftController;
  session: ConversationSession;
  getLinkedContentController: () => LinkedContentController;
  clearQueuedMessage: () => void;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  ensureExecutionInitialized?: () => Promise<boolean>;
  getSelectedModel?: () => string | null;
  ensureExecutionForConversation?: (conversation: Conversation | null) => Promise<void>;
  dismissPendingInlinePrompts?: () => void;
  awaitBackgroundWork?: () => Promise<void>;
  /** True once the owning tab has begun teardown. */
  isDisposed?: () => boolean;
  isConversationHydrated?: () => boolean;
}

export class ConversationController {
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private switchRequestRevision = 0;
  private switchTail: Promise<void> = Promise.resolve();
  private pendingProgressSave: { supersede: () => void } | null = null;
  readonly #setTransition: ReturnType<ChatState['claimTransitionWriter']>;
  readonly #branching: ConversationBranching;
  readonly #rewind: ConversationRewind;

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
    this.#setTransition = deps.state.claimTransitionWriter();
    const ensureExecutionInitialized = deps.ensureExecutionInitialized
      && (() => this.deps.ensureExecutionInitialized!());
    const isDisposed = (): boolean => this.deps.isDisposed?.() ?? false;
    this.#branching = new ConversationBranching({
      state: deps.state,
      setRewinding: value => this.#setTransition('isRewinding', value),
      renderer: deps.renderer,
      drafts: deps.drafts,
      session: deps.session,
      getMessagesEl: () => this.deps.getMessagesEl(),
      getExecutionCoordinator: () => this.#getExecutionCoordinator(),
      ensureExecutionInitialized,
      getSelectedModel: () => this.deps.getSelectedModel?.() ?? null,
      isDisposed,
      save: () => this.save(),
      renderTranscript: (messages, syncWelcomeVisibility) => (
        this.#renderTranscript(messages, syncWelcomeVisibility)
      ),
    });
    this.#rewind = new ConversationRewind({
      plugin: deps.plugin,
      state: deps.state,
      setRewinding: value => this.#setTransition('isRewinding', value),
      session: deps.session,
      drafts: deps.drafts,
      getExecutionCoordinator: () => this.#getExecutionCoordinator(),
      ensureExecutionInitialized,
      isDisposed,
      save: (updateLastActivity, options) => this.save(updateLastActivity, options),
      renderTranscript: messages => this.#renderTranscript(messages),
    });
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
    const { state, subagentManager, session } = this.deps;
    const force = !!options.force;
    const isCancellingForegroundTurn = force && session.hasActiveTurn;
    if (session.hasActiveTurn && !force) return;
    if (state.isRewinding) return;
    if (state.isResettingToNewChat) return;
    if (state.isSwitchingConversation) return;

    // Set flag to block message sending during reset
    this.#branching.cancelDraft();
    this.#setTransition('isResettingToNewChat', true);

    try {
      this.deps.dismissPendingInlinePrompts?.();
      // The replaced turn unwinds without presenting into the new chat.
      if (isCancellingForegroundTurn) session.cancelTurn('new-conversation');

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
      state.resetStreamingPresentation();
      state.toolCallElements.clear();
      state.writeEditStates.clear();

      await this.#resetToEntryState();

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.empty();

      const welcomeEl = createWelcomeElement(messagesEl, this.#greeting());
      this.deps.setWelcomeEl(welcomeEl);

      this.deps.drafts.restore('main', { content: '', images: [] });

      this.deps.getLinkedContentController().resetAutoDraft();

      this.deps.clearQueuedMessage();

      this.callbacks.onNewConversation?.();
    } finally {
      this.#setTransition('isResettingToNewChat', false);
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
    const { plugin, state } = this.deps;

    const conversationId = state.currentConversationId;
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;

    // No active conversation - start at entry point
    if (!conversation) {
      await this.#resetToEntryState();
      this.deps.getLinkedContentController().resetAutoDraft();
      this.#renderTranscript([]);

      this.callbacks.onConversationLoaded?.();
      return;
    }

    await this.deps.ensureExecutionForConversation?.(conversation);
    this.#restoreConversation(conversation);

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
    if (this.deps.session.hasActiveTurn) return;
    if (state.isRewinding) return;
    if (state.isSwitchingConversation) return;
    if (state.isResettingToNewChat) return;

    this.#branching.cancelDraft();
    this.#setTransition('isSwitchingConversation', true);

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
    } finally {
      this.#setTransition('isSwitchingConversation', false);
      this.deps.renderer.refreshBranchButtonState();
    }
    this.callbacks.onConversationSwitched?.();
  }

  rewind(userMessageId: string, mode?: ChatRewindMode): Promise<void> {
    return this.#rewind.run(userMessageId, mode);
  }

  navigateBranch(messageId: string, branchMessageId?: string): Promise<void> {
    return this.#branching.navigate(messageId, branchMessageId);
  }

  cancelBranchDraft(): void {
    this.#branching.cancelDraft();
  }

  get hasBranchDraft(): boolean {
    return this.#branching.hasDraft;
  }

  /** Runs inside the already admitted main turn, without taking a second operation. */
  commitBranchDraft(signal?: AbortSignal): Promise<ConversationBranchResult> {
    return this.#branching.commitDraft(signal);
  }

  /** Creates the Conversation for its first admitted turn and freezes that turn's Linked content. */
  async createConversation(
    token: LinkedContentSubmissionToken,
    options: { providerId: ProviderId; selectedModel?: string },
  ): Promise<void> {
    const { plugin, state } = this.deps;
    const conversation = await plugin.createConversation({
      providerId: options.providerId,
      ...(options.selectedModel ? { selectedModel: options.selectedModel } : {}),
      ...(token.path ? { linkedContentPath: token.path } : {}),
    });
    state.currentConversationId = conversation.id;

    const settlement = this.deps.getLinkedContentController().commitSubmission(token);
    for (const event of settlement.queuedEvents) {
      if (event.kind !== 'rename') continue;
      await plugin.rewriteLinkedContentPaths(event.oldPath, event.newPath, event.includeDescendants);
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
  async save(updateLastActivity = false, options?: ConversationSaveOptions): Promise<void> {
    // Every save persists the whole current state, including any coalesced progress.
    this.pendingProgressSave?.supersede();
    this.pendingProgressSave = null;
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
    await this.#branching.refreshMetadata();
  }

  /**
   * Coalesces display-only progress into one trailing save. The next direct save of any kind,
   * including close, teardown, and navigation saves, supersedes it without another write.
   * `persist` runs the save from its owner's queue; only the scheduling call receives the promise.
   */
  scheduleProgressSave(persist: () => Promise<void> | null | undefined): Promise<void> | undefined {
    if (this.pendingProgressSave) return undefined;
    let pending!: { supersede: () => void };
    const due = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(true), PROGRESS_SAVE_DELAY_MS);
      pending = {
        supersede: () => {
          window.clearTimeout(timer);
          resolve(false);
        },
      };
    });
    this.pendingProgressSave = pending;
    return due.then(async (isDue) => {
      if (!isDue) return;
      if (this.pendingProgressSave === pending) this.pendingProgressSave = null;
      await persist();
    });
  }

  /**
   * Shared logic for restoring a conversation into the current tab.
   * Used by both loadActive() and switchTo() to avoid duplication.
   */
  #restoreConversation(conversation: Conversation): void {
    const { plugin, state } = this.deps;

    this.#branching.reset();
    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    this.deps.getLinkedContentController().lock(conversation.linkedContentPath);

    this.#renderTranscript(state.messages);
  }

  /** Clears the tab back to the blank entry point; a conversation is created on first send. */
  async #resetToEntryState(): Promise<void> {
    const { plugin, state } = this.deps;
    this.#branching.reset();
    state.currentConversationId = null;
    state.clearMessages();
    state.usage = null;
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    await this.#getExecutionCoordinator()?.bindConversation(null);
  }

  /** Replaces the rendered transcript, which recreates the welcome element above it. */
  #renderTranscript(messages: ChatMessage[], syncWelcomeVisibility = true): void {
    this.deps.state.writeEditStates.clear();
    this.deps.setWelcomeEl(this.deps.renderer.renderMessages(messages, () => this.#greeting()));
    if (syncWelcomeVisibility) this.updateWelcomeVisibility();
  }

  // ============================================
  // Welcome & Greeting
  // ============================================

  #greeting(): string {
    return pickWelcomeGreeting(this.deps.plugin.settings.userName?.trim(), new Date(), Math.random());
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
      renderWelcomeContent(welcomeEl, this.#greeting());
      this.deps.setWelcomeEl(welcomeEl);
    }

    this.updateWelcomeVisibility();
  }

}
