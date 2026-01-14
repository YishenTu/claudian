/**
 * Input controller for handling user input and message sending.
 *
 * Manages message sending, queue handling, slash command expansion,
 * instruction mode, and approval dialogs.
 */

import { Notice } from 'obsidian';

import type { ClaudianService } from '../../../core/agent';
import { detectBuiltInCommand, type SlashCommandManager } from '../../../core/commands';
import { isCommandBlocked } from '../../../core/security/BlocklistChecker';
import { TOOL_BASH } from '../../../core/tools/toolNames';
import type { ChatMessage } from '../../../core/types';
import { getBashToolBlockedCommands } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { ApprovalModal } from '../../../shared/modals/ApprovalModal';
import { InstructionModal } from '../../../shared/modals/InstructionConfirmModal';
import { prependCurrentNote } from '../../../utils/context';
import { type EditorSelectionContext, prependEditorContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import { formatSlashCommandWarnings } from '../../../utils/slashCommand';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { InstructionRefineService } from '../services/InstructionRefineService';
import type { TitleGenerationService } from '../services/TitleGenerationService';
import type { ChatState } from '../state/ChatState';
import type { QueryOptions } from '../state/types';
import type { FileContextManager, ImageContextManager, InstructionModeManager, McpServerSelector } from '../ui';
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
  getExternalContextSelector: () => { getExternalContexts: () => string[] } | null;
  getInstructionModeManager: () => InstructionModeManager | null;
  getInstructionRefineService: () => InstructionRefineService | null;
  getTitleGenerationService: () => TitleGenerationService | null;
  generateId: () => string;
  resetContextMeter: () => void;
  resetInputHeight: () => void;
  /** Get the agent service from the tab. */
  getAgentService?: () => ClaudianService | null;
  /** Ensures the agent service is initialized (lazy loading). Returns true if ready. */
  ensureServiceInitialized?: () => Promise<boolean>;
}

/**
 * InputController handles user input and message sending.
 */
export class InputController {
  private deps: InputControllerDeps;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  /** Gets the agent service from the tab. */
  private getAgentService(): ClaudianService | null {
    return this.deps.getAgentService?.() ?? null;
  }

  // ============================================
  // Message Sending
  // ============================================

