import { Notice } from 'obsidian';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import type { ProviderExecutionEvent } from '@/core/execution';
import { captureSelectionSnapshots } from '@/core/prompt/promptContext';
import type { ProviderId } from '@/core/providers/types';
import { decodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ChatSettings } from '@/features/chat/ChatSettings';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { FirstTurnAdmission } from '@/features/chat/conversation/FirstTurnAdmission';
import { buildChatExecutionConfiguration } from '@/features/chat/execution/chatExecutionConfiguration';
import {
  type ChatExecutionCoordinator,
  ChatExecutionPreHandoffError,
  type ChatTurnSubmission,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SessionMessageDeferredError, type SessionMessageUnsentReason } from '@/features/chat/session-messaging/SessionMailbox';
import type { SessionComposerPort } from '@/features/chat/sessions/SessionComposer';
import type { ChatState } from '@/features/chat/state/ChatState';
import { createQueuedMessage } from '@/features/chat/state/chatTurnRequest';
import type { ChatTurnRequest, TabReviewOutcome } from '@/features/chat/state/types';
import { ResponseStream } from '@/features/chat/turns/ResponseStream';
import type { StreamController } from '@/features/chat/turns/StreamController';
import type { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import type { TurnQueue } from '@/features/chat/turns/TurnQueue';
import type { TurnSteering } from '@/features/chat/turns/TurnSteering';
import { toError } from '@/utils/error';

/** A main turn admitted for execution, with everything captured when it was admitted. */
export interface MainTurn {
  origin: 'user' | 'session-message';
  onUnsent?: (reason: SessionMessageUnsentReason) => void;
  displayContent: string;
  request: ChatTurnRequest;
  images?: ImageAttachment[];
  /**
   * `consume` clears the main draft before native navigation can yield; `consumed` was cleared at
   * admission. Both commit a pending branch draft first; `none` never touches the composer.
   */
  composerDraft: 'consume' | 'consumed' | 'none';
  /** Only unqueued submissions retain the originating interaction lifetime. */
  assertBeforeHandoff?: () => void;
  onDelivery?: (accepted: boolean) => void;
}

export interface MainTurnExecutionDeps {
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer | null;
  streamController: StreamController;
  conversationController: ConversationController;
  drafts: SessionComposerPort;
  turns: TurnCoordinator;
  steering: TurnSteering;
  queue: TurnQueue;
  firstTurn: FirstTurnAdmission;
  getWelcomeEl: () => HTMLElement | null;
  getMessagesEl: () => HTMLElement | null;
  generateId: () => string;
  getSettings: () => Readonly<ChatSettings>;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  getProviderId: () => ProviderId;
  /** Returns true if ready. */
  ensureExecutionInitialized: () => Promise<boolean>;
  /** Captures a review reporter when a terminal provider turn becomes visible. */
  captureReviewableSettlement?: (outcome: TabReviewOutcome) => () => void;
  isClosing: () => boolean;
  canStartTurn: () => boolean;
  /** An invalidated turn expires every live question it asked. */
  onInvalidated: () => void;
}

/**
 * Owns one main turn from admission through settlement: the transcript projection and its
 * rollback, the response stream with its provider message boundaries, delivery, and the
 * review a continuation defers until it settles.
 */
export class MainTurnExecution {
  private readonly responseStream: ResponseStream;
  private sawInitialProviderUserMessage = false;
  private awaitingProviderAssistantStart = false;
  private activeDelivery: MainTurn['onDelivery'];
  private deferredReviewableSettlement: {
    conversationId: string | null;
    report: () => void;
  } | null = null;

  constructor(private readonly deps: MainTurnExecutionDeps) {
    this.responseStream = new ResponseStream({
      state: deps.state, get renderer() { return deps.renderer; }, stream: deps.streamController, turns: deps.turns,
      createMessageId: () => deps.generateId(),
    });
  }

  async handleEvent(event: ProviderExecutionEvent): Promise<void> {
    if (event.type === 'turn_started' && event.accepted) this.activeDelivery?.(true);
    const assistant = this.responseStream.active;
    if (!assistant) return;
    if (event.type === 'user_message_started') {
      await this.#handleProviderUserMessageStart(event.content ?? '', event.nativeUserMessageId, event.inputId);
      return;
    }
    if (event.type === 'assistant_message_started') {
      await this.#handleProviderAssistantMessageStart();
      return;
    }
    await this.responseStream.handleEvent(event);
  }

  async run(turn: MainTurn, signal: AbortSignal): Promise<void> {
    const { plugin, state, streamController, conversationController } = this.deps;
    const { displayContent, request: turnRequest, images: imagesForMessage } = turn;
    const isCompact = parseCompactCommand(turnRequest.text) !== null;
    const restoreUnsentInput = (request: ChatTurnRequest, merge = true, unsentReason: SessionMessageUnsentReason = 'failed'): void => {
      if (turn.origin === 'session-message') {
        const reason: unknown = signal.aborted ? signal.reason : unsentReason;
        turn.onUnsent?.(reason === 'user' || reason === 'shutdown' || reason === 'new-conversation' || reason === 'deferred' ? reason : 'failed');
        return;
      }
      // Unadmitted interaction replies stay with their prompt; queued replies use normal draft recovery.
      if (turn.assertBeforeHandoff) return;
      this.deps.queue.returnMessageToComposer(createQueuedMessage(displayContent, request), { merge });
    };
    // Capture and consume the main submission before native navigation can yield
    // and the shared composer can switch to another destination.
    if (turn.composerDraft !== 'none') {
      if (turn.composerDraft === 'consume') this.deps.drafts.consume('main');
      if (conversationController.hasBranchDraft) {
        const committed = await conversationController.commitBranchDraft(signal);
        if (committed.status !== 'committed' || signal.aborted || !this.deps.canStartTurn()) {
          restoreUnsentInput(turnRequest);
          return;
        }
      }
    }

    if (turn.origin === 'user') state.acknowledgeReview();

    let turnConversationId = state.currentConversationId;
    this.deps.steering.finishTurn(turnConversationId);

    const streamGeneration = this.deps.turns.beginResponse();
    streamController.beginResponse();
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true; // Reset auto-scroll based on setting

    // Hide welcome message when sending first message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.addClass('claudian-hidden');
    }

    const messagesBeforeTurn = state.messages;
    const admission = this.deps.firstTurn.begin(messagesBeforeTurn, isCompact);
    const hadPendingConversationSave = state.hasPendingConversationSave;

    const sender = turn.origin === 'session-message' ? decodeSessionMessage(turnRequest.text) : null;
    const userMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'user',
      ...(sender ? { sessionMessage: { from: sender.from, sessionId: sender.sessionId } } : {}),
      content: displayContent,
      displayContent,                // Original user input (for UI display)
      timestamp: Date.now(),
      images: imagesForMessage,
    };
    state.addMessage(userMsg);
    state.hasPendingConversationSave = true;
    this.deps.renderer?.addMessage(userMsg);

    const rollbackFailedTurn = (assistantMsg?: ChatMessage): void => {
      // Admission can overlap independent background output. Only this unaccepted submission is rolled back.
      const owned = new Set([userMsg.id, assistantMsg?.id]);
      const retained = state.messages.filter(message => {
        if (!owned.has(message.id)) return true;
        this.deps.renderer?.removeMessage(message.id);
        return false;
      });
      state.messages = retained;
      state.hasPendingConversationSave = hadPendingConversationSave
        || retained.some(message => !messagesBeforeTurn.includes(message));
      this.#resetTurnStreamingState();
      if (retained.length === 0) this.deps.getWelcomeEl()?.removeClass('claudian-hidden');
    };

    const restoreCancelledInput = (assistantMsg?: ChatMessage): boolean => {
      if (!signal.aborted) return false;
      restoreUnsentInput(turnRequest);
      rollbackFailedTurn(assistantMsg);
      this.responseStream.clear();
      this.#resetProviderMessageBoundaryState();
      this.reportDeferredReview();
      return true;
    };

    try {
      await admission.ensureConversation(() => ({
        providerId: this.deps.getProviderId(),
        model: this.deps.getSettings().model || undefined,
      }));
      if ((turn.origin === 'user' && this.#retainUnsentTurnOnClose(signal)) || restoreCancelledInput()) return;
      await admission.titleFirstTurn();
      if ((turn.origin === 'user' && this.#retainUnsentTurnOnClose(signal)) || restoreCancelledInput()) return;
    } catch (error) {
      admission.rollbackIfUncreated();
      restoreUnsentInput(turnRequest, false);
      rollbackFailedTurn();
      throw error;
    }
    turnConversationId = state.currentConversationId;
    const admittedTurnRequest = admission.bind(turnRequest);

    const assistantMsg = this.responseStream.start();
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = true;

    streamController.thinkingIndicator.show(
      isCompact ? 'Compacting...' : undefined,
      isCompact ? 'claudian-thinking--compact' : undefined,
    );
    state.responseStartTime = performance.now();

    let wasInterrupted = false;
    let wasInvalidated = false;
    let didEnqueueToSdk = false;
    let didRollbackUnsentTurn = false;
    let shouldReportReviewableSettlement = false;
    let currentReviewableSettlementReporter: (() => void) | null = null;
    let didCancelThisTurn = false;
    let completed = false;
    let hadExecutionError = false;
    let scheduledContinuation = false;

    const rollbackUnstartedTurn = (): void => {
      restoreUnsentInput(admittedTurnRequest);
      rollbackFailedTurn(assistantMsg);
      this.responseStream.clear();
      this.#resetProviderMessageBoundaryState();
      this.reportDeferredReview();
    };

    // Lazy initialization: bind and prepare execution on the first provider action.
    const ready = await this.deps.ensureExecutionInitialized();
    if ((turn.origin === 'user' && this.#retainUnsentTurnOnClose(signal, assistantMsg.id)) || restoreCancelledInput(assistantMsg)) return;
    if (!ready) {
      if ((turn.origin === 'user' && this.#retainUnsentTurnOnClose(signal, assistantMsg.id))) return;
      new Notice('Failed to initialize agent execution. Please try again.');
      rollbackUnstartedTurn();
      return;
    }

    const coordinator = this.deps.getExecutionCoordinator();
    if (!coordinator) {
      new Notice('Agent execution is not available. Please reload the plugin.');
      rollbackUnstartedTurn();
      return;
    }

    try {
      userMsg.content = admittedTurnRequest.text;
      userMsg.linkedContentPath = admittedTurnRequest.linkedContentPath;
      this.activeDelivery = turn.onDelivery;
      const submission = this.createSubmission(
        displayContent,
        admittedTurnRequest,
        userMsg,
        assistantMsg,
      );
      if (turn.assertBeforeHandoff) submission.assertBeforeHandoff = turn.assertBeforeHandoff;
      const result = await coordinator.execute(submission, signal);
      if (result.status === 'completed') {
        completed = true;
        const checkpoint = result.nativeAssistantMessageId ?? result.nativeCheckpointId;
        const finalAssistant = this.responseStream.active ?? assistantMsg;
        finalAssistant.completedAt = Date.now();
        if (checkpoint) {
          // The execution binding points to the original projection, before native message splits.
          if (finalAssistant !== assistantMsg && assistantMsg.assistantMessageId === checkpoint) {
            delete assistantMsg.assistantMessageId;
          }
          finalAssistant.assistantMessageId = checkpoint;
        }
      }
      if (!result.accepted && turn.origin === 'session-message' && result.status !== 'missing-session') {
        restoreUnsentInput(admittedTurnRequest);
        rollbackFailedTurn(assistantMsg);
        didRollbackUnsentTurn = true;
      }
      didEnqueueToSdk = result.accepted;
      if (result.accepted) turn.onDelivery?.(true);
      shouldReportReviewableSettlement = result.status === 'completed'
        || (result.status === 'error' && result.accepted);
      if (shouldReportReviewableSettlement) {
        currentReviewableSettlementReporter = this.deps.captureReviewableSettlement?.(
          result.status === 'error' ? 'error' : 'completed',
        ) ?? null;
      }
      if (result.status === 'cancelled') {
        wasInterrupted = true;
      } else if (result.status === 'invalidated') {
        this.deps.onInvalidated();
        wasInvalidated = true;
      } else if (result.status === 'missing-session') {
        const retryMessage = result.accepted || turn.assertBeforeHandoff || turn.origin === 'session-message'
          ? null
          : createQueuedMessage(displayContent, {
            ...admittedTurnRequest,
            images: imagesForMessage ?? admittedTurnRequest.images,
          });
        const resolution = result.missingSessionResolution ?? 'not_found';
        if (!result.accepted && turn.origin === 'session-message') turn.onUnsent?.(resolution === 'deleted' ? 'deleted' : 'failed');
        const { queue } = this.deps;
        if (resolution === 'deleted') {
          // The composer keeps its draft; the deleted session's tabs reset after this turn settles
          // and carry the composer, so queued and unsent input must reach it first. Settling first
          // sends steers that become definitely unsent later to the composer, not a dead queue.
          this.deps.turns.settle();
          queue.restoreToComposer();
          queue.returnMessageToComposer(retryMessage, { merge: true });
        } else if (!result.accepted) {
          queue.returnMessageToComposer(retryMessage, { merge: true });
          rollbackFailedTurn(assistantMsg);
        }
        if (result.accepted) {
          this.#finishAcceptedMissingSession(streamGeneration);
        }
        const notice = resolution === 'deleted'
            ? 'The provider session no longer exists. Its Claudian record was removed; send again to start a new session.'
            : resolution === 'reset'
              ? 'The provider session no longer exists. Claudian preserved the recoverable history; send again to rebuild the session.'
              : resolution === 'preserved'
                ? 'The provider session no longer exists. Claudian preserved its record because the remaining history could not be verified.'
                : 'The provider session no longer exists. Send again to start a new session.';
        new Notice(notice);
        wasInvalidated = true;
      } else if (result.status === 'error' && result.error) {
        hadExecutionError = true;
        await streamController.appendError(result.error.message);
      }
    } catch (error) {
      if (error instanceof ChatExecutionPreHandoffError) {
        if (!turn.assertBeforeHandoff && (turn.origin === 'user' && this.#retainUnsentTurnOnClose(signal, assistantMsg.id))) return;
        const deferred = error.cause instanceof SessionMessageDeferredError;
        restoreUnsentInput(admittedTurnRequest, true, deferred ? 'deferred' : 'failed');
        rollbackFailedTurn(assistantMsg);
        didRollbackUnsentTurn = true;
        if (deferred) scheduledContinuation = this.deps.queue.scheduleContinuation();
        if (!signal.aborted && !deferred) new Notice(error.userMessage ?? 'Message was not sent. Please try again.');
        this.reportDeferredReview();
      } else {
        hadExecutionError = true;
        shouldReportReviewableSettlement = true;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await streamController.appendError(errorMsg);
        currentReviewableSettlementReporter =
          this.deps.captureReviewableSettlement?.('error') ?? null;
      }
    } finally {
      this.activeDelivery = undefined;
      const finalAssistantMsg = this.responseStream.active ?? assistantMsg;

      // ALWAYS clear the timer interval, even on stream invalidation (prevents memory leaks).
      // An invalidated turn that still owns the stream also withdraws its pending indicator.
      if (state.streamGeneration === streamGeneration) streamController.thinkingIndicator.hide();
      else state.clearFlavorTimerInterval();

      try {
        // Only the response generation that still owns the stream may finalize it.
        if (
          !wasInvalidated
          && !didRollbackUnsentTurn
          && state.streamGeneration === streamGeneration
        ) {
          // Native completion wins over a cancel that reached the provider too late.
          didCancelThisTurn = wasInterrupted || (state.cancelRequested && !completed);
          await this.responseStream.finish(finalAssistantMsg, { interrupted: didCancelThisTurn, failed: hadExecutionError });
          this.#syncScrollToBottomAfterRenderUpdates();

          const saveExtras = didEnqueueToSdk ? { resumeAtMessageId: undefined } : undefined;
          await conversationController.save(true, saveExtras);
          const userMsgIndex = state.messages.indexOf(userMsg);
          this.deps.renderer?.refreshActionButtons(userMsg, state.messages, userMsgIndex >= 0 ? userMsgIndex : undefined);
          scheduledContinuation = this.deps.queue.scheduleContinuation();
        }

        if (wasInvalidated) {
          this.deps.steering.clearCurrentUi();
          this.deps.queue.updateIndicator();
        }
      } finally {
        const currentSettlementIsReviewable = shouldReportReviewableSettlement
          && !didCancelThisTurn
          && state.streamGeneration === streamGeneration;
        if (scheduledContinuation) {
          if (currentSettlementIsReviewable && currentReviewableSettlementReporter) {
            this.#deferReviewableSettlement(currentReviewableSettlementReporter);
          }
        } else if (currentSettlementIsReviewable) {
          this.#reportCurrentOrDeferredReviewableSettlement(
            currentReviewableSettlementReporter,
          );
        } else {
          this.reportDeferredReview();
        }

        this.deps.steering.finishTurn(turnConversationId);
        this.responseStream.clear();
        this.#resetProviderMessageBoundaryState();
      }
    }
  }

  createSubmission(
    displayContent: string,
    request: ChatTurnRequest,
    user?: ChatMessage,
    assistant?: ChatMessage,
  ): ChatTurnSubmission {
    const settings = this.deps.getSettings();
    const images = [...(request.images ?? [])];

    return {
      canonicalText: request.text,
      configuration: {
        ...buildChatExecutionConfiguration(settings),
        promptSuggestions: true,
      },
      context: {
        ...(request.selections !== undefined ? { selections: captureSelectionSnapshots(request) } : {}),
        ...(request.sessionReferences?.length ? { sessionReferences: request.sessionReferences } : {}),
        ...(request.browserSelection
          ? { browserSelection: request.browserSelection }
          : {}),
        ...(request.canvasSelection
          ? { canvasSelection: request.canvasSelection }
          : {}),
        ...(request.linkedContentPath
          ? { linkedContent: { path: request.linkedContentPath } }
          : {}),
        ...(request.editorSelection
          ? { editorSelection: request.editorSelection }
          : {}),
      },
      conversationHistory: user && assistant
        ? this.deps.state.messages.slice(0, -2)
        : [...this.deps.state.messages],
      images,
      submissionId: this.deps.generateId(),
      ...(user && assistant ? { messages: { assistant, user } } : {}),
      rawDisplayText: displayContent,
      timestamp: user?.timestamp ?? Date.now(),
      toolPolicy: { kind: 'provider-default' },
    };
  }

  // ============================================
  // Deferred review
  // ============================================

  reportDeferredReview(): void {
    if (!this.#hasDeferredReviewableSettlement()) return;
    const deferred = this.deferredReviewableSettlement;
    this.clearDeferredReview();
    deferred?.report();
  }

  clearDeferredReview(): void {
    this.deferredReviewableSettlement = null;
  }

  /** A review deferred for another conversation can no longer be reported here. */
  discardStaleDeferredReview(): void {
    if (
      this.deferredReviewableSettlement !== null
      && this.deferredReviewableSettlement.conversationId
        !== this.deps.state.currentConversationId
    ) {
      this.clearDeferredReview();
    }
  }

  #deferReviewableSettlement(report: (() => void) | null): void {
    if (!report) return;
    this.deferredReviewableSettlement = {
      conversationId: this.deps.state.currentConversationId,
      report,
    };
  }

  #hasDeferredReviewableSettlement(): boolean {
    this.discardStaleDeferredReview();
    return this.deferredReviewableSettlement !== null;
  }

  #reportCurrentOrDeferredReviewableSettlement(
    currentReporter: (() => void) | null,
  ): void {
    const reporter = currentReporter
      ?? (this.#hasDeferredReviewableSettlement()
        ? this.deferredReviewableSettlement?.report ?? null
        : null);
    this.clearDeferredReview();
    reporter?.();
  }

  // ============================================
  // Provider message boundaries
  // ============================================

  #resetProviderMessageBoundaryState(): void {
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = false;
  }

  async #handleProviderUserMessageStart(content: string, nativeUserMessageId: string | undefined, inputId?: string): Promise<void> {
    // The turn's own input echo is already projected.
    if (!this.sawInitialProviderUserMessage) {
      this.sawInitialProviderUserMessage = true;
      return;
    }

    const echo = this.deps.steering.claimProviderEcho(nativeUserMessageId, inputId);
    const acceptanceError = await echo.acceptance;
    const expected = echo.expected;

    const previousAssistant = this.responseStream.active;
    const shouldDiscardPlaceholder = this.#shouldDiscardPendingAssistantPlaceholder(previousAssistant);
    if (previousAssistant) {
      if (shouldDiscardPlaceholder) {
        this.#discardStreamingAssistantMessage(previousAssistant.id);
      } else {
        await this.responseStream.flush(previousAssistant);
      }
    }
    this.deps.streamController.thinkingIndicator.hide();

    const displayContent = expected?.displayContent ?? content;
    const persistedContent = expected?.persistedContent ?? displayContent;
    const images = expected?.images;
    if (displayContent || expected?.persistedContent || (images?.length ?? 0) > 0) {
      // A steered session message keeps its sender, as history replay decodes it.
      const sender = decodeSessionMessage(persistedContent);
      const userMessage: ChatMessage = {
        id: this.deps.generateId(),
        role: 'user',
        ...(sender ? { sessionMessage: { from: sender.from, sessionId: sender.sessionId } } : {}),
        content: persistedContent,
        displayContent,
        timestamp: Date.now(),
        linkedContentPath: expected?.linkedContentPath,
        images,
        ...(nativeUserMessageId ? { userMessageId: nativeUserMessageId } : {}),
      };
      this.deps.state.addMessage(userMessage);
      this.deps.renderer?.addMessage(userMessage);
    }
    echo.settle();

    this.responseStream.start();
    this.deps.streamController.thinkingIndicator.show();
    this.deps.state.responseStartTime = performance.now();
    this.awaitingProviderAssistantStart = true;
    if (acceptanceError) throw toError(acceptanceError, 'Provider user message failed');
  }

  async #handleProviderAssistantMessageStart(): Promise<void> {
    if (this.awaitingProviderAssistantStart) {
      this.awaitingProviderAssistantStart = false;
      return;
    }

    const previousAssistant = this.responseStream.active;
    if (previousAssistant) {
      await this.responseStream.flush(previousAssistant);
    }

    this.responseStream.start();
    this.deps.streamController.thinkingIndicator.show();
  }

  #shouldDiscardPendingAssistantPlaceholder(message: ChatMessage | null): boolean {
    return this.awaitingProviderAssistantStart
      && !!message
      && !message.content.trim()
      && (message.toolCalls?.length ?? 0) === 0
      && (message.contentBlocks?.length ?? 0) === 0;
  }

  // ============================================
  // Rollback
  // ============================================

  #retainUnsentTurnOnClose(signal: AbortSignal, assistantMessageId?: string): boolean {
    if (!this.deps.isClosing() && signal.reason !== 'shutdown') return false;
    // Teardown retains submitted input in the in-memory conversation projection.
    // The closing composer cannot receive a retry; native history remains provider-owned.
    if (assistantMessageId) this.#discardStreamingAssistantMessage(assistantMessageId);
    this.responseStream.clear();
    this.#resetProviderMessageBoundaryState();
    this.#resetTurnStreamingState();
    return true;
  }

  #discardStreamingAssistantMessage(messageId: string): void {
    const { state, renderer } = this.deps;
    state.messages = state.messages.filter((message) => message.id !== messageId);
    renderer?.removeMessage(messageId);
    state.resetStreamingPresentation();
  }

  #finishAcceptedMissingSession(streamGeneration: number): void {
    if (this.deps.state.streamGeneration !== streamGeneration) return;
    this.#resetTurnStreamingState();
  }

  #resetTurnStreamingState(): void {
    const { state, streamController } = this.deps;
    streamController.thinkingIndicator.hide();
    this.deps.turns.settle();
    state.resetStreamingPresentation();
    streamController.subagents.releaseManaged();
  }

  #syncScrollToBottomAfterRenderUpdates(): void {
    const { plugin, state } = this.deps;
    if (!(plugin.settings.enableAutoScroll ?? true)) return;
    if (!state.autoScrollEnabled) return;

    const messagesEl = this.deps.getMessagesEl();
    const view = messagesEl?.ownerDocument.defaultView;
    if (!messagesEl || !view) return;
    view.requestAnimationFrame(() => {
      if (this.deps.getMessagesEl() !== messagesEl) return;
      if (!(this.deps.plugin.settings.enableAutoScroll ?? true)) return;
      if (!this.deps.state.autoScrollEnabled) return;

      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
}
