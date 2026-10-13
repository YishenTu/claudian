import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { TitleGenerationService } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import type { ComposerPromptSuggestion } from '@/features/chat/composer/ComposerPromptSuggestion';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { BuiltInCommandController } from '@/features/chat/input/BuiltInCommandController';
import type { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { InputController } from '@/features/chat/input/InputController';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { LinkedContentController, type LinkedContentControllerOptions } from '@/features/chat/linked-content';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { pickWelcomeGreeting } from '@/features/chat/rendering/WelcomeRenderer';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { SessionComposer } from '@/features/chat/sessions/SessionComposer';
import { SessionEvents } from '@/features/chat/sessions/SessionEvents';
import { createConversationExecutionBinding } from '@/features/chat/sessions/sessionExecution';
import { captureLatestCompletedForkSource, findLatestForkCheckpoint } from '@/features/chat/sessions/SessionForkSource';
import { requireSessionProviderId } from '@/features/chat/sessions/sessionProvider';
import { getSessionChatUIConfig, getSessionSelectedModel, getSessionSettingsSnapshot, updateSessionProviderSettings } from '@/features/chat/sessions/sessionSettings';
import { SessionTranscript } from '@/features/chat/sessions/SessionTranscript';
import { SideChatController, type SideChatControllerPresentation } from '@/features/chat/side-chat/SideChatController';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabReviewOutcome } from '@/features/chat/state/types';
import { AsyncSubagentHistoryRecovery } from '@/features/chat/subagents/AsyncSubagentHistoryRecovery';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { StreamController } from '@/features/chat/turns/StreamController';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';
import { getVaultPath } from '@/utils/path';

export type SessionChange = 'streaming' | 'rewinding' | 'attention' | 'conversation' | 'identity' | 'usage' | 'scroll' | 'work' | 'commands' | 'settings' | 'destination';

/** The current view only. No execution dependency may retain an earlier instance. */
export interface SessionPresentation {
  readonly renderer: MessageRenderer;
  readonly messagesEl: HTMLElement;
  readonly queueIndicatorEl: HTMLElement;
  readonly drafts: ComposerDraftController;
  readonly selections: Pick<ComposerSelections, 'capture'>;
  readonly builtInCommands: Pick<BuiltInCommandController, 'execute'>;
  readonly side: SideChatControllerPresentation;
  readonly suggestions: Pick<ComposerPromptSuggestion, 'beginTurn' | 'bindTurn' | 'receive' | 'discard'>;
  /** The view's invalidated vault index; pickers exist only while a view is attached. */
  readonly vaultIndex: Pick<LinkedContentControllerOptions, 'getCachedVaultFiles' | 'getCachedVaultFolders'>;
  getInputEl(): ComposerInputElement;
  getWelcomeEl(): HTMLElement | null;
  setWelcomeEl(element: HTMLElement | null): void;
  getPromptParentEl(): HTMLElement | null;
  getSuppressedEl(): HTMLElement | null;
  isVisible(): boolean;
  onChanged(change: SessionChange): void;
}

/** Evictable main transcript and its controllers. The runtime retains identity and provider ownership. */
export class SessionModel {
  readonly state: ChatState;
  readonly subagentManager: SubagentManager;
  readonly titleGenerationService: TitleGenerationService;
  readonly linkedContentController: LinkedContentController;
  readonly composer: SessionComposer;
  readonly streamController: StreamController;
  readonly inlinePrompts: SessionInteractions;
  readonly conversationController: ConversationController;
  readonly inputController: InputController;
  readonly transcript: SessionTranscript;
  readonly events: SessionEvents;
  private presentation: SessionPresentation | null = null;
  private hydration: Promise<void> | null = null;
  private readonly titleWork = new Set<Promise<void>>();
  private readonly recovery: AsyncSubagentHistoryRecovery;
  hydrationState: 'idle' | 'loading' | 'ready' | 'failed';