  /** Sends a message with optional editor context override. */
  async sendMessage(options?: {
    editorContextOverride?: EditorSelectionContext | null;
    content?: string;
    promptPrefix?: string;
  }): Promise<void> {
    const { plugin, state, renderer, streamController, selectionController, conversationController } = this.deps;

    // During conversation creation/switching, don't send - input is preserved so user can retry
    if (state.isCreatingConversation || state.isSwitchingConversation) return;

    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();
    const slashCommandManager = this.deps.getSlashCommandManager();
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const externalContextSelector = this.deps.getExternalContextSelector();

    const contentOverride = options?.content;
    const shouldUseInput = contentOverride === undefined;
    let content = (contentOverride ?? inputEl.value).trim();
    const hasImages = imageContextManager?.hasImages() ?? false;
    if (!content && !hasImages) return;

    // Check for built-in commands first (e.g., /clear, /new)
    const builtInCmd = detectBuiltInCommand(content);
    if (builtInCmd) {
      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      await this.executeBuiltInCommand(builtInCmd.action);
      return;
    }

    // If agent is working, queue the message instead of dropping it
    if (state.isStreaming) {
      const images = hasImages ? [...(imageContextManager?.getAttachedImages() || [])] : undefined;
      const editorContext = selectionController.getContext();
      const promptPrefix = options?.promptPrefix;

      // Append to existing queued message if any
      if (state.queuedMessage) {
        state.queuedMessage.content += '\n\n' + content;
        if (images && images.length > 0) {
          state.queuedMessage.images = [...(state.queuedMessage.images || []), ...images];
        }
        state.queuedMessage.editorContext = editorContext;
        if (promptPrefix) {
          state.queuedMessage.promptPrefix = state.queuedMessage.promptPrefix ?? promptPrefix;
        }
      } else {
        state.queuedMessage = {
          content,
          images,
          editorContext,
          promptPrefix,
        };
      }

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
    state.subagentsSpawnedThisStream = 0; // Reset subagent counter for new query
    const streamGeneration = state.bumpStreamGeneration();

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
                plugin.settings.permissionMode !== 'yolo'
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

    const images = imageContextManager?.getAttachedImages() || [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;

    // Only clear images if we consumed user input (not for programmatic content override)
    if (shouldUseInput) {
      imageContextManager?.clearImages();
    }

    const currentNotePath = fileContextManager?.getCurrentNotePath() || null;
    const shouldSendCurrentNote = fileContextManager?.shouldSendCurrentNote(currentNotePath) ?? false;

    const editorContextOverride = options?.editorContextOverride;
    const editorContext = editorContextOverride !== undefined
      ? editorContextOverride
      : selectionController.getContext();

    // Wrap query in XML tag
    let promptToSend = `<query>\n${content}\n</query>`;
    let currentNoteForMessage: string | undefined;

    // Prepend editor context if available
    if (editorContext) {
      promptToSend = prependEditorContext(promptToSend, editorContext);
    }

    if (shouldSendCurrentNote && currentNotePath) {
      promptToSend = prependCurrentNote(promptToSend, currentNotePath);
      currentNoteForMessage = currentNotePath;
    }

    const externalContextPaths = externalContextSelector?.getExternalContexts();
    promptToSend = this.prependExternalContexts(promptToSend, externalContextPaths);

    if (options?.promptPrefix) {
      promptToSend = `${options.promptPrefix}\n\n${promptToSend}`;
    }

    // Transform context file mentions (e.g., @folder/file.ts) to absolute paths
    if (fileContextManager) {
      promptToSend = fileContextManager.transformContextMentions(promptToSend);
    }

    fileContextManager?.markCurrentNoteSent();

    const userMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'user',
      content: promptToSend,         // Full prompt with XML context (for history rebuild)
      displayContent,                // Original user input (for UI display)
      timestamp: Date.now(),
      currentNote: currentNoteForMessage,
      images: imagesForMessage,
    };
    state.addMessage(userMsg);
    renderer.addMessage(userMsg);

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

    // Transform @mcpname to @mcpname MCP in API request only
    promptToSend = plugin.mcpService.transformMentions(promptToSend);

    // Add MCP options to query
    const enabledMcpServers = mcpServerSelector?.getEnabledServers();
    if (mcpMentions.size > 0 || (enabledMcpServers && enabledMcpServers.size > 0)) {
      queryOptions = {
        ...queryOptions,
        mcpMentions,
        enabledMcpServers,
      };
    }

    // Add external context paths to query
    if (externalContextPaths && externalContextPaths.length > 0) {
      queryOptions = {
        ...queryOptions,
        externalContextPaths,
      };
    }

    let wasInterrupted = false;
    let wasInvalidated = false;

    // Lazy initialization: ensure service is ready before first query
    if (this.deps.ensureServiceInitialized) {
      const ready = await this.deps.ensureServiceInitialized();
      if (!ready) {
        new Notice('Failed to initialize agent service. Please try again.');
        streamController.hideThinkingIndicator();
        state.isStreaming = false;
        return;
      }
    }

    const agentService = this.getAgentService();
    if (!agentService) {
      new Notice('Agent service not available. Please reload the plugin.');
      return;
    }
    try {
      // Pass history WITHOUT current turn (userMsg + assistantMsg we just added)
      // This prevents duplication when rebuilding context for new sessions
      const previousMessages = state.messages.slice(0, -2);
      for await (const chunk of agentService.query(promptToSend, imagesForMessage, previousMessages, queryOptions)) {
        if (state.streamGeneration !== streamGeneration) {
          wasInvalidated = true;
          break;
        }
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
      // Skip cleanup if stream was invalidated (tab closed or conversation switched)
      if (!wasInvalidated && state.streamGeneration === streamGeneration) {
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

        // Generate AI title after first complete exchange (user + assistant)
        await this.triggerTitleGeneration();

        this.processQueuedMessage();
      }
    }
  }

  // ============================================
  // External Context Helpers
  // ============================================

  private prependExternalContexts(prompt: string, externalContextPaths?: string[] | null): string {
    if (!externalContextPaths || externalContextPaths.length === 0) {
      return prompt;
    }

    const uniquePaths = Array.from(
      new Set(externalContextPaths.map((p) => p.trim()).filter(Boolean))
    );
    if (uniquePaths.length === 0) {
      return prompt;
    }

    const tag = `<external_contexts>\n${uniquePaths.join('\n')}\n</external_contexts>`;
    return `${tag}\n\n${prompt}`;
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

  /** Restores the queued message to the input field without sending. */
  private restoreQueuedMessageToInput(): void {
    const { state } = this.deps;
    if (!state.queuedMessage) return;

    const { content, images } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }
  }

  /** Processes the queued message. */
  private processQueuedMessage(): void {
    const { state } = this.deps;
    if (!state.queuedMessage) return;

    const { content, images, editorContext, promptPrefix } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }

    setTimeout(() => this.sendMessage({ editorContextOverride: editorContext, promptPrefix }), 0);
  }

  // ============================================
  // Title Generation
  // ============================================

  /**
   * Triggers AI title generation after first exchange.
   * Handles setting fallback title, firing async generation, and updating UI.
   */
  private async triggerTitleGeneration(): Promise<void> {
    const { plugin, state, conversationController } = this.deps;

    if (state.messages.length !== 2 || !state.currentConversationId) {
      return;
    }

    // Find first user and assistant messages by role (not by index)
    const firstUserMsg = state.messages.find(m => m.role === 'user');
    const firstAssistantMsg = state.messages.find(m => m.role === 'assistant');

    if (!firstUserMsg || !firstAssistantMsg) {
      return;
    }

    const userContent = firstUserMsg.displayContent || firstUserMsg.content;

    // Extract text from assistant response
    const assistantText = firstAssistantMsg.content ||
      firstAssistantMsg.contentBlocks
        ?.filter((b): b is { type: 'text'; content: string } => b.type === 'text')
        .map(b => b.content)
        .join('\n') || '';

    // Set immediate fallback title
    const fallbackTitle = conversationController.generateFallbackTitle(userContent);
    await plugin.renameConversation(state.currentConversationId, fallbackTitle);

    if (!plugin.settings.enableAutoTitleGeneration) {
      return;
    }

    // Fire async AI title generation only if service and content available
    const titleService = this.deps.getTitleGenerationService();
    if (!titleService || !assistantText) {
      // No titleService or no assistantText, just keep the fallback title with no status
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
      assistantText,
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

  /** Cancels the current streaming operation. */
  cancelStreaming(): void {
    const { state, streamController } = this.deps;
    if (!state.isStreaming) return;
    state.cancelRequested = true;
    // Restore queued message to input instead of discarding
    this.restoreQueuedMessageToInput();
    this.getAgentService()?.cancel();
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
  ): Promise<'allow' | 'allow-always' | 'deny' | 'deny-always' | 'cancel'> {
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
        { showAlwaysAllow: false, showAlwaysDeny: false, title: 'Inline bash execution' }
      );
      modal.open();
    });
  }

  // ============================================
  // Built-in Commands
  // ============================================

  /** Executes a built-in command action. */
  private async executeBuiltInCommand(action: string): Promise<void> {
    const { conversationController } = this.deps;

    switch (action) {
      case 'clear':
        await conversationController.createNew();
        break;
      default:
        // Unknown command - ignore
    }
  }
}
