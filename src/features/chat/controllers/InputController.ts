import { Notice } from 'obsidian';

import type { ApprovalCallbackOptions, ClaudianService } from '../../../core/agent';
import { detectBuiltInCommand } from '../../../core/commands';
import type { ChatMessage } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { type ApprovalDecision, ApprovalModal } from '../../../shared/modals/ApprovalModal';
import { InstructionModal } from '../../../shared/modals/InstructionConfirmModal';
import { appendCurrentNote } from '../../../utils/context';
import { formatDurationMmSs } from '../../../utils/date';
import { appendEditorContext, type EditorSelectionContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import { COMPLETION_FLAVOR_WORDS } from '../constants';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { InstructionRefineService } from '../services/InstructionRefineService';
import type { SubagentManager } from '../services/SubagentManager';
import type { TitleGenerationService } from '../services/TitleGenerationService';
import type { ChatState } from '../state/ChatState';
import type { QueryOptions } from '../state/types';
import type { AddExternalContextResult, FileContextManager, ImageContextManager, InstructionModeManager, McpServerSelector, StatusPanel } from '../ui';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import type { StreamController } from './StreamController';

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
  getMcpServerSelector: () => McpServerSelector | null;
  getExternalContextSelector: () => {
    getExternalContexts: () => string[];
    addExternalContext: (path: string) => AddExternalContextResult;
  } | null;
  getInstructionModeManager: () => InstructionModeManager | null;
  getInstructionRefineService: () => InstructionRefineService | null;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  generateId: () => string;
  resetInputHeight: () => void;
  getAgentService?: () => ClaudianService | null;
  getSubagentManager: () => SubagentManager;
  /** Returns true if ready. */
  ensureServiceInitialized?: () => Promise<boolean>;
}

export class InputController {
  private deps: InputControllerDeps;
  private pendingApprovalModal: ApprovalModal | null = null;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  private getAgentService(): ClaudianService | null {
    return this.deps.getAgentService?.() ?? null;
  }

  // ============================================
  // Message Sending
  // ============================================

