import { Notice, setIcon } from 'obsidian';

import {
  type BuiltInCommand,
  detectBuiltInCommand,
  isBuiltInCommandSupported,
} from '../../../core/commands/builtInCommands';
import type { ProviderExecutionEvent } from '../../../core/execution';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type InstructionRefineService,
  type ProviderCapabilities,
  type ProviderId,
  type TitleGenerationService,
} from '../../../core/providers/types';
import { TOOL_EXIT_PLAN_MODE } from '../../../core/tools/toolNames';
import {
  type ApprovalDecision,
  type ChatMessage,
  type ExitPlanModeDecision,
  type ExitPlanModePresentationOptions,
  isCanonicalUserMessage,
  type StreamChunk,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { ResumeSessionDropdown } from '../../../shared/components/ResumeSessionDropdown';
import { InstructionModal } from '../../../shared/modals/InstructionConfirmModal';
import type { BrowserSelectionContext } from '../../../utils/browser';
import type { CanvasSelectionContext } from '../../../utils/canvas';
import { extractUserDisplayContent } from '../../../utils/context';
import { formatDurationMmSs } from '../../../utils/date';
import type { EditorSelectionContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import type { FeatureHost } from '../../FeatureHost';
import { COMPLETION_FLAVOR_WORDS } from '../constants';
import {
  type ChatExecutionCoordinator,
  ChatExecutionPreHandoffError,
  type ChatTurnSubmission,
} from '../execution/ChatExecutionCoordinator';
import type {
  LinkedContentController,
  LinkedContentSubmissionToken,
} from '../linked-content';
import { type InlineAskQuestionConfig, InlineAskUserQuestion } from '../rendering/InlineAskUserQuestion';
import { InlineExitPlanMode } from '../rendering/InlineExitPlanMode';
import { InlinePlanApproval,type PlanApprovalDecision } from '../rendering/InlinePlanApproval';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { setToolIcon, updateToolCallResult } from '../rendering/ToolCallRenderer';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { ChatTurnRequest, QueuedMessage, TabReviewOutcome } from '../state/types';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { AddExternalContextResult } from '../ui/InputToolbar';
import type { InstructionModeManager } from '../ui/InstructionModeManager';
import type { StatusPanel } from '../ui/StatusPanel';
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

const APPROVAL_OPTION_MAP: Record<string, ApprovalDecision> = {
  'Deny': 'deny',
  'Allow once': 'allow',
  'Always allow': 'allow-always',
};

interface ApprovalDecisionOption {
  label: string;
  description?: string;
  value: string;
  decision?: ApprovalDecision;
}

interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
  decisionOptions?: ApprovalDecisionOption[];
  additionalPermissions?: unknown;
}

const DEFAULT_APPROVAL_DECISION_OPTIONS: ApprovalDecisionOption[] =
  Object.entries(APPROVAL_OPTION_MAP).map(([label, decision]) => ({
    label,
    value: label,
    decision,
  }));

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface InputControllerDeps {
  plugin: FeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  selectionController: SelectionController;
  browserSelectionController?: BrowserSelectionController;
  canvasSelectionController: CanvasSelectionController;
  conversationController: ConversationController;
  getInputEl: () => HTMLTextAreaElement;
  getWelcomeEl: () => HTMLElement | null;
  getMessagesEl: () => HTMLElement;
  getFileContextManager: () => FileContextManager | null;
  getLinkedContentController: () => LinkedContentController;
  getImageContextManager: () => ImageContextManager | null;
  getExternalContextSelector: () => {
    getExternalContexts: () => string[];
    addExternalContext: (path: string) => AddExternalContextResult;
  } | null;
  getInstructionModeManager: () => InstructionModeManager | null;
  getInstructionRefineService: () => InstructionRefineService | null;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  getInputContainerEl: () => HTMLElement;
  generateId: () => string;
  resetInputHeight: () => void;
  getAuxiliaryModel?: () => string | null;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  getSubagentManager: () => SubagentManager;
  /** Authoritative tab/conversation provider, independent of runtime lifecycle. */
  getTabProviderId?: () => ProviderId;
  /** Returns true if ready. */
  ensureExecutionInitialized?: () => Promise<boolean>;
  openConversation?: (conversationId: string) => Promise<void>;
  /** Lets the active layout replace in-place clear with its own New action. */
  handleNewConversationCommand?: () => Promise<boolean>;
  /** Lets the active layout start approved plan content in a separate conversation. */
  handleNewSessionPlan?: (planContent: string) => Promise<boolean>;
  onForkAll?: () => Promise<void>;
  /** Toggles the active provider's fast service tier when available. */
  toggleFastMode?: () => Promise<boolean>;
  restorePrePlanPermissionModeIfNeeded?: () => void | Promise<void>;
  /** Captures a review reporter when a terminal provider turn becomes visible. */
  captureReviewableSettlement?: (outcome: TabReviewOutcome) => () => void;
  canStartTurn?: () => boolean;
  turnOwner?: ActiveTurnOwner;
}

export interface SendMessageOptions {
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
  readonly inputRecordId: string;
  readonly message: QueuedMessage;
  readonly expectedProviderMessage: PendingProviderUserMessage;
  providerDisposition: PendingSteerProviderDisposition;
  uiState: 'visible' | 'cleared';
  correlationState: 'pending' | 'settled' | 'delegated-to-history';
  retryState: 'blocked' | 'parked' | 'restored';
}

export class InputController {
  private deps: InputControllerDeps;
  private pendingApprovalInline: InlineAskUserQuestion | null = null;
  private pendingAskInline: InlineAskUserQuestion | null = null;
  private pendingExitPlanModeInline: InlineExitPlanMode | null = null;
  private pendingPlanApproval: InlinePlanApproval | null = null;
  private pendingPlanApprovalInvalidated = false;
  private activeResumeDropdown: ResumeSessionDropdown | null = null;
  private inputContainerHideDepth = 0;
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
    this.turnCoordinator = new TurnCoordinator(
      (options) => this.executeSendMessage(options),
      deps.turnOwner,
    );
  }

  private getExecutionCoordinator(): ChatExecutionCoordinator | null {
    return this.deps.getExecutionCoordinator();
  }

  private getAuxiliaryModel(): string | null {
    return this.deps.getAuxiliaryModel?.() ?? null;
  }

  private syncInstructionRefineModelOverride(
    instructionRefineService: InstructionRefineService,
  ): void {
    instructionRefineService.setModelOverride?.(this.getAuxiliaryModel() ?? undefined);
  }

  private getActiveProviderId(): ProviderId {
    const tabProviderId = this.deps.getTabProviderId?.();
    if (tabProviderId) {
      return tabProviderId;
    }

    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) {
      return DEFAULT_CHAT_PROVIDER_ID;
    }

    return this.deps.plugin.getConversationSync(conversationId)?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  private getActiveCapabilities(): ProviderCapabilities {
    const providerId = this.getActiveProviderId();
    return ProviderRegistry.getCapabilities(providerId);
  }

  private async resolveMainAgentDynamicSystemPromptSections(): Promise<readonly string[]> {
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
    if (event.type === 'user_message_started') {
      await this.handleProviderMessageBoundaryChunk({
        content: event.content ?? '',
        itemId: event.nativeUserMessageId,
        type: 'user_message_start',
      });
      return;
    }
    if (event.type === 'assistant_message_started') {
      await this.handleProviderMessageBoundaryChunk({
        itemId: event.nativeAssistantId,
        type: 'assistant_message_start',
      });
      return;
    }
    const chunk = providerOutputEventToStreamChunk(event);
    if (chunk) {
      await this.deps.streamController.handleStreamChunk(
        chunk,
        this.activeStreamingAssistantMessage ?? assistant,
      );
    }
  }

  private async executeSendMessage(options?: SendMessageOptions): Promise<void> {
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
    this.discardDeferredReviewForDifferentConversation();

    // During conversation creation/switching, don't send - input is preserved so user can retry
    if (state.isCreatingConversation || state.isSwitchingConversation) {
      this.reportDeferredReviewableSettlement();
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
      this.reportDeferredReviewableSettlement();
      return;
    }

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      this.reportDeferredReviewableSettlement();
      return;
    }

    // Check for built-in commands first (e.g., /clear, /new, /add-dir)
    const builtInCmd = detectBuiltInCommand(content, this.getActiveProviderId());
    if (builtInCmd) {
      if (builtInCmd.command.action === 'clear') {
        this.clearDeferredReviewableSettlement();
      } else {
        this.reportDeferredReviewableSettlement();
      }
      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      await this.executeBuiltInCommand(builtInCmd.command, builtInCmd.args);
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
      const { displayContent, turnRequest } = this.buildTurnSubmission({
        content,
        images,
        editorContextOverride: editorContext,
        browserContextOverride: browserContext,
        canvasContextOverride: canvasContext,
      });
      state.queuedMessage = this.mergeQueuedMessages(
        state.queuedMessage,
        this.createQueuedMessage(displayContent, turnRequest),
      );

      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      if (shouldUseInput) {
        imageContextManager?.clearImages();
      }
      this.updateQueueIndicator();
      return;
    }

    state.acknowledgeReview();

    let turnConversationId = state.currentConversationId;
    this.delegatePendingSteerCorrelationToHistory(turnConversationId);

    if (shouldUseInput) {
      inputEl.value = '';
      this.deps.resetInputHeight();
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
      : this.buildTurnSubmission({
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
      await this.ensureConversationShell(linkedContentSubmission);
      await this.triggerTitleGeneration();
    } catch (error) {
      if (linkedContentSubmission && !state.currentConversationId) {
        linkedContentController.rollbackSubmission(linkedContentSubmission);
      }
      this.restoreMessageToInput(this.createQueuedMessage(displayContent, turnRequest));
      this.rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      throw error;
    }
    turnConversationId = state.currentConversationId;
    const admittedTurnRequest = this.bindLinkedContentAtTurnAdmission(
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
    this.activateStreamingAssistantMessage(assistantMsg);
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
    let planCompleted = false;
    let didRollbackUnsentTurn = false;
    let shouldReportReviewableSettlement = false;
    let currentReviewableSettlementReporter: (() => void) | null = null;
    let didCancelThisTurn = false;
    let planApprovalInvalidated = false;
    let scheduledContinuation = false;
    let continuationStaysInCurrentController = false;

    // Lazy initialization: bind and prepare execution on the first provider action.
    if (this.deps.ensureExecutionInitialized) {
      const ready = await this.deps.ensureExecutionInitialized();
      if (!ready) {
        new Notice('Failed to initialize agent execution. Please try again.');
        this.restoreMessageToInput(this.createQueuedMessage(displayContent, admittedTurnRequest));
        this.rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        this.activeStreamingAssistantMessage = null;
        this.resetProviderMessageBoundaryState();
        this.reportDeferredReviewableSettlement();
        return;
      }
    }

    const coordinator = this.getExecutionCoordinator();
    if (!coordinator) {
      new Notice('Agent execution is not available. Please reload the plugin.');
      this.restoreMessageToInput(this.createQueuedMessage(displayContent, admittedTurnRequest));
      this.rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
      this.activeStreamingAssistantMessage = null;
      this.resetProviderMessageBoundaryState();
      this.reportDeferredReviewableSettlement();
      return;
    }

    const dynamicSystemPromptSections = await this.resolveMainAgentDynamicSystemPromptSections();

    try {
      userMsg.content = admittedTurnRequest.text;
      userMsg.linkedContentPath = admittedTurnRequest.linkedContentPath;
      const result = await coordinator.execute(this.createExecutionSubmission(
        displayContent,
        admittedTurnRequest,
        userMsg,
        assistantMsg,
        dynamicSystemPromptSections,
      ));
      didEnqueueToSdk = result.accepted;
      planCompleted = result.planCompleted;
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
          : this.createQueuedMessage(displayContent, {
            ...admittedTurnRequest,
            images: imagesForMessage ?? admittedTurnRequest.images,
          });
        const pendingMessagesToRestore = state.queuedMessage
          ? this.cloneQueuedMessage(state.queuedMessage)
          : null;
        const composerDraftToRestore = this.captureComposerDraft();
        const resolution = result.missingSessionResolution ?? 'not_found';
        if (resolution === 'deleted') {
          this.restoreMessageToInput(composerDraftToRestore, { mergeWithComposer: true });
          this.restoreMessageToInput(pendingMessagesToRestore, { mergeWithComposer: true });
          this.restoreMessageToInput(retryMessage, { mergeWithComposer: true });
        } else if (retryMessage) {
          this.restoreMessageToInput(retryMessage, { mergeWithComposer: true });
          this.rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        }
        if (result.accepted) {
          this.finishAcceptedMissingSession(streamGeneration);
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
        await streamController.appendText(`\n\n**Error:** ${result.error.message}`);
      }
    } catch (error) {
      if (error instanceof ChatExecutionPreHandoffError) {
        this.restoreMessageToInput(
          this.createQueuedMessage(displayContent, admittedTurnRequest),
          { mergeWithComposer: true },
        );
        this.rollbackFailedTurn(messagesBeforeTurn, hadPendingConversationSave);
        didRollbackUnsentTurn = true;
        new Notice('Message was not sent. Please try again.');
        this.reportDeferredReviewableSettlement();
      } else {
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
          if (didCancelThisTurn && !state.pendingNewSessionPlan) {
            finalAssistantMsg.isInterrupt = true;
            if (state.currentContentEl) {
              renderer.appendInterruptIndicator(state.currentContentEl);
            }
          }
          streamController.hideThinkingIndicator();
          state.isStreaming = false;
          state.cancelRequested = false;

          // Capture response duration before resetting state (skip for interrupted responses and compaction)
          const hasCompactBoundary = finalAssistantMsg.contentBlocks?.some(b => b.type === 'context_compacted');
          if (!didCancelThisTurn && !hasCompactBoundary) {
            const durationSeconds = state.responseStartTime
              ? Math.floor((performance.now() - state.responseStartTime) / 1000)
              : 0;
            if (durationSeconds > 0) {
              const flavorWord =
                COMPLETION_FLAVOR_WORDS[Math.floor(Math.random() * COMPLETION_FLAVOR_WORDS.length)];
              finalAssistantMsg.durationSeconds = durationSeconds;
              finalAssistantMsg.durationFlavorWord = flavorWord;
              // Add footer to live message in DOM
              if (state.currentContentEl) {
                const footerEl = state.currentContentEl.createDiv({ cls: 'claudian-response-footer' });
                footerEl.createSpan({
                  text: `* ${flavorWord} for ${formatDurationMmSs(durationSeconds)}`,
                  cls: 'claudian-baked-duration',
                });
              }
            }
          }

          state.currentContentEl = null;

          await streamController.finalizeCurrentThinkingBlock(finalAssistantMsg);
          await streamController.finalizeCurrentTextBlock(finalAssistantMsg);
          this.deps.getSubagentManager().resetStreamingState();

          // Auto-hide completed todo panel on response end
          // Panel reappears only when new TodoWrite tool is called
          if (state.currentTodos && state.currentTodos.every(t => t.status === 'completed')) {
            state.currentTodos = null;
          }
          this.syncScrollToBottomAfterRenderUpdates();

          // approve-new-session: the tool_result chunk is dropped because cancelRequested
          // was set before the stream loop could process it — manually set the result so
          // the saved conversation renders correctly when revisited
          if (state.pendingNewSessionPlan && finalAssistantMsg.toolCalls) {
            for (const tc of finalAssistantMsg.toolCalls) {
              if (tc.name === TOOL_EXIT_PLAN_MODE && !tc.result) {
                tc.status = 'completed';
                tc.result = 'User approved the plan and started a new session.';
                updateToolCallResult(tc.id, tc, state.toolCallElements);
              }
            }
          }

          // Provider-agnostic post-plan approval: show UI and await decision before save/auto-send
          let planAutoSendContent: string | null = null;
          let shouldProcessQueuedMessage = true;
          if (planCompleted && !didCancelThisTurn) {
            const planInteractionId = `local-plan-approval:${streamGeneration}`;
            state.beginActionRequired(planInteractionId);
            let decisionResult: { decision: PlanApprovalDecision | null; invalidated: boolean };
            try {
              decisionResult = await this.showPlanApproval();
            } finally {
              state.endActionRequired(planInteractionId);
            }
            const { decision, invalidated } = decisionResult;

            // Re-check invalidation after async approval prompt
            if (state.streamGeneration !== streamGeneration || invalidated) {
              planApprovalInvalidated = true;
            } else if (decision?.type === 'implement') {
              await this.deps.restorePrePlanPermissionModeIfNeeded?.();
              planAutoSendContent = 'Implement the plan.';
            } else if (decision?.type === 'revise') {
              // Keep plan mode active, populate input with feedback text
              this.deps.getInputEl().value = decision.text;
              shouldProcessQueuedMessage = false;
            } else {
              // cancel or null (dismissed)
              await this.deps.restorePrePlanPermissionModeIfNeeded?.();
            }
          }

          if (!planApprovalInvalidated) {
            // Only clear resumeAtMessageId if enqueue succeeded; preserve checkpoint on failure for retry
            const saveExtras = didEnqueueToSdk ? { resumeAtMessageId: undefined } : undefined;
            await conversationController.save(true, saveExtras);

            const userMsgIndex = state.messages.indexOf(userMsg);
            renderer.refreshActionButtons(userMsg, state.messages, userMsgIndex >= 0 ? userMsgIndex : undefined);

            // Auto-implement takes precedence over both approve-new-session and queued input
            if (planAutoSendContent) {
              scheduledContinuation = true;
              continuationStaysInCurrentController = true;
              this.deps.getInputEl().value = planAutoSendContent;
              this.deferReviewableSettlement(currentReviewableSettlementReporter);
              this.sendMessage().catch(() => this.reportDeferredReviewableSettlement());
            } else {
              // approve-new-session: create fresh conversation and send plan content
              // Must be inside the invalidation guard — if the tab was closed or
              // conversation switched, we must not create a new session on stale state.
              const planContent = state.pendingNewSessionPlan;
              if (planContent) {
                state.pendingNewSessionPlan = null;
                const handledByLayout = await this.deps.handleNewSessionPlan?.(planContent) ?? false;
                if (handledByLayout) {
                  scheduledContinuation = true;
                } else {
                  await conversationController.createNew();
                  scheduledContinuation = true;
                  continuationStaysInCurrentController = true;
                  this.deps.getInputEl().value = planContent;
                  this.deferReviewableSettlement(currentReviewableSettlementReporter);
                  this.sendMessage().catch(() => this.reportDeferredReviewableSettlement());
                }
              } else if (shouldProcessQueuedMessage) {
                scheduledContinuation = this.processQueuedMessage();
                continuationStaysInCurrentController = scheduledContinuation;
              }
            }
          }
        }

        if (wasInvalidated) {
          this.clearCurrentPendingSteerUi();
          this.updateQueueIndicator();
        }
      } finally {
        const currentSettlementIsReviewable = shouldReportReviewableSettlement
          && !didCancelThisTurn
          && !planApprovalInvalidated
          && state.streamGeneration === streamGeneration;
        if (scheduledContinuation) {
          if (continuationStaysInCurrentController) {
            if (currentSettlementIsReviewable && currentReviewableSettlementReporter) {
              this.deferReviewableSettlement(currentReviewableSettlementReporter);
            }
          } else {
            this.clearDeferredReviewableSettlement();
          }
        } else if (currentSettlementIsReviewable) {
          this.reportCurrentOrDeferredReviewableSettlement(
            currentReviewableSettlementReporter,
          );
        } else {
          this.reportDeferredReviewableSettlement();
        }

        this.delegatePendingSteerCorrelationToHistory(turnConversationId);
        this.activeStreamingAssistantMessage = null;
        this.resetProviderMessageBoundaryState();
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

    const pendingSteer = this.getCurrentPendingSteer();
    const visiblePendingSteer = pendingSteer?.uiState === 'visible'
      ? pendingSteer.message
      : null;
    const visibleQueuedMessage = state.queuedMessage ?? visiblePendingSteer;
    if (visibleQueuedMessage) {
      const isPendingSteerOnly = !state.queuedMessage && !!visiblePendingSteer;
      indicatorEl.createSpan({
        cls: 'claudian-queue-indicator-text',
        text: `${isPendingSteerOnly ? '⌙ Steering: ' : '⌙ Queued: '}${this.getQueuedMessageDisplay(visibleQueuedMessage)}`,
      });

      if (state.queuedMessage) {
        const actionsEl = indicatorEl.createDiv({ cls: 'claudian-queue-indicator-actions' });

        if (this.canSteerQueuedMessage()) {
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

        const editButton = this.createQueueIconButton(
          actionsEl,
          'pencil',
          'Edit queued message',
        );
        editButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this.withdrawQueuedMessageToComposer();
        });

        const discardButton = this.createQueueIconButton(
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

    const queuedMessage = this.cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    this.restoreMessageToInput(queuedMessage, { mergeWithComposer: true });
    this.updateQueueIndicator();
  }

  restoreRewoundMessageToComposer(
    message: Pick<ChatMessage, 'content' | 'images'>,
  ): void {
    this.restoreMessageToInput({
      canvasContext: null,
      content: message.content,
      editorContext: null,
      images: message.images,
    });
    const inputEl = this.deps.getInputEl();
    const EventConstructor = inputEl.ownerDocument?.defaultView?.Event ?? Event;
    inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  }

  private restoreMessageToInput(
    message: QueuedMessage | null,
    options: { mergeWithComposer?: boolean } = {},
  ): void {
    if (!message) return;

    const { content, images } = message;
    const inputEl = this.deps.getInputEl();
    const currentContent = options.mergeWithComposer ? inputEl.value.trim() : '';
    inputEl.value = currentContent
      ? appendMarkdownSnippet(content, currentContent)
      : content;

    const imageContextManager = this.deps.getImageContextManager();
    const currentImages = options.mergeWithComposer
      ? (imageContextManager?.getAttachedImages() ?? [])
      : [];
    const restoredImages = [...(images ?? []), ...currentImages];
    if (imageContextManager && (!options.mergeWithComposer || restoredImages.length > 0)) {
      imageContextManager.setImages(restoredImages);
    }
    this.deps.resetInputHeight();
    inputEl.focus();
  }

  private captureComposerDraft(): QueuedMessage | null {
    const content = this.deps.getInputEl().value;
    const attachedImages = this.deps.getImageContextManager()?.getAttachedImages() ?? [];
    const images = attachedImages.length > 0 ? [...attachedImages] : undefined;
    if (!content.trim() && !images) {
      return null;
    }

    return this.createQueuedMessage(content, {
      text: content,
      images,
    });
  }

  private restoreQueuedMessageToInput(): void {
    const { state } = this.deps;
    const queuedMessage = state.queuedMessage
      ? this.cloneQueuedMessage(state.queuedMessage)
      : null;
    this.restoreMessageToInput(queuedMessage, { mergeWithComposer: true });
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

  private processQueuedMessage(): boolean {
    const { state } = this.deps;
    if (!state.queuedMessage) return false;

    const queuedMessage = this.cloneQueuedMessage(state.queuedMessage);
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
          content: queuedMessage.content,
          images: queuedMessage.images,
          turnRequestOverride: this.toQueuedChatTurn(queuedMessage).request,
        }).catch(() => this.reportDeferredReviewableSettlement());
      },
      0
    );
    return true;
  }

  private deferReviewableSettlement(report: (() => void) | null): void {
    if (!report) return;
    this.deferredReviewableSettlement = {
      conversationId: this.deps.state.currentConversationId,
      report,
    };
  }

  private hasDeferredReviewableSettlement(): boolean {
    this.discardDeferredReviewForDifferentConversation();
    return this.deferredReviewableSettlement !== null;
  }

  private reportDeferredReviewableSettlement(): void {
    if (!this.hasDeferredReviewableSettlement()) return;
    const deferred = this.deferredReviewableSettlement;
    this.clearDeferredReviewableSettlement();
    deferred?.report();
  }

  private reportCurrentOrDeferredReviewableSettlement(
    currentReporter: (() => void) | null,
  ): void {
    const reporter = currentReporter
      ?? (this.hasDeferredReviewableSettlement()
        ? this.deferredReviewableSettlement?.report ?? null
        : null);
    this.clearDeferredReviewableSettlement();
    reporter?.();
  }

  private discardDeferredReviewForDifferentConversation(): void {
    if (
      this.deferredReviewableSettlement !== null
      && this.deferredReviewableSettlement.conversationId
        !== this.deps.state.currentConversationId
    ) {
      this.clearDeferredReviewableSettlement();
    }
  }

  private clearDeferredReviewableSettlement(): void {
    this.deferredReviewableSettlement = null;
  }

  private buildTurnSubmission(options: {
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

    const fileContextManager = this.deps.getFileContextManager();
    const externalContextSelector = this.deps.getExternalContextSelector();

    const editorContext = options.editorContextOverride !== undefined
      ? options.editorContextOverride
      : selectionController.getContext();
    const browserContext = options.browserContextOverride !== undefined
      ? options.browserContextOverride
      : (browserSelectionController?.getContext() ?? null);
    const canvasContext = options.canvasContextOverride !== undefined
      ? options.canvasContextOverride
      : canvasSelectionController.getContext();

    const externalContextPaths = externalContextSelector?.getExternalContexts();
    const isCompact = /^\/compact(\s|$)/i.test(options.content);
    const candidateUserTurnOrdinal = this.deps.state.messages
      .filter(isCanonicalUserMessage).length + 1;
    const linkedContentPath = !isCompact && candidateUserTurnOrdinal === 1
      ? this.deps.getLinkedContentController().getSnapshot().path ?? undefined
      : undefined;
    const transformedText = !isCompact && fileContextManager
      ? fileContextManager.transformContextMentions(options.content)
      : options.content;
    return {
      displayContent: options.content,
      turnRequest: {
        text: transformedText,
        images: options.images,
        linkedContentPath,
        editorSelection: editorContext,
        browserSelection: browserContext,
        canvasSelection: canvasContext,
        externalContextPaths: externalContextPaths && externalContextPaths.length > 0
          ? externalContextPaths
          : undefined,
      },
    };
  }

  private bindLinkedContentAtTurnAdmission(
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

  private createExecutionSubmission(
    displayContent: string,
    request: ChatTurnRequest,
    user?: ChatMessage,
    assistant?: ChatMessage,
    dynamicSystemPromptSections: readonly string[] = [],
  ): ChatTurnSubmission {
    const providerId = this.getActiveProviderId();
    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.deps.plugin.settings,
      providerId,
    );
    const reasoning = typeof settings.effortLevel === 'string'
      ? settings.effortLevel
      : typeof settings.thinkingBudget === 'string'
        ? settings.thinkingBudget
        : undefined;
    const permissionMode = typeof settings.permissionMode === 'string'
      ? settings.permissionMode
      : undefined;
    const serviceTier = typeof settings.serviceTier === 'string'
      ? settings.serviceTier
      : undefined;
    const mode = permissionMode === 'plan' && this.getActiveCapabilities().supportsPlanMode
      ? permissionMode
      : undefined;
    const images = [...(request.images ?? [])];
    const existingUserTurns = this.deps.state.messages.filter(isCanonicalUserMessage).length;

    return {
      canonicalText: request.text,
      configuration: {
        ...(request.externalContextPaths
          ? { externalWorkspaceRoots: [...request.externalContextPaths] }
          : {}),
        ...(this.getAuxiliaryModel()
          ? { model: this.getAuxiliaryModel() ?? undefined }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(mode ? { mode } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(serviceTier ? { serviceTier } : {}),
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
        ...(request.externalContextPaths
          ? { externalContextPaths: [...request.externalContextPaths] }
          : {}),
      },
      conversationHistory: user && assistant
        ? this.deps.state.messages.slice(0, -2)
        : [...this.deps.state.messages],
      images,
      inputRecordId: this.deps.generateId(),
      ...(user ? { localMessageId: user.id } : {}),
      ...(user && assistant ? { messages: { assistant, user } } : {}),
      rawDisplayText: displayContent,
      timestamp: user?.timestamp ?? Date.now(),
      toolPolicy: { kind: 'provider-default' },
      userTurnOrdinal: user ? existingUserTurns : existingUserTurns + 1,
    };
  }

  private getQueuedMessageDisplay(message: QueuedMessage | null): string {
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

  private createQueueIconButton(
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

  private canSteerQueuedMessage(): boolean {
    return this.deps.state.isStreaming
      && this.getCurrentPendingSteer() === null
      && this.getActiveCapabilities().supportsTurnSteer === true
      && this.getExecutionCoordinator() !== null;
  }

  private cloneQueuedMessage(message: QueuedMessage): QueuedMessage {
    return {
      ...message,
      images: message.images ? [...message.images] : undefined,
      turnRequest: message.turnRequest
        ? cloneChatTurnRequest(message.turnRequest)
        : undefined,
    };
  }

  private createQueuedMessage(displayContent: string, turnRequest: ChatTurnRequest): QueuedMessage {
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

  private toQueuedChatTurn(message: QueuedMessage): {
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

  private getCurrentPendingSteer(): PendingSteerState | null {
    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) return null;
    return this.pendingSteersByConversation.get(conversationId) ?? null;
  }

  private isPendingSteerRegistered(pending: PendingSteerState): boolean {
    return this.pendingSteersByConversation.get(pending.conversationId) === pending;
  }

  private clearCurrentPendingSteerUi(): void {
    const pending = this.getCurrentPendingSteer();
    if (!pending) return;
    pending.uiState = 'cleared';
    this.updateQueueIndicator();
  }

  private clearPendingSteerUi(pending: PendingSteerState): void {
    pending.uiState = 'cleared';
    if (pending.conversationId === this.deps.state.currentConversationId) {
      this.updateQueueIndicator();
    }
  }

  private releasePendingSteer(pending: PendingSteerState): void {
    if (this.isPendingSteerRegistered(pending)) {
      this.pendingSteersByConversation.delete(pending.conversationId);
      pending.coordinator.releaseSteerCorrelation(pending.inputRecordId);
    }
  }

  private delegatePendingSteerCorrelationToHistory(
    conversationId: string | null,
  ): void {
    if (!conversationId) return;
    const pending = this.pendingSteersByConversation.get(conversationId);
    if (!pending) return;

    if (pending.correlationState === 'pending') {
      pending.correlationState = 'delegated-to-history';
    }
    this.clearPendingSteerUi(pending);
    if (
      pending.providerDisposition !== 'awaiting-result'
      || pending.correlationState === 'settled'
    ) {
      this.releasePendingSteer(pending);
    }
  }

  private restoreDefinitelyUnsentSteer(pending: PendingSteerState): void {
    if (
      pending.retryState === 'restored'
      || pending.providerDisposition === 'accepted-awaiting-correlation'
    ) {
      return;
    }

    pending.providerDisposition = 'definitely-unsent';
    pending.correlationState = 'settled';
    this.clearPendingSteerUi(pending);
    if (
      pending.conversationId !== this.deps.state.currentConversationId
      || this.deps.state.isSwitchingConversation
      || this.deps.state.isCreatingConversation
    ) {
      pending.retryState = 'parked';
      return;
    }

    this.restoreDefinitelyUnsentSteerForActiveConversation(pending);
  }

  private restoreDefinitelyUnsentSteerForActiveConversation(
    pending: PendingSteerState,
  ): void {
    if (pending.retryState === 'restored') return;

    pending.retryState = 'restored';
    this.releasePendingSteer(pending);

    const { state } = this.deps;
    if (state.isStreaming && !state.cancelRequested) {
      state.queuedMessage = state.queuedMessage
        ? this.mergeQueuedMessages(pending.message, state.queuedMessage)
        : this.cloneQueuedMessage(pending.message);
    } else {
      this.restoreMessageToInput(pending.message, { mergeWithComposer: true });
    }
    this.updateQueueIndicator();
  }

  onConversationActivated(): void {
    this.discardDeferredReviewForDifferentConversation();
    if (
      this.deps.state.isSwitchingConversation
      || this.deps.state.isCreatingConversation
    ) {
      return;
    }
    const pending = this.getCurrentPendingSteer();
    if (
      pending?.providerDisposition === 'definitely-unsent'
      && pending.retryState === 'parked'
    ) {
      this.restoreDefinitelyUnsentSteerForActiveConversation(pending);
      return;
    }
    this.updateQueueIndicator();
  }

  private mergeQueuedMessages(
    existing: QueuedMessage | null,
    incoming: QueuedMessage,
  ): QueuedMessage {
    if (!existing) {
      return this.cloneQueuedMessage(incoming);
    }

    const mergedTurn = mergeQueuedChatTurns(
      this.toQueuedChatTurn(existing),
      this.toQueuedChatTurn(incoming),
    );
    return this.createQueuedMessage(mergedTurn.displayContent, mergedTurn.request);
  }

  private async steerQueuedMessage(): Promise<void> {
    const { state } = this.deps;
    const coordinator = this.getExecutionCoordinator();
    const conversationId = state.currentConversationId;
    if (!state.queuedMessage || !this.canSteerQueuedMessage() || !coordinator) {
      return;
    }
    if (!conversationId) return;

    const queuedMessage = this.cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    const { displayContent, request } = this.toQueuedChatTurn(queuedMessage);
    const dynamicSystemPromptSections = await this.resolveMainAgentDynamicSystemPromptSections();
    const submission = this.createExecutionSubmission(
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
      inputRecordId: submission.inputRecordId,
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
        this.restoreDefinitelyUnsentSteer(pending);
        return;
      }

      pending.providerDisposition = 'accepted-awaiting-correlation';
      this.clearPendingSteerUi(pending);
      if (pending.correlationState !== 'pending') {
        this.releasePendingSteer(pending);
      }
    } catch (error) {
      if (pending.providerDisposition === 'accepted-awaiting-correlation') return;
      if (error instanceof ChatExecutionPreHandoffError) {
        this.restoreDefinitelyUnsentSteer(pending);
        new Notice('Failed to steer the queued message. It is still available.');
        return;
      }

      pending.providerDisposition = 'ambiguous-awaiting-reconciliation';
      this.clearPendingSteerUi(pending);
      if (pending.correlationState !== 'pending') {
        this.releasePendingSteer(pending);
      }
      new Notice(
        'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.',
      );
    }
  }

  private activateStreamingAssistantMessage(message: ChatMessage): void {
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

  private resetProviderMessageBoundaryState(): void {
    this.pendingProviderUserMessages = [];
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = false;
  }

  private async handleProviderMessageBoundaryChunk(chunk: StreamChunk): Promise<boolean> {
    switch (chunk.type) {
      case 'user_message_start':
        await this.handleProviderUserMessageStart(chunk);
        return true;
      case 'assistant_message_start':
        await this.handleProviderAssistantMessageStart();
        return true;
      default:
        return false;
    }
  }

  private async handleProviderUserMessageStart(
    chunk: Extract<StreamChunk, { type: 'user_message_start' }>,
  ): Promise<void> {
    if (!this.sawInitialProviderUserMessage) {
      this.pendingProviderUserMessages.shift();
      this.sawInitialProviderUserMessage = true;
      return;
    }

    const pendingSteer = this.getCurrentPendingSteer();
    const expected = pendingSteer?.correlationState === 'pending'
      ? pendingSteer.expectedProviderMessage
      : this.pendingProviderUserMessages.shift();
    let acceptanceError: unknown;
    if (pendingSteer?.correlationState === 'pending') {
      pendingSteer.providerDisposition = 'accepted-awaiting-correlation';
      pendingSteer.correlationState = 'settled';
      this.clearPendingSteerUi(pendingSteer);
      try {
        await pendingSteer.coordinator.acceptSteerFromProviderEvent(
          pendingSteer.inputRecordId,
          chunk.itemId,
        );
      } catch (error) {
        acceptanceError = error;
      }
    }

    const previousAssistant = this.activeStreamingAssistantMessage;
    const shouldDiscardPlaceholder = this.shouldDiscardPendingAssistantPlaceholder(previousAssistant);
    if (previousAssistant) {
      if (shouldDiscardPlaceholder) {
        this.discardStreamingAssistantMessage(previousAssistant.id);
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
      this.releasePendingSteer(pendingSteer);
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
    this.activateStreamingAssistantMessage(assistantMessage);
    this.deps.streamController.showThinkingIndicator();
    this.deps.state.responseStartTime = performance.now();
    this.awaitingProviderAssistantStart = true;
    if (acceptanceError) throw toError(acceptanceError);
  }

  private async handleProviderAssistantMessageStart(): Promise<void> {
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
    this.activateStreamingAssistantMessage(assistantMessage);
    this.deps.streamController.showThinkingIndicator();
  }

  private shouldDiscardPendingAssistantPlaceholder(message: ChatMessage | null): boolean {
    return this.awaitingProviderAssistantStart
      && !!message
      && !message.content.trim()
      && (message.toolCalls?.length ?? 0) === 0
      && (message.contentBlocks?.length ?? 0) === 0;
  }

  private discardStreamingAssistantMessage(messageId: string): void {
    const { state, renderer } = this.deps;
    state.messages = state.messages.filter((message) => message.id !== messageId);
    renderer.removeMessage(messageId);
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
  }

  private rollbackFailedTurn(
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
    this.resetTurnStreamingState();

    if (messagesBeforeTurn.length === 0) {
      this.deps.getWelcomeEl()?.removeClass('claudian-hidden');
    }
  }

  private finishAcceptedMissingSession(streamGeneration: number): void {
    if (this.deps.state.streamGeneration !== streamGeneration) return;
    this.resetTurnStreamingState();
  }

  private resetTurnStreamingState(): void {
    const { state, streamController } = this.deps;
    streamController.hideThinkingIndicator();
    state.isStreaming = false;
    state.cancelRequested = false;
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
    state.responseStartTime = null;
    this.deps.getSubagentManager().resetStreamingState();
  }

  // ============================================
  // Title Generation
  // ============================================

  /**
   * Triggers AI title generation after first user message.
   * Handles setting fallback title, firing async generation, and updating UI.
   */
  private async triggerTitleGeneration(): Promise<void> {
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

    if (!plugin.settings.enableAutoTitleGeneration) {
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
    conversationController.updateHistoryDropdown();

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
        conversationController.updateHistoryDropdown();
      }
    ).catch(() => {
      // Silently ignore title generation errors
    });
  }

  private async ensureConversationShell(
    token: LinkedContentSubmissionToken | null,
  ): Promise<void> {
    const { plugin, state } = this.deps;
    if (state.currentConversationId) return;
    if (!token) {
      throw new Error('Missing Linked content submission for new Conversation');
    }

    const selectedModel = this.getAuxiliaryModel() ?? undefined;
    const conversation = await plugin.createConversation({
      providerId: this.getActiveProviderId(),
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
    const { state, streamController } = this.deps;
    if (!state.isStreaming) return;
    state.cancelRequested = true;
    this.restoreQueuedMessageToInput();
    this.clearCurrentPendingSteerUi();
    this.getExecutionCoordinator()?.cancel();
    streamController.hideThinkingIndicator();
  }

  /** Cancels the active turn and waits for its cleanup and conversation persistence. */
  async cancelStreamingAndWait(): Promise<void> {
    const activeTurn = this.turnCoordinator.current;
    this.cancelStreaming();
    await activeTurn;
  }

  private syncScrollToBottomAfterRenderUpdates(): void {
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
  // Instruction Mode
  // ============================================

  async handleInstructionSubmit(rawInstruction: string): Promise<void> {
    const { plugin } = this.deps;

    if (this.deps.ensureExecutionInitialized) {
      const ready = await this.deps.ensureExecutionInitialized();
      if (!ready) {
        new Notice('Failed to initialize instruction refinement. Please try again.');
        return;
      }
    }
    const instructionRefineService = this.deps.getInstructionRefineService();
    const instructionModeManager = this.deps.getInstructionModeManager();

    if (!instructionRefineService) return;

    const existingPrompt = plugin.settings.systemPrompt;
    let modal: InstructionModal | null = null;
    let wasCancelled = false;

    try {
      modal = new InstructionModal(
        plugin.app,
        rawInstruction,
        {
          onAccept: (finalInstruction) => {
            void (async (): Promise<void> => {
              await plugin.mutateSettings((settings) => {
                settings.systemPrompt = appendMarkdownSnippet(
                  settings.systemPrompt,
                  finalInstruction,
                );
              });

              new Notice('Instruction added to custom system prompt');
              instructionModeManager?.clear();
            })();
          },
          onReject: () => {
            wasCancelled = true;
            instructionRefineService.cancel();
            instructionModeManager?.clear();
          },
          onClarificationSubmit: async (response) => {
            this.syncInstructionRefineModelOverride(instructionRefineService);
            const result = await instructionRefineService.continueConversation(response);

            if (wasCancelled) {
              return;
            }

            if (!result.success) {
              if (result.error === 'Cancelled') {
                return;
              }
              new Notice(result.error || 'Failed to process response');
              modal?.showError(result.error || 'Failed to process response');
              return;
            }

            if (result.clarification) {
              modal?.showClarification(result.clarification);
            } else if (result.refinedInstruction) {
              modal?.showConfirmation(result.refinedInstruction);
            }
          }
        }
      );
      modal.open();

      this.syncInstructionRefineModelOverride(instructionRefineService);
      instructionRefineService.resetConversation();
      const result = await instructionRefineService.refineInstruction(
        rawInstruction,
        existingPrompt
      );

      if (wasCancelled) {
        return;
      }

      if (!result.success) {
        if (result.error === 'Cancelled') {
          instructionModeManager?.clear();
          return;
        }
        new Notice(result.error || 'Failed to refine instruction');
        modal.showError(result.error || 'Failed to refine instruction');
        instructionModeManager?.clear();
        return;
      }

      if (result.clarification) {
        modal.showClarification(result.clarification);
      } else if (result.refinedInstruction) {
        modal.showConfirmation(result.refinedInstruction);
      } else {
        new Notice('No instruction received');
        modal.showError('No instruction received');
        instructionModeManager?.clear();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error: ${errorMsg}`);
      modal?.showError(errorMsg);
      instructionModeManager?.clear();
    }
  }

  // ============================================
  // Approval Dialogs
  // ============================================

  async handleApprovalRequest(
    toolName: string,
    _input: Record<string, unknown>,
    description: string,
    approvalOptions?: ApprovalCallbackOptions,
  ): Promise<ApprovalDecision> {
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      throw new Error('Input container is detached from DOM');
    }

    // Build header element, then detach — InlineAskUserQuestion will re-attach it
    const headerEl = parentEl.createDiv({ cls: 'claudian-ask-approval-info' });
    headerEl.remove();

    const toolEl = headerEl.createDiv({ cls: 'claudian-ask-approval-tool' });
    const iconEl = toolEl.createSpan({ cls: 'claudian-ask-approval-icon' });
    iconEl.setAttribute('aria-hidden', 'true');
    setToolIcon(iconEl, toolName);
    toolEl.createSpan({ text: toolName, cls: 'claudian-ask-approval-tool-name' });

    if (approvalOptions?.decisionReason) {
      headerEl.createDiv({ text: approvalOptions.decisionReason, cls: 'claudian-ask-approval-reason' });
    }
    if (approvalOptions?.blockedPath) {
      headerEl.createDiv({ text: approvalOptions.blockedPath, cls: 'claudian-ask-approval-blocked-path' });
    }
    if (approvalOptions?.agentID) {
      headerEl.createDiv({ text: `Agent: ${approvalOptions.agentID}`, cls: 'claudian-ask-approval-agent' });
    }

    headerEl.createDiv({ text: description, cls: 'claudian-ask-approval-desc' });

    const decisionOptions = approvalOptions?.decisionOptions ?? DEFAULT_APPROVAL_DECISION_OPTIONS;
    const optionDecisionMap = new Map<string, ApprovalDecision>();
    const questionOptions = decisionOptions.map((option, index) => {
      const value = option.value || `approval-option-${index}`;
      if (option.decision) {
        optionDecisionMap.set(value, option.decision);
      }
      return {
        label: option.label,
        description: option.description ?? '',
        value,
      };
    });
    const input = {
      questions: [{
        question: 'Allow this action?',
        options: questionOptions,
        isOther: false,
        isSecret: false,
      }],
    };

    const result = await this.showInlineQuestion(
      parentEl,
      inputContainerEl,
      input,
      (inline) => { this.pendingApprovalInline = inline; },
      undefined,
      { title: 'Permission required', headerEl, showCustomInput: false, immediateSelect: true },
    );

    if (!result) return 'cancel';
    const selected = Object.values(result)[0];
    const selectedValue = Array.isArray(selected) ? selected[0] : selected;
    if (typeof selectedValue !== 'string') {
      new Notice(`Unexpected approval selection: "${String(selectedValue)}"`);
      return 'cancel';
    }

    const decision = optionDecisionMap.get(selectedValue);
    if (decision) {
      return decision;
    }

    return {
      type: 'select-option',
      value: selectedValue,
    };
  }

  async handleAskUserQuestion(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string | string[]> | null> {
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      throw new Error('Input container is detached from DOM');
    }

    return this.showInlineQuestion(
      parentEl,
      inputContainerEl,
      input,
      (inline) => { this.pendingAskInline = inline; },
      signal,
    );
  }

  private showInlineQuestion(
    parentEl: HTMLElement,
    inputContainerEl: HTMLElement,
    input: Record<string, unknown>,
    setPending: (inline: InlineAskUserQuestion | null) => void,
    signal?: AbortSignal,
    config?: InlineAskQuestionConfig,
  ): Promise<Record<string, string | string[]> | null> {
    this.deps.streamController.hideThinkingIndicator();
    this.hideInputContainer(inputContainerEl);

    return new Promise<Record<string, string | string[]> | null>((resolve, reject) => {
      const inline = new InlineAskUserQuestion(
        parentEl,
        input,
        (result: Record<string, string | string[]> | null) => {
          setPending(null);
          this.restoreInputContainer(inputContainerEl);
          resolve(result);
        },
        signal,
        config,
      );
      setPending(inline);
      try {
        inline.render();
      } catch (err) {
        setPending(null);
        this.restoreInputContainer(inputContainerEl);
        reject(toError(err));
      }
    });
  }

  async handleExitPlanMode(
    input: Record<string, unknown>,
    signal?: AbortSignal,
    presentation?: ExitPlanModePresentationOptions,
  ): Promise<ExitPlanModeDecision | null> {
    const { state, streamController } = this.deps;
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      throw new Error('Input container is detached from DOM');
    }

    streamController.hideThinkingIndicator();
    this.hideInputContainer(inputContainerEl);

    const enrichedInput = state.planFilePath
      ? { ...input, planFilePath: state.planFilePath }
      : input;

    const renderContent = (el: HTMLElement, markdown: string) =>
      this.deps.renderer.renderContent(el, markdown);

    const planPathPrefix = this.getActiveCapabilities().planPathPrefix;

    return new Promise<ExitPlanModeDecision | null>((resolve, reject) => {
      const inline = new InlineExitPlanMode(
        parentEl,
        enrichedInput,
        (decision: ExitPlanModeDecision | null) => {
          this.pendingExitPlanModeInline = null;
          this.restoreInputContainer(inputContainerEl);
          resolve(decision);
        },
        signal,
        renderContent,
        planPathPrefix,
        presentation,
      );
      this.pendingExitPlanModeInline = inline;
      try {
        inline.render();
      } catch (err) {
        this.pendingExitPlanModeInline = null;
        this.restoreInputContainer(inputContainerEl);
        reject(toError(err));
      }
    });
  }

  dismissPendingApprovalPrompt(): void {
    if (this.pendingApprovalInline) {
      this.pendingApprovalInline.destroy();
      this.pendingApprovalInline = null;
    }
  }

  dismissProviderInteraction(kind: 'approval' | 'question' | 'plan-decision'): void {
    if (kind === 'approval') {
      this.dismissPendingApprovalPrompt();
      return;
    }
    if (kind === 'question') {
      this.pendingAskInline?.destroy();
      this.pendingAskInline = null;
      return;
    }
    if (this.pendingExitPlanModeInline) {
      this.pendingExitPlanModeInline.destroy();
      this.pendingExitPlanModeInline = null;
    }
  }

  dismissPendingApproval(): void {
    this.dismissPendingApprovalPrompt();
    if (this.pendingAskInline) {
      this.pendingAskInline.destroy();
      this.pendingAskInline = null;
    }
    if (this.pendingExitPlanModeInline) {
      this.pendingExitPlanModeInline.destroy();
      this.pendingExitPlanModeInline = null;
    }
    this.dismissPendingPlanApproval(true);
    this.resetInputContainerVisibility();
  }

  private showPlanApproval(): Promise<{ decision: PlanApprovalDecision | null; invalidated: boolean }> {
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      return Promise.resolve({ decision: null, invalidated: false });
    }

    this.hideInputContainer(inputContainerEl);
    this.pendingPlanApprovalInvalidated = false;

    return new Promise<{ decision: PlanApprovalDecision | null; invalidated: boolean }>((resolve, reject) => {
      const inline = new InlinePlanApproval(
        parentEl,
        (decision: PlanApprovalDecision | null) => {
          const invalidated = this.pendingPlanApprovalInvalidated;
          this.pendingPlanApprovalInvalidated = false;
          this.pendingPlanApproval = null;
          this.restoreInputContainer(inputContainerEl);
          resolve({ decision, invalidated });
        },
      );
      this.pendingPlanApproval = inline;
      try {
        inline.render();
      } catch (err) {
        this.pendingPlanApproval = null;
        this.pendingPlanApprovalInvalidated = false;
        this.restoreInputContainer(inputContainerEl);
        reject(toError(err));
      }
    });
  }

  private dismissPendingPlanApproval(invalidated: boolean): void {
    if (!this.pendingPlanApproval) {
      return;
    }

    if (invalidated) {
      this.pendingPlanApprovalInvalidated = true;
    }
    this.pendingPlanApproval.destroy();
    this.pendingPlanApproval = null;
  }

  private hideInputContainer(inputContainerEl: HTMLElement): void {
    this.inputContainerHideDepth++;
    inputContainerEl.addClass('claudian-hidden');
  }

  private restoreInputContainer(inputContainerEl: HTMLElement): void {
    if (this.inputContainerHideDepth <= 0) return;
    this.inputContainerHideDepth--;
    if (this.inputContainerHideDepth === 0) {
      inputContainerEl.removeClass('claudian-hidden');
    }
  }

  private resetInputContainerVisibility(): void {
    if (this.inputContainerHideDepth > 0) {
      this.inputContainerHideDepth = 0;
      this.deps.getInputContainerEl().removeClass('claudian-hidden');
    }
  }

  // ============================================
  // Built-in Commands
  // ============================================

  private async executeBuiltInCommand(command: BuiltInCommand, args: string): Promise<void> {
    const { conversationController } = this.deps;
    const capabilities = this.getActiveCapabilities();

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
      case 'add-dir': {
        const externalContextSelector = this.deps.getExternalContextSelector();
        if (!externalContextSelector) {
          new Notice('External context selector not available.');
          return;
        }
        const result = externalContextSelector.addExternalContext(args);
        if (result.success) {
          new Notice(`Added external context: ${result.normalizedPath}`);
        } else {
          new Notice(result.error);
        }
        break;
      }
      case 'resume':
        this.showResumeDropdown();
        break;
      case 'fork': {
        if (!this.getActiveCapabilities().supportsFork) {
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
      case 'instruction': {
        const manager = this.deps.getInstructionModeManager();
        if (!manager?.enter()) {
          new Notice('Instruction mode is not available.');
        }
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

  private showResumeDropdown(): void {
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
    externalContextPaths: request.externalContextPaths
      ? [...request.externalContextPaths]
      : undefined,
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
  const externalContextPaths = Array.from(new Set([
    ...(existing.request.externalContextPaths ?? []),
    ...(incoming.request.externalContextPaths ?? []),
  ]));
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
      externalContextPaths:
        externalContextPaths.length > 0 ? externalContextPaths : undefined,
      images: images.length > 0 ? images : undefined,
      text: mergeText(existing.request.text, incoming.request.text),
    },
  };
}
