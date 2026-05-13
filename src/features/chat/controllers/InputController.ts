import { Notice } from 'obsidian';

import {
  type BuiltInCommand,
  detectBuiltInCommand,
  isBuiltInCommandSupported,
} from '../../../core/commands/builtInCommands';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type InstructionRefineService,
  type ProviderCapabilities,
  type ProviderId,
  type TitleGenerationService,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallbackOptions,
  ApprovalDecisionOption,
  ChatTurnRequest,
} from '../../../core/runtime/types';
import { TOOL_EXIT_PLAN_MODE } from '../../../core/tools/toolNames';
import type { ApprovalDecision, ChatMessage, ExitPlanModeDecision, StreamChunk } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { ResumeSessionDropdown } from '../../../shared/components/ResumeSessionDropdown';
import { InstructionModal } from '../../../shared/modals/InstructionConfirmModal';
import type { BrowserSelectionContext } from '../../../utils/browser';
import type { CanvasSelectionContext } from '../../../utils/canvas';
import { formatDurationMmSs } from '../../../utils/date';
import type { EditorSelectionContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import { COMPLETION_FLAVOR_WORDS } from '../constants';
import { type InlineAskQuestionConfig, InlineAskUserQuestion } from '../rendering/InlineAskUserQuestion';
import { InlineExitPlanMode } from '../rendering/InlineExitPlanMode';
import { InlinePlanApproval,type PlanApprovalDecision } from '../rendering/InlinePlanApproval';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { setToolIcon, updateToolCallResult } from '../rendering/ToolCallRenderer';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { QueuedMessage } from '../state/types';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { AddExternalContextResult, McpServerSelector } from '../ui/InputToolbar';
import type { InstructionModeManager } from '../ui/InstructionModeManager';
import type { StatusPanel } from '../ui/StatusPanel';
import type { BrowserSelectionController } from './BrowserSelectionController';
import type { CanvasSelectionController } from './CanvasSelectionController';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import type { StreamController } from './StreamController';

const APPROVAL_OPTION_MAP: Record<string, ApprovalDecision> = {
  'Deny': 'deny',
  'Allow once': 'allow',
  'Always allow': 'allow-always',
};

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
  plugin: ClaudianPlugin;
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
  getImageContextManager: () => ImageContextManager | null;
  getMcpServerSelector: () => McpServerSelector | null;
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
  getAgentService?: () => ChatRuntime | null;
  getSubagentManager: () => SubagentManager;
  /** Tab-level provider fallback for blank tabs (derived from draft model). */
  getTabProviderId?: () => ProviderId;
  /** Returns true if ready. */
  ensureServiceInitialized?: () => Promise<boolean>;
  openConversation?: (conversationId: string) => Promise<void>;
  onForkAll?: () => Promise<void>;
  restorePrePlanPermissionModeIfNeeded?: () => void;
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
  private steerInFlight = false;
  private pendingSteerMessage: QueuedMessage | null = null;
  private activeStreamingAssistantMessage: ChatMessage | null = null;
  private pendingProviderUserMessages: Array<{
    displayContent: string;
    persistedContent?: string;
    currentNote?: string;
    images?: ChatMessage['images'];
  }> = [];
  private sawInitialProviderUserMessage = false;
  private awaitingProviderAssistantStart = false;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  private getAgentService(): ChatRuntime | null {
    return this.deps.getAgentService?.() ?? null;
  }

  private getAuxiliaryModel(): string | null {
    return this.deps.getAuxiliaryModel?.()
      ?? this.getAgentService()?.getAuxiliaryModel?.()
      ?? null;
  }

  private syncInstructionRefineModelOverride(
    instructionRefineService: InstructionRefineService,
  ): void {
    instructionRefineService.setModelOverride?.(this.getAuxiliaryModel() ?? undefined);
  }

  private getActiveProviderId(): ProviderId {
    const agentService = this.getAgentService();
    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) {
      return this.deps.getTabProviderId?.() ?? agentService?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    }

    if (agentService?.providerId) {
      return agentService.providerId;
    }

    return this.deps.plugin.getConversationSync(conversationId)?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  private getActiveCapabilities(): ProviderCapabilities {
    const providerId = this.getActiveProviderId();
    const agentService = this.getAgentService();
    if (agentService?.providerId === providerId) {
      return agentService.getCapabilities();
    }

    return ProviderRegistry.getCapabilities(providerId);
  }

  private isResumeSessionAtStillNeeded(resumeUuid: string, previousMessages: ChatMessage[]): boolean {
    for (let i = previousMessages.length - 1; i >= 0; i--) {
      if (previousMessages[i].role === 'assistant' && previousMessages[i].assistantMessageId === resumeUuid) {
        // Still needed only if no messages follow the resume point
        return i === previousMessages.length - 1;
      }
    }
    return false;
  }

  // ============================================
  // Message Sending
  // ============================================

  async sendMessage(options?: {
    editorContextOverride?: EditorSelectionContext | null;
    browserContextOverride?: BrowserSelectionContext | null;
    canvasContextOverride?: CanvasSelectionContext | null;
    content?: string;
  }): Promise<void> {
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

    // During conversation creation/switching, don't send - input is preserved so user can retry
    if (state.isCreatingConversation || state.isSwitchingConversation) return;

    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();

    const contentOverride = options?.content;
    const shouldUseInput = contentOverride === undefined;
    const content = (contentOverride ?? inputEl.value).trim();
    const hasImages = imageContextManager?.hasImages() ?? false;
    if (!content && !hasImages) return;

    // Check for built-in commands first (e.g., /clear, /new, /add-dir)
    const builtInCmd = detectBuiltInCommand(content);
    if (builtInCmd) {
      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      await this.executeBuiltInCommand(builtInCmd.command, builtInCmd.args);
      return;
    }

    // If agent is working, queue the message instead of dropping it
    if (state.isStreaming) {
      const images = hasImages ? [...(imageContextManager?.getAttachedImages() || [])] : undefined;
      const editorContext = selectionController.getContext();
      const browserContext = browserSelectionController?.getContext() ?? null;
      const canvasContext = canvasSelectionController.getContext();
      state.queuedMessage = this.mergeQueuedMessages(state.queuedMessage, {
        content,
        images,
        editorContext,
        browserContext,
        canvasContext,
      });

      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

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

    fileContextManager?.startSession();

    // Slash commands are passed directly to SDK for handling
    // SDK handles expansion, $ARGUMENTS, @file references, and frontmatter options
    const images = imageContextManager?.getAttachedImages() || [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;
    const isCompact = /^\/compact(\s|$)/i.test(content);

    // Only clear images if we consumed user input (not for programmatic content override)
    if (shouldUseInput) {
      imageContextManager?.clearImages();
    }

    const { displayContent, turnRequest } = this.buildTurnSubmission({
      content,
      images: imagesForMessage,
      editorContextOverride: options?.editorContextOverride,
      browserContextOverride: options?.browserContextOverride,
      canvasContextOverride: options?.canvasContextOverride,
    });

    fileContextManager?.markCurrentNoteSent();

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

    await this.triggerTitleGeneration();

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

    // Lazy initialization: ensure service is ready before first query
    if (this.deps.ensureServiceInitialized) {
      const ready = await this.deps.ensureServiceInitialized();
      if (!ready) {
        new Notice('Failed to initialize agent service. Please try again.');
        streamController.hideThinkingIndicator();
        state.isStreaming = false;
        this.activeStreamingAssistantMessage = null;
        this.resetProviderMessageBoundaryState();
        return;
      }
    }

    const agentService = this.getAgentService();
    if (!agentService) {
      new Notice('Agent service not available. Please reload the plugin.');
      this.activeStreamingAssistantMessage = null;
      this.resetProviderMessageBoundaryState();
      return;
    }

    // Restore pendingResumeAt from persisted conversation state (survives plugin reload)
    const conversationIdForSend = state.currentConversationId;
    if (conversationIdForSend) {
      const conv = plugin.getConversationSync(conversationIdForSend);
      if (conv?.resumeAtMessageId) {
        if (this.isResumeSessionAtStillNeeded(conv.resumeAtMessageId, state.messages.slice(0, -2))) {
          agentService.setResumeCheckpoint(conv.resumeAtMessageId);
        } else {
          try {
            await plugin.updateConversation(conversationIdForSend, { resumeAtMessageId: undefined });
          } catch {
            // Best-effort — don't block send
          }
        }
      }
    }

    try {
      const preparedTurn = agentService.prepareTurn(turnRequest);
      userMsg.content = preparedTurn.persistedContent;
      userMsg.currentNote = preparedTurn.isCompact
        ? undefined
        : preparedTurn.request.currentNotePath;

      // Pass history WITHOUT current turn (userMsg + assistantMsg we just added)
      // This prevents duplication when rebuilding context for new sessions
      const previousMessages = state.messages.slice(0, -2);
      for await (const chunk of agentService.query(preparedTurn, previousMessages)) {
        if (state.streamGeneration !== streamGeneration) {
          wasInvalidated = true;
          break;
        }
        if (state.cancelRequested) {
          wasInterrupted = true;
          break;
        }

        if (await this.handleProviderMessageBoundaryChunk(chunk)) {
          continue;
        }

        await streamController.handleStreamChunk(
          chunk,
          this.activeStreamingAssistantMessage ?? assistantMsg,
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await streamController.appendText(`\n\n**Error:** ${errorMsg}`);
    } finally {
      const finalAssistantMsg = this.activeStreamingAssistantMessage ?? assistantMsg;
      const turnMetadata = agentService.consumeTurnMetadata();
      userMsg.userMessageId = turnMetadata.userMessageId ?? userMsg.userMessageId;
      finalAssistantMsg.assistantMessageId = turnMetadata.assistantMessageId ?? finalAssistantMsg.assistantMessageId;
      didEnqueueToSdk = didEnqueueToSdk || turnMetadata.wasSent === true;
      planCompleted = planCompleted || turnMetadata.planCompleted === true;

      // ALWAYS clear the timer interval, even on stream invalidation (prevents memory leaks)
      state.clearFlavorTimerInterval();

      // Skip remaining cleanup if stream was invalidated (tab closed or conversation switched)
      if (!wasInvalidated && state.streamGeneration === streamGeneration) {
        const didCancelThisTurn = wasInterrupted || state.cancelRequested;
        if (didCancelThisTurn && !state.pendingNewSessionPlan) {
          await streamController.appendText('\n\n<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>');
        }
        streamController.hideThinkingIndicator();
        state.isStreaming = false;
        state.cancelRequested = false;
        this.restorePendingSteerMessageToQueue();

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
        let planApprovalInvalidated = false;
        let shouldProcessQueuedMessage = true;
        if (planCompleted && !didCancelThisTurn) {
          const { decision, invalidated } = await this.showPlanApproval();

          // Re-check invalidation after async approval prompt
          if (state.streamGeneration !== streamGeneration || invalidated) {
            planApprovalInvalidated = true;
          } else if (decision?.type === 'implement') {
            this.deps.restorePrePlanPermissionModeIfNeeded?.();
            planAutoSendContent = 'Implement the plan.';
          } else if (decision?.type === 'revise') {
            // Keep plan mode active, populate input with feedback text
            this.deps.getInputEl().value = decision.text;
            shouldProcessQueuedMessage = false;
          } else {
            // cancel or null (dismissed)
            this.deps.restorePrePlanPermissionModeIfNeeded?.();
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
            this.deps.getInputEl().value = planAutoSendContent;
            this.sendMessage().catch(() => {});
          } else {
            // approve-new-session: create fresh conversation and send plan content
            // Must be inside the invalidation guard — if the tab was closed or
            // conversation switched, we must not create a new session on stale state.
            const planContent = state.pendingNewSessionPlan;
            if (planContent) {
              state.pendingNewSessionPlan = null;
              await conversationController.createNew();
              this.deps.getInputEl().value = planContent;
              this.sendMessage().catch(() => {
                // sendMessage() handles its own errors internally; this prevents
                // unhandled rejection if an unexpected error slips through.
              });
            } else if (shouldProcessQueuedMessage) {
              this.processQueuedMessage();
            }
          }
        }
      }

      if (wasInvalidated) {
        this.clearPendingSteerState();
        this.updateQueueIndicator();
      }

      this.activeStreamingAssistantMessage = null;
      this.resetProviderMessageBoundaryState();
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

    const visibleQueuedMessage = state.queuedMessage ?? this.pendingSteerMessage;
    if (visibleQueuedMessage) {
      const isPendingSteerOnly = !state.queuedMessage && !!this.pendingSteerMessage;
      indicatorEl.createSpan({
        cls: 'claudian-queue-indicator-text',
        text: `${isPendingSteerOnly ? '⌙ Steering: ' : '⌙ Queued: '}${this.getQueuedMessageDisplay(visibleQueuedMessage)}`,
      });

      if (state.queuedMessage && this.canSteerQueuedMessage()) {
        const steerButton = indicatorEl.createEl('button', {
          cls: 'claudian-queue-indicator-action',
          text: this.steerInFlight ? 'Steering...' : 'Steer Now',
        });
        steerButton.setAttribute('type', 'button');
        if (this.steerInFlight) {
          steerButton.setAttribute('disabled', 'true');
        } else {
          steerButton.addEventListener('click', (event) => {
            event.stopPropagation();
            void this.steerQueuedMessage();
          });
        }
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

  private restoreMessageToInput(message: QueuedMessage | null): void {
    if (!message) return;

    const { content, images } = message;
    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }
  }

  private restorePendingMessagesToInput(): void {
    const { state } = this.deps;
    const combinedMessage = this.mergePendingMessages(
      this.pendingSteerMessage,
      state.queuedMessage,
    );
    this.restoreMessageToInput(combinedMessage);
    state.queuedMessage = null;
    this.clearPendingSteerState();
    this.updateQueueIndicator();
  }

  private processQueuedMessage(): void {
    const { state } = this.deps;
    if (!state.queuedMessage) return;

    const { content, images, editorContext, browserContext, canvasContext } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }

    window.setTimeout(
      () => {
        void this.sendMessage({
          editorContextOverride: editorContext,
          browserContextOverride: browserContext ?? null,
          canvasContextOverride: canvasContext,
        });
      },
      0
    );
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
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const externalContextSelector = this.deps.getExternalContextSelector();

    const currentNotePath = fileContextManager?.getCurrentNotePath() || null;
    const shouldSendCurrentNote = fileContextManager?.shouldSendCurrentNote(currentNotePath) ?? false;

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
    const transformedText = !isCompact && fileContextManager
      ? fileContextManager.transformContextMentions(options.content)
      : options.content;
    const enabledMcpServers = mcpServerSelector?.getEnabledServers();

    return {
      displayContent: options.content,
      turnRequest: {
        text: transformedText,
        images: options.images,
        currentNotePath: shouldSendCurrentNote && currentNotePath ? currentNotePath : undefined,
        editorSelection: editorContext,
        browserSelection: browserContext,
        canvasSelection: canvasContext,
        externalContextPaths: externalContextPaths && externalContextPaths.length > 0
          ? externalContextPaths
          : undefined,
        enabledMcpServers: enabledMcpServers && enabledMcpServers.size > 0
          ? enabledMcpServers
          : undefined,
      },
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

  private canSteerQueuedMessage(): boolean {
    const agentService = this.getAgentService();
    return this.deps.state.isStreaming
      && this.getActiveCapabilities().supportsTurnSteer === true
      && typeof agentService?.steer === 'function';
  }

  private cloneQueuedMessage(message: QueuedMessage): QueuedMessage {
    return {
      ...message,
      images: message.images ? [...message.images] : undefined,
    };
  }

  private mergePendingMessages(
    first: QueuedMessage | null,
    second: QueuedMessage | null,
  ): QueuedMessage | null {
    if (first && second) {
      return this.mergeQueuedMessages(first, second);
    }

    if (first) {
      return this.cloneQueuedMessage(first);
    }

    if (second) {
      return this.cloneQueuedMessage(second);
    }

    return null;
  }

  private clearPendingSteerState(): void {
    this.pendingSteerMessage = null;
    this.steerInFlight = false;
  }

  private restorePendingSteerMessageToQueue(): void {
    if (!this.pendingSteerMessage) {
      return;
    }

    const { state } = this.deps;
    const pendingSteerMessage = this.cloneQueuedMessage(this.pendingSteerMessage);
    this.clearPendingSteerState();
    state.queuedMessage = state.queuedMessage
      ? this.mergeQueuedMessages(pendingSteerMessage, state.queuedMessage)
      : pendingSteerMessage;
    this.updateQueueIndicator();
  }

  private mergeQueuedMessages(
    existing: QueuedMessage | null,
    incoming: QueuedMessage,
  ): QueuedMessage {
    if (!existing) {
      return {
        ...incoming,
        images: incoming.images ? [...incoming.images] : undefined,
      };
    }

    const contentParts = [existing.content, incoming.content].filter(part => part.length > 0);

    return {
      content: contentParts.join('\n\n'),
      images: [...(existing.images || []), ...(incoming.images || [])].filter(Boolean).length > 0
        ? [...(existing.images || []), ...(incoming.images || [])]
        : undefined,
      editorContext: incoming.editorContext,
      browserContext: incoming.browserContext,
      canvasContext: incoming.canvasContext,
    };
  }

  private async steerQueuedMessage(): Promise<void> {
    if (this.steerInFlight) {
      return;
    }

    const { state } = this.deps;
    const agentService = this.getAgentService();
    if (!state.queuedMessage || !this.canSteerQueuedMessage() || !agentService?.steer) {
      return;
    }

    const queuedMessage = this.cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    this.pendingSteerMessage = queuedMessage;
    this.steerInFlight = true;
    this.updateQueueIndicator();

    try {
      const { displayContent, turnRequest } = this.buildTurnSubmission({
        content: queuedMessage.content,
        images: queuedMessage.images,
        editorContextOverride: queuedMessage.editorContext,
        browserContextOverride: queuedMessage.browserContext ?? null,
        canvasContextOverride: queuedMessage.canvasContext,
      });

      const preparedTurn = agentService.prepareTurn(turnRequest);
      const accepted = await agentService.steer(preparedTurn);
      if (state.cancelRequested || !this.pendingSteerMessage) {
        return;
      }
      if (!accepted) {
        this.restoreQueuedMessageAfterSteerFailure(queuedMessage);
        return;
      }

      this.deps.getFileContextManager()?.markCurrentNoteSent();

      this.pendingProviderUserMessages.push({
        displayContent,
        persistedContent: preparedTurn.persistedContent,
        currentNote: preparedTurn.isCompact
          ? undefined
          : preparedTurn.request.currentNotePath,
        images: queuedMessage.images,
      });
    } catch {
      this.restoreQueuedMessageAfterSteerFailure(queuedMessage);
      new Notice('Failed to steer the queued Codex message. It is still available.');
    }
  }

  private restoreQueuedMessageAfterSteerFailure(
    message: QueuedMessage,
  ): void {
    const { state } = this.deps;
    this.clearPendingSteerState();
    if (state.cancelRequested) {
      this.updateQueueIndicator();
      return;
    }

    if (state.isStreaming) {
      state.queuedMessage = state.queuedMessage
        ? this.mergeQueuedMessages(message, state.queuedMessage)
        : message;
      this.updateQueueIndicator();
      return;
    }

    this.restoreMessageToInput(message);
    this.updateQueueIndicator();
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
    const expected = this.pendingProviderUserMessages.shift();
    if (!this.sawInitialProviderUserMessage) {
      this.sawInitialProviderUserMessage = true;
      return;
    }

    this.clearPendingSteerState();
    this.updateQueueIndicator();

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
        currentNote: expected?.currentNote,
        images,
      };
      this.deps.state.addMessage(userMessage);
      this.deps.renderer.addMessage(userMessage);
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

    if (!state.currentConversationId) {
      const sessionId = this.getAgentService()?.getSessionId() ?? undefined;
      const conversation = await plugin.createConversation({
        providerId: this.getActiveProviderId(),
        sessionId,
      });
      state.currentConversationId = conversation.id;
    }

    // Find first user message by role (not by index)
    const firstUserMsg = state.messages.find(m => m.role === 'user');

    if (!firstUserMsg) {
      return;
    }

    const userContent = firstUserMsg.displayContent || firstUserMsg.content;

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

  // ============================================
  // Streaming Control
  // ============================================

  cancelStreaming(): void {
    const { state, streamController } = this.deps;
    if (!state.isStreaming) return;
    state.cancelRequested = true;
    // Restore queued message to input instead of discarding
    this.restorePendingMessagesToInput();
    this.getAgentService()?.cancel();
    streamController.hideThinkingIndicator();
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
              const currentPrompt = plugin.settings.systemPrompt;
              plugin.settings.systemPrompt = appendMarkdownSnippet(currentPrompt, finalInstruction);
              await plugin.saveSettings();

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
      case 'clear':
        await conversationController.createNew();
        break;
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
