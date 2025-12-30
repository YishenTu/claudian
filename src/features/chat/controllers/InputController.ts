/**
 * Input controller for handling user input and message sending.
 *
 * Manages message sending, queue handling, slash command expansion,
 * instruction mode, and approval dialogs.
 */

import type { Component } from 'obsidian';
import { Notice } from 'obsidian';

import type { ExitPlanModeDecision } from '../../../core/agent/ClaudianService';
import { isCommandBlocked } from '../../../core/security/BlocklistChecker';
import { TOOL_BASH } from '../../../core/tools/toolNames';
import type { AskUserQuestionInput, ChatMessage, ImageAttachment } from '../../../core/types';
import { getBashToolBlockedCommands } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import {
  ApprovalModal,
  type FileContextManager,
  type ImageContextManager,
  InstructionModal,
  type InstructionModeManager,
  type McpServerSelector,
  type PlanBanner,
  showAskUserQuestionPanel,
  showPlanApprovalPanel,
  type SlashCommandManager,
} from '../../../ui';
import { prependContextFiles } from '../../../utils/context';
import { type EditorSelectionContext, prependEditorContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import { formatSlashCommandWarnings } from '../../../utils/slashCommandWarnings';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { InstructionRefineService } from '../services/InstructionRefineService';
import type { ChatState } from '../state/ChatState';
import type { QueryOptions } from '../state/types';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import type { StreamController } from './StreamController';

const PLAN_MODE_CONTINUE_PROMPT =
  'Continue the most recent user request in plan mode. Use the prior request as the task, plus any attached files, editor context, and images. Create an implementation plan and call ExitPlanMode when ready.';

/** Dependencies for InputController. */
export interface InputControllerDeps {
  plugin: ClaudianPlugin;
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  selectionController: SelectionController;
  conversationController: ConversationController;
  getInputEl: () => HTMLTextAreaElement;
  getWelcomeEl: () => HTMLElement | null;
  getMessagesEl: () => HTMLElement;
  getFileContextManager: () => FileContextManager | null;
  getImageContextManager: () => ImageContextManager | null;
  getSlashCommandManager: () => SlashCommandManager | null;
  getMcpServerSelector: () => McpServerSelector | null;
  getInstructionModeManager: () => InstructionModeManager | null;
  getInstructionRefineService: () => InstructionRefineService | null;
  getComponent: () => Component;
  setPlanModeActive: (active: boolean) => void;
  getPlanBanner: () => PlanBanner | null;
  generateId: () => string;
  resetContextMeter: () => void;
}

interface PlanModeResendPayload {
  content: string;
  displayContent?: string;
  images?: ImageAttachment[];
  contextFiles?: string[];
  editorContext?: EditorSelectionContext | null;
  queryOptions?: QueryOptions;
}

interface PlanModeSendOptions extends PlanModeResendPayload {
  skipUserMessage?: boolean;
}

/**
 * InputController handles user input and message sending.
 */
export class InputController {
  private deps: InputControllerDeps;
  private lastSentPayload: PlanModeResendPayload | null = null;
  private pendingPlanModeResendPayload: PlanModeResendPayload | null = null;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  // ============================================
  // Message Sending
  // ============================================

  /** Sends a message with optional editor context override. */
  async sendMessage(options?: { editorContextOverride?: EditorSelectionContext | null; hidden?: boolean }): Promise<void> {
    const { plugin, state, renderer, streamController, selectionController, conversationController } = this.deps;
    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();
    const slashCommandManager = this.deps.getSlashCommandManager();
    const mcpServerSelector = this.deps.getMcpServerSelector();

    let content = inputEl.value.trim();
    const hasImages = imageContextManager?.hasImages() ?? false;
    if (!content && !hasImages) return;

    // If agent is working, queue the message instead of dropping it
    if (state.isStreaming) {
      const images = hasImages ? [...(imageContextManager?.getAttachedImages() || [])] : undefined;
      const editorContext = selectionController.getContext();

      // Append to existing queued message if any
      if (state.queuedMessage) {
        state.queuedMessage.content += '\n\n' + content;
        if (images && images.length > 0) {
          state.queuedMessage.images = [...(state.queuedMessage.images || []), ...images];
        }
        state.queuedMessage.editorContext = editorContext;
        // Preserve hidden flag (once hidden, always hidden)
        state.queuedMessage.hidden = state.queuedMessage.hidden || options?.hidden;
      } else {
        state.queuedMessage = { content, images, editorContext, hidden: options?.hidden };
      }

      inputEl.value = '';
      imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

    inputEl.value = '';
    state.isStreaming = true;
    state.cancelRequested = false;
    state.ignoreUsageUpdates = false; // Allow usage updates for new query

    // Hide welcome message when sending first message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.style.display = 'none';
    }

    fileContextManager?.startSession();

    // Check for slash command and expand it
    const displayContent = content;
    let queryOptions: QueryOptions | undefined;
    if (content && slashCommandManager) {
      slashCommandManager.setCommands(plugin.settings.slashCommands);
      const detected = slashCommandManager.detectCommand(content);
      if (detected) {
        const cmd = plugin.settings.slashCommands.find(
          c => c.name.toLowerCase() === detected.commandName.toLowerCase()
        );
        if (cmd) {
          const result = await slashCommandManager.expandCommand(cmd, detected.args, {
            bash: {
              enabled: true,
              shouldBlockCommand: (bashCommand) =>
                isCommandBlocked(
                  bashCommand,
                  getBashToolBlockedCommands(plugin.settings.blockedCommands),
                  plugin.settings.enableBlocklist
                ),
              requestApproval:
                plugin.settings.permissionMode === 'normal'
                  ? (bashCommand) => this.requestInlineBashApproval(bashCommand)
                  : undefined,
            },
          });
          content = result.expandedPrompt;

          if (result.errors.length > 0) {
            new Notice(formatSlashCommandWarnings(result.errors));
          }

          if (result.allowedTools || result.model) {
            queryOptions = {
              allowedTools: result.allowedTools,
              model: result.model,
            };
          }
        }
      }
    }

    if (content && imageContextManager) {
      const result = await imageContextManager.handleImagePathInText(content);
      if (result.imageLoaded) {
        content = result.text;
      }
    }

    const images = imageContextManager?.getAttachedImages() || [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;

    imageContextManager?.clearImages();

    const attachedFiles = fileContextManager?.getAttachedFiles() || new Set();
    const currentFiles = Array.from(attachedFiles);
    const filesChanged = fileContextManager?.hasFilesChanged() ?? false;

    const editorContextOverride = options?.editorContextOverride;
    const editorContext = editorContextOverride !== undefined
      ? editorContextOverride
      : selectionController.getContext();

    // Wrap query in XML tag
    let promptToSend = `<query>\n${content}\n</query>`;
    let contextFilesForMessage: string[] | undefined;

    // Prepend editor context if available
    if (editorContext) {
      promptToSend = prependEditorContext(promptToSend, editorContext);
    }

    if (filesChanged) {
      promptToSend = prependContextFiles(promptToSend, currentFiles);
      contextFilesForMessage = currentFiles;
    }

    this.lastSentPayload = {
      content,
      displayContent,
      images: imagesForMessage,
      contextFiles: contextFilesForMessage,
      editorContext,
      queryOptions,
    };

    fileContextManager?.markFilesSent();

    const userMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'user',
      content,
      displayContent: displayContent !== content ? displayContent : undefined,
      timestamp: Date.now(),
      contextFiles: contextFilesForMessage,
      images: imagesForMessage,
      hidden: options?.hidden,
    };
    state.addMessage(userMsg);
    if (!options?.hidden) {
      renderer.addMessage(userMsg);
    }

    if (state.messages.length === 1 && state.currentConversationId) {
      const title = conversationController.generateTitle(displayContent);
      await plugin.renameConversation(state.currentConversationId, title);
    }

    const assistantMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    state.addMessage(assistantMsg);
    const msgEl = renderer.addMessage(assistantMsg);
    const contentEl = msgEl.querySelector('.claudian-message-content') as HTMLElement;

    state.toolCallElements.clear();
    state.currentContentEl = contentEl;
    state.currentTextEl = null;
    state.currentTextContent = '';

    streamController.showThinkingIndicator(contentEl);

    // Extract @-mentioned MCP servers from prompt
    const mcpMentions = plugin.mcpService.extractMentions(promptToSend);

    // Add MCP options to query
    const enabledMcpServers = mcpServerSelector?.getEnabledServers();
    if (mcpMentions.size > 0 || (enabledMcpServers && enabledMcpServers.size > 0)) {
      queryOptions = {
        ...queryOptions,
        mcpMentions,
        enabledMcpServers,
      };
    }

    let wasInterrupted = false;
    let scheduledPlanModeResend = false;
    try {
      for await (const chunk of plugin.agentService.query(promptToSend, imagesForMessage, state.messages, queryOptions)) {
        if (state.cancelRequested) {
          wasInterrupted = true;
          break;
        }
        await streamController.handleStreamChunk(chunk, assistantMsg);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await streamController.appendText(`\n\n**Error:** ${errorMsg}`);
    } finally {
      // Check if we need to re-send with plan mode (agent called EnterPlanMode)
      const planModeState = state.planModeState;
      const pendingPlanModeResend = planModeState?.pendingResend;

      if (wasInterrupted && !pendingPlanModeResend) {
        await streamController.appendText('\n\n<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>');
      }
      streamController.hideThinkingIndicator();
      state.isStreaming = false;
      state.cancelRequested = false;
      state.currentContentEl = null;

      streamController.finalizeCurrentThinkingBlock(assistantMsg);
      streamController.finalizeCurrentTextBlock(assistantMsg);
      state.activeSubagents.clear();

      await conversationController.save(true);

      // If agent initiated plan mode, re-send with plan mode enabled
      if (pendingPlanModeResend) {
        planModeState.pendingResend = false;
        const resendPayload = this.pendingPlanModeResendPayload ?? this.getPlanModeResendPayload();
        this.pendingPlanModeResendPayload = null;
        if (resendPayload) {
          setTimeout(() => {
            void this.sendMessageWithPlanMode({ ...resendPayload, skipUserMessage: true });
          }, 100);
          scheduledPlanModeResend = true;
        }
      }

      if (!scheduledPlanModeResend) {
        this.processQueuedMessage();
      }
    }
  }

  // ============================================
  // Plan Mode
  // ============================================

  /** Sends a message in plan mode (read-only exploration). */
  async sendPlanModeMessage(): Promise<void> {
    const { state, plugin } = this.deps;
    const inputEl = this.deps.getInputEl();

    const content = inputEl.value.trim();
    if (!content) return;

    // Cannot enter plan mode while streaming
    if (state.isStreaming) {
      new Notice('Cannot enter plan mode while agent is working');
      return;
    }

    // Clear any stale plan file path before starting a new plan mode session
    plugin.agentService.setCurrentPlanFilePath(null);

    // Set plan mode state (agent will determine plan file path)
    state.planModeState = {
      isActive: true,
      planFilePath: null,
      planContent: null,
      originalQuery: content,
    };

    // Update file context manager to hide edited files during plan mode
    this.deps.getFileContextManager()?.setPlanModeActive(true);

    // Clear input and send
    inputEl.value = '';
    await this.sendMessageWithPlanMode({ content });
  }

  /**
   * Handles agent-initiated EnterPlanMode tool call.
   * Sets up state for re-sending with plan mode after current stream ends.
   */
  async handleEnterPlanMode(): Promise<void> {
    const { state, plugin } = this.deps;

    if (state.planModeState?.isActive) {
      return;
    }

    const resendPayload = this.getPlanModeResendPayload();
    if (!resendPayload || !resendPayload.content.trim()) {
      return;
    }

    const originalQuery = resendPayload.content;
    const planModePayload: PlanModeResendPayload = {
      ...resendPayload,
      content: PLAN_MODE_CONTINUE_PROMPT,
      displayContent: PLAN_MODE_CONTINUE_PROMPT,
    };

    this.pendingPlanModeResendPayload = {
      ...planModePayload,
      images: planModePayload.images ? [...planModePayload.images] : undefined,
      contextFiles: planModePayload.contextFiles ? [...planModePayload.contextFiles] : undefined,
    };

    // Set plan mode state with pending resend flag
    state.planModeState = {
      isActive: true,
      planFilePath: null,
      planContent: null,
      originalQuery,
      pendingResend: true,
    };

    // Update UI
    this.deps.setPlanModeActive(true);
    this.deps.getFileContextManager()?.setPlanModeActive(true);

    // Clear stale plan file path
    plugin.agentService.setCurrentPlanFilePath(null);
  }

  /** Internal: sends message with plan mode options. */
  private async sendMessageWithPlanMode(options?: PlanModeSendOptions): Promise<void> {
    const { plugin, state, renderer, streamController, selectionController, conversationController } = this.deps;
    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();
    const mcpServerSelector = this.deps.getMcpServerSelector();

    const content = (options?.content ?? inputEl.value).trim();
    if (!content) return;

    const skipUserMessage = options?.skipUserMessage ?? false;
    if (options?.content === undefined) {
      inputEl.value = '';
    }
    state.isStreaming = true;
    state.cancelRequested = false;
    state.ignoreUsageUpdates = false; // Allow usage updates for new query

    // Hide welcome message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.style.display = 'none';
    }

    fileContextManager?.startSession();

    const images = skipUserMessage
      ? (options?.images ?? [])
      : (options?.images ?? (imageContextManager?.getAttachedImages() || []));
    const imagesForMessage = images.length > 0 ? [...images] : undefined;
    if (!skipUserMessage && !options?.images) {
      imageContextManager?.clearImages();
    }

    let currentFiles: string[] = [];
    let filesChanged = false;
    let contextFilesForMessage: string[] | undefined;
    if (skipUserMessage) {
      currentFiles = options?.contextFiles ? [...options.contextFiles] : [];
      filesChanged = currentFiles.length > 0;
      contextFilesForMessage = filesChanged ? currentFiles : undefined;
    } else if (options?.contextFiles) {
      currentFiles = [...options.contextFiles];
      filesChanged = currentFiles.length > 0;
      contextFilesForMessage = filesChanged ? currentFiles : undefined;
    } else {
      const attachedFiles = fileContextManager?.getAttachedFiles() || new Set();
      currentFiles = Array.from(attachedFiles);
      filesChanged = fileContextManager?.hasFilesChanged() ?? false;
      if (filesChanged) {
        contextFilesForMessage = currentFiles;
      }
    }

    const editorContext = options?.editorContext ?? selectionController.getContext();

    // Wrap query in XML tag with plan mode context
    // Note: The system prompt already includes full plan mode instructions
    let promptToSend = `[Plan Mode]
Explore the codebase and create an implementation plan. Call the ExitPlanMode tool when the plan is ready for user approval.

<query>
${content}
</query>`;
    if (editorContext) {
      promptToSend = prependEditorContext(promptToSend, editorContext);
    }

    if (filesChanged) {
      promptToSend = prependContextFiles(promptToSend, currentFiles);
      contextFilesForMessage = currentFiles;
    }

    if (!skipUserMessage) {
      fileContextManager?.markFilesSent();
    }

    if (!skipUserMessage) {
      const displayContent = options?.displayContent ?? content;
      const userMsg: ChatMessage = {
        id: this.deps.generateId(),
        role: 'user',
        content,
        displayContent: displayContent !== content ? displayContent : undefined,
        timestamp: Date.now(),
        contextFiles: contextFilesForMessage,
        images: imagesForMessage,
      };
      state.addMessage(userMsg);
      renderer.addMessage(userMsg);

      if (state.messages.length === 1 && state.currentConversationId) {
        const title = conversationController.generateTitle(displayContent);
        await plugin.renameConversation(state.currentConversationId, title);
      }
    }

    const assistantMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    state.addMessage(assistantMsg);
    const msgEl = renderer.addMessage(assistantMsg);
    const contentEl = msgEl.querySelector('.claudian-message-content') as HTMLElement;

    state.toolCallElements.clear();
    state.currentContentEl = contentEl;
    state.currentTextEl = null;
    state.currentTextContent = '';

    streamController.showThinkingIndicator(contentEl);

    // Build query options with plan mode
    const mcpMentions = plugin.mcpService.extractMentions(promptToSend);
    const enabledMcpServers = mcpServerSelector?.getEnabledServers();

    const queryOptions = {
      ...options?.queryOptions,
      planMode: true,
      mcpMentions,
      enabledMcpServers,
    };

    let wasInterrupted = false;
    try {
      for await (const chunk of plugin.agentService.query(promptToSend, imagesForMessage, state.messages, queryOptions)) {
        if (state.cancelRequested) {
          wasInterrupted = true;
          break;
        }
        await streamController.handleStreamChunk(chunk, assistantMsg);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await streamController.appendText(`\n\n**Error:** ${errorMsg}`);
    } finally {
      if (wasInterrupted) {
        await streamController.appendText('\n\n<span class="claudian-interrupted">Plan mode interrupted</span>');
        state.resetPlanModeState();
        plugin.agentService.setCurrentPlanFilePath(null);
        this.deps.setPlanModeActive(false);
      }
      streamController.hideThinkingIndicator();
      state.isStreaming = false;
      state.cancelRequested = false;
      state.currentContentEl = null;

      streamController.finalizeCurrentThinkingBlock(assistantMsg);
      streamController.finalizeCurrentTextBlock(assistantMsg);
      state.activeSubagents.clear();

      await conversationController.save(true);

      this.processQueuedMessage();
    }
  }

  private getPlanModeResendPayload(): PlanModeResendPayload | null {
    if (this.lastSentPayload?.content) {
      return this.lastSentPayload;
    }

    const { state, selectionController } = this.deps;
    const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg?.content) {
      return null;
    }

    return {
      content: lastUserMsg.content,
      displayContent: lastUserMsg.displayContent,
      images: lastUserMsg.images,
      contextFiles: lastUserMsg.contextFiles,
      editorContext: selectionController.getContext(),
    };
  }

  // ============================================
  // Queue Management
  // ============================================

  /** Updates the queue indicator UI. */
  updateQueueIndicator(): void {
    const { state } = this.deps;
    if (!state.queueIndicatorEl) return;

    if (state.queuedMessage) {
      const rawContent = state.queuedMessage.content.trim();
      const preview = rawContent.length > 40
        ? rawContent.slice(0, 40) + '...'
        : rawContent;
      const hasImages = (state.queuedMessage.images?.length ?? 0) > 0;
      let display = preview;

      if (hasImages) {
        display = display ? `${display} [images]` : '[images]';
      }

      state.queueIndicatorEl.setText(`⌙ Queued: ${display}`);
      state.queueIndicatorEl.style.display = 'block';
    } else {
      state.queueIndicatorEl.style.display = 'none';
    }
  }

  /** Clears the queued message. */
  clearQueuedMessage(): void {
    const { state } = this.deps;
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

  /** Processes the queued message. */
  private processQueuedMessage(): void {
    const { state } = this.deps;
    if (!state.queuedMessage) return;

    const { content, images, editorContext, hidden } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }

    setTimeout(() => this.sendMessage({ editorContextOverride: editorContext, hidden }), 0);
  }

  // ============================================
  // Streaming Control
  // ============================================

  /** Cancels the current streaming operation. */
  cancelStreaming(): void {
    const { plugin, state, streamController } = this.deps;
    if (!state.isStreaming) return;
    state.cancelRequested = true;
    this.clearQueuedMessage();
    plugin.agentService.cancel();
    streamController.hideThinkingIndicator();
  }

  // ============================================
  // Instruction Mode
  // ============================================

  /** Handles instruction mode submission. */
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
          onAccept: async (finalInstruction) => {
            const currentPrompt = plugin.settings.systemPrompt;
            plugin.settings.systemPrompt = appendMarkdownSnippet(currentPrompt, finalInstruction);
            await plugin.saveSettings();

            new Notice('Instruction added to custom system prompt');
            instructionModeManager?.clear();
          },
          onReject: () => {
            wasCancelled = true;
            instructionRefineService.cancel();
            instructionModeManager?.clear();
          },
          onClarificationSubmit: async (response) => {
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

  /** Handles tool approval requests. */
  async handleApprovalRequest(
    toolName: string,
    input: Record<string, unknown>,
    description: string
  ): Promise<'allow' | 'allow-always' | 'deny'> {
    const { plugin } = this.deps;
    return new Promise((resolve) => {
      const modal = new ApprovalModal(plugin.app, toolName, input, description, resolve);
      modal.open();
    });
  }

  /** Requests approval for inline bash commands. */
  async requestInlineBashApproval(command: string): Promise<boolean> {
    const { plugin } = this.deps;
    const description = `Execute inline bash command:\n${command}`;
    return new Promise((resolve) => {
      const modal = new ApprovalModal(
        plugin.app,
        TOOL_BASH,
        { command },
        description,
        (decision) => resolve(decision === 'allow' || decision === 'allow-always'),
        { showAlwaysAllow: false, title: 'Inline bash execution' }
      );
      modal.open();
    });
  }

  /** Handles AskUserQuestion tool calls by showing a floating panel. */
  async handleAskUserQuestion(input: AskUserQuestionInput): Promise<Record<string, string | string[]> | null> {
    const { plugin } = this.deps;

    // Get the container element (the claudian view container)
    const messagesEl = this.deps.getMessagesEl();
    const containerEl = messagesEl.parentElement;
    if (!containerEl) {
      return null;
    }

    return showAskUserQuestionPanel(plugin.app, containerEl, input);
  }

  // ============================================
  // Plan Mode Approval
  // ============================================

  /** Handles ExitPlanMode tool by showing plan approval panel. */
  async handleExitPlanMode(planContent: string): Promise<ExitPlanModeDecision> {
    const { state, renderer, conversationController } = this.deps;

    // Get the container element (the claudian view container)
    const messagesEl = this.deps.getMessagesEl();
    const containerEl = messagesEl.parentElement;
    if (!containerEl) {
      return { decision: 'cancel' };
    }

    // Store plan content in state
    if (state.planModeState) {
      state.planModeState.planContent = planContent;
    }

    // Add plan as a chat message with distinct styling
    const planMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: planContent,
      timestamp: Date.now(),
      isPlanMessage: true,
    };
    state.addMessage(planMsg);
    renderer.addMessage(planMsg);
    // Render the plan content with special styling
    const lastMsgEl = messagesEl.lastElementChild;
    if (lastMsgEl) {
      lastMsgEl.classList.add('claudian-message-plan');
      const contentEl = lastMsgEl.querySelector('.claudian-message-content') as HTMLElement;
      if (contentEl) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        await renderer.renderContent(textEl, planContent);
      }
    }

    // Scroll to bottom to show the plan
    renderer.scrollToBottom();

    // Save pending plan content to state and persist to conversation
    state.pendingPlanContent = planContent;
    await conversationController.save();

    // Show approval panel and handle decision
    return this.showApprovalPanelAndHandleDecision(planContent, containerEl);
  }

  /**
   * Restores pending plan approval panel when loading a conversation.
   * Called when a conversation with pendingPlanContent is loaded.
   */
  restorePendingPlanApproval(planContent: string): void {
    const messagesEl = this.deps.getMessagesEl();
    const containerEl = messagesEl.parentElement;
    if (!containerEl) {
      return;
    }

    // Show approval panel (plan message is already in chat from saved messages)
    void this.showApprovalPanelAndHandleDecision(planContent, containerEl);
  }

  /** Shows approval panel and handles the decision. */
  private async showApprovalPanelAndHandleDecision(
    planContent: string,
    containerEl: HTMLElement
  ): Promise<ExitPlanModeDecision> {
    const { plugin, state, conversationController } = this.deps;

    // Show approval panel (buttons only, plan is already in chat)
    const result = await showPlanApprovalPanel(
      plugin.app,
      containerEl,
      planContent,
      this.deps.getComponent()
    );

    // Clear pending plan content after any decision
    state.pendingPlanContent = null;

    if (result.decision === 'approve') {
      // Add approval indicator
      this.addApprovalIndicator('approve');
      // Store approved plan content for system prompt
      plugin.agentService.setApprovedPlanContent(planContent);
      // Show the plan banner
      const planBanner = this.deps.getPlanBanner();
      if (planBanner) {
        void planBanner.show(planContent);
      }
      // Clear plan mode state and toggle
      state.resetPlanModeState();
      plugin.agentService.setCurrentPlanFilePath(null);
      this.deps.setPlanModeActive(false);
      // Save conversation to clear pending and set approved
      await conversationController.save();
      // Auto-send implementation prompt (hidden from UI)
      const inputEl = this.deps.getInputEl();
      inputEl.value = 'Please implement the approved plan.';
      setTimeout(() => this.sendMessage({ hidden: true }), 100);
      return { decision: 'approve' };
    } else if (result.decision === 'approve_new_session') {
      // Add approval indicator
      this.addApprovalIndicator('approve_new_session');
      // Show the plan banner
      const planBanner = this.deps.getPlanBanner();
      if (planBanner) {
        void planBanner.show(planContent);
      }
      // Clear plan mode state and toggle
      state.resetPlanModeState();
      plugin.agentService.setCurrentPlanFilePath(null);
      this.deps.setPlanModeActive(false);
      // RESET SESSION for fresh context window
      plugin.agentService.resetSession();
      // Store approved plan content AFTER reset (resetSession clears it)
      plugin.agentService.setApprovedPlanContent(planContent);
      // Ignore any further usage updates from the old stream
      state.ignoreUsageUpdates = true;
      // Clear usage and reset the context meter (fresh session)
      state.usage = null;
      this.deps.resetContextMeter();
      // Save conversation to clear pending and set approved (sessionId will be null)
      await conversationController.save();
      // Auto-send implementation prompt (hidden from UI)
      const inputEl = this.deps.getInputEl();
      inputEl.value = 'Please implement the approved plan.';
      setTimeout(() => this.sendMessage({ hidden: true }), 100);
      return { decision: 'approve_new_session' };
    } else if (result.decision === 'revise') {
      // Add approval indicator with feedback
      this.addApprovalIndicator('revise', result.feedback);
      // Save conversation to clear pending (new plan will be generated)
      await conversationController.save();
      // Clear plan file path to avoid reusing stale content on revise
      plugin.agentService.setCurrentPlanFilePath(null);
      // Send feedback as a follow-up message
      const feedback = result.feedback;
      // Queue the feedback as a user message for the next turn
      const inputEl = this.deps.getInputEl();
      inputEl.value = `Please revise the plan based on this feedback:\n\n${feedback}`;
      return { decision: 'revise', feedback };
    } else {
      // Cancel (Esc) - treat as normal interrupt, no indicator
      state.resetPlanModeState();
      plugin.agentService.setCurrentPlanFilePath(null);
      this.deps.setPlanModeActive(false);
      // Save conversation to clear pending
      await conversationController.save();
      return { decision: 'cancel' };
    }
  }

  /** Hides the plan banner. */
  hidePlanBanner(): void {
    const planBanner = this.deps.getPlanBanner();
    if (planBanner) {
      planBanner.hide();
    }
  }

  /** Adds an approval indicator message to the chat. */
  private addApprovalIndicator(
    type: 'approve' | 'approve_new_session' | 'revise',
    feedback?: string
  ): void {
    const { state, renderer } = this.deps;

    const indicatorMsg: ChatMessage = {
      id: `indicator-${Date.now()}`,
      role: 'user',
      content: '', // Empty content, rendered via approvalIndicator
      timestamp: Date.now(),
      approvalIndicator: {
        type,
        feedback,
      },
    };

    state.addMessage(indicatorMsg);
    renderer.addMessage(indicatorMsg);
    renderer.scrollToBottom();
  }
}
