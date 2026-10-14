import type { ChatRewindMode, ConversationBranchResult } from '@/core/execution';
import type {
  ChatMessage,
  Conversation,
  ConversationMutablePatch,
  ProviderId,
} from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ConversationBranching } from '@/features/chat/conversation/ConversationBranching';
import { ConversationRewind, type ConversationSaveOptions } from '@/features/chat/conversation/ConversationRewind';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { LinkedContentController, LinkedContentSubmissionToken } from '@/features/chat/linked-content';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import {
  pickWelcomeGreeting,
  renderWelcomeContent,
} from '@/features/chat/rendering/WelcomeRenderer';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { SessionComposerPort } from '@/features/chat/sessions/SessionComposer';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { SubagentManager } from '@/features/chat/subagents/SubagentManager';

/** Longest a progress-only change waits for its coalesced save. */
const PROGRESS_SAVE_DELAY_MS = 1_000;

export interface ConversationCallbacks {
  onConversationLoaded?: () => void;
}

/** The tab session capabilities conversation transitions coordinate with. */
export type ConversationSession = Pick<
  ChatSessionRuntime,
  'canNavigateConversation' | 'runConversationNavigation' | 'hasActiveTurn' | 'cancelTurn' | 'isIdle'
  | 'hasBackgroundWork'
>;

export interface ConversationControllerDeps {
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer | null;
  subagentManager: SubagentManager;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement | null;
  drafts: SessionComposerPort;
  session: ConversationSession;
  getLinkedContentController: () => LinkedContentController;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  ensureExecutionInitialized?: () => Promise<boolean>;
  getSelectedModel?: () => string | null;
  ensureExecutionForConversation?: (conversation: Conversation | null) => Promise<void>;
  /** True once the owning tab has begun teardown. */
  isClosing?: () => boolean;
  /** The transcript now shows the bound conversation (or the blank entry point) in full. */
  isConversationHydrated?: () => boolean;
  onConversationHydrated?: () => void;
  onPersistenceChanged?: () => void;
  onBranchPreviewCancelled?: () => void;
}

export class ConversationController {
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private pendingProgressSave: { supersede: () => void } | null = null;
  private pendingSaves = 0;
  private creation: Promise<void> | null = null;
  get hasPendingPersistence(): boolean { return this.pendingSaves > 0 || !!this.pendingProgressSave || !!this.creation; }
  awaitCreation(): Promise<void> { return this.creation ?? Promise.resolve(); }
  readonly #setTransition: ReturnType<ChatState['claimTransitionWriter']>;
  readonly #branching: ConversationBranching;
  readonly #rewind: ConversationRewind;

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
    this.#setTransition = deps.state.claimTransitionWriter();
    const ensureExecutionInitialized = deps.ensureExecutionInitialized
      && (() => this.deps.ensureExecutionInitialized!());
    const isClosing = (): boolean => this.deps.isClosing?.() ?? false;
    this.#branching = new ConversationBranching({
      state: deps.state,
      setRewinding: value => this.#setTransition('isRewinding', value),
      get renderer() { return deps.renderer; },
      drafts: deps.drafts,
      session: deps.session,
      getMessagesEl: () => this.deps.getMessagesEl(),
      getExecutionCoordinator: () => this.#getExecutionCoordinator(),
      ensureExecutionInitialized,
      getSelectedModel: () => this.deps.getSelectedModel?.() ?? null,
      isClosing,
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
      isClosing,
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
   * Loads the current tab conversation, or starts at entry point if none.
   *
   * Entry point (no conversation) shows welcome screen without
   * creating a conversation. Conversation is created lazily on first message.
   */
  async loadActive(): Promise<void> {
    const { plugin, state } = this.deps;

    const conversationId = state.currentConversationId;
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;

    if (conversationId && !conversation) throw new Error(`Conversation ${conversationId} no longer exists`);

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

  rewind(userMessageId: string, mode?: ChatRewindMode): Promise<void> {
    return this.#rewind.run(userMessageId, mode);
  }

  navigateBranch(messageId: string, branchMessageId?: string): Promise<void> {
    return this.#branching.navigate(messageId, branchMessageId);
  }

  cancelBranchDraft(): void {
    const hadDraft = this.#branching.hasDraft;
    this.#branching.cancelDraft();
    if (hadDraft && !this.#branching.hasDraft) this.deps.onBranchPreviewCancelled?.();
  }

  get visibleMessages(): readonly ChatMessage[] {
    return this.#branching.visibleMessages;
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
    const pending = this.createConversationShell(token, options);
    this.creation = pending;
    try { await pending; }
    finally { if (this.creation === pending) this.creation = null; this.deps.onPersistenceChanged?.(); }
  }

  private async createConversationShell(
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
    this.pendingSaves++;
    try { await this.persist(updateLastActivity, options); }
    catch (error) {
      // The unsaved state stays dirty so a later save, such as before release, retries it.
      this.deps.state.hasPendingConversationSave = true;
      throw error;
    } finally { this.pendingSaves--; this.deps.onPersistenceChanged?.(); }
  }

  private async persist(updateLastActivity: boolean, options?: ConversationSaveOptions): Promise<void> {
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
    this.deps.onConversationHydrated?.();
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
    this.deps.onConversationHydrated?.();
  }

  /** Replaces the rendered transcript, which recreates the welcome element above it. */
  #renderTranscript(messages: ChatMessage[], syncWelcomeVisibility = true): void {
    this.deps.state.writeEditStates.clear();
    this.deps.setWelcomeEl(this.deps.renderer?.renderMessages(messages, () => this.#greeting()) ?? null);
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
