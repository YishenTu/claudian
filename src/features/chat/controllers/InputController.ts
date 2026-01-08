/**
 * Input controller for handling user input and message sending.
 *
 * Manages message sending, queue handling, slash command expansion,
 * instruction mode, and approval dialogs.
 */

import type { Component } from 'obsidian';
import { Notice } from 'obsidian';

import type { ExitPlanModeDecision } from '../../../core/agent/ClaudianService';
import { detectBuiltInCommand, type SlashCommandManager } from '../../../core/commands';
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
} from '../../../ui';
import { prependCurrentNote } from '../../../utils/context';
import { type EditorSelectionContext, prependEditorContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import { formatSlashCommandWarnings } from '../../../utils/slashCommand';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { InstructionRefineService } from '../services/InstructionRefineService';
import type { TitleGenerationService } from '../services/TitleGenerationService';
import type { ChatState } from '../state/ChatState';
import type { QueryOptions } from '../state/types';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import type { StreamController } from './StreamController';

const PLAN_MODE_REQUEST_PREFIX =
  'User requested plan mode. Call EnterPlanMode before responding.';
const PLAN_MODE_CONTINUE_PROMPT =
  'Continue in plan mode. Create a detailed, step-by-step implementation plan for the user\'s last request. Use read-only tools only. Call ExitPlanMode when the plan is ready.';

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
  currentNote?: string;
  editorContext?: EditorSelectionContext | null;
  queryOptions?: QueryOptions;
}

interface PlanModeSendOptions extends PlanModeResendPayload {
  skipUserMessage?: boolean;
  hidden?: boolean;
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
  async sendMessage(options?: {
    editorContextOverride?: EditorSelectionContext | null;
    hidden?: boolean;
    content?: string;
    promptPrefix?: string;
  }): Promise<void> {
    const { plugin, state, renderer, streamController, selectionController, conversationController } = this.deps;
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
        // Preserve hidden flag (once hidden, always hidden)
        state.queuedMessage.hidden = state.queuedMessage.hidden || options?.hidden;
        if (promptPrefix) {
          state.queuedMessage.promptPrefix = state.queuedMessage.promptPrefix ?? promptPrefix;
        }
      } else {
        state.queuedMessage = {
          content,
          images,
          editorContext,
          hidden: options?.hidden,
          promptPrefix,
        };
      }

      if (shouldUseInput) {
        inputEl.value = '';
      }
      imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