  constructor(readonly session: ChatSessionRuntime, private readonly plugin: ChatFeatureHost) {
    const getRenderer = () => this.transcript?.renderer ?? null;
    this.hydrationState = session.conversationId ? 'idle' : 'ready';
    this.state = new ChatState({
      onStreamingStateChanged: streaming => {
        if (streaming) this.presentation?.suggestions.beginTurn();
        this.publish('streaming');
      },
      onRewindingStateChanged: () => this.publish('rewinding'),
      onAttentionChanged: () => this.publish('attention'),
      onConversationChanged: () => this.publish('conversation'),
      onUsageChanged: () => this.publish('usage'),
      onAutoScrollChanged: () => this.publish('scroll'),
    }, { get: () => session.conversationId, set: id => session.setConversationId(id) }, session.turns, session.attention);
    this.subagentManager = new SubagentManager(info => {
      this.streamController.subagents.onAsyncSubagentStateChange(info);
      this.publish('work');
    });
    this.syncProvider();
    const titles = ProviderRegistry.createTitleGenerationService(plugin.providerHost);
    this.titleGenerationService = {
      cancel: () => titles.cancel(),
      generateTitle: async (...args) => {
        const pending = titles.generateTitle(...args);
        this.titleWork.add(pending);
        try { await pending; }
        finally { this.titleWork.delete(pending); session.notifyChanged(); }
      },
    };
    this.linkedContentController = new LinkedContentController({
      app: plugin.app,
      getExcludedTags: () => plugin.settings.excludedTags,
      getCachedVaultFiles: () => this.presentation?.vaultIndex.getCachedVaultFiles() ?? [],
      getCachedVaultFolders: () => this.presentation?.vaultIndex.getCachedVaultFolders() ?? [],
    });
    if (session.conversationId) this.linkedContentController.lock(plugin.getConversationSync(session.conversationId)?.linkedContentPath);
    else this.linkedContentController.resetAutoDraft();
    this.composer = new SessionComposer(() => this.presentation?.drafts ?? null);
    const recovery = this.recovery = new AsyncSubagentHistoryRecovery({
      subagentManager: this.subagentManager,
      getProviderId: () => requireSessionProviderId(session, plugin),
      getProviderSessionId: () => session.executionCoordinator.snapshot?.providerSessionId ?? null,
      loadSubagentToolCalls: async request => {
        const vaultPath = getVaultPath(plugin.app);
        if (!vaultPath) return undefined;
        return ProviderRegistry.createSubagentHistoryService(plugin.providerHost, request.providerId)
          ?.loadToolCalls({ ...request, vaultPath });
      },
      loadSubagentFinalResult: async request => {
        const vaultPath = getVaultPath(plugin.app);
        if (!vaultPath) return undefined;
        return ProviderRegistry.createSubagentHistoryService(plugin.providerHost, request.providerId)
          ?.loadFinalResult({ ...request, vaultPath });
      },
      enqueueBackgroundWork: work => session.enqueueBackgroundWork(work),
      persistConversation: () => this.conversationController.save(false),
      onWorkChanged: () => session.notifyChanged(),
    });
    this.streamController = new StreamController({
      plugin, state: this.state, subagentManager: this.subagentManager,
      get renderer() { return getRenderer(); },
      getMessagesEl: () => this.transcript?.messagesEl ?? null,
      getProviderId: () => requireSessionProviderId(session, plugin),
      onQuestionToolChanged: tool => this.inputController.updateAsyncQuestion(tool),
      updateQueueIndicator: () => this.inputController.queue.updateIndicator(),
      asyncSubagentHistoryRecovery: recovery,
    });
    this.transcript = new SessionTranscript(this.state, this.streamController, this.subagentManager);
    this.inlinePrompts = new SessionInteractions({
      getPromptParentEl: () => this.presentation?.getPromptParentEl() ?? null,
      getSuppressedEl: () => this.presentation?.getSuppressedEl() ?? null,
      onBeforeShow: () => {
        const generation = this.state.streamGeneration;
        this.streamController.thinkingIndicator.hide();
        return () => this.streamController.thinkingIndicator.resume(generation);
      },
    });
    this.conversationController = new ConversationController({
      plugin, state: this.state, session, drafts: this.composer, subagentManager: this.subagentManager,
      get renderer() { return getRenderer(); },
      getWelcomeEl: () => this.presentation?.getWelcomeEl() ?? null,
      setWelcomeEl: element => this.presentation?.setWelcomeEl(element),
      getMessagesEl: () => this.transcript.messagesEl,
      getLinkedContentController: () => this.linkedContentController,
      getExecutionCoordinator: () => session.executionCoordinator,
      ensureExecutionInitialized: () => this.ensureExecutionInitialized(),
      getSelectedModel: () => getSessionSelectedModel(session, plugin),
      isClosing: () => session.isDisposed,
      isConversationHydrated: () => this.hydrationState === 'ready',
      onConversationHydrated: () => { this.hydrationState = 'ready'; },
      onPersistenceChanged: () => session.notifyChanged(),
      onBranchPreviewCancelled: () => this.publish('work'),
      ensureExecutionForConversation: async conversation => {
        this.publish('commands');
        const sameIdentity = session.conversationId === (conversation?.id ?? null);
        session.bindConversation(conversation?.id ?? null, conversation?.providerId ?? session.providerId);
        this.syncProvider();
        // Rehydrating an evicted transcript must not replace a live provider event binding.
        if (!sameIdentity || !session.executionCoordinator.snapshot) {
          await session.executionCoordinator.bindConversation(conversation ? createConversationExecutionBinding(conversation) : null);
        }
        this.publish('settings');
      },
    }, {
      onConversationLoaded: () => this.activated(),
    });
    this.inputController = new InputController({
      onWorkChanged: () => this.publish('work'),
      plugin, state: this.state, session, drafts: this.composer, inlinePrompts: this.inlinePrompts,
      streamController: this.streamController, conversationController: this.conversationController,
      get renderer() { return getRenderer(); },
      selections: { capture: () => this.presentation?.selections.capture() ?? {} },
      builtInCommands: { execute: async (command, capabilities) => { await this.presentation?.builtInCommands.execute(command, capabilities); } },
      getInputEl: () => this.presentation?.getInputEl() ?? null,
      getWelcomeEl: () => this.presentation?.getWelcomeEl() ?? null,
      getMessagesEl: () => this.transcript.messagesEl,
      getLinkedContentController: () => this.linkedContentController,
      getTitleGenerationService: () => this.titleGenerationService,
      generateId: createSessionMessageId,
      getSettings: () => getSessionSettingsSnapshot(session, plugin),
      getExecutionCoordinator: () => session.executionCoordinator,
      getTabProviderId: () => session.providerId,
      canStartTurn: () => session.acceptsIntents,
      isClosing: () => session.isDisposed,
      getSideChatController: () => session.sideChat,
      ensureExecutionInitialized: () => this.ensureExecutionInitialized(),
      captureReviewableSettlement: outcome => this.captureReview(outcome),
    });
    this.events = new SessionEvents({
      session, state: this.state, stream: this.streamController,
      get renderer() { return getRenderer(); },
      executionCoordinator: session.executionCoordinator,
      persistence: this.conversationController,
      createMessageId: createSessionMessageId,
      captureReviewableSettlement: outcome => this.captureReview(outcome),
      updatePermissionMode: async mode => {
        await updateSessionProviderSettings(session, plugin, settings => {
          const ui = getSessionChatUIConfig(session, plugin);
          if (ui.applyPermissionMode) ui.applyPermissionMode(mode, settings);
          else settings.permissionMode = mode;
        });
        this.publish('settings');
      },
      receiveSuggestion: (id, suggestion) => {
        if (this.presentation?.isVisible()) this.presentation.suggestions.receive(id, suggestion);
      },
      discardSuggestion: () => this.presentation?.suggestions.discard(),
      canAcceptBackgroundWork: () => !session.isDisposed,
      claimBackgroundUserMessage: (nativeUserMessageId, inputId) => this.inputController.claimBackgroundUserMessage(nativeUserMessageId, inputId),
    });
  }