  async sendMessage(options?: {
    editorContextOverride?: EditorSelectionContext | null;
    content?: string;
  }): Promise<void> {
    const { plugin, state, renderer, streamController, selectionController, conversationController } = this.deps;

    // During conversation creation/switching, don't send - input is preserved so user can retry
    if (state.isCreatingConversation || state.isSwitchingConversation) return;

    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const externalContextSelector = this.deps.getExternalContextSelector();

    const contentOverride = options?.content;
    const shouldUseInput = contentOverride === undefined;
    const content = (contentOverride ?? inputEl.value).trim();
    const hasImages = imageContextManager?.hasImages() ?? false;
    if (!content && !hasImages) return;

    // Clear completed/error/orphaned subagents from previous responses
    this.deps.getStatusPanel()?.clearTerminalSubagents();

    // Check for built-in commands first (e.g., /clear, /new, /add-dir)
    const builtInCmd = detectBuiltInCommand(content);
    if (builtInCmd) {
      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      await this.executeBuiltInCommand(builtInCmd.command.action, builtInCmd.args);
      return;
    }

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
        state.queuedMessage = {
          content,
          images,
          editorContext,
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
    this.deps.getSubagentManager().resetSpawnedCount();
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true; // Reset auto-scroll based on setting
    const streamGeneration = state.bumpStreamGeneration();

    // Hide welcome message when sending first message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.style.display = 'none';
    }

    fileContextManager?.startSession();

    // Slash commands are passed directly to SDK for handling
    // SDK handles expansion, $ARGUMENTS, @file references, and frontmatter options
    const displayContent = content;
    let queryOptions: QueryOptions | undefined;

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

    const externalContextPaths = externalContextSelector?.getExternalContexts();
    const isCompact = /^\/compact(\s|$)/i.test(content);

    // User content first, context XML appended after (enables slash command detection)
    let promptToSend = content;
    let currentNoteForMessage: string | undefined;

    // SDK built-in commands (e.g., /compact) must be sent bare — context XML breaks detection
    if (!isCompact) {
      // Append current note context if available
      if (shouldSendCurrentNote && currentNotePath) {
        promptToSend = appendCurrentNote(promptToSend, currentNotePath);
        currentNoteForMessage = currentNotePath;
      }

      // Append editor context if available
      if (editorContext) {
        promptToSend = appendEditorContext(promptToSend, editorContext);
      }

      // Transform context file mentions (e.g., @folder/file.ts) to absolute paths
      if (fileContextManager) {
        promptToSend = fileContextManager.transformContextMentions(promptToSend);
      }
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
    const msgEl = renderer.addMessage(assistantMsg);
    const contentEl = msgEl.querySelector('.claudian-message-content') as HTMLElement;

    state.toolCallElements.clear();
    state.currentContentEl = contentEl;
    state.currentTextEl = null;
    state.currentTextContent = '';

    streamController.showThinkingIndicator(
      isCompact ? 'Compacting...' : undefined,
      isCompact ? 'claudian-thinking--compact' : undefined,
    );
    state.responseStartTime = performance.now();

    // Extract @-mentioned MCP servers from prompt
    const mcpMentions = plugin.mcpManager.extractMentions(promptToSend);

    // Transform @mcpname to @mcpname MCP in API request only
    promptToSend = plugin.mcpManager.transformMentions(promptToSend);

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
      // ALWAYS clear the timer interval, even on stream invalidation (prevents memory leaks)
      state.clearFlavorTimerInterval();

      // Skip remaining cleanup if stream was invalidated (tab closed or conversation switched)
      if (!wasInvalidated && state.streamGeneration === streamGeneration) {
        if (wasInterrupted) {
          await streamController.appendText('\n\n<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>');
        }
        streamController.hideThinkingIndicator();
        state.isStreaming = false;
        state.cancelRequested = false;

        // Capture response duration before resetting state (skip for interrupted responses and compaction)
        const hasCompactBoundary = assistantMsg.contentBlocks?.some(b => b.type === 'compact_boundary');
        if (!wasInterrupted && !hasCompactBoundary) {
          const durationSeconds = state.responseStartTime
            ? Math.floor((performance.now() - state.responseStartTime) / 1000)
            : 0;
          if (durationSeconds > 0) {
            const flavorWord =
              COMPLETION_FLAVOR_WORDS[Math.floor(Math.random() * COMPLETION_FLAVOR_WORDS.length)];
            assistantMsg.durationSeconds = durationSeconds;
            assistantMsg.durationFlavorWord = flavorWord;
            // Add footer to live message in DOM
            if (contentEl) {
              const footerEl = contentEl.createDiv({ cls: 'claudian-response-footer' });
              footerEl.createSpan({
                text: `* ${flavorWord} for ${formatDurationMmSs(durationSeconds)}`,
                cls: 'claudian-baked-duration',
              });
            }
          }
        }

        state.currentContentEl = null;

        streamController.finalizeCurrentThinkingBlock(assistantMsg);
        streamController.finalizeCurrentTextBlock(assistantMsg);
        this.deps.getSubagentManager().resetStreamingState();

        // Auto-hide completed status panels on response end
        // Panels reappear only when new TodoWrite/Task tool is called
        if (state.currentTodos && state.currentTodos.every(t => t.status === 'completed')) {
          state.currentTodos = null;
        }
        const statusPanel = this.deps.getStatusPanel();
        if (statusPanel?.areAllSubagentsCompleted()) {
          statusPanel.clearTerminalSubagents();
        }

        await conversationController.save(true);

        this.processQueuedMessage();
      }
    }
  }

  // ============================================
  // Queue Management
  // ============================================

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

  clearQueuedMessage(): void {
    const { state } = this.deps;
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

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
      const conversation = await plugin.createConversation(sessionId);
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
    this.restoreQueuedMessageToInput();
    this.getAgentService()?.cancel();
    streamController.hideThinkingIndicator();
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

  async handleApprovalRequest(
    toolName: string,
    input: Record<string, unknown>,
    description: string,
    options?: ApprovalCallbackOptions,
  ): Promise<ApprovalDecision> {
    const { plugin } = this.deps;
    return new Promise((resolve) => {
      const modal = new ApprovalModal(plugin.app, toolName, input, description, (decision) => {
        this.pendingApprovalModal = null;
        resolve(decision);
      }, options);
      this.pendingApprovalModal = modal;
      modal.open();
    });
  }

  dismissPendingApproval(): void {
    if (this.pendingApprovalModal) {
      this.pendingApprovalModal.close();
      this.pendingApprovalModal = null;
    }
  }

  // ============================================
  // Built-in Commands
  // ============================================

  private async executeBuiltInCommand(action: string, args: string): Promise<void> {
    const { conversationController } = this.deps;

    switch (action) {
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
      default:
        // Unknown command - notify user
        new Notice(`Unknown command: ${action}`);
    }
  }
}
