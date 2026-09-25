import { Notice, setIcon } from 'obsidian';

import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

import {
  type BuiltInCommand,
  detectBuiltInCommand,
  detectMainOnlyBuiltInCommand,
  detectSideChatCommand,
  isBuiltInCommandSupported,
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
  type ChatMessage,
  isCanonicalUserMessage,
  type StreamChunk,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { ResumeSessionDropdown } from '../../../shared/components/ResumeSessionDropdown';
import type { BrowserSelectionContext } from '../../../utils/browser';
import type { CanvasSelectionContext } from '../../../utils/canvas';
import { extractUserDisplayContent } from '../../../utils/context';
import type { EditorSelectionContext } from '../../../utils/editor';
import { toError } from '../../../utils/error';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import type { ChatSettings } from '../ChatSettings';
import {
  type ChatExecutionCoordinator,
  ChatExecutionPreHandoffError,
  type ChatTurnSubmission,
} from '../execution/ChatExecutionCoordinator';
import type {
  LinkedContentController,
  LinkedContentSubmissionToken,
} from '../linked-content';
import {
  type InlineApprovalOptions,
  InlineInteractionPrompts,
} from '../rendering/InlineInteractionPrompts';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { continueResponseAfterNotification } from '../rendering/ResponseContinuation';
import type { SubagentManager } from '../services/SubagentManager';
import type { SideChatController } from '../side-chat/SideChatController';
import type { ChatState } from '../state/ChatState';
import type { ChatTurnRequest, QueuedMessage, TabReviewOutcome } from '../state/types';
import type { ImageContextManager } from '../ui/ImageContext';
import type { BrowserSelectionController } from './BrowserSelectionController';
import type { CanvasSelectionController } from './CanvasSelectionController';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import {
  providerOutputEventToStreamChunk,
  type StreamController,
} from './StreamController';
import type { ActiveTurnOwner } from './TurnCoordinator';
import { TurnCoordinator } from './TurnCoordinator';

type ApprovalCallbackOptions = InlineApprovalOptions;

export interface InputControllerDeps {
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  selectionController: SelectionController;
  browserSelectionController?: BrowserSelectionController;
  canvasSelectionController: CanvasSelectionController;
  conversationController: ConversationController;
  getInputEl: () => ComposerInputElement;
  getWelcomeEl: () => HTMLElement | null;
  getMessagesEl: () => HTMLElement;
  getLinkedContentController: () => LinkedContentController;
  getImageContextManager: () => ImageContextManager | null;
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
  openConversation?: (conversationId: string) => Promise<void>;
  /** Lets the active layout replace in-place clear with its own New action. */
  handleNewConversationCommand?: () => Promise<boolean>;
  onForkAll?: () => Promise<void>;
  /** Toggles the active provider's fast service tier when available. */
  toggleFastMode?: () => Promise<boolean>;
  /** Captures a review reporter when a terminal provider turn becomes visible. */
  captureReviewableSettlement?: (outcome: TabReviewOutcome) => () => void;
  canStartTurn?: () => boolean;
  turnOwner?: ActiveTurnOwner;
  /** Destination seam for the shared composer; absent means main-only. */
  getSideChatController?: () => SideChatController | null;
}

export interface SendMessageOptions {
  /** Retained main input must not follow later composer destination changes. */
  destination?: 'main';
  editorContextOverride?: EditorSelectionContext | null;
  browserContextOverride?: BrowserSelectionContext | null;
  canvasContextOverride?: CanvasSelectionContext | null;
  content?: string;
  images?: ChatMessage['images'];
  turnRequestOverride?: ChatTurnRequest;
}

interface PendingProviderUserMessage {
  displayContent: string;
  persistedContent?: string;
  linkedContentPath?: string;
  images?: ChatMessage['images'];
}

type PendingSteerProviderDisposition =
  | 'awaiting-result'
  | 'definitely-unsent'
  | 'accepted-awaiting-correlation'
  | 'ambiguous-awaiting-reconciliation';

interface PendingSteerState {
  readonly conversationId: string;
  readonly coordinator: ChatExecutionCoordinator;
  readonly submissionId: string;
  readonly message: QueuedMessage;
  readonly expectedProviderMessage: PendingProviderUserMessage;
  providerDisposition: PendingSteerProviderDisposition;
  uiState: 'visible' | 'cleared';
  correlationState: 'pending' | 'settled' | 'delegated-to-history';
  retryState: 'blocked' | 'parked' | 'restored';
}

export class InputController {
  private deps: InputControllerDeps;
  private activeResumeDropdown: ResumeSessionDropdown | null = null;
  private readonly inlinePrompts: InlineInteractionPrompts;
  private readonly pendingSteersByConversation = new Map<string, PendingSteerState>();
  private activeStreamingAssistantMessage: ChatMessage | null = null;
  private pendingProviderUserMessages: PendingProviderUserMessage[] = [];
  private sawInitialProviderUserMessage = false;
  private awaitingProviderAssistantStart = false;
  private deferredReviewableSettlement: {
    conversationId: string | null;
    report: () => void;
  } | null = null;
  private readonly turnCoordinator: TurnCoordinator<SendMessageOptions>;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
    this.inlinePrompts = new InlineInteractionPrompts({
      getPromptParentEl: () => this.deps.getInputContainerEl().parentElement,
      getSuppressedEl: () => this.deps.getInputContainerEl(),
      onBeforeShow: () => this.deps.streamController.hideThinkingIndicator(),
    });
    this.turnCoordinator = new TurnCoordinator(
      (options) => this.#executeSendMessage(options),
      deps.turnOwner,
    );
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

    return this.deps.plugin.getConversationSync(conversationId)?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  #getActiveCapabilities(): ProviderCapabilities {
    const providerId = this.#getActiveProviderId();
    return ProviderRegistry.getCapabilities(providerId);
  }

  async #resolveMainAgentDynamicSystemPromptSections(): Promise<readonly string[]> {
    try {
      return await this.deps.plugin.getMainAgentDynamicSystemPromptSections?.() ?? [];
    } catch {
      return [];
    }
  }

  // ============================================
  // Message Sending
  // ============================================

  async sendMessage(options?: SendMessageOptions): Promise<void> {
    if (this.deps.canStartTurn?.() === false) return;
    if (this.deps.getTabProviderId?.() === null) {
      new Notice(t('chat.selectAvailableModel'));
      return;
    }
    await this.turnCoordinator.run(options);
  }

  resumeQueuedTurnAfterIntentAdmission(): void {
    if (this.deps.canStartTurn?.() === false) return;
    if (this.deps.state.isStreaming || !this.deps.state.queuedMessage) return;
    this.processQueuedMessage();
  }

  async handleExecutionEvent(event: ProviderExecutionEvent): Promise<void> {
    const assistant = this.activeStreamingAssistantMessage;
    if (!assistant) return;
    if (event.type === 'turn_completed') {
      this.deps.state.cancelRequested = false;
      assistant.turnStats = event.turnStats;
      return;
    }
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
    const chunk = providerOutputEventToStreamChunk(event);
    if (chunk) {
      this.activeStreamingAssistantMessage = await continueResponseAfterNotification({
        state: this.deps.state, renderer: this.deps.renderer, stream: this.deps.streamController,
        createMessageId: () => this.deps.generateId(),
      }, this.activeStreamingAssistantMessage ?? assistant, chunk, event.scope);
      await this.deps.streamController.handleStreamChunk(
        chunk,
        this.activeStreamingAssistantMessage ?? assistant,
      );
    }
  }

  async #executeSendMessage(options?: SendMessageOptions): Promise<void> {
    const {
      plugin,
      state,
      renderer,
      streamController,
      selectionController,
      browserSelectionController,
      canvasSelectionController,
      conversationController
    } = this.deps;
    this.#discardDeferredReviewForDifferentConversation();

    // During conversation creation/switching, don't send - input is preserved so user can retry
    if (state.isCreatingConversation || state.isSwitchingConversation) {
      this.#reportDeferredReviewableSettlement();
      return;
    }

    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();

    const contentOverride = options?.content;
    const shouldUseInput = contentOverride === undefined;
    const content = (contentOverride ?? inputEl.value).trim();
    const imageOverride = options?.images;
    const hasImages = imageOverride !== undefined
      ? imageOverride.length > 0
      : (imageContextManager?.hasImages() ?? false);
    if (!content && !hasImages) {
      this.#reportDeferredReviewableSettlement();
      return;
    }

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      this.#reportDeferredReviewableSettlement();
      return;
    }

    const sideChat = this.deps.getSideChatController?.() ?? null;
    const destination = options?.destination ?? sideChat?.destination ?? 'main';

    // Reserved side-chat aliases never reach provider chat as ordinary text.
    const sideCommand = detectSideChatCommand(content);
    if (sideCommand) {
      this.#reportDeferredReviewableSettlement();
      if (!sideChat || !isSideChatCommandSupported(this.#getActiveCapabilities())) {
        new Notice(t('chat.sideChat.unsupportedProvider'));
        return;
      }
      const images = hasImages
        ? [...(imageOverride ?? imageContextManager?.getAttachedImages() ?? [])]
        : [];
      // The side controller owns composer clearing so a rejected command keeps the draft.
      await sideChat.handleCommandSubmission(sideCommand.argument, images, this.#buildSideContext());
      return;
    }

    if (destination === 'side' && sideChat) {
      this.#reportDeferredReviewableSettlement();
      const mainOnly = detectMainOnlyBuiltInCommand(content);
      if (mainOnly) {
        new Notice(t('chat.sideChat.mainOnlyCommand', { command: mainOnly.name }));
        return;
      }
      const images = hasImages
        ? [...(imageOverride ?? imageContextManager?.getAttachedImages() ?? [])]
        : [];
      const context = this.#buildSideContext();
      const previousValue = inputEl.value;
      if (shouldUseInput) {
        inputEl.value = '';
        imageContextManager?.clearImages();
      }
      const accepted = await sideChat.submitToSide(
        content,
        images,
        context,
      );
      if (!accepted && shouldUseInput) {
        inputEl.value = previousValue;
        imageContextManager?.setImages(images);
      }
      return;
    }

    // Check for built-in commands first (e.g., /clear, /new)
    const builtInCmd = detectBuiltInCommand(content, this.#getActiveProviderId());
    if (builtInCmd) {
      if (builtInCmd.command.action === 'clear') {
        this.#clearDeferredReviewableSettlement();
      } else {
        this.#reportDeferredReviewableSettlement();
      }
      if (shouldUseInput) {
        inputEl.value = '';
      }
      await this.#executeBuiltInCommand(builtInCmd.command);
      return;
    }

    // If agent is working, queue the message instead of dropping it
    if (state.isStreaming) {
      const images = hasImages
        ? [...(imageOverride ?? imageContextManager?.getAttachedImages() ?? [])]
        : undefined;
      const editorContext = selectionController.getContext();
      const browserContext = browserSelectionController?.getContext() ?? null;
      const canvasContext = canvasSelectionController.getContext();
      const { displayContent, turnRequest } = this.#buildTurnSubmission({
        content,
        images,
        editorContextOverride: editorContext,
        browserContextOverride: browserContext,
        canvasContextOverride: canvasContext,
      });
      state.queuedMessage = this.#mergeQueuedMessages(
        state.queuedMessage,
        this.#createQueuedMessage(displayContent, turnRequest),
      );

      if (shouldUseInput) {
        inputEl.value = '';
      }
      if (shouldUseInput) {
        imageContextManager?.clearImages();
      }
      this.updateQueueIndicator();
      return;
    }

    state.acknowledgeReview();

    let turnConversationId = state.currentConversationId;
    this.#delegatePendingSteerCorrelationToHistory(turnConversationId);

    if (shouldUseInput) {
      inputEl.value = '';
    }
    state.isStreaming = true;
    state.cancelRequested = false;
    state.ignoreUsageUpdates = false; // Allow usage updates for new query
    this.deps.getSubagentManager().resetSpawnedCount();
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true; // Reset auto-scroll based on setting
    const streamGeneration = state.bumpStreamGeneration();

    // Hide welcome message when sending first message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.addClass('claudian-hidden');
    }

    const linkedContentController = this.deps.getLinkedContentController();
    const linkedContentSubmission = state.currentConversationId
      ? null
      : linkedContentController.beginSubmission();

    // Slash commands are passed directly to SDK for handling
    // SDK handles expansion, $ARGUMENTS, @file references, and frontmatter options
    const images = imageOverride ?? imageContextManager?.getAttachedImages() ?? [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;
    const isCompact = /^\/compact(\s|$)/i.test(content);

    // Only clear images if we consumed user input (not for programmatic content override)
    if (shouldUseInput) {
      imageContextManager?.clearImages();
    }

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

    try {
      await this.#ensureConversationShell(linkedContentSubmission);
      await this.#triggerTitleGeneration();
    } catch (error) {
      if (linkedContentSubmission && !state.currentConversationId) {
        linkedContentController.rollbackSubmission(linkedContentSubmission);
      }
      this.#restoreMessageToInput(this.#createQueuedMessage(displayContent, turnRequest));
      this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      throw error;
    }
    turnConversationId = state.currentConversationId;
    const admittedTurnRequest = this.#bindLinkedContentAtTurnAdmission(
      turnRequest,
      isCompact,
    );

    const assistantMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    state.addMessage(assistantMsg);
    this.activeStreamingAssistantMessage = assistantMsg;
    this.#activateStreamingAssistantMessage(assistantMsg);
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
    let hadExecutionError = false;
    let scheduledContinuation = false;

    // Lazy initialization: bind and prepare execution on the first provider action.
    if (this.deps.ensureExecutionInitialized) {
      const ready = await this.deps.ensureExecutionInitialized();
      if (!ready) {
        new Notice('Failed to initialize agent execution. Please try again.');
        this.#restoreMessageToInput(
          this.#createQueuedMessage(displayContent, admittedTurnRequest),
          { mergeWithComposer: true },
        );
        this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        this.activeStreamingAssistantMessage = null;
        this.#resetProviderMessageBoundaryState();
        this.#reportDeferredReviewableSettlement();
        return;
      }
    }

    const coordinator = this.#getExecutionCoordinator();
    if (!coordinator) {
      new Notice('Agent execution is not available. Please reload the plugin.');
      this.#restoreMessageToInput(
        this.#createQueuedMessage(displayContent, admittedTurnRequest),
        { mergeWithComposer: true },
      );
      this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      this.activeStreamingAssistantMessage = null;
      this.#resetProviderMessageBoundaryState();
      this.#reportDeferredReviewableSettlement();
      return;
    }

    const dynamicSystemPromptSections = await this.#resolveMainAgentDynamicSystemPromptSections();

    try {
      userMsg.content = admittedTurnRequest.text;
      userMsg.linkedContentPath = admittedTurnRequest.linkedContentPath;
      const result = await coordinator.execute(this.#createExecutionSubmission(
        displayContent,
        admittedTurnRequest,
        userMsg,
        assistantMsg,
        dynamicSystemPromptSections,
      ));
      if (result.status === 'completed') {
        const checkpoint = result.nativeAssistantMessageId ?? result.nativeCheckpointId;
        const finalAssistant = this.activeStreamingAssistantMessage ?? assistantMsg;
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
        wasInvalidated = true;
      } else if (result.status === 'missing-session') {
        const retryMessage = result.accepted
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
        } else if (retryMessage) {
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
        await streamController.appendText(`\n\n**Error:** ${result.error.message}`);
      }
    } catch (error) {
      if (error instanceof ChatExecutionPreHandoffError) {
        this.#restoreMessageToInput(
          this.#createQueuedMessage(displayContent, admittedTurnRequest),
          { mergeWithComposer: true },
        );
        this.#rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        didRollbackUnsentTurn = true;
        new Notice('Message was not sent. Please try again.');
        this.#reportDeferredReviewableSettlement();
      } else {
        hadExecutionError = true;
        shouldReportReviewableSettlement = true;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await streamController.appendText(`\n\n**Error:** ${errorMsg}`);
        currentReviewableSettlementReporter =
          this.deps.captureReviewableSettlement?.('error') ?? null;
      }
    } finally {
      const finalAssistantMsg = this.activeStreamingAssistantMessage ?? assistantMsg;

      // ALWAYS clear the timer interval, even on stream invalidation (prevents memory leaks)
      state.clearFlavorTimerInterval();

      try {
        // Skip remaining cleanup if stream was invalidated (tab closed or conversation switched)
        if (
          !wasInvalidated
          && !didRollbackUnsentTurn
          && state.streamGeneration === streamGeneration
        ) {
          didCancelThisTurn = wasInterrupted || state.cancelRequested;
          if (didCancelThisTurn) {
            finalAssistantMsg.isInterrupt = true;
            if (state.currentContentEl) {
              renderer.appendInterruptIndicator(state.currentContentEl);
            }
          }
          streamController.hideThinkingIndicator();
          state.isStreaming = false;
          state.cancelRequested = false;

          // Capture response duration before resetting state (skip for interrupted responses, errors, and compaction)
          const hasCompactBoundary = finalAssistantMsg.contentBlocks?.some(b => b.type === 'context_compacted');
          if (!didCancelThisTurn && !hadExecutionError && !hasCompactBoundary) {
            const durationSeconds = state.responseStartTime
              ? Math.floor((performance.now() - state.responseStartTime) / 1000)
              : 0;
            finalAssistantMsg.durationSeconds = durationSeconds;
          }

          state.currentContentEl = null;

          await streamController.finalizeCurrentThinkingBlock(finalAssistantMsg);
          await streamController.finalizeCurrentTextBlock(finalAssistantMsg);
          renderer.finalizeResponse(finalAssistantMsg, state.messages, !didCancelThisTurn && !hadExecutionError);
          streamController.resetSubagentStreamingState();
          this.#syncScrollToBottomAfterRenderUpdates();

          const saveExtras = didEnqueueToSdk ? { resumeAtMessageId: undefined } : undefined;
          await conversationController.save(true, saveExtras);
          const userMsgIndex = state.messages.indexOf(userMsg);
          renderer.refreshActionButtons(userMsg, state.messages, userMsgIndex >= 0 ? userMsgIndex : undefined);
          scheduledContinuation = this.processQueuedMessage();
        }

        if (wasInvalidated) {
          this.#clearCurrentPendingSteerUi();
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

        this.#delegatePendingSteerCorrelationToHistory(turnConversationId);
        this.activeStreamingAssistantMessage = null;
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

    const pendingSteer = this.#getCurrentPendingSteer();
    const visiblePendingSteer = pendingSteer?.uiState === 'visible'
      ? pendingSteer.message
      : null;
    const visibleQueuedMessage = state.queuedMessage ?? visiblePendingSteer;
    if (visibleQueuedMessage) {
      const isPendingSteerOnly = !state.queuedMessage && !!visiblePendingSteer;
      indicatorEl.createSpan({
        cls: 'claudian-queue-indicator-text',
        text: `${isPendingSteerOnly ? '⌙ Steering: ' : '⌙ Queued: '}${this.#getQueuedMessageDisplay(visibleQueuedMessage)}`,
      });

      if (state.queuedMessage) {
        const actionsEl = indicatorEl.createDiv({ cls: 'claudian-queue-indicator-actions' });

        if (this.#canSteerQueuedMessage()) {
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
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

  withdrawQueuedMessageToComposer(): void {
    const { state } = this.deps;
    if (!state.queuedMessage) return;

    const queuedMessage = this.#cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    this.#restoreMessageToInput(queuedMessage, { mergeWithComposer: true });
    this.updateQueueIndicator();
  }

  restoreRewoundMessageToComposer(
    message: Pick<ChatMessage, 'content' | 'images'>,
  ): void {
    this.#restoreMessageToInput({
      canvasContext: null,
      content: message.content,
      editorContext: null,
      images: message.images,
    });
    const inputEl = this.deps.getInputEl();
    const EventConstructor = inputEl.ownerDocument?.defaultView?.Event ?? Event;
    inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  }

  #restoreMessageToInput(
    message: QueuedMessage | null,
    options: { mergeWithComposer?: boolean } = {},
  ): void {
    if (!message) return;

    const { content, images } = message;
    const inputEl = this.deps.getInputEl();
    const sideChat = this.deps.getSideChatController?.() ?? null;
    const mainDraft = sideChat?.destination === 'side' ? sideChat.getMainDraft() : null;
    const currentContent = options.mergeWithComposer
      ? (mainDraft?.content ?? inputEl.value).trim()
      : '';
    const restoredContent = currentContent
      ? appendMarkdownSnippet(content, currentContent)
      : content;

    const imageContextManager = this.deps.getImageContextManager();
    const currentImages = options.mergeWithComposer
      ? (mainDraft?.images ?? imageContextManager?.getAttachedImages() ?? [])
      : [];
    const restoredImages = [...(images ?? []), ...currentImages];
    if (mainDraft && sideChat) {
      sideChat.restoreMainDraft({ content: restoredContent, images: restoredImages });
      return;
    }
    inputEl.value = restoredContent;
    if (imageContextManager && (!options.mergeWithComposer || restoredImages.length > 0)) {
      imageContextManager.setImages(restoredImages);
    }
    inputEl.focus();
  }

  #captureComposerDraft(): QueuedMessage | null {
    const sideChat = this.deps.getSideChatController?.() ?? null;
    const mainDraft = sideChat?.destination === 'side' ? sideChat.getMainDraft() : null;
    const content = mainDraft?.content ?? this.deps.getInputEl().value;
    const attachedImages = mainDraft?.images
      ?? this.deps.getImageContextManager()?.getAttachedImages() ?? [];
    const images = attachedImages.length > 0 ? [...attachedImages] : undefined;
    if (!content.trim() && !images) {
      return null;
    }

    return this.#createQueuedMessage(content, {
      text: content,
      images,
    });
  }

  #restoreQueuedMessageToInput(): void {
    const { state } = this.deps;
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

    const queuedMessage = this.#cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    this.updateQueueIndicator();

    window.setTimeout(
      () => {
        if (this.deps.canStartTurn?.() === false) {
          if (!state.queuedMessage) {
            state.queuedMessage = queuedMessage;
            this.updateQueueIndicator();
          }
          return;
        }
        void this.sendMessage({
          destination: 'main',
          content: queuedMessage.content,
          images: queuedMessage.images ?? [],
          turnRequestOverride: this.#toQueuedChatTurn(queuedMessage).request,
        }).catch(() => this.#reportDeferredReviewableSettlement());
      },
      0
    );
    return true;
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

    const isCompact = /^\/compact(\s|$)/i.test(options.content);
    const candidateUserTurnOrdinal = this.deps.state.messages
      .filter(isCanonicalUserMessage).length + 1;
    const linkedContentPath = !isCompact && candidateUserTurnOrdinal === 1
      ? this.deps.getLinkedContentController().getSnapshot().path ?? undefined
      : undefined;
    return {
      displayContent: options.content,
      turnRequest: {
        text: options.content,
        images: options.images,
        linkedContentPath,
        editorSelection: editorContext,
        browserSelection: browserContext,
        canvasSelection: canvasContext,
      },
    };
  }

  #bindLinkedContentAtTurnAdmission(
    request: ChatTurnRequest,
    isCompact: boolean,
  ): ChatTurnRequest {
    const userTurnOrdinal = this.deps.state.messages
      .filter(isCanonicalUserMessage).length;
    const linkedContentPath = !isCompact && userTurnOrdinal === 1
      ? request.linkedContentPath
        ?? this.deps.getLinkedContentController().getSnapshot().path
        ?? undefined
      : undefined;
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
        model: settings.model,
        reasoning: settings.reasoning,
        permissionMode: settings.permissionMode,
        serviceTier: settings.serviceTier,
        systemInstructions: dynamicSystemPromptSections.length > 0
          ? {
              dynamicSections: [...dynamicSystemPromptSections],
              kind: 'provider-default',
            }
          : { kind: 'provider-default' },
      },
      context: {
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

    const rawContent = message.content.trim();
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
        title: label,
        type: 'button',
      },
    });
    setIcon(button, icon);
    return button;
  }

  #canSteerQueuedMessage(): boolean {
    return this.deps.state.isStreaming
      && this.#getCurrentPendingSteer() === null
      && this.#getActiveCapabilities().supportsTurnSteer === true
      && this.#getExecutionCoordinator() !== null;
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

  #getCurrentPendingSteer(): PendingSteerState | null {
    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) return null;
    return this.pendingSteersByConversation.get(conversationId) ?? null;
  }

  #isPendingSteerRegistered(pending: PendingSteerState): boolean {
    return this.pendingSteersByConversation.get(pending.conversationId) === pending;
  }

  #clearCurrentPendingSteerUi(): void {
    const pending = this.#getCurrentPendingSteer();
    if (!pending) return;
    pending.uiState = 'cleared';
    this.updateQueueIndicator();
  }

  #clearPendingSteerUi(pending: PendingSteerState): void {
    pending.uiState = 'cleared';
    if (pending.conversationId === this.deps.state.currentConversationId) {
      this.updateQueueIndicator();
    }
  }

  #releasePendingSteer(pending: PendingSteerState): void {
    if (this.#isPendingSteerRegistered(pending)) {
      this.pendingSteersByConversation.delete(pending.conversationId);
      pending.coordinator.releaseSteerCorrelation(pending.submissionId);
    }
  }

  #delegatePendingSteerCorrelationToHistory(
    conversationId: string | null,
  ): void {
    if (!conversationId) return;
    const pending = this.pendingSteersByConversation.get(conversationId);
    if (!pending) return;

    if (pending.correlationState === 'pending') {
      pending.correlationState = 'delegated-to-history';
    }
    this.#clearPendingSteerUi(pending);
    if (
      pending.providerDisposition !== 'awaiting-result'
      || pending.correlationState === 'settled'
    ) {
      this.#releasePendingSteer(pending);
    }
  }

  #restoreDefinitelyUnsentSteer(pending: PendingSteerState): void {
    if (
      pending.retryState === 'restored'
      || pending.providerDisposition === 'accepted-awaiting-correlation'
    ) {
      return;
    }

    pending.providerDisposition = 'definitely-unsent';
    pending.correlationState = 'settled';
    this.#clearPendingSteerUi(pending);
    if (
      pending.conversationId !== this.deps.state.currentConversationId
      || this.deps.state.isSwitchingConversation
      || this.deps.state.isCreatingConversation
    ) {
      pending.retryState = 'parked';
      return;
    }

    this.#restoreDefinitelyUnsentSteerForActiveConversation(pending);
  }

  #restoreDefinitelyUnsentSteerForActiveConversation(
    pending: PendingSteerState,
  ): void {
    if (pending.retryState === 'restored') return;

    pending.retryState = 'restored';
    this.#releasePendingSteer(pending);

    const { state } = this.deps;
    if (state.isStreaming && !state.cancelRequested) {
      state.queuedMessage = state.queuedMessage
        ? this.#mergeQueuedMessages(pending.message, state.queuedMessage)
        : this.#cloneQueuedMessage(pending.message);
    } else {
      this.#restoreMessageToInput(pending.message, { mergeWithComposer: true });
    }
    this.updateQueueIndicator();
  }

  onConversationActivated(): void {
    this.#discardDeferredReviewForDifferentConversation();
    if (
      this.deps.state.isSwitchingConversation
      || this.deps.state.isCreatingConversation
    ) {
      return;
    }
    const pending = this.#getCurrentPendingSteer();
    if (
      pending?.providerDisposition === 'definitely-unsent'
      && pending.retryState === 'parked'
    ) {
      this.#restoreDefinitelyUnsentSteerForActiveConversation(pending);
      return;
    }
    this.updateQueueIndicator();
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
    return this.#createQueuedMessage(mergedTurn.displayContent, mergedTurn.request);
  }

  private async steerQueuedMessage(): Promise<void> {
    const { state } = this.deps;
    const coordinator = this.#getExecutionCoordinator();
    const conversationId = state.currentConversationId;
    if (!state.queuedMessage || !this.#canSteerQueuedMessage() || !coordinator) {
      return;
    }
    if (!conversationId) return;

    const queuedMessage = this.#cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    const { displayContent, request } = this.#toQueuedChatTurn(queuedMessage);
    const dynamicSystemPromptSections = await this.#resolveMainAgentDynamicSystemPromptSections();
    const submission = this.#createExecutionSubmission(
      displayContent,
      request,
      undefined,
      undefined,
      dynamicSystemPromptSections,
    );
    const pending: PendingSteerState = {
      conversationId,
      coordinator,
      correlationState: 'pending',
      expectedProviderMessage: {
        displayContent,
        persistedContent: request.text,
        linkedContentPath: /^\/compact(\s|$)/i.test(request.text)
          ? undefined
          : request.linkedContentPath,
        images: request.images,
      },
      submissionId: submission.submissionId,
      message: queuedMessage,
      providerDisposition: 'awaiting-result',
      retryState: 'blocked',
      uiState: 'visible',
    };
    this.pendingSteersByConversation.set(conversationId, pending);
    this.updateQueueIndicator();

    try {
      const accepted = await coordinator.steer(submission);
      if (!accepted) {
        if (pending.providerDisposition === 'accepted-awaiting-correlation') return;
        this.#restoreDefinitelyUnsentSteer(pending);
        return;
      }

      pending.providerDisposition = 'accepted-awaiting-correlation';
      this.#clearPendingSteerUi(pending);
      if (pending.correlationState !== 'pending') {
        this.#releasePendingSteer(pending);
      }
    } catch (error) {
      if (pending.providerDisposition === 'accepted-awaiting-correlation') return;
      if (error instanceof ChatExecutionPreHandoffError) {
        this.#restoreDefinitelyUnsentSteer(pending);
        new Notice('Failed to steer the queued message. It is still available.');
        return;
      }

      pending.providerDisposition = 'ambiguous-awaiting-reconciliation';
      this.#clearPendingSteerUi(pending);
      if (pending.correlationState !== 'pending') {
        this.#releasePendingSteer(pending);
      }
      new Notice(
        'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.',
      );
    }
  }

  #activateStreamingAssistantMessage(message: ChatMessage): void {
    const { state, renderer } = this.deps;
    const msgEl = renderer.addMessage(message);
    const contentEl = msgEl.querySelector<HTMLElement>('.claudian-message-content');

    if (!contentEl) {
      return;
    }

    if (!state.currentContentEl) {
      state.toolCallElements.clear();
    }

    state.currentContentEl = contentEl;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
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

    const pendingSteer = this.#getCurrentPendingSteer();
    const expected = pendingSteer?.correlationState === 'pending'
      ? pendingSteer.expectedProviderMessage
      : this.pendingProviderUserMessages.shift();
    let acceptanceError: unknown;
    if (pendingSteer?.correlationState === 'pending') {
      pendingSteer.providerDisposition = 'accepted-awaiting-correlation';
      pendingSteer.correlationState = 'settled';
      this.#clearPendingSteerUi(pendingSteer);
      try {
        await pendingSteer.coordinator.acceptSteerFromProviderEvent(
          pendingSteer.submissionId,
          chunk.itemId,
        );
      } catch (error) {
        acceptanceError = error;
      }
    }

    const previousAssistant = this.activeStreamingAssistantMessage;
    const shouldDiscardPlaceholder = this.#shouldDiscardPendingAssistantPlaceholder(previousAssistant);
    if (previousAssistant) {
      if (shouldDiscardPlaceholder) {
        this.#discardStreamingAssistantMessage(previousAssistant.id);
      } else {
        await this.deps.streamController.finalizeCurrentThinkingBlock(previousAssistant);
        await this.deps.streamController.finalizeCurrentTextBlock(previousAssistant);
      }
    }
    this.deps.streamController.hideThinkingIndicator();

    const displayContent = expected?.displayContent ?? chunk.content;
    const persistedContent = expected?.persistedContent ?? displayContent;
    const images = expected?.images;
    if (displayContent || (images?.length ?? 0) > 0) {
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
    if (pendingSteer?.correlationState === 'settled') {
      this.#releasePendingSteer(pendingSteer);
    }

    const assistantMessage: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    this.deps.state.addMessage(assistantMessage);
    this.activeStreamingAssistantMessage = assistantMessage;
    this.#activateStreamingAssistantMessage(assistantMessage);
    this.deps.streamController.showThinkingIndicator();
    this.deps.state.responseStartTime = performance.now();
    this.awaitingProviderAssistantStart = true;
    if (acceptanceError) throw toError(acceptanceError, 'Provider user message failed');
  }

  async #handleProviderAssistantMessageStart(): Promise<void> {
    if (this.awaitingProviderAssistantStart) {
      this.awaitingProviderAssistantStart = false;
      return;
    }

    const previousAssistant = this.activeStreamingAssistantMessage;
    if (previousAssistant) {
      await this.deps.streamController.finalizeCurrentThinkingBlock(previousAssistant);
      await this.deps.streamController.finalizeCurrentTextBlock(previousAssistant);
    }

    const assistantMessage: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    this.deps.state.addMessage(assistantMessage);
    this.activeStreamingAssistantMessage = assistantMessage;
    this.#activateStreamingAssistantMessage(assistantMessage);
    this.deps.streamController.showThinkingIndicator();
  }

  #shouldDiscardPendingAssistantPlaceholder(message: ChatMessage | null): boolean {
    return this.awaitingProviderAssistantStart
      && !!message
      && !message.content.trim()
      && (message.toolCalls?.length ?? 0) === 0
      && (message.contentBlocks?.length ?? 0) === 0;
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
    state.isStreaming = false;
    state.cancelRequested = false;
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
    state.responseStartTime = null;
    streamController.resetSubagentStreamingState();
  }

  // ============================================
  // Title Generation
  // ============================================

  /**
   * Triggers AI title generation after first user message.
   * Handles setting fallback title, firing async generation, and updating UI.
   */
  async #triggerTitleGeneration(): Promise<void> {
    const { plugin, state, conversationController } = this.deps;

    if (state.messages.length !== 1) {
      return;
    }

    if (!state.currentConversationId) return;

    // Find first user message by role (not by index)
    const firstUserMsg = state.messages.find(m => m.role === 'user');

    if (!firstUserMsg) {
      return;
    }

    const userContent = firstUserMsg.displayContent
      ?? extractUserDisplayContent(firstUserMsg.content)
      ?? firstUserMsg.content;

    // Set immediate fallback title
    const fallbackTitle = conversationController.generateFallbackTitle(userContent);
    await plugin.renameConversation(state.currentConversationId, fallbackTitle);

    if (!plugin.settings.enableAutoTitleGeneration
      || !ProviderRegistry.resolveTitleGenerationSelection(plugin.settings)) {
      return;
    }

    // Fire async AI title generation only if service available
    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) {
      // No titleService, just keep the fallback title with no status
      return;
    }

    // Mark as pending only when we're actually starting generation
    await plugin.updateConversation(state.currentConversationId, { titleGenerationStatus: 'pending' });

    const convId = state.currentConversationId;
    const expectedTitle = fallbackTitle; // Store to check if user renamed during generation

    titleService.generateTitle(
      convId,
      userContent,
      async (conversationId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = await plugin.getConversationById(conversationId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches fallback)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && !userManuallyRenamed) {
          await plugin.renameConversation(conversationId, result.title);
          await plugin.updateConversation(conversationId, { titleGenerationStatus: 'success' });
        } else if (!userManuallyRenamed) {
          // Keep fallback title, mark as failed (only if user hasn't renamed)
          await plugin.updateConversation(conversationId, { titleGenerationStatus: 'failed' });
        } else {
          // User manually renamed, clear the status (user's choice takes precedence)
          await plugin.updateConversation(conversationId, { titleGenerationStatus: undefined });
        }
      }
    ).catch(() => {
      // Silently ignore title generation errors
    });
  }

  async #ensureConversationShell(
    token: LinkedContentSubmissionToken | null,
  ): Promise<void> {
    const { plugin, state } = this.deps;
    if (state.currentConversationId) return;
    if (!token) {
      throw new Error('Missing Linked content submission for new Conversation');
    }

    const selectedModel = this.deps.getSettings().model || undefined;
    const conversation = await plugin.createConversation({
      providerId: this.#getActiveProviderId(),
      ...(selectedModel ? { selectedModel } : {}),
      ...(token.path ? { linkedContentPath: token.path } : {}),
    });
    state.currentConversationId = conversation.id;

    const settlement = this.deps.getLinkedContentController().commitSubmission(token);
    for (const event of settlement.queuedEvents) {
      if (event.kind !== 'rename') continue;
      await plugin.rewriteLinkedContentPaths(
        event.oldPath,
        event.newPath,
        event.includeDescendants,
      );
    }
  }

  // ============================================
  // Streaming Control
  // ============================================

  cancelStreaming(): void {
    const sideChat = this.deps.getSideChatController?.() ?? null;
    if (sideChat?.destination === 'side') {
      sideChat.cancelSide();
      return;
    }
    this.#cancelMainStreaming();
  }

  #cancelMainStreaming(): void {
    const { state, streamController } = this.deps;
    if (!state.isStreaming) return;
    state.cancelRequested = true;
    this.#restoreQueuedMessageToInput();
    this.#clearCurrentPendingSteerUi();
    this.#getExecutionCoordinator()?.cancel();
    streamController.hideThinkingIndicator();
  }

  /** Cancels the active turn and waits for its cleanup and conversation persistence. */
  async cancelStreamingAndWait(): Promise<void> {
    const activeTurn = this.turnCoordinator.current;
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
    toolName: string,
    input: Record<string, unknown>,
    description: string,
    approvalOptions?: ApprovalCallbackOptions,
  ): Promise<ApprovalDecision> {
    return this.inlinePrompts.requestApproval(
      toolName,
      input,
      description,
      approvalOptions,
    );
  }

  handleAskUserQuestion(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string | string[]> | null> {
    return this.inlinePrompts.askUserQuestion(input, signal);
  }

  dismissPendingApprovalPrompt(): void {
    this.inlinePrompts.dismissApproval();
  }

  dismissProviderInteraction(kind: 'approval' | 'question'): void {
    this.inlinePrompts.dismiss(kind);
  }

  dismissPendingApproval(): void {
    this.inlinePrompts.dismissAll();
  }

  // ============================================
  // Built-in Commands
  // ============================================

  async #executeBuiltInCommand(command: BuiltInCommand): Promise<void> {
    const { conversationController } = this.deps;
    const capabilities = this.#getActiveCapabilities();

    if (!isBuiltInCommandSupported(command, capabilities)) {
      new Notice(`/${command.name} is not supported by this provider.`);
      return;
    }

    switch (command.action) {
      case 'clear': {
        const handledByLayout = await this.deps.handleNewConversationCommand?.() ?? false;
        if (handledByLayout) {
          const linkedContent = this.deps.getLinkedContentController();
          const linkedContentMode = linkedContent.getSnapshot().mode;
          if (linkedContentMode === 'auto-draft' || linkedContentMode === 'explicit-draft') {
            linkedContent.resetAutoDraft();
          }
        } else {
          await conversationController.createNew();
        }
        break;
      }
      case 'resume':
        this.#showResumeDropdown();
        break;
      case 'fork': {
        if (!this.#getActiveCapabilities().supportsFork) {
          new Notice('Fork is not supported by this provider.');
          return;
        }
        if (!this.deps.onForkAll) {
          new Notice('Fork not available.');
          return;
        }
        await this.deps.onForkAll();
        break;
      }
      case 'fast': {
        try {
          const toggled = await this.deps.toggleFastMode?.() ?? false;
          if (!toggled) {
            new Notice('Fast mode is not available for this model.');
          }
        } catch {
          new Notice('Failed to toggle fast mode.');
        }
        break;
      }
      case 'side': {
        const sideChat = this.deps.getSideChatController?.() ?? null;
        if (!sideChat) {
          new Notice(t('chat.sideChat.unsupportedProvider'));
          return;
        }
        await sideChat.handleCommandSubmission('', []);
        break;
      }
      default: {
        // Unknown command - notify user
        const unknownAction = typeof (command as { action?: unknown }).action === 'string'
          ? (command as { action: string }).action
          : 'unknown';
        new Notice(`Unknown command: ${unknownAction}`);
        break;
      }
    }
  }

  // ============================================
  // Resume Session Dropdown
  // ============================================

  handleResumeKeydown(e: KeyboardEvent): boolean {
    if (!this.activeResumeDropdown?.isVisible()) return false;
    return this.activeResumeDropdown.handleKeydown(e);
  }

  isResumeDropdownVisible(): boolean {
    return this.activeResumeDropdown?.isVisible() ?? false;
  }

  destroyResumeDropdown(): void {
    if (this.activeResumeDropdown) {
      this.activeResumeDropdown.destroy();
      this.activeResumeDropdown = null;
    }
  }

  #showResumeDropdown(): void {
    const { plugin, state, conversationController } = this.deps;

    // Clean up any existing dropdown
    this.destroyResumeDropdown();

    const conversations = plugin.getConversationList();
    if (conversations.length === 0) {
      new Notice('No conversations to resume');
      return;
    }

    const openConversation = this.deps.openConversation
      ?? ((id: string) => conversationController.switchTo(id));

    this.activeResumeDropdown = new ResumeSessionDropdown(
      this.deps.getInputContainerEl(),
      this.deps.getInputEl(),
      conversations,
      state.currentConversationId,
      {
        onSelect: (id) => {
          this.destroyResumeDropdown();
          openConversation(id).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to open conversation: ${msg}`);
          });
        },
        onDismiss: () => {
          this.destroyResumeDropdown();
        },
      }
    );
  }
}

function cloneChatTurnRequest(request: ChatTurnRequest): ChatTurnRequest {
  return {
    ...request,
    images: request.images ? [...request.images] : undefined,
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
      linkedContentPath:
        incoming.request.linkedContentPath ?? existing.request.linkedContentPath,
      images: images.length > 0 ? images : undefined,
      text: mergeText(existing.request.text, incoming.request.text),
    },
  };
}
