import { Notice, setIcon } from 'obsidian';

import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';
import { captureSelectionSnapshots } from '@/core/prompt/promptContext';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

import {
  detectBuiltInCommand,
  detectMainOnlyBuiltInCommand,
  detectSideChatCommand,
  isSideChatCommandSupported,
} from '../../../core/commands/builtInCommands';
import type { ProviderExecutionEvent } from '../../../core/execution';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type ProviderCapabilities,
  type ProviderId,
  type TitleGenerationService,
} from '../../../core/providers/types';
import {
  type ApprovalDecision,
  type AskUserAnswers,
  type ChatMessage,
  isCanonicalUserMessage,
  type StreamChunk,
  type ToolCallInfo,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { toError } from '../../../utils/error';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import type { ChatSettings } from '../ChatSettings';
import type { ComposerDraftController } from '../composer/ComposerDraftController';
import { findComposerSessionMentions } from '../composer/composerSessionMentions';
import { buildChatExecutionConfiguration, resolveChatDynamicSections } from '../execution/chatExecutionConfiguration';
import {
  type ChatExecutionCoordinator,
  ChatExecutionPreHandoffError,
  type ChatTurnSubmission,
} from '../execution/ChatExecutionCoordinator';
import type {
  LinkedContentController,
  LinkedContentSubmissionToken,
} from '../linked-content';
import { AsyncQuestionPrompts } from '../rendering/AsyncQuestionPrompts';
import {
  type InlineApprovalOptions,
  InlineInteractionPrompts,
} from '../rendering/InlineInteractionPrompts';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { ResponseStream } from '../rendering/ResponseStream';
import { deliverAsyncQuestion } from '../services/asyncQuestionDelivery';
import { ConversationTitleGeneration } from '../services/ConversationTitleGeneration';
import type { SubagentManager } from '../services/SubagentManager';
import { resolveSessionMentions } from '../session-mentions/resolveSessionMentions';
import type { SideChatController } from '../side-chat/SideChatController';
import type { ChatState } from '../state/ChatState';
import type { ChatTurnRequest, QueuedMessage, TabReviewOutcome } from '../state/types';
import type { TabSession } from '../tabs/TabSession';
import type { BrowserSelectionController } from './BrowserSelectionController';
import type { BuiltInCommandController } from './BuiltInCommandController';
import type { CanvasSelectionController } from './CanvasSelectionController';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import {
  type StreamController,
} from './StreamController';
import type { TurnCoordinator } from './TurnCoordinator';
import { type PendingProviderUserMessage, TurnSteering } from './TurnSteering';

type ApprovalCallbackOptions = InlineApprovalOptions;

/** Rejected dispatch leaves draft recovery with its caller; handled work owns recovery. */
type DispatchResult = 'rejected' | 'handled' | 'queued';

export interface InputControllerDeps {
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  selectionController: SelectionController;
  browserSelectionController?: BrowserSelectionController;
  canvasSelectionController: CanvasSelectionController;
  conversationController: ConversationController;
  drafts: ComposerDraftController;
  getInputEl: () => ComposerInputElement;
  getWelcomeEl: () => HTMLElement | null;
  getMessagesEl: () => HTMLElement;
  getLinkedContentController: () => LinkedContentController;
  getTitleGenerationService: () => TitleGenerationService | null;
  getInputContainerEl: () => HTMLElement;
  generateId: () => string;
  getSettings: () => Readonly<ChatSettings>;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  getSubagentManager: () => SubagentManager;
  /** Authoritative tab/conversation provider, independent of runtime lifecycle. */
  getTabProviderId?: () => ProviderId | null;
  /** Returns true if ready. */
  ensureExecutionInitialized?: () => Promise<boolean>;
  builtInCommands: Pick<BuiltInCommandController, 'execute'>;
  /** Captures a review reporter when a terminal provider turn becomes visible. */
  captureReviewableSettlement?: (outcome: TabReviewOutcome) => () => void;
  canStartTurn?: () => boolean;
  isClosing?: () => boolean;
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

export class InputController {
  private deps: InputControllerDeps;
  private activeDelivery: SendMessageOptions['onDelivery'];
  private readonly inlinePrompts: InlineInteractionPrompts;
  private readonly asyncQuestions: AsyncQuestionPrompts;
  private readonly steering: TurnSteering;
  private readonly responseStream: ResponseStream;
  private pendingProviderUserMessages: PendingProviderUserMessage[] = [];
  private sawInitialProviderUserMessage = false;
  private awaitingProviderAssistantStart = false;
  private deferredReviewableSettlement: {
    conversationId: string | null;
    report: () => void;
  } | null = null;
  private readonly turnCoordinator: TurnCoordinator;
  private readonly titles: ConversationTitleGeneration;
  private queuedDispatch: { conversationId: string | null; timer: number } | null = null;
  private mainPreparationBarrier: Promise<void> | null = null;
  private readonly mentionPreparations = new Map<AbortController, { destination: 'main' | 'side'; pending: Promise<void> }>();

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
    this.turnCoordinator = deps.session.turns;
    this.steering = new TurnSteering({
      plugin: deps.plugin,
      state: deps.state,
      turns: this.turnCoordinator,
      getExecutionCoordinator: () => this.#getExecutionCoordinator(),
      getCapabilities: () => this.#getActiveCapabilities(),
      canStartTurn: () => this.deps.canStartTurn?.() !== false,
      toQueuedChatTurn: message => this.#toQueuedChatTurn(message),
      createSubmission: (displayContent, request) => this.#createExecutionSubmission(displayContent, request),
      onVisibleSteerChanged: () => this.updateQueueIndicator(),
      returnUnsent: message => this.#returnUnsentSteer(message),
    });
    this.titles = new ConversationTitleGeneration({
      host: deps.plugin, getService: () => this.deps.getTitleGenerationService(),
    });
    this.responseStream = new ResponseStream({
      state: deps.state, renderer: deps.renderer, stream: deps.streamController, turns: this.turnCoordinator,
      createMessageId: () => deps.generateId(),
    });
    this.inlinePrompts = new InlineInteractionPrompts({
      getPromptParentEl: () => this.deps.getInputContainerEl().parentElement,
      getSuppressedEl: () => this.deps.getInputContainerEl(),
      onBeforeShow: () => this.deps.streamController.hideThinkingIndicator(),
      onAfterSettle: () => this.deps.streamController.resumeThinkingIndicator(),
    });
    this.asyncQuestions = new AsyncQuestionPrompts({
      prompts: this.inlinePrompts,
      answer: (tool, answers, signal) => this.answerQuestion(tool, answers, this.deps.state.currentConversationId, signal),
      onChange: tool => this.deps.renderer.updateQuestionTool(tool),
      onPendingChange: (id, pending) => pending
        ? this.deps.state.beginActionRequired(id)
        : this.deps.state.endActionRequired(id),
    });
  }

  #getExecutionCoordinator(): ChatExecutionCoordinator | null {
    return this.deps.getExecutionCoordinator();
  }

  #getActiveProviderId(): ProviderId {
    const tabProviderId = this.deps.getTabProviderId?.();
    if (tabProviderId === null) throw new Error(t('chat.selectAvailableModel'));
    if (tabProviderId) {
      return tabProviderId;
    }

    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) {
      return DEFAULT_CHAT_PROVIDER_ID;
    }

    return this.deps.plugin.getConversationSummary(conversationId)?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  #getActiveCapabilities(): ProviderCapabilities {
    const providerId = this.#getActiveProviderId();
    return ProviderRegistry.getCapabilities(providerId);
  }

  // ============================================
  // Message Sending
  // ============================================

  async sendMessage(options?: SendMessageOptions): Promise<void> {
    let queued = false;
    try {
      if (this.deps.canStartTurn?.() === false) return;
      if (this.deps.getTabProviderId?.() === null) {
        new Notice(t('chat.selectAvailableModel'));
        return;
      }
      const result = await this.#dispatchMessage(options);
      queued = result === 'queued';
    } finally {
      if (!queued) options?.onDelivery?.(false);
    }
  }

  setPromptActive(active: boolean): void {
    this.inlinePrompts.setActive(active);
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
        if (this.deps.canStartTurn?.() === false || state.cancelRequested || state.isSwitchingConversation
          || state.isResettingToNewChat || state.isRewinding) {
          throw new Error('The answer was not sent. Please try again.');
        }
      },
      prepare: reply => {
        const { turnRequest } = this.#buildTurnSubmission({
          content: reply.content, images: [], editorContextOverride: null, browserContextOverride: null, canvasContextOverride: null,
        });
        turnRequest.draftContent = reply.draftContent;
        return {
          steer: async onDelivery => {
            if (!this.steering.canSteer) return 'not-sent';
            const pending = await this.steering.steer(
              { ...this.#createQueuedMessage(reply.displayContent, turnRequest), onDelivery }, () => undefined, signal,
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
    return [...this.mentionPreparations].some(([controller, preparation]) =>
      preparation.destination === 'main' && !controller.signal.aborted);
  }

  resumeQueuedTurnAfterIntentAdmission(): void {
    if (this.deps.canStartTurn?.() === false) return;
    if (this.turnCoordinator.isActive || !this.deps.state.queuedMessage) return;
    this.processQueuedMessage();
  }

  async handleExecutionEvent(event: ProviderExecutionEvent): Promise<void> {
    if (event.type === 'turn_started' && event.accepted) this.activeDelivery?.(true);
    const assistant = this.responseStream.active;
    if (!assistant) return;
    if (event.type === 'user_message_started') {
      await this.#handleProviderMessageBoundaryChunk({
        content: event.content ?? '',
        itemId: event.nativeUserMessageId,
        type: 'user_message_start',
      });
      return;
    }
    if (event.type === 'assistant_message_started') {
      await this.#handleProviderMessageBoundaryChunk({
        itemId: event.nativeAssistantId,
        type: 'assistant_message_start',
      });
      return;
    }
    await this.responseStream.handleEvent(event);
  }

  #reserveMainPreparation(): () => void {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    this.mainPreparationBarrier = barrier;
    return () => {
      release();
      if (this.mainPreparationBarrier === barrier) this.mainPreparationBarrier = null;
    };
  }

  async #dispatchMessage(
    options?: SendMessageOptions, skipPreparationBarrier = false, onAdmitted?: () => void,
  ): Promise<DispatchResult> {
    const {
      state,
      selectionController,
      browserSelectionController,
      canvasSelectionController,
    } = this.deps;
    this.#discardDeferredReviewForDifferentConversation();

    // While resetting to a new chat or switching, don't send - input is preserved so user can retry
    if (state.isResettingToNewChat || state.isSwitchingConversation) {
      this.#reportDeferredReviewableSettlement();
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
      this.#reportDeferredReviewableSettlement();
      return 'rejected';
    }

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      this.#reportDeferredReviewableSettlement();
      return 'rejected';
    }

    const sideChat = this.deps.getSideChatController?.() ?? null;

    // Reserved side-chat aliases never reach provider chat as ordinary text.
    const sideCommand = options?.turnRequestOverride ? null : detectSideChatCommand(content);
    if (sideCommand) {
      this.#reportDeferredReviewableSettlement();
      if (!sideChat || !isSideChatCommandSupported(this.#getActiveCapabilities())) {
        new Notice(t('chat.sideChat.unsupportedProvider'));
        return 'rejected';
      }
      const images = hasImages
        ? [...(imageOverride ?? composerDraft.images)]
        : [];
      // The side controller owns composer clearing so a rejected command keeps the draft.
      await sideChat.handleCommandSubmission(sideCommand.argument, images, this.#buildSideContext());
      return 'handled';
    }

    // Check for built-in commands first (e.g., /clear, /new)
    const builtInCmd = options?.turnRequestOverride ? null : detectBuiltInCommand(content, this.#getActiveProviderId());
    if (builtInCmd && destination !== 'side') {
      if (builtInCmd.command.action === 'clear') {
        this.#clearDeferredReviewableSettlement();
      } else {
        this.#reportDeferredReviewableSettlement();
      }
      if (shouldUseInput) {
        this.deps.drafts.restore(destination, { content: '', images: composerDraft.images });
      }
      await this.deps.builtInCommands.execute(builtInCmd.command, this.#getActiveCapabilities());
      return 'handled';
    }

    // Reserve busy-main admission order before any hydration can yield.
    if (destination === 'main' && this.mainPreparationBarrier && !skipPreparationBarrier) {
      const previous = this.mainPreparationBarrier;
      const conversationId = state.currentConversationId;
      const original = shouldUseInput ? this.deps.drafts.consume('main') : { content, images: imageOverride ?? composerDraft.images };
      const { turnRequest: captured } = this.#buildTurnSubmission({ content, ...options });
      const capturedOptions: SendMessageOptions = {
        ...options, destination: 'main', content, images: [...(imageOverride ?? composerDraft.images)],
        editorContextOverride: captured.editorSelection ?? null,
        browserContextOverride: captured.browserSelection ?? null,
        canvasContextOverride: captured.canvasSelection ?? null,
        draftConsumed: shouldUseInput,
      };
      const controller = new AbortController();
      const releaseAdmission = this.#reserveMainPreparation();
      let queued = false;
      const pending = (async () => {
        await previous;
        options?.assertBeforeHandoff?.();
        if (controller.signal.aborted || state.currentConversationId !== conversationId || this.deps.canStartTurn?.() === false) {
          this.deps.drafts.restore('main', original, { merge: true });
          return;
        }
        const result = await this.#dispatchMessage(capturedOptions, true, releaseAdmission);
        if (result === 'rejected') this.deps.drafts.restore('main', original, { merge: true });
        queued = result === 'queued';
      })();
      this.mentionPreparations.set(controller, { destination, pending });
      try { await pending; } finally {
        this.mentionPreparations.delete(controller);
        releaseAdmission();
      }
      return queued ? 'queued' : 'handled';
    }

    if (!options?.turnRequestOverride && findComposerSessionMentions(content).length > 0) {
      if (destination === 'side' && detectMainOnlyBuiltInCommand(content)) {
        new Notice(t('chat.sideChat.mainOnlyCommand', { command: detectMainOnlyBuiltInCommand(content)!.name }));
        return 'rejected';
      }
      const conversationId = state.currentConversationId;
      const capturedSideRuntime = sideChat?.runtime;
      const images = [...(imageOverride ?? composerDraft.images)];
      const captured = this.#buildTurnSubmission({ content, images, ...options });
      const sideContext = this.#buildSideContext();
      const original = shouldUseInput ? this.deps.drafts.consume(destination) : { content, images };
      const preparation = new AbortController();
      const ownsMainTurn = destination === 'main' && !this.turnCoordinator.isActive && !state.queuedMessage;
      const releaseAdmission = destination === 'main' && !ownsMainTurn && !skipPreparationBarrier
        ? this.#reserveMainPreparation() : onAdmitted;
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
          if (state.currentConversationId !== conversationId || this.deps.canStartTurn?.() === false
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
            await this.#executeMainTurn(resolved.text, signal, { ...options, images, turnRequestOverride: turnRequest,
              draftConsumed: shouldUseInput || options?.draftConsumed });
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
          if (ownsMainTurn && !handedOff) this.#restoreQueuedMessageToInput();
        }
      };
      const pending = ownsMainTurn ? this.turnCoordinator.run(prepare) : prepare(preparation.signal);
      this.mentionPreparations.set(preparation, { destination, pending });
      try { await pending; } finally {
        this.mentionPreparations.delete(preparation);
        releaseAdmission?.();
      }
      return queued ? 'queued' : 'handled';
    }

    if (destination === 'side' && sideChat) {
      this.#reportDeferredReviewableSettlement();
      const mainOnly = detectMainOnlyBuiltInCommand(content);
      if (mainOnly) {
        new Notice(t('chat.sideChat.mainOnlyCommand', { command: mainOnly.name }));
        return 'rejected';
      }
      const images = hasImages
        ? [...(imageOverride ?? composerDraft.images)]
        : [];
      const context = this.#buildSideContext();
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
    if (this.turnCoordinator.isActive || state.queuedMessage) {
      const images = hasImages
        ? [...(imageOverride ?? composerDraft.images)]
        : undefined;
      const editorContext = options?.editorContextOverride !== undefined
        ? options.editorContextOverride : selectionController.getContext();
      const browserContext = options?.browserContextOverride !== undefined
        ? options.browserContextOverride : browserSelectionController?.getContext() ?? null;
      const canvasContext = options?.canvasContextOverride !== undefined
        ? options.canvasContextOverride : canvasSelectionController.getContext();
      const { displayContent, turnRequest } = options?.turnRequestOverride
        ? { displayContent: content, turnRequest: cloneChatTurnRequest(options.turnRequestOverride) }
        : this.#buildTurnSubmission({
          content,
          images,
          editorContextOverride: editorContext,
          browserContextOverride: browserContext,
          canvasContextOverride: canvasContext,
        });
      state.queuedMessage = this.#mergeQueuedMessages(
        state.queuedMessage,
        { ...this.#createQueuedMessage(displayContent, turnRequest), onDelivery: options?.onDelivery },
      );

      if (shouldUseInput) this.deps.drafts.consume(destination);
      this.updateQueueIndicator();
      onAdmitted?.();
      options?.onQueued?.();
      if (!this.turnCoordinator.isActive) this.processQueuedMessage();
      return 'queued';
    }

    if (!shouldUseInput) this.deps.conversationController.cancelBranchDraft();
    await this.turnCoordinator.run(signal => {
      onAdmitted?.();
      return this.#executeMainTurn(content, signal, options);
    });
    return 'handled';
  }

  async #executeMainTurn(content: string, signal: AbortSignal, options?: SendMessageOptions): Promise<void> {
    const { plugin, state, renderer, streamController, conversationController } = this.deps;
    const composerDraft = this.deps.drafts.capture('main');
    const imageOverride = options?.images;
    const shouldUseInput = options?.content === undefined || options?.draftConsumed === true;
    // Slash commands are passed directly to SDK for handling
    // SDK handles expansion, $ARGUMENTS, @file references, and frontmatter options
    const images = imageOverride ?? composerDraft.images;
    const imagesForMessage = images.length > 0 ? [...images] : undefined;
    const isCompact = /^\/compact(\s|$)/i.test(options?.turnRequestOverride?.text ?? content);

    const turnSubmission = options?.turnRequestOverride
      ? {
        displayContent: content,
        turnRequest: cloneChatTurnRequest(options.turnRequestOverride),
      }
      : this.#buildTurnSubmission({
        content,
        images: imagesForMessage,
        editorContextOverride: options?.editorContextOverride,
        browserContextOverride: options?.browserContextOverride,
        canvasContextOverride: options?.canvasContextOverride,
      });
    const { displayContent, turnRequest } = turnSubmission;
    const restoreUnsentInput = (request: ChatTurnRequest, mergeWithComposer = true): void => {
      // Unadmitted interaction replies stay with their prompt; queued replies use normal draft recovery.
      if (options?.assertBeforeHandoff) return;
      this.#restoreMessageToInput(this.#createQueuedMessage(displayContent, request), { mergeWithComposer });
    };
    // Capture and consume the main submission before native navigation can yield
    // and the shared composer can switch to another destination.
    if (shouldUseInput) {
      if (!options?.draftConsumed) this.deps.drafts.consume('main');
      if (conversationController.hasBranchDraft) {
        const committed = await conversationController.commitBranchDraft(signal);
        if (committed.status !== 'committed' || signal.aborted || this.deps.canStartTurn?.() === false) {
          restoreUnsentInput(turnRequest);
          return;
        }
      }
    }

    state.acknowledgeReview();

    let turnConversationId = state.currentConversationId;
    this.steering.delegateCorrelationToHistory(turnConversationId);

    const streamGeneration = this.turnCoordinator.beginResponse();
    state.ignoreUsageUpdates = false; // Allow usage updates for new query
    this.deps.getSubagentManager().resetSpawnedCount();
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true; // Reset auto-scroll based on setting

    // Hide welcome message when sending first message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.addClass('claudian-hidden');
    }

    const linkedContentController = this.deps.getLinkedContentController();
    const linkedContentSubmission = state.currentConversationId
      ? null
      : linkedContentController.beginSubmission();

    const messagesBeforeTurn = state.messages;
    const hadPendingConversationSave = state.hasPendingConversationSave;

    const userMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'user',
      content: displayContent,
      displayContent,                // Original user input (for UI display)
      timestamp: Date.now(),
      images: imagesForMessage,
    };
    state.addMessage(userMsg);
    state.hasPendingConversationSave = true;
    renderer.addMessage(userMsg);

    const restoreCancelledInput = (): boolean => {
      if (!signal.aborted) return false;
      restoreUnsentInput(turnRequest);
      this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      this.responseStream.clear();
      this.#resetProviderMessageBoundaryState();
      this.#reportDeferredReviewableSettlement();
      return true;
    };

    try {
      await this.#ensureConversation(linkedContentSubmission);
      if (this.#retainUnsentTurnOnClose(signal) || restoreCancelledInput()) return;
      await this.#titleFirstTurn();
      if (this.#retainUnsentTurnOnClose(signal) || restoreCancelledInput()) return;
    } catch (error) {
      if (linkedContentSubmission && !state.currentConversationId) {
        linkedContentController.rollbackSubmission(linkedContentSubmission);
      }
      restoreUnsentInput(turnRequest, false);
      this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      throw error;
    }
    turnConversationId = state.currentConversationId;
    const admittedTurnRequest = this.#bindLinkedContentAtTurnAdmission(turnRequest, {
      isCompact, creation: linkedContentSubmission, transcriptBeforeTurn: messagesBeforeTurn,
    });

    const assistantMsg = this.responseStream.start();
    this.pendingProviderUserMessages = [{
      displayContent,
      linkedContentPath: admittedTurnRequest.linkedContentPath,
      images: imagesForMessage,
    }];
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = true;

    streamController.showThinkingIndicator(
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

    // Lazy initialization: bind and prepare execution on the first provider action.
    if (this.deps.ensureExecutionInitialized) {
      const ready = await this.deps.ensureExecutionInitialized();
      if (this.#retainUnsentTurnOnClose(signal, assistantMsg.id) || restoreCancelledInput()) return;
      if (!ready) {
        if (this.#retainUnsentTurnOnClose(signal, assistantMsg.id)) return;
        new Notice('Failed to initialize agent execution. Please try again.');
        restoreUnsentInput(admittedTurnRequest);
        this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        this.responseStream.clear();
        this.#resetProviderMessageBoundaryState();
        this.#reportDeferredReviewableSettlement();
        return;
      }
    }

    const coordinator = this.#getExecutionCoordinator();
    if (!coordinator) {
      new Notice('Agent execution is not available. Please reload the plugin.');
      restoreUnsentInput(admittedTurnRequest);
      this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      this.responseStream.clear();
      this.#resetProviderMessageBoundaryState();
      this.#reportDeferredReviewableSettlement();
      return;
    }

    const dynamicSystemPromptSections = await resolveChatDynamicSections(this.deps.plugin);
    if (this.#retainUnsentTurnOnClose(signal, assistantMsg.id) || restoreCancelledInput()) return;

    try {
      userMsg.content = admittedTurnRequest.text;
      userMsg.linkedContentPath = admittedTurnRequest.linkedContentPath;
      this.activeDelivery = options?.onDelivery;
      const submission = this.#createExecutionSubmission(
        displayContent,
        admittedTurnRequest,
        userMsg,
        assistantMsg,
        dynamicSystemPromptSections,
      );
      if (options?.assertBeforeHandoff) submission.assertBeforeHandoff = options.assertBeforeHandoff;
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
      didEnqueueToSdk = result.accepted;
      if (result.accepted) options?.onDelivery?.(true);
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
        this.asyncQuestions.expireAll();
        wasInvalidated = true;
      } else if (result.status === 'missing-session') {
        const retryMessage = result.accepted || options?.assertBeforeHandoff
          ? null
          : this.#createQueuedMessage(displayContent, {
            ...admittedTurnRequest,
            images: imagesForMessage ?? admittedTurnRequest.images,
          });
        const pendingMessagesToRestore = state.queuedMessage
          ? this.#cloneQueuedMessage(state.queuedMessage)
          : null;
        const composerDraftToRestore = this.#captureComposerDraft();
        const resolution = result.missingSessionResolution ?? 'not_found';
        if (resolution === 'deleted') {
          this.#restoreMessageToInput(composerDraftToRestore, { mergeWithComposer: true });
          this.#restoreMessageToInput(pendingMessagesToRestore, { mergeWithComposer: true });
          this.#restoreMessageToInput(retryMessage, { mergeWithComposer: true });
        } else if (!result.accepted) {
          this.#restoreMessageToInput(retryMessage, { mergeWithComposer: true });
          this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
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
        if (!options?.assertBeforeHandoff && this.#retainUnsentTurnOnClose(signal, assistantMsg.id)) return;
        restoreUnsentInput(admittedTurnRequest);
        this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        didRollbackUnsentTurn = true;
        if (!signal.aborted) new Notice('Message was not sent. Please try again.');
        this.#reportDeferredReviewableSettlement();
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
      if (state.streamGeneration === streamGeneration) streamController.hideThinkingIndicator();
      else state.clearFlavorTimerInterval();

      try {
        // Skip remaining cleanup if stream was invalidated (tab closed or conversation switched)
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
          renderer.refreshActionButtons(userMsg, state.messages, userMsgIndex >= 0 ? userMsgIndex : undefined);
          scheduledContinuation = this.processQueuedMessage();
        }

        if (wasInvalidated) {
          this.steering.clearCurrentUi();
          this.updateQueueIndicator();
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
          this.#reportDeferredReviewableSettlement();
        }

        this.steering.delegateCorrelationToHistory(turnConversationId);
        this.responseStream.clear();
        this.#resetProviderMessageBoundaryState();
      }
    }
  }

  // ============================================
  // Queue Management
  // ============================================

  updateQueueIndicator(): void {
    const { state } = this.deps;
    const indicatorEl = state.queueIndicatorEl;
    if (!indicatorEl) return;

    indicatorEl.empty();

    const pendingSteer = this.steering.current;
    const visiblePendingSteer = pendingSteer?.uiState === 'visible'
      ? pendingSteer.message
      : null;
    const visibleQueuedMessage = state.queuedMessage ?? visiblePendingSteer;
    if (visibleQueuedMessage) {
      const isPendingSteerOnly = !state.queuedMessage && !!visiblePendingSteer;
      indicatorEl.createSpan({
        cls: 'claudian-input-queue-strip-tag',
        text: isPendingSteerOnly ? 'Steering' : 'Queued',
      });
      indicatorEl.createSpan({
        cls: 'claudian-queue-indicator-text',
        text: this.#getQueuedMessageDisplay(visibleQueuedMessage),
      });

      if (state.queuedMessage) {
        const actionsEl = indicatorEl.createDiv({ cls: 'claudian-queue-indicator-actions' });

        if (this.steering.canSteer) {
          const steerButton = actionsEl.createEl('button', {
            cls: 'claudian-queue-indicator-action',
            text: pendingSteer?.providerDisposition === 'awaiting-result'
              ? 'Steering...'
              : 'Steer Now',
          });
          steerButton.setAttribute('type', 'button');
          if (pendingSteer?.providerDisposition === 'awaiting-result') {
            steerButton.setAttribute('disabled', 'true');
          } else {
            steerButton.addEventListener('click', (event) => {
              event.stopPropagation();
              void this.steerQueuedMessage();
            });
          }
        }

        const editButton = this.#createQueueIconButton(
          actionsEl,
          'pencil',
          'Edit queued message',
        );
        editButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this.withdrawQueuedMessageToComposer();
        });

        const discardButton = this.#createQueueIconButton(
          actionsEl,
          'trash-2',
          'Discard queued message',
        );
        discardButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this.clearQueuedMessage();
        });
      }

      indicatorEl.addClass('claudian-visible-flex');
      indicatorEl.removeClass('claudian-hidden');
      return;
    }

    indicatorEl.removeClass('claudian-visible-flex');
    indicatorEl.addClass('claudian-hidden');
  }

  clearQueuedMessage(): void {
    const { state } = this.deps;
    this.#cancelQueuedDispatch();
    state.queuedMessage?.onDelivery?.(false);
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

  withdrawQueuedMessageToComposer(): void {
    const { state } = this.deps;
    this.#cancelQueuedDispatch();
    if (!state.queuedMessage) return;

    const queuedMessage = this.#cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    this.#restoreMessageToInput(queuedMessage, { mergeWithComposer: true });
    this.updateQueueIndicator();
  }

  #restoreMessageToInput(
    message: QueuedMessage | null,
    options: { mergeWithComposer?: boolean } = {},
  ): void {
    if (!message) return;
    message.onDelivery?.(false);

    this.deps.drafts.restore('main', { ...message, content: message.turnRequest?.draftContent ?? message.content }, {
      merge: options.mergeWithComposer, focus: true,
    });
  }

  #captureComposerDraft(): QueuedMessage | null {
    const { content, images } = this.deps.drafts.capture('main');
    if (!content.trim() && !images.length) return null;
    return this.#createQueuedMessage(content, { text: content, images });
  }

  #restoreQueuedMessageToInput(): void {
    const { state } = this.deps;
    this.#cancelQueuedDispatch();
    const queuedMessage = state.queuedMessage
      ? this.#cloneQueuedMessage(state.queuedMessage)
      : null;
    this.#restoreMessageToInput(queuedMessage, { mergeWithComposer: true });
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

  private processQueuedMessage(): boolean {
    const { state } = this.deps;
    if (!state.queuedMessage) return false;
    if (this.queuedDispatch) return true;

    // The visible queue retains ownership until the scheduled callback enters a turn.
    const reservation = { conversationId: state.currentConversationId, timer: 0 };
    this.queuedDispatch = reservation;
    reservation.timer = window.setTimeout(
      () => {
        if (this.queuedDispatch !== reservation) return;
        if (state.currentConversationId !== reservation.conversationId
          || state.isRewinding || state.isResettingToNewChat || state.isSwitchingConversation) {
          this.#restoreQueuedMessageToInput();
          return;
        }
        if (this.deps.canStartTurn?.() === false || this.turnCoordinator.isActive) {
          this.#cancelQueuedDispatch();
          return;
        }
        if (this.deps.getTabProviderId?.() === null) {
          this.#cancelQueuedDispatch();
          new Notice(t('chat.selectAvailableModel'));
          return;
        }
        const queuedMessage = state.queuedMessage;
        if (!queuedMessage) {
          this.#cancelQueuedDispatch();
          return;
        }
        void this.turnCoordinator.run(signal => {
          this.#cancelQueuedDispatch();
          state.queuedMessage = null;
          this.updateQueueIndicator();
          this.deps.conversationController.cancelBranchDraft();
          return this.#executeMainTurn(queuedMessage.content, signal, {
            destination: 'main', content: queuedMessage.content,
            images: queuedMessage.images ?? [],
            turnRequestOverride: this.#toQueuedChatTurn(queuedMessage).request,
            onDelivery: queuedMessage.onDelivery,
          });
        }).catch(() => {
          if (this.queuedDispatch === reservation) this.#cancelQueuedDispatch();
          this.#reportDeferredReviewableSettlement();
        })
          .finally(() => queuedMessage.onDelivery?.(false));
      },
      0
    );
    return true;
  }

  #cancelQueuedDispatch(): void {
    if (!this.queuedDispatch) return;
    window.clearTimeout(this.queuedDispatch.timer);
    this.queuedDispatch = null;
  }

  #deferReviewableSettlement(report: (() => void) | null): void {
    if (!report) return;
    this.deferredReviewableSettlement = {
      conversationId: this.deps.state.currentConversationId,
      report,
    };
  }

  #hasDeferredReviewableSettlement(): boolean {
    this.#discardDeferredReviewForDifferentConversation();
    return this.deferredReviewableSettlement !== null;
  }

  #reportDeferredReviewableSettlement(): void {
    if (!this.#hasDeferredReviewableSettlement()) return;
    const deferred = this.deferredReviewableSettlement;
    this.#clearDeferredReviewableSettlement();
    deferred?.report();
  }

  #reportCurrentOrDeferredReviewableSettlement(
    currentReporter: (() => void) | null,
  ): void {
    const reporter = currentReporter
      ?? (this.#hasDeferredReviewableSettlement()
        ? this.deferredReviewableSettlement?.report ?? null
        : null);
    this.#clearDeferredReviewableSettlement();
    reporter?.();
  }

  #discardDeferredReviewForDifferentConversation(): void {
    if (
      this.deferredReviewableSettlement !== null
      && this.deferredReviewableSettlement.conversationId
        !== this.deps.state.currentConversationId
    ) {
      this.#clearDeferredReviewableSettlement();
    }
  }

  #clearDeferredReviewableSettlement(): void {
    this.deferredReviewableSettlement = null;
  }

  #buildSideContext() {
    const editorSelection = this.deps.selectionController.getContext();
    const browserSelection = this.deps.browserSelectionController?.getContext() ?? null;
    const canvasSelection = this.deps.canvasSelectionController.getContext();
    return {
      ...(browserSelection ? { browserSelection: { ...browserSelection } } : {}),
      ...(canvasSelection ? {
        canvasSelection: { ...canvasSelection, nodeIds: [...canvasSelection.nodeIds] },
      } : {}),
      ...(editorSelection ? {
        editorSelection: {
          ...editorSelection,
          ...(editorSelection.cursorContext
            ? { cursorContext: { ...editorSelection.cursorContext } }
            : {}),
        },
      } : {}),
    };
  }

  #buildTurnSubmission(options: {
    content: string;
    images?: ChatMessage['images'];
    editorContextOverride?: EditorSelectionContext | null;
    browserContextOverride?: BrowserSelectionContext | null;
    canvasContextOverride?: CanvasSelectionContext | null;
  }): {
    displayContent: string;
    turnRequest: ChatTurnRequest;
  } {
    const {
      selectionController,
      browserSelectionController,
      canvasSelectionController,
    } = this.deps;

    const editorContext = options.editorContextOverride !== undefined
      ? options.editorContextOverride
      : selectionController.getContext();
    const browserContext = options.browserContextOverride !== undefined
      ? options.browserContextOverride
      : (browserSelectionController?.getContext() ?? null);
    const canvasContext = options.canvasContextOverride !== undefined
      ? options.canvasContextOverride
      : canvasSelectionController.getContext();

    // Linked content is bound only at admission, never from capture-time transcript state.
    return {
      displayContent: options.content,
      turnRequest: cloneChatTurnRequest({
        text: options.content,
        images: options.images,
        editorSelection: editorContext,
        browserSelection: browserContext,
        canvasSelection: canvasContext,
      }),
    };
  }

  /**
   * The first admitted canonical input of a Conversation carries its frozen Linked content: the
   * path captured when this turn created the Conversation, or the path locked into the existing
   * Conversation when an earlier first attempt failed after creation.
   */
  #bindLinkedContentAtTurnAdmission(
    request: ChatTurnRequest,
    admission: {
      isCompact: boolean;
      creation: LinkedContentSubmissionToken | null;
      transcriptBeforeTurn: readonly ChatMessage[];
    },
  ): ChatTurnRequest {
    const isFirstTurn = !admission.isCompact && !admission.transcriptBeforeTurn.some(isCanonicalUserMessage);
    const frozenPath = admission.creation
      ? admission.creation.path
      : this.deps.getLinkedContentController().getSnapshot().path;
    const linkedContentPath = isFirstTurn ? frozenPath ?? undefined : undefined;
    if (request.linkedContentPath === linkedContentPath) return request;

    const admittedRequest = cloneChatTurnRequest(request);
    if (linkedContentPath) {
      admittedRequest.linkedContentPath = linkedContentPath;
    } else {
      delete admittedRequest.linkedContentPath;
    }
    return admittedRequest;
  }

  #createExecutionSubmission(
    displayContent: string,
    request: ChatTurnRequest,
    user?: ChatMessage,
    assistant?: ChatMessage,
    dynamicSystemPromptSections: readonly string[] = [],
  ): ChatTurnSubmission {
    const settings = this.deps.getSettings();
    const images = [...(request.images ?? [])];

    return {
      canonicalText: request.text,
      configuration: {
        ...buildChatExecutionConfiguration(
          settings, this.deps.plugin.getSessionSnapshotDirectory(), dynamicSystemPromptSections,
        ),
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

  #getQueuedMessageDisplay(message: QueuedMessage | null): string {
    if (!message) {
      return '';
    }

    const rawContent = (message.content || message.turnRequest?.draftContent || '').trim();
    const preview = rawContent.length > 40
      ? rawContent.slice(0, 40) + '...'
      : rawContent;
    const hasImages = (message.images?.length ?? 0) > 0;

    if (hasImages) {
      return preview ? `${preview} [images]` : '[images]';
    }

    return preview;
  }

  #createQueueIconButton(
    parentEl: HTMLElement,
    icon: string,
    label: string,
  ): HTMLElement {
    const button = parentEl.createEl('button', {
      cls: 'claudian-queue-indicator-icon-action',
      attr: {
        'aria-label': label,
        type: 'button',
      },
    });
    setIcon(button, icon);
    return button;
  }

  #cloneQueuedMessage(message: QueuedMessage): QueuedMessage {
    return {
      ...message,
      images: message.images ? [...message.images] : undefined,
      turnRequest: message.turnRequest
        ? cloneChatTurnRequest(message.turnRequest)
        : undefined,
    };
  }

  #createQueuedMessage(displayContent: string, turnRequest: ChatTurnRequest): QueuedMessage {
    const request = cloneChatTurnRequest(turnRequest);
    return {
      content: displayContent,
      images: request.images,
      editorContext: request.editorSelection ?? null,
      browserContext: request.browserSelection ?? null,
      canvasContext: request.canvasSelection ?? null,
      turnRequest: request,
    };
  }

  #toQueuedChatTurn(message: QueuedMessage): {
    displayContent: string;
    request: ChatTurnRequest;
  } {
    if (message.turnRequest) {
      return {
        displayContent: message.content,
        request: cloneChatTurnRequest(message.turnRequest),
      };
    }

    return {
      displayContent: message.content,
      request: {
        text: message.content,
        images: message.images ? [...message.images] : undefined,
        editorSelection: message.editorContext,
        browserSelection: message.browserContext ?? null,
        canvasSelection: message.canvasContext,
      },
    };
  }

  onConversationActivated(): void {
    this.#discardDeferredReviewForDifferentConversation();
    if (
      this.deps.state.isSwitchingConversation
      || this.deps.state.isResettingToNewChat
    ) {
      return;
    }
    if (this.steering.resumeParked()) return;
    this.updateQueueIndicator();
  }

  /** Unsent steering rejoins the queue while its turn still runs, otherwise the composer. */
  #returnUnsentSteer(message: QueuedMessage): void {
    const { state } = this.deps;
    if (this.turnCoordinator.isInFlight && !this.turnCoordinator.cancelRequested) {
      state.queuedMessage = state.queuedMessage
        ? this.#mergeQueuedMessages(message, state.queuedMessage)
        : this.#cloneQueuedMessage(message);
    } else {
      this.#restoreMessageToInput(message, { mergeWithComposer: true });
    }
  }

  #mergeQueuedMessages(
    existing: QueuedMessage | null,
    incoming: QueuedMessage,
  ): QueuedMessage {
    if (!existing) {
      return this.#cloneQueuedMessage(incoming);
    }

    const mergedTurn = mergeQueuedChatTurns(
      this.#toQueuedChatTurn(existing),
      this.#toQueuedChatTurn(incoming),
    );
    return {
      ...this.#createQueuedMessage(mergedTurn.displayContent, mergedTurn.request),
      onDelivery: accepted => {
        existing.onDelivery?.(accepted);
        incoming.onDelivery?.(accepted);
      },
    };
  }

  private async steerQueuedMessage(): Promise<void> {
    const { state } = this.deps;
    const coordinator = this.#getExecutionCoordinator();
    if (!state.queuedMessage || !this.steering.canSteer || !coordinator) {
      return;
    }
    if (!state.currentConversationId) return;

    const queuedMessage = this.#cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    const pending = await this.steering.steer(queuedMessage);
    if (pending.providerDisposition === 'definitely-unsent') this.steering.restoreIfDefinitelyUnsent(pending);
  }

  #resetProviderMessageBoundaryState(): void {
    this.pendingProviderUserMessages = [];
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = false;
  }

  async #handleProviderMessageBoundaryChunk(chunk: StreamChunk): Promise<boolean> {
    switch (chunk.type) {
      case 'user_message_start':
        await this.#handleProviderUserMessageStart(chunk);
        return true;
      case 'assistant_message_start':
        await this.#handleProviderAssistantMessageStart();
        return true;
      default:
        return false;
    }
  }

  async #handleProviderUserMessageStart(
    chunk: Extract<StreamChunk, { type: 'user_message_start' }>,
  ): Promise<void> {
    if (!this.sawInitialProviderUserMessage) {
      this.pendingProviderUserMessages.shift();
      this.sawInitialProviderUserMessage = true;
      return;
    }

    const echo = await this.steering.claimProviderEcho(chunk.itemId);
    const expected = echo.expected ?? this.pendingProviderUserMessages.shift();

    const previousAssistant = this.responseStream.active;
    const shouldDiscardPlaceholder = this.#shouldDiscardPendingAssistantPlaceholder(previousAssistant);
    if (previousAssistant) {
      if (shouldDiscardPlaceholder) {
        this.#discardStreamingAssistantMessage(previousAssistant.id);
      } else {
        await this.responseStream.flush(previousAssistant);
      }
    }
    this.deps.streamController.hideThinkingIndicator();

    const displayContent = expected?.displayContent ?? chunk.content;
    const persistedContent = expected?.persistedContent ?? displayContent;
    const images = expected?.images;
    if (displayContent || expected?.persistedContent || (images?.length ?? 0) > 0) {
      const userMessage: ChatMessage = {
        id: this.deps.generateId(),
        role: 'user',
        content: persistedContent,
        displayContent,
        timestamp: Date.now(),
        linkedContentPath: expected?.linkedContentPath,
        images,
        ...(chunk.itemId ? { userMessageId: chunk.itemId } : {}),
      };
      this.deps.state.addMessage(userMessage);
      this.deps.renderer.addMessage(userMessage);
    }
    echo.settle();

    this.responseStream.start();
    this.deps.streamController.showThinkingIndicator();
    this.deps.state.responseStartTime = performance.now();
    this.awaitingProviderAssistantStart = true;
    if (echo.acceptanceError) throw toError(echo.acceptanceError, 'Provider user message failed');
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
    this.deps.streamController.showThinkingIndicator();
  }

  #shouldDiscardPendingAssistantPlaceholder(message: ChatMessage | null): boolean {
    return this.awaitingProviderAssistantStart
      && !!message
      && !message.content.trim()
      && (message.toolCalls?.length ?? 0) === 0
      && (message.contentBlocks?.length ?? 0) === 0;
  }

  #retainUnsentTurnOnClose(signal: AbortSignal, assistantMessageId?: string): boolean {
    if (!this.deps.isClosing?.() && signal.reason !== 'shutdown') return false;
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
    renderer.removeMessage(messageId);
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
  }

  #rollbackFailedTurn(
    messagesBeforeTurn: ChatMessage[],
    hadPendingConversationSave: boolean,
  ): void {
    const { state, renderer } = this.deps;
    const retainedMessageIds = new Set(messagesBeforeTurn.map(message => message.id));
    for (const message of state.messages) {
      if (!retainedMessageIds.has(message.id)) {
        renderer.removeMessage(message.id);
      }
    }

    state.messages = messagesBeforeTurn;
    state.hasPendingConversationSave = hadPendingConversationSave;
    this.#resetTurnStreamingState();

    if (messagesBeforeTurn.length === 0) {
      this.deps.getWelcomeEl()?.removeClass('claudian-hidden');
    }
  }

  #finishAcceptedMissingSession(streamGeneration: number): void {
    if (this.deps.state.streamGeneration !== streamGeneration) return;
    this.#resetTurnStreamingState();
  }

  #resetTurnStreamingState(): void {
    const { state, streamController } = this.deps;
    streamController.hideThinkingIndicator();
    this.turnCoordinator.settle();
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
    state.responseStartTime = null;
    streamController.resetSubagentStreamingState();
  }

  /** Titles a Conversation after its first user message is admitted. */
  async #titleFirstTurn(): Promise<void> {
    const { state } = this.deps;
    if (state.messages.length !== 1 || !state.currentConversationId) return;
    const firstUserMessage = state.messages.find(message => message.role === 'user');
    if (!firstUserMessage) return;
    await this.titles.titleFirstTurn(state.currentConversationId, firstUserMessage);
  }

  async #ensureConversation(token: LinkedContentSubmissionToken | null): Promise<void> {
    if (this.deps.state.currentConversationId) return;
    if (!token) {
      throw new Error('Missing Linked content submission for new Conversation');
    }
    await this.deps.conversationController.createConversation(token, {
      providerId: this.#getActiveProviderId(),
      selectedModel: this.deps.getSettings().model || undefined,
    });
  }

  // ============================================
  // Streaming Control
  // ============================================

  /** Tab teardown closes admission before cancelling and joining these preparations. */
  async drainSessionMentionPreparations(): Promise<void> {
    this.#cancelQueuedDispatch();
    const pending = [...this.mentionPreparations.values()].map(value => value.pending);
    for (const controller of this.mentionPreparations.keys()) controller.abort();
    await Promise.allSettled(pending);
  }

  cancelStreaming(): void {
    const destination = this.deps.drafts.destination;
    for (const [controller, preparation] of this.mentionPreparations) {
      if (preparation.destination === destination) controller.abort();
    }
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
    if (!this.turnCoordinator.isInFlight) {
      this.#restoreQueuedMessageToInput();
      return;
    }
    this.deps.session.cancelTurn('user');
    this.#restoreQueuedMessageToInput();
    this.steering.clearCurrentUi();
    this.deps.streamController.hideThinkingIndicator();
  }

  /** Cancels the active turn and waits for its cleanup and conversation persistence. */
  async cancelStreamingAndWait(): Promise<void> {
    const activeTurn = Promise.allSettled([this.turnCoordinator.drain(), ...[...this.mentionPreparations.values()].map(value => value.pending)]);
    this.cancelStreaming();
    await activeTurn;
  }

  #syncScrollToBottomAfterRenderUpdates(): void {
    const { plugin, state } = this.deps;
    if (!(plugin.settings.enableAutoScroll ?? true)) return;
    if (!state.autoScrollEnabled) return;

    window.requestAnimationFrame(() => {
      if (!(this.deps.plugin.settings.enableAutoScroll ?? true)) return;
      if (!this.deps.state.autoScrollEnabled) return;

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ============================================
  // Approval Dialogs
  // ============================================

  handleApprovalRequest(
    interactionId: string,
    toolName: string,
    input: Record<string, unknown>,
    description: string,
    approvalOptions?: ApprovalCallbackOptions,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    return this.inlinePrompts.requestApproval(
      interactionId,
      toolName,
      input,
      description,
      approvalOptions,
      signal,
    );
  }

  handleAskUserQuestion(
    interactionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string | string[]> | null> {
    return this.inlinePrompts.askUserQuestion(interactionId, input, signal);
  }

  dismissProviderInteraction(interactionId: string): void {
    this.inlinePrompts.dismiss(interactionId);
  }

  dismissPendingApproval(): void {
    this.asyncQuestions.expireAll();
    this.inlinePrompts.dismissAll();
  }
}

function cloneChatTurnRequest(request: ChatTurnRequest): ChatTurnRequest {
  return {
    ...request,
    ...(request.selections !== undefined ? { selections: captureSelectionSnapshots(request) } : {}),
    ...(request.editorSelection ? { editorSelection: { ...request.editorSelection,
      ...(request.editorSelection.cursorContext ? { cursorContext: { ...request.editorSelection.cursorContext } } : {}),
    } } : {}),
    ...(request.browserSelection ? { browserSelection: { ...request.browserSelection } } : {}),
    ...(request.canvasSelection ? { canvasSelection: { ...request.canvasSelection, nodeIds: [...request.canvasSelection.nodeIds] } } : {}),
    images: request.images ? [...request.images] : undefined,
    ...(request.sessionReferences ? { sessionReferences: request.sessionReferences.map(reference => ({ ...reference })) } : {}),
  };
}

function mergeQueuedChatTurns(
  existing: { displayContent: string; request: ChatTurnRequest },
  incoming: { displayContent: string; request: ChatTurnRequest },
): { displayContent: string; request: ChatTurnRequest } {
  const mergeText = (first: string, second: string) => (
    [first, second].map(value => value.trim()).filter(Boolean).join('\n\n')
  );
  const images = [
    ...(existing.request.images ?? []),
    ...(incoming.request.images ?? []),
  ];
  return {
    displayContent: mergeText(existing.displayContent, incoming.displayContent),
    request: {
      ...cloneChatTurnRequest(incoming.request),
      selections: [...captureSelectionSnapshots(existing.request), ...captureSelectionSnapshots(incoming.request)],
      editorSelection: undefined,
      browserSelection: undefined,
      canvasSelection: undefined,
      sessionReferences: [...(existing.request.sessionReferences ?? []), ...(incoming.request.sessionReferences ?? [])],
      ...(existing.request.draftContent !== undefined || incoming.request.draftContent !== undefined ? {
        draftContent: mergeText(existing.request.draftContent ?? existing.displayContent,
          incoming.request.draftContent ?? incoming.displayContent),
      } : {}),
      images: images.length > 0 ? images : undefined,
      text: mergeText(existing.request.text, incoming.request.text),
    },
  };
}
