/**
 * Input controller for handling user input and message sending.
 *
 * Manages message sending, queue handling, slash command expansion,
 * instruction mode, and approval dialogs.
 */

import { Notice } from 'obsidian';

import { isCommandBlocked } from '../../../core/security/BlocklistChecker';
import { TOOL_BASH } from '../../../core/tools/toolNames';
import type { AskUserQuestionInput, ChatMessage } from '../../../core/types';
import { getBashToolBlockedCommands } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import {
  ApprovalModal,
  AskUserQuestionModal,
  type FileContextManager,
  type ImageContextManager,
  InstructionModal,
  type InstructionModeManager,
  type McpServerSelector,
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
  generateId: () => string;
}

/**
 * InputController handles user input and message sending.
 */
export class InputController {
  private deps: InputControllerDeps;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  // ============================================
  // Message Sending
  // ============================================

  /** Sends a message with optional editor context override. */
  async sendMessage(options?: { editorContextOverride?: EditorSelectionContext | null }): Promise<void> {
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
      } else {
        state.queuedMessage = { content, images, editorContext };
      }

      inputEl.value = '';
      imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

    inputEl.value = '';
    state.isStreaming = true;
    state.cancelRequested = false;

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

    fileContextManager?.markFilesSent();

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

      this.processQueuedMessage();
    }
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

    const { content, images, editorContext } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }

    setTimeout(() => this.sendMessage({ editorContextOverride: editorContext }), 0);
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

  /** Handles AskUserQuestion tool calls by showing a modal. */
  async handleAskUserQuestion(input: AskUserQuestionInput): Promise<Record<string, string> | null> {
    const { plugin } = this.deps;
    return new Promise((resolve) => {
      const modal = new AskUserQuestionModal(plugin.app, input, resolve);
      modal.open();
    });
  }
}