  private activated(): void {
    this.inputController.onConversationActivated();
    this.publish('commands');
  }

  /** Admitted input and async subagents keep the session working without a foreground turn. */
  get hasPendingWork(): boolean {
    return this.subagentManager.hasActiveAsyncSubagents() || this.inputController.isPreparingMainTurn || !!this.state.queuedMessage;
  }

  get hasPendingInteraction(): boolean {
    return this.inlinePrompts.pendingCount > 0;
  }

  /** Expires every pending prompt, including ones outside the active turn. */
  dismissInteractions(): void {
    this.inputController.dismissPendingApproval();
  }

  /**
   * Retention beyond the session's own work and interactions, which keep it from being idle. An
   * uncertain branch keeps its promised reconciliation. Recovered input is kept only for a
   * conversation that can be reattached; nothing can acquire a detached draft again.
   */
  get canEvict(): boolean {
    return !this.presentation && !this.hydration && this.titleWork.size === 0 && !this.recovery.hasPendingWork
      && !this.conversationController.hasPendingPersistence && !this.conversationController.hasBranchDraft
      && (!this.composer.hasRecovery || !this.session.conversationId);
  }

  syncProvider(): void {
    if (this.session.providerId) this.subagentManager.setTaskResultInterpreter(ProviderRegistry.getTaskResultInterpreter(this.session.providerId));
  }

  publish(change: SessionChange): void {
    this.presentation?.onChanged(change);
    this.session.notifyChanged();
  }

  bindSuggestion(turnId: string, isCurrent: () => boolean): void {
    this.presentation?.suggestions.bindTurn(turnId, isCurrent);
  }

  captureReview(outcome: TabReviewOutcome): () => void {
    const attention = this.session.attention;
    const epoch = attention.reviewEpoch;
    return () => {
      if (epoch !== attention.reviewEpoch || this.presentation?.isVisible()) return;
      attention.markReviewRequired(outcome);
    };
  }

  acknowledgeReviewIfVisible(): void {
    if (this.presentation?.isVisible()) this.session.attention.acknowledgeReview();
  }