    if (shouldUseInput) {
      inputEl.value = '';
    }
    state.isStreaming = true;
    state.cancelRequested = false;
    state.ignoreUsageUpdates = false; // Allow usage updates for new query
    state.subagentsSpawnedThisStream = 0; // Reset subagent counter for new query

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
      content,
      displayContent: displayContent !== content ? displayContent : undefined,
      timestamp: Date.now(),
      currentNote: currentNoteForMessage,
      images: imagesForMessage,
      hidden: options?.hidden,
    };
    state.addMessage(userMsg);
    if (!options?.hidden) {
      renderer.addMessage(userMsg);
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

      await this.activatePendingPlanMode();

      // Generate AI title after first complete exchange (user + assistant)
      await this.triggerTitleGeneration();

      this.processQueuedMessage();
    }
  }

  // ============================================
  // Plan Mode
  // ============================================

  setPlanModeRequested(active: boolean): void {
    const { state } = this.deps;
    if (state.planModeRequested === active) {
      return;
    }
    state.planModeRequested = active;
    this.deps.setPlanModeActive(active);
  }

  private ensurePlanModeState(agentInitiated: boolean): void {
    const { state, plugin } = this.deps;
    if (plugin.settings.permissionMode !== 'plan') {
      return;
    }
    if (state.planModeState?.isActive) {
      if (!state.planModeState.agentInitiated && agentInitiated) {
        state.planModeState.agentInitiated = true;
      }
      return;
    }
    state.planModeState = {
      isActive: true,
      planFilePath: null,
      planContent: null,
      originalQuery: null,
      agentInitiated,
    };
  }

  private async activatePendingPlanMode(): Promise<void> {
    const { plugin, state } = this.deps;
    if (!state.planModeActivationPending) {
      return;
    }

    state.planModeActivationPending = false;

    if (plugin.settings.permissionMode !== 'plan') {
      plugin.settings.lastNonPlanPermissionMode = plugin.settings.permissionMode;
      plugin.settings.permissionMode = 'plan';
      await plugin.saveSettings();
    }

    state.planModeRequested = false;
    this.ensurePlanModeState(true);
    plugin.agentService.setCurrentPlanFilePath(null);
    this.deps.setPlanModeActive(true);

    await this.sendMessageWithPlanMode({ content: PLAN_MODE_CONTINUE_PROMPT, hidden: true });
  }

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

  private async exitPlanPermissionMode(): Promise<void> {
    const { plugin, state } = this.deps;
    const restored = plugin.settings.lastNonPlanPermissionMode ?? 'yolo';
    if (plugin.settings.permissionMode === 'plan') {
      plugin.settings.permissionMode = restored;
      plugin.settings.lastNonPlanPermissionMode = restored;
      await plugin.saveSettings();
    }
    state.resetPlanModeState();
    state.planModeRequested = false;
    state.planModeActivationPending = false;
    this.deps.setPlanModeActive(false);
  }

  /** Sends a message in plan mode (read-only exploration). */
  async sendPlanModeMessage(): Promise<void> {
    const { state, plugin } = this.deps;
    const inputEl = this.deps.getInputEl();

    const content = inputEl.value.trim();
    if (!content) return;

    // Cannot enter plan mode while streaming
    if (state.isStreaming) {
      new Notice('Cannot request plan mode while agent is working');
      return;
    }

    if (plugin.settings.permissionMode === 'plan') {
      // Clear any stale plan file path before starting a new plan mode session
      plugin.agentService.setCurrentPlanFilePath(null);
      // Preserve existing agentInitiated value, default to false (user-initiated) if unknown
      const wasAgentInitiated = state.planModeState?.agentInitiated ?? false;
      this.ensurePlanModeState(wasAgentInitiated);

      // Set plan mode state (agent determines plan file path)
      state.planModeState = {
        isActive: true,
        planFilePath: null,
        planContent: null,
        originalQuery: content,
        agentInitiated: wasAgentInitiated,
      };

      // Clear input and send
      inputEl.value = '';
      await this.sendMessageWithPlanMode({ content });
      return;
    }

    await this.sendMessage({ promptPrefix: PLAN_MODE_REQUEST_PREFIX });
  }

  /**
   * Handles agent-initiated EnterPlanMode tool call.
   * Sets up state for re-sending with plan mode after current stream ends.
   */
  async handleEnterPlanMode(): Promise<void> {
    const { state, plugin } = this.deps;

    if (plugin.settings.permissionMode === 'plan') {
      this.ensurePlanModeState(true);
      return;
    }

    state.planModeActivationPending = true;
  }

  /** Internal: sends message with plan mode options. */
  private async sendMessageWithPlanMode(options?: PlanModeSendOptions): Promise<void> {
    const { plugin, state, renderer, streamController, selectionController, conversationController } = this.deps;
    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const externalContextSelector = this.deps.getExternalContextSelector();
    if (plugin.settings.permissionMode !== 'plan') {
      await this.sendMessage({ promptPrefix: PLAN_MODE_REQUEST_PREFIX });
      return;
    }
    // Preserve existing agentInitiated value, default to false (user-initiated) if unknown
    this.ensurePlanModeState(state.planModeState?.agentInitiated ?? false);

    const content = (options?.content ?? inputEl.value).trim();
    if (!content) return;

    const skipUserMessage = options?.skipUserMessage ?? false;
    if (options?.content === undefined) {
      inputEl.value = '';
    }
    state.isStreaming = true;
    state.cancelRequested = false;
    state.ignoreUsageUpdates = false; // Allow usage updates for new query
    state.subagentsSpawnedThisStream = 0; // Reset subagent counter for new query

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

    let currentNote: string | null = null;
    let shouldSendCurrentNote = false;
    let currentNoteForMessage: string | undefined;
    if (skipUserMessage || options?.currentNote) {
      currentNote = options?.currentNote || null;
    } else {
      currentNote = fileContextManager?.getCurrentNotePath() || null;
    }
    shouldSendCurrentNote = fileContextManager?.shouldSendCurrentNote(currentNote) ?? false;
    if (shouldSendCurrentNote && currentNote) {
      currentNoteForMessage = currentNote;
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

    if (shouldSendCurrentNote && currentNote) {
      promptToSend = prependCurrentNote(promptToSend, currentNote);
      currentNoteForMessage = currentNote;
    }

    const externalContextPaths = externalContextSelector?.getExternalContexts();
    promptToSend = this.prependExternalContexts(promptToSend, externalContextPaths);

    fileContextManager?.markCurrentNoteSent();

    if (!skipUserMessage) {
      const displayContent = options?.displayContent ?? content;
      const userMsg: ChatMessage = {
        id: this.deps.generateId(),
        role: 'user',
        content,
        displayContent: displayContent !== content ? displayContent : undefined,
        timestamp: Date.now(),
        currentNote: currentNoteForMessage,
        images: imagesForMessage,
        hidden: options?.hidden,
      };
      state.addMessage(userMsg);
      if (!options?.hidden) {
        renderer.addMessage(userMsg);
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

    // Transform @mcpname to @mcpname MCP in API request only
    promptToSend = plugin.mcpService.transformMentions(promptToSend);

    const enabledMcpServers = mcpServerSelector?.getEnabledServers();

    const queryOptions = {
      ...options?.queryOptions,
      planMode: true,
      mcpMentions,
      enabledMcpServers,
    };
    if (externalContextPaths && externalContextPaths.length > 0) {
      queryOptions.externalContextPaths = externalContextPaths;
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
        await streamController.appendText('\n\n<span class="claudian-interrupted">Plan mode interrupted</span>');
        plugin.agentService.setCurrentPlanFilePath(null);
      }
      streamController.hideThinkingIndicator();
      state.isStreaming = false;
      state.cancelRequested = false;
      state.currentContentEl = null;

      streamController.finalizeCurrentThinkingBlock(assistantMsg);
      streamController.finalizeCurrentTextBlock(assistantMsg);
      state.activeSubagents.clear();

      await conversationController.save(true);
      await this.activatePendingPlanMode();

      // Generate AI title after first complete plan mode exchange
      await this.triggerTitleGeneration({ isPlanMode: true });

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

    const { content, images, editorContext, hidden, promptPrefix } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const isPlanMode = this.deps.plugin.settings.permissionMode === 'plan';
    if (isPlanMode) {
      setTimeout(
        () => this.sendMessageWithPlanMode({ content, images, editorContext, hidden }),
        0
      );
      return;
    }

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }

    setTimeout(() => this.sendMessage({ editorContextOverride: editorContext, hidden, promptPrefix }), 0);
  }

  // ============================================
  // Title Generation
  // ============================================

  /**
   * Triggers AI title generation after first exchange.
   * Handles setting fallback title, firing async generation, and updating UI.
   */
  private async triggerTitleGeneration(options: { isPlanMode?: boolean } = {}): Promise<void> {
    const { plugin, state, conversationController } = this.deps;
    const { isPlanMode = false } = options;

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
    const displayTitle = isPlanMode ? `[Plan] ${fallbackTitle}` : fallbackTitle;
    await plugin.renameConversation(state.currentConversationId, displayTitle);

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
    const expectedTitle = displayTitle; // Store to check if user renamed during generation

    titleService.generateTitle(
      convId,
      userContent,
      assistantText,
      async (conversationId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = plugin.getConversationById(conversationId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches fallback)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && !userManuallyRenamed) {
          const newTitle = isPlanMode ? `[Plan] ${result.title}` : result.title;
          await plugin.renameConversation(conversationId, newTitle);
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
    ).catch((error) => {
      // Log unexpected errors (callback errors are already handled by safeCallback)
      console.error('[InputController] Title generation failed:', error instanceof Error ? error.message : error);
    });
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
    const { state, renderer, conversationController, streamController } = this.deps;

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

    // Hide the thinking indicator from the original (empty) assistant message
    // before adding the plan message. This prevents it from appearing above
    // the plan when revision is selected.
    streamController.hideThinkingIndicator();

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
        // Update currentContentEl to point to the plan message's content.
        // This ensures that if revision is selected and the stream continues,
        // new content (including thinking indicator) will appear below the plan.
        state.currentContentEl = contentEl;
        state.currentTextEl = null;
        state.currentTextContent = '';
        state.currentThinkingState = null;
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
      // Exit plan mode and restore permission settings
      await this.exitPlanPermissionMode();
      plugin.agentService.setCurrentPlanFilePath(null);
      // Save conversation to clear pending and set approved
      await conversationController.save();
      // Auto-send implementation prompt (hidden from UI)
      setTimeout(
        () => this.sendMessage({ hidden: true, content: 'Please implement the approved plan.' }),
        100
      );
      return { decision: 'approve' };
    } else if (result.decision === 'approve_new_session') {
      // Add approval indicator
      this.addApprovalIndicator('approve_new_session');
      // Show the plan banner
      const planBanner = this.deps.getPlanBanner();
      if (planBanner) {
        void planBanner.show(planContent);
      }
      // Exit plan mode and restore permission settings
      await this.exitPlanPermissionMode();
      plugin.agentService.setCurrentPlanFilePath(null);
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
      setTimeout(
        () => this.sendMessage({ hidden: true, content: 'Please implement the approved plan.' }),
        100
      );
      return { decision: 'approve_new_session' };
    } else if (result.decision === 'revise') {
      // Add approval indicator with feedback
      this.addApprovalIndicator('revise', result.feedback);
      // Save conversation to clear pending (new plan will be generated)
      await conversationController.save();
      // Clear plan file path to avoid reusing stale content on revise
      plugin.agentService.setCurrentPlanFilePath(null);
      // Auto-send feedback as hidden plan mode message (indicator already shows it)
      setTimeout(
        () => this.sendMessageWithPlanMode({ content: result.feedback, hidden: true, images: [] }),
        100
      );
      return { decision: 'revise', feedback: result.feedback };
    } else {
      // Cancel (Esc) - plan mode stays active, user can continue chatting or revise
      // Only clear the plan file path so a new plan can be generated
      plugin.agentService.setCurrentPlanFilePath(null);
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
        console.warn(`[InputController] Unknown built-in command action: ${action}`);
    }
  }
}
