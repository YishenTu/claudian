import { Notice } from 'obsidian';

import {
  detectBuiltInCommand,
  detectMainOnlyBuiltInCommand,
  detectSideChatCommand,
  isSideChatCommandSupported,
} from '@/core/commands/builtInCommands';
import type { ProviderExecutionEvent } from '@/core/execution';
import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderId, TitleGenerationService } from '@/core/providers/types';
import type { AskUserAnswers, ChatMessage, ToolCallInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ChatSettings } from '@/features/chat/ChatSettings';
import type { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { findComposerSessionMentions } from '@/features/chat/composer/composerSessionMentions';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import { FirstTurnAdmission } from '@/features/chat/conversation/FirstTurnAdmission';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { BuiltInCommandController } from '@/features/chat/input/BuiltInCommandController';
import type { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { resolveSessionMentions } from '@/features/chat/input/resolveSessionMentions';
import { SubmissionPreparations } from '@/features/chat/input/SubmissionPreparations';
import { deliverAsyncQuestion } from '@/features/chat/interactions/asyncQuestionDelivery';
import { AsyncQuestionPrompts } from '@/features/chat/interactions/AsyncQuestionPrompts';
import type { InlineInteractionPrompts } from '@/features/chat/interactions/InlineInteractionPrompts';
import type { LinkedContentController } from '@/features/chat/linked-content';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { SideChatController } from '@/features/chat/side-chat/SideChatController';
import type { ChatState } from '@/features/chat/state/ChatState';
import { cloneChatTurnRequest, createQueuedMessage } from '@/features/chat/state/chatTurnRequest';
import type { ChatTurnRequest, TabReviewOutcome } from '@/features/chat/state/types';
import type { TabSession } from '@/features/chat/tabs/TabSession';
import { type MainTurn, MainTurnExecution } from '@/features/chat/turns/MainTurnExecution';
import type { StreamController } from '@/features/chat/turns/StreamController';
import type { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { TurnQueue } from '@/features/chat/turns/TurnQueue';
import { TurnSteering } from '@/features/chat/turns/TurnSteering';
import { t } from '@/i18n/i18n';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

/** Rejected dispatch leaves draft recovery with its caller; handled work owns recovery. */
type DispatchResult = 'rejected' | 'handled' | 'queued';

export interface InputControllerDeps {
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  selections: Pick<ComposerSelections, 'capture'>;
  conversationController: ConversationController;
  drafts: ComposerDraftController;
  /** The tab's inline prompt surface, shared with its provider interaction port. */
  inlinePrompts: InlineInteractionPrompts;
  getInputEl: () => ComposerInputElement;
  getWelcomeEl: () => HTMLElement | null;
  getMessagesEl: () => HTMLElement;
  getLinkedContentController: () => LinkedContentController;
  getTitleGenerationService: () => TitleGenerationService | null;
  generateId: () => string;
  getSettings: () => Readonly<ChatSettings>;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  /** Authoritative tab/conversation provider; null means no available model is selected. */
  getTabProviderId: () => ProviderId | null;
  /** Returns true if ready. */
  ensureExecutionInitialized: () => Promise<boolean>;
  builtInCommands: Pick<BuiltInCommandController, 'execute'>;
  /** Captures a review reporter when a terminal provider turn becomes visible. */
  captureReviewableSettlement?: (outcome: TabReviewOutcome) => () => void;
  canStartTurn: () => boolean;
  isClosing: () => boolean;
  /** The tab-owned turn activity and its single cancellation recipe. */
  session: Pick<TabSession, 'turns' | 'cancelTurn'>;
  /** Destination seam for the shared composer; absent means main-only. */
  getSideChatController?: () => SideChatController | null;
}

export interface SendMessageOptions {
  /** Only unqueued submissions retain the originating interaction lifetime. */
  assertBeforeHandoff?: () => void;
  onDelivery?: (accepted: boolean) => void;
  /** Queue admission releases an async question without waiting for the next turn. */
  onQueued?: () => void;
  /** Retained main input must not follow later composer destination changes. */
  destination?: 'main';
  editorContextOverride?: EditorSelectionContext | null;
  browserContextOverride?: BrowserSelectionContext | null;
  canvasContextOverride?: CanvasSelectionContext | null;
  content?: string;
  images?: ChatMessage['images'];
  turnRequestOverride?: ChatTurnRequest;
  /** The original composer draft was consumed before asynchronous preparation. */
  draftConsumed?: boolean;
}

/** Admits composer and answer submissions and routes each to its destination. */
export class InputController {
  /** Main follow-up input waiting behind the running turn. */
  readonly queue: TurnQueue;
  private readonly deps: InputControllerDeps;
  private readonly turns: TurnCoordinator;
  private readonly asyncQuestions: AsyncQuestionPrompts;
  private readonly steering: TurnSteering;
  private readonly execution: MainTurnExecution;
  private readonly preparations = new SubmissionPreparations();

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
    this.turns = deps.session.turns;
    this.steering = new TurnSteering({
      state: deps.state,
      turns: this.turns,
      getExecutionCoordinator: () => this.deps.getExecutionCoordinator(),
      getCapabilities: () => this.#getActiveCapabilities(),
      canStartTurn: () => this.deps.canStartTurn(),
      toQueuedChatTurn: message => ({
        displayContent: message.content,
        request: cloneChatTurnRequest(message.turnRequest),
      }),
      createSubmission: (displayContent, request) => this.execution.createSubmission(displayContent, request),
      onVisibleSteerChanged: () => this.queue.updateIndicator(),
      returnUnsent: message => this.queue.returnUnsent(message),
    });
    this.queue = new TurnQueue({
      state: deps.state,
      turns: this.turns,
      drafts: deps.drafts,
      steering: this.steering,
      canStartTurn: () => this.deps.canStartTurn(),
      getTabProviderId: () => this.deps.getTabProviderId(),
      runQueued: (message, signal) => {
        this.deps.conversationController.cancelBranchDraft();
        const images = message.turnRequest.images ?? [];
        return this.execution.run({
          displayContent: message.content,
          request: cloneChatTurnRequest(message.turnRequest),
          images: images.length > 0 ? [...images] : undefined,
          composerDraft: 'none',
          onDelivery: message.onDelivery,
        }, signal);
      },
      onContinuationFailed: () => this.execution.reportDeferredReview(),
    });
    this.asyncQuestions = new AsyncQuestionPrompts({
      prompts: deps.inlinePrompts,
      answer: (tool, answers, signal) => this.answerQuestion(tool, answers, this.deps.state.currentConversationId, signal),
      onChange: tool => this.deps.renderer.updateQuestionTool(tool),
      onPendingChange: (id, pending) => pending
        ? this.deps.state.beginActionRequired(id)
        : this.deps.state.endActionRequired(id),
    });
    this.execution = new MainTurnExecution({
      plugin: deps.plugin,
      state: deps.state,
      renderer: deps.renderer,
      streamController: deps.streamController,
      conversationController: deps.conversationController,
      drafts: deps.drafts,
      turns: this.turns,
      steering: this.steering,
      queue: this.queue,
      firstTurn: new FirstTurnAdmission({
        host: deps.plugin,
        state: deps.state,
        conversationController: deps.conversationController,
        getLinkedContentController: () => this.deps.getLinkedContentController(),
        getTitleGenerationService: () => this.deps.getTitleGenerationService(),
      }),
      getWelcomeEl: () => this.deps.getWelcomeEl(),
      getMessagesEl: () => this.deps.getMessagesEl(),
      generateId: () => this.deps.generateId(),
      getSettings: () => this.deps.getSettings(),
      getExecutionCoordinator: () => this.deps.getExecutionCoordinator(),
      getProviderId: () => this.#getActiveProviderId(),
      ensureExecutionInitialized: () => this.deps.ensureExecutionInitialized(),
      captureReviewableSettlement: deps.captureReviewableSettlement,
      isClosing: () => this.deps.isClosing(),
      canStartTurn: () => this.deps.canStartTurn(),
      onInvalidated: () => this.asyncQuestions.expireAll(),
    });
  }

  #getActiveProviderId(): ProviderId {
    const providerId = this.deps.getTabProviderId();
    if (providerId === null) throw new Error(t('chat.selectAvailableModel'));
    return providerId;
  }

  #getActiveCapabilities(): ProviderCapabilities {
    return ProviderRegistry.getCapabilities(this.#getActiveProviderId());
  }

  // ============================================
  // Message Sending
  // ============================================

  async sendMessage(options?: SendMessageOptions): Promise<void> {
    let queued = false;
    try {
      if (!this.deps.canStartTurn()) return;
      if (this.deps.getTabProviderId() === null) {
        new Notice(t('chat.selectAvailableModel'));
        return;
      }
      const result = await this.#dispatchMessage(options);
      queued = result === 'queued';
    } finally {
      if (!queued) options?.onDelivery?.(false);
    }
  }

  updateAsyncQuestion(tool: ToolCallInfo): void {
    this.asyncQuestions.update(tool);
  }

  async answerQuestion(tool: ToolCallInfo, answers: AskUserAnswers, conversationId: string | null, signal?: AbortSignal): Promise<void> {
    const { state } = this.deps;
    await deliverAsyncQuestion(tool, answers, {
      providerId: this.#getActiveProviderId(),
      assertCurrent: () => {
        if (state.currentConversationId !== conversationId || !state.messages.some(message => message.toolCalls?.includes(tool))) {
          throw new Error('This question belongs to a different conversation.');
        }
        if (!this.deps.canStartTurn() || state.cancelRequested || state.isSwitchingConversation
          || state.isResettingToNewChat || state.isRewinding) {
          throw new Error('The answer was not sent. Please try again.');
        }
      },
      prepare: reply => {
        const { turnRequest } = this.#buildTurnSubmission(reply.content, [], {
          editorContextOverride: null, browserContextOverride: null, canvasContextOverride: null,
        });
        turnRequest.draftContent = reply.draftContent;
        return {
          steer: async onDelivery => {
            if (!this.steering.canSteer) return 'not-sent';
            const pending = await this.steering.steer(
              { ...createQueuedMessage(reply.displayContent, turnRequest), onDelivery }, () => undefined, signal,
            );
            if (pending.providerDisposition === 'definitely-unsent') {
              this.steering.release(pending);
              return 'not-sent';
            }
            return pending.providerDisposition === 'accepted-awaiting-correlation' ? 'accepted' : 'uncertain';
          },
          submit: (onDelivery, assertBeforeHandoff) => this.sendMessage({
            destination: 'main', content: reply.displayContent, images: [], turnRequestOverride: turnRequest,
            onDelivery, assertBeforeHandoff, onQueued: () => onDelivery(true),
          }),
        };
      },
    }, signal);
  }

  get isPreparingMainTurn(): boolean {
    return this.preparations.isPreparing('main');
  }

  resumeQueuedTurnAfterIntentAdmission(): void {
    if (!this.deps.canStartTurn()) return;
    if (this.turns.isActive || !this.queue.message) return;
    this.queue.scheduleContinuation();
  }

  handleExecutionEvent(event: ProviderExecutionEvent): Promise<void> {
    return this.execution.handleEvent(event);
  }

  async #dispatchMessage(
    options?: SendMessageOptions, skipPreparationBarrier = false, onAdmitted?: () => void,
  ): Promise<DispatchResult> {
    const { state } = this.deps;
    this.execution.discardStaleDeferredReview();

    // While resetting to a new chat or switching, don't send - input is preserved so user can retry
    if (state.isResettingToNewChat || state.isSwitchingConversation) {
      this.execution.reportDeferredReview();
      return 'rejected';
    }

    const destination = options?.destination ?? this.deps.drafts.destination;
    const composerDraft = this.deps.drafts.capture(destination);

    const contentOverride = options?.content;
    const shouldUseInput = contentOverride === undefined;
    const content = (contentOverride ?? composerDraft.content).trim();
    const imageOverride = options?.images;
    const hasImages = imageOverride !== undefined
      ? imageOverride.length > 0
      : (composerDraft.images.length > 0);
    if (!content && !hasImages && !options?.turnRequestOverride?.text.trim()) {
      this.execution.reportDeferredReview();
      return 'rejected';
    }

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      this.execution.reportDeferredReview();
      return 'rejected';
    }

    const sideChat = this.deps.getSideChatController?.() ?? null;

    // Reserved side-chat aliases never reach provider chat as ordinary text.
    const sideCommand = options?.turnRequestOverride ? null : detectSideChatCommand(content);
    if (sideCommand) {
      this.execution.reportDeferredReview();
      if (!sideChat || !isSideChatCommandSupported(this.#getActiveCapabilities())) {
        new Notice(t('chat.sideChat.unsupportedProvider'));
        return 'rejected';
      }
      const images = hasImages
        ? [...(imageOverride ?? composerDraft.images)]
        : [];
      // The side controller owns composer clearing so a rejected command keeps the draft.
      await sideChat.handleCommandSubmission(sideCommand.argument, images, this.deps.selections.capture());
      return 'handled';
    }

    // Check for built-in commands first (e.g., /clear, /new)
    const builtInCmd = options?.turnRequestOverride ? null : detectBuiltInCommand(content, this.#getActiveProviderId());
    if (builtInCmd && destination !== 'side') {
      if (builtInCmd.command.action === 'clear') {
        this.execution.clearDeferredReview();
      } else {
        this.execution.reportDeferredReview();
      }
      if (shouldUseInput) {
        this.deps.drafts.restore(destination, { content: '', images: composerDraft.images });
      }
      await this.deps.builtInCommands.execute(builtInCmd.command, this.#getActiveCapabilities());
      return 'handled';
    }

    // Reserve busy-main admission order before any hydration can yield.
    const previousMainAdmission = this.preparations.pendingMainAdmission;
    if (destination === 'main' && previousMainAdmission && !skipPreparationBarrier) {
      const conversationId = state.currentConversationId;
      const original = shouldUseInput ? this.deps.drafts.consume('main') : { content, images: imageOverride ?? composerDraft.images };
      const captured = this.#resolveSelections(options);
      const capturedOptions: SendMessageOptions = {
        ...options, destination: 'main', content, images: [...(imageOverride ?? composerDraft.images)],
        editorContextOverride: captured.editorSelection,
        browserContextOverride: captured.browserSelection,
        canvasContextOverride: captured.canvasSelection,
        draftConsumed: shouldUseInput,
      };
      const controller = new AbortController();
      const releaseAdmission = this.preparations.reserveMainAdmission();
      let queued = false;
      const pending = (async () => {
        await previousMainAdmission;
        options?.assertBeforeHandoff?.();
        if (controller.signal.aborted || state.currentConversationId !== conversationId || !this.deps.canStartTurn()) {
          this.deps.drafts.restore('main', original, { merge: true });
          return;
        }
        const result = await this.#dispatchMessage(capturedOptions, true, releaseAdmission);
        if (result === 'rejected') this.deps.drafts.restore('main', original, { merge: true });
        queued = result === 'queued';
      })();
      try {
        await this.preparations.track(controller, destination, pending);
      } finally {
        releaseAdmission();
      }
      return queued ? 'queued' : 'handled';
    }

    const hasSessionMentions = !options?.turnRequestOverride && findComposerSessionMentions(content).length > 0;
    if (destination === 'side' && (sideChat || hasSessionMentions)) {
      // An immediate side submission settles deferred main review; reference preparation does not.
      if (!hasSessionMentions) this.execution.reportDeferredReview();
      const mainOnly = detectMainOnlyBuiltInCommand(content);
      if (mainOnly) {
        new Notice(t('chat.sideChat.mainOnlyCommand', { command: mainOnly.name }));
        return 'rejected';
      }
    }

    if (hasSessionMentions) {
      const conversationId = state.currentConversationId;
      const capturedSideRuntime = sideChat?.runtime;
      const images = [...(imageOverride ?? composerDraft.images)];
      const captured = this.#buildTurnSubmission(content, images, options);
      const sideContext = this.deps.selections.capture();
      const original = shouldUseInput ? this.deps.drafts.consume(destination) : { content, images };
      const preparation = new AbortController();
      const ownsMainTurn = destination === 'main' && !this.turns.isActive && !this.queue.message;
      const releaseAdmission = destination === 'main' && !ownsMainTurn && !skipPreparationBarrier
        ? this.preparations.reserveMainAdmission() : onAdmitted;
      let queued = false;
      const prepare = async (signal: AbortSignal): Promise<void> => {
        const cancelSidePreparation = () => { if (destination === 'side') capturedSideRuntime?.cancel(); };
        signal.addEventListener('abort', cancelSidePreparation, { once: true });
        this.deps.getInputEl().setAttribute?.('aria-busy', 'true');
        let handedOff = false;
        try {
          const resolved = destination === 'side' && capturedSideRuntime
            ? await capturedSideRuntime.prepareSubmission(sideSignal => resolveSessionMentions(this.deps.plugin, content, sideSignal))
            : await resolveSessionMentions(this.deps.plugin, content, signal);
          signal.throwIfAborted();
          if (state.currentConversationId !== conversationId || !this.deps.canStartTurn()
            || (destination === 'side' && sideChat?.runtime !== capturedSideRuntime)) {
            throw new Error('The destination changed while preparing session references.');
          }
          const turnRequest = { ...captured.turnRequest, text: resolved.text, draftContent: original.content,
            sessionReferences: resolved.references };
          if (destination === 'side') {
            const accepted = await sideChat?.submitToSide(resolved.text, images,
              { ...sideContext, sessionReferences: resolved.references }, resolved.text);
            if (!accepted) throw new Error('The side chat could not accept this message.');
          } else if (ownsMainTurn) {
            handedOff = true;
            releaseAdmission?.();
            await this.execution.run(this.#resolveMainTurn(resolved.text, { ...options, images, turnRequestOverride: turnRequest,
              draftConsumed: shouldUseInput || options?.draftConsumed }), signal);
          } else {
            handedOff = true;
            const result = await this.#dispatchMessage({ ...options, destination: 'main', content: resolved.text, images, turnRequestOverride: turnRequest }, true, releaseAdmission);
            if (result === 'rejected') this.deps.drafts.restore(destination, original, { merge: true });
            queued = result === 'queued';
          }
          handedOff = true;
        } catch (error) {
          if (!handedOff) {
            this.deps.drafts.restore(destination, original, { merge: true });
            if (!signal.aborted) new Notice(error instanceof Error ? error.message : String(error));
          } else throw error;
        } finally {
          signal.removeEventListener('abort', cancelSidePreparation);
          this.deps.getInputEl().removeAttribute?.('aria-busy');
          if (ownsMainTurn && !handedOff) this.queue.restoreToComposer();
        }
      };
      const pending = ownsMainTurn ? this.turns.run(prepare) : prepare(preparation.signal);
      try {
        await this.preparations.track(preparation, destination, pending);
      } finally {
        releaseAdmission?.();
      }
      return queued ? 'queued' : 'handled';
    }

    if (destination === 'side' && sideChat) {
      const images = hasImages
        ? [...(imageOverride ?? composerDraft.images)]
        : [];
      const context = this.deps.selections.capture();
      const previousDraft = shouldUseInput ? this.deps.drafts.consume('side') : null;
      const accepted = await sideChat.submitToSide(
        content,
        images,
        context,
      );
      if (!accepted && previousDraft) this.deps.drafts.restore('side', previousDraft, { merge: true });
      return 'handled';
    }

    // Interaction ownership ends at queue admission, or at direct provider handoff.
    options?.assertBeforeHandoff?.();
    // If agent is working, queue the message instead of dropping it
    if (this.turns.isActive || this.queue.message) {
      const images = hasImages
        ? [...(imageOverride ?? composerDraft.images)]
        : undefined;
      const { displayContent, turnRequest } = this.#buildTurnSubmission(content, images, options);
      this.queue.enqueue({ ...createQueuedMessage(displayContent, turnRequest), onDelivery: options?.onDelivery });

      if (shouldUseInput) this.deps.drafts.consume(destination);
      onAdmitted?.();
      options?.onQueued?.();
      if (!this.turns.isActive) this.queue.scheduleContinuation();
      return 'queued';
    }

    if (!shouldUseInput) this.deps.conversationController.cancelBranchDraft();
    await this.turns.run(signal => {
      onAdmitted?.();
      return this.execution.run(this.#resolveMainTurn(content, options), signal);
    });
    return 'handled';
  }

  /** Captures a main turn when it is admitted to run now. */
  #resolveMainTurn(content: string, options?: SendMessageOptions): MainTurn {
    // Slash commands are passed directly to the provider, which owns their expansion.
    const images = options?.images ?? this.deps.drafts.capture('main').images;
    const imagesForMessage = images.length > 0 ? [...images] : undefined;
    const { displayContent, turnRequest } = this.#buildTurnSubmission(content, imagesForMessage, options);
    const fromComposer = options?.content === undefined || options?.draftConsumed === true;
    return {
      displayContent,
      request: turnRequest,
      images: imagesForMessage,
      composerDraft: !fromComposer ? 'none' : options?.draftConsumed ? 'consumed' : 'consume',
      assertBeforeHandoff: options?.assertBeforeHandoff,
      onDelivery: options?.onDelivery,
    };
  }

  #resolveSelections(options?: SendMessageOptions): Required<Pick<ChatTurnRequest, 'editorSelection' | 'browserSelection' | 'canvasSelection'>> {
    const live = this.deps.selections.capture();
    return {
      editorSelection: options?.editorContextOverride !== undefined
        ? options.editorContextOverride
        : live.editorSelection ?? null,
      browserSelection: options?.browserContextOverride !== undefined
        ? options.browserContextOverride
        : live.browserSelection ?? null,
      canvasSelection: options?.canvasContextOverride !== undefined
        ? options.canvasContextOverride
        : live.canvasSelection ?? null,
    };
  }

  #buildTurnSubmission(content: string, images: ChatMessage['images'], options?: SendMessageOptions): {
    displayContent: string;
    turnRequest: ChatTurnRequest;
  } {
    if (options?.turnRequestOverride) {
      return { displayContent: content, turnRequest: cloneChatTurnRequest(options.turnRequestOverride) };
    }
    // Linked content is bound only at admission, never from capture-time transcript state.
    return {
      displayContent: content,
      turnRequest: cloneChatTurnRequest({ text: content, images, ...this.#resolveSelections(options) }),
    };
  }

  onConversationActivated(): void {
    this.execution.discardStaleDeferredReview();
    if (
      this.deps.state.isSwitchingConversation
      || this.deps.state.isResettingToNewChat
    ) {
      return;
    }
    if (this.steering.resumeParked()) return;
    this.queue.updateIndicator();
  }

  // ============================================
  // Streaming Control
  // ============================================

  /** Tab teardown closes admission before cancelling and joining these preparations. */
  async drainSessionMentionPreparations(): Promise<void> {
    this.queue.cancelScheduled();
    await this.preparations.drain();
  }

  cancelStreaming(): void {
    this.preparations.abort(this.deps.drafts.destination);
    const sideChat = this.deps.getSideChatController?.() ?? null;
    if (sideChat?.destination === 'side') {
      sideChat.cancelSide();
      return;
    }
    this.#cancelMainStreaming();
  }

  #cancelMainStreaming(): void {
    this.asyncQuestions.cancelSubmissions();
    // Settlement already owns the response; only queued input can still be withdrawn.
    if (!this.turns.isInFlight) {
      this.queue.restoreToComposer();
      return;
    }
    this.deps.session.cancelTurn('user');
    this.queue.restoreToComposer();
    this.steering.clearCurrentUi();
    this.deps.streamController.thinkingIndicator.hide();
  }

  /** Cancels the active turn and waits for its cleanup and conversation persistence. */
  async cancelStreamingAndWait(): Promise<void> {
    const activeTurn = Promise.allSettled([this.turns.drain(), this.preparations.settled()]);
    this.cancelStreaming();
    await activeTurn;
  }

  dismissPendingApproval(): void {
    this.asyncQuestions.expireAll();
    this.deps.inlinePrompts.dismissAll();
  }
}