  attach(presentation: SessionPresentation): void {
    if (this.presentation) throw new Error('Session model already attached');
    this.presentation = presentation;
    try {
      this.state.queueIndicatorEl = presentation.queueIndicatorEl;
      const welcome = this.transcript.attach(presentation.renderer, presentation.messagesEl,
        () => pickWelcomeGreeting(this.plugin.settings.userName?.trim(), new Date(), Math.random()));
      presentation.setWelcomeEl(welcome);
      this.session.sideChat.attachPresentation(presentation.side);
      this.inlinePrompts.setActive(this.session.sideChat.destination === 'main');
      this.composer.restoreRecovered();
      this.inputController.queue.updateIndicator();
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  detach(expected?: SessionPresentation): void {
    if (expected && this.presentation !== expected) return;
    // A branch preview exists only in the presentation showing it; reattachment shows the full transcript.
    if (this.presentation) this.conversationController.cancelBranchDraft();
    this.session.sideChat.detachPresentation();
    this.inlinePrompts.detachPresentation();
    this.linkedContentController.unmountWelcome();
    this.linkedContentController.unmountInfoRow();
    this.transcript.detach();
    this.presentation = null;
  }

  async hydrate(): Promise<void> {
    if (this.hydrationState === 'ready') return;
    if (this.hydration) return this.hydration;
    this.hydrationState = 'loading';
    this.hydration = this.conversationController.loadActive()
      .then(() => { this.hydrationState = 'ready'; })
      .catch(error => { this.hydrationState = 'failed'; throw error; })
      .finally(() => { this.hydration = null; });
    return this.hydration;
  }

  async ensureExecutionInitialized(): Promise<boolean> {
    const coordinator = this.session.executionCoordinator;
    if (coordinator.state === 'idle' || coordinator.state === 'active') return true;
    try {
      const providerId = requireSessionProviderId(this.session, this.plugin);
      await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'session-execution');
      if (this.session.isDisposed) return false;
      const conversation = this.session.conversationId ? await this.plugin.getConversationById(this.session.conversationId) : null;
      if (this.session.isDisposed) return false;
      await coordinator.bindConversation(conversation ? createConversationExecutionBinding(conversation) : null);
      if (conversation) await coordinator.prepare();
      this.publish('settings');
      return !this.session.isDisposed;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Failed to initialize chat execution');
      return false;
    }
  }

  dispose(): void {
    this.detach();
    this.inlinePrompts.dismissAll();
    this.streamController.dispose();
    this.linkedContentController.destroy();
    this.subagentManager.clear();
    this.state.dispose();
    this.recovery.dispose();
  }

  async drainAuxiliaryWork(): Promise<void> {
    this.titleGenerationService.cancel();
    this.recovery.dispose();
    await Promise.allSettled(this.titleWork);
  }
}

export function createSessionMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Kept outside the evictable main model so a completed child and its source remain available. */
export function createSessionSideChat(session: ChatSessionRuntime, plugin: ChatFeatureHost): SideChatController {
  return new SideChatController({
    plugin,
    // Drafts belong to the attached view; only unsent recovery may need a model to retain it.
    drafts: {
      capture: destination => session.peekModel?.composer.capture(destination) ?? { content: '', images: [] },
      consume: destination => session.peekModel?.composer.consume(destination) ?? { content: '', images: [] },
      restore: (destination, draft, options) => session.model.composer.restore(destination, draft, options),
      changeDestination: update => session.peekModel ? session.peekModel.composer.changeDestination(update) : update(),
    },
    parent: {
      get conversationId() { return session.conversationId; },
      get providerId() { return session.providerId; },
      get isLive() { return !session.isDisposed; },
      get isStreaming() { return session.turns.isInFlight; },
      // Transcript reads hold a hydrated model; an evicted parent must not answer from an empty one.
      readLatestForkCheckpoint: () => session.withModel(async model => findLatestForkCheckpoint(model.state.messages)),
      captureForkSource: async () => {
        const capture = (model: SessionModel) => captureLatestCompletedForkSource({
          get conversationId() { return session.conversationId; },
          get providerId() { return session.providerId; },
          get draftModel() { return session.draftModel; },
          state: model.state, executionCoordinator: session.executionCoordinator,
        }, plugin, () => !session.isDisposed);
        if (session.isDisposed) return { ok: false, reason: 'stale-binding' };
        // The attached transcript is the source the user chose; only an evicted parent needs reloading.
        return session.peekModel ? capture(session.peekModel) : session.withModel(capture);
      },
    },
    onDestinationChanged: () => {
      const model = session.peekModel;
      if (!model) return;
      model.inlinePrompts.setActive(session.sideChat.destination === 'main');
      if (session.sideChat.destination === 'side') model.conversationController.cancelBranchDraft();
      model.publish('destination');
    },
    onStatusChanged: () => session.notifyChanged(),
  });
}
