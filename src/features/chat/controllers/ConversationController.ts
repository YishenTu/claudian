/**
 * Conversation controller for chat session management.
 *
 * Handles conversation lifecycle (create, load, save, switch),
 * history dropdown UI, and greeting/welcome state.
 */

import { setIcon } from 'obsidian';

import type { ClaudianService } from '../../../core/agent';
import { extractLastTodosFromMessages } from '../../../core/tools';
import type { Conversation } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { cleanupThinkingBlock } from '../rendering';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { AsyncSubagentManager } from '../services/AsyncSubagentManager';
import type { TitleGenerationService } from '../services/TitleGenerationService';
import type { ChatState } from '../state/ChatState';
import type { ExternalContextSelector, FileContextManager, ImageContextManager, McpServerSelector, TodoPanel } from '../ui';

/** Callbacks for conversation events. */
export interface ConversationCallbacks {
  onNewConversation?: () => void;
  onConversationLoaded?: () => void;
  onConversationSwitched?: () => void;
}

/** Dependencies for ConversationController. */
export interface ConversationControllerDeps {
  plugin: ClaudianPlugin;
  state: ChatState;
  renderer: MessageRenderer;
  asyncSubagentManager: AsyncSubagentManager;
  getHistoryDropdown: () => HTMLElement | null;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  getInputEl: () => HTMLTextAreaElement;
  getFileContextManager: () => FileContextManager | null;
  getImageContextManager: () => ImageContextManager | null;
  getMcpServerSelector: () => McpServerSelector | null;
  getExternalContextSelector: () => ExternalContextSelector | null;
  clearQueuedMessage: () => void;
  /** Get title generation service. */
  getTitleGenerationService: () => TitleGenerationService | null;
  /** Get TodoPanel for remounting after messagesEl.empty(). */
  getTodoPanel: () => TodoPanel | null;
  /** Get the agent service (for multi-tab, returns tab's service). */
  getAgentService?: () => ClaudianService | null;
}

/**
 * ConversationController manages conversation lifecycle.
 */
export class ConversationController {
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
  }

  /** Gets the agent service from the tab. */
  private getAgentService(): ClaudianService | null {
    return this.deps.getAgentService?.() ?? null;
  }

  // ============================================
  // Conversation Lifecycle
  // ============================================

  /**
   * Resets to entry point state (New Chat).
   *
   * Entry point is a blank UI state - no conversation is created until the
   * first message is sent. This prevents empty conversations cluttering history.
   */
  async createNew(options: { force?: boolean } = {}): Promise<void> {
    const { plugin, state, asyncSubagentManager } = this.deps;
    const force = options.force === true;
    if (state.isStreaming && !force) return;
    if (state.isCreatingConversation) return;
    if (state.isSwitchingConversation) return;

    // Set flag to block message sending during reset
    state.isCreatingConversation = true;

    try {
      if (force && state.isStreaming) {
        state.cancelRequested = true;
        state.bumpStreamGeneration();
        this.getAgentService()?.cancel();
      }

      // Save current conversation if it has messages
      if (state.currentConversationId && state.messages.length > 0) {
        await this.save();
      }

      asyncSubagentManager.orphanAllActive();
      state.asyncSubagentStates.clear();

      // Clear streaming state and related DOM references
      cleanupThinkingBlock(state.currentThinkingState);
      state.currentContentEl = null;
      state.currentTextEl = null;
      state.currentTextContent = '';
      state.currentThinkingState = null;
      state.toolCallElements.clear();
      state.activeSubagents.clear();
      state.writeEditStates.clear();
      state.isStreaming = false;

      // Reset to entry point state - no conversation created yet
      state.currentConversationId = null;
      state.clearMessages();
      state.usage = null;
      state.currentTodos = null;

      // Reset agent service session (no session ID for entry point)
      this.getAgentService()?.setSessionId(null);

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.empty();

      // Recreate welcome element first (before TodoPanel for consistent ordering)
      const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
      welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
      this.deps.setWelcomeEl(welcomeEl);

      // Remount TodoPanel after welcome (messagesEl.empty() removes it from DOM)
      this.deps.getTodoPanel()?.remount();

      this.deps.getInputEl().value = '';

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForNewConversation();
      fileCtx?.autoAttachActiveFile();

      this.deps.getImageContextManager()?.clearImages();
      this.deps.getMcpServerSelector()?.clearEnabled();
      // Pass current settings to ensure we have the most up-to-date persistent paths
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
      this.deps.clearQueuedMessage();

      this.callbacks.onNewConversation?.();
    } finally {
      state.isCreatingConversation = false;
    }
  }

  /**
   * Loads the current tab conversation, or starts at entry point if none.
   *
   * Entry point (no conversation) shows welcome screen without
   * creating a conversation. Conversation is created lazily on first message.
   */
  async loadActive(): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    const conversationId = state.currentConversationId;
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;

    // No active conversation - start at entry point
    if (!conversation) {
      state.currentConversationId = null;
      state.clearMessages();
      state.usage = null;
      state.currentTodos = null;

      this.getAgentService()?.setSessionId(null);

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForNewConversation();
      fileCtx?.autoAttachActiveFile();

      // Initialize external contexts with persistent paths from settings
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );

      this.deps.getMcpServerSelector()?.clearEnabled();

      const welcomeEl = renderer.renderMessages(
        [],
        () => this.getGreeting()
      );
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      this.callbacks.onConversationLoaded?.();
      return;
    }

    // Load existing conversation
    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;

    this.getAgentService()?.setSessionId(conversation.sessionId ?? null);

    const hasMessages = state.messages.length > 0;
    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForLoadedConversation(hasMessages);

    if (conversation.currentNote) {
      fileCtx?.setCurrentNote(conversation.currentNote);
    } else if (!hasMessages) {
      fileCtx?.autoAttachActiveFile();
    }

    // Restore external context paths based on session state
    this.restoreExternalContextPaths(
      conversation.externalContextPaths,
      !hasMessages
    );

    // Restore enabled MCP servers (or clear for new conversation)
    const mcpServerSelector = this.deps.getMcpServerSelector();
    if (conversation.enabledMcpServers && conversation.enabledMcpServers.length > 0) {
      mcpServerSelector?.setEnabledServers(conversation.enabledMcpServers);
    } else {
      mcpServerSelector?.clearEnabled();
    }

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);
    this.updateWelcomeVisibility();

    // Restore todo panel from loaded conversation
    state.currentTodos = extractLastTodosFromMessages(state.messages);

    this.callbacks.onConversationLoaded?.();
  }

  /** Switches to a different conversation. */
  async switchTo(id: string): Promise<void> {
    const { plugin, state, renderer, asyncSubagentManager } = this.deps;

    if (id === state.currentConversationId) return;
    if (state.isStreaming) return;
    if (state.isSwitchingConversation) return;
    if (state.isCreatingConversation) return;

    state.isSwitchingConversation = true;

    try {
      await this.save();

      asyncSubagentManager.orphanAllActive();
      state.asyncSubagentStates.clear();

      const conversation = await plugin.switchConversation(id);
      if (!conversation) {
        return;
      }

      state.currentConversationId = conversation.id;
      state.messages = [...conversation.messages];
      state.usage = conversation.usage ?? null;

      // Update agent service session ID to match conversation (triggers pre-warm)
      this.getAgentService()?.setSessionId(conversation.sessionId ?? null);

      this.deps.getInputEl().value = '';
      this.deps.clearQueuedMessage();

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForLoadedConversation(state.messages.length > 0);

      if (conversation.currentNote) {
        fileCtx?.setCurrentNote(conversation.currentNote);
      }

      // Restore external context paths based on session state
      this.restoreExternalContextPaths(
        conversation.externalContextPaths,
        state.messages.length === 0
      );

      // Restore enabled MCP servers (or clear if none)
      const mcpServerSelector = this.deps.getMcpServerSelector();
      if (conversation.enabledMcpServers && conversation.enabledMcpServers.length > 0) {
        mcpServerSelector?.setEnabledServers(conversation.enabledMcpServers);
      } else {
        mcpServerSelector?.clearEnabled();
      }

      const welcomeEl = renderer.renderMessages(
        state.messages,
        () => this.getGreeting()
      );
      this.deps.setWelcomeEl(welcomeEl);

      // Restore todo panel from switched conversation
      state.currentTodos = extractLastTodosFromMessages(state.messages);

      this.deps.getHistoryDropdown()?.removeClass('visible');
      this.updateWelcomeVisibility();

      this.callbacks.onConversationSwitched?.();
    } finally {
      state.isSwitchingConversation = false;
    }
  }

  /**
   * Saves the current conversation.
   *
   * If we're at an entry point (no conversation yet) and have messages,
   * creates a new conversation first (lazy creation).
   *
   * For native sessions (new conversations with sessionId from SDK),
   * only metadata is saved - the SDK handles message persistence.
   */
  async save(updateLastResponse = false): Promise<void> {
    const { plugin, state } = this.deps;

    // Entry point with no messages - nothing to save
    if (!state.currentConversationId && state.messages.length === 0) {
      return;
    }

    const agentService = this.getAgentService();
    const sessionId = agentService?.getSessionId() ?? null;
    const sessionInvalidated = agentService?.consumeSessionInvalidation?.() ?? false;

    // Entry point with messages - create conversation lazily
    // New conversations always use SDK-native storage.
    if (!state.currentConversationId && state.messages.length > 0) {
      const conversation = await plugin.createConversation(sessionId ?? undefined);
      state.currentConversationId = conversation.id;
    }

    const fileCtx = this.deps.getFileContextManager();
    const currentNote = fileCtx?.getCurrentNotePath() || undefined;
    const externalContextSelector = this.deps.getExternalContextSelector();
    const externalContextPaths = externalContextSelector?.getExternalContexts() ?? [];
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const enabledMcpServers = mcpServerSelector ? Array.from(mcpServerSelector.getEnabledServers()) : [];

    // Check if this is a native session and promote legacy sessions after first SDK session capture
    const conversation = await plugin.getConversationById(state.currentConversationId!);
    const wasNative = conversation?.isNative ?? false;
    const shouldPromote = !wasNative && !!sessionId;
    const isNative = wasNative || shouldPromote;
    const legacyMessages = conversation?.messages ?? [];
    const legacyCutoffAt = shouldPromote
      ? legacyMessages[legacyMessages.length - 1]?.timestamp
      : conversation?.legacyCutoffAt;

    const updates: Partial<Conversation> = {
      // For native sessions, don't persist messages (SDK handles that)
      // For legacy sessions, persist messages as before
      messages: isNative ? state.messages : state.getPersistedMessages(),
      // Preserve existing sessionId when SDK hasn't captured a new one yet
      sessionId: sessionInvalidated ? null : (sessionId ?? conversation?.sessionId ?? null),
      sdkSessionId: isNative && sessionId ? sessionId : conversation?.sdkSessionId,
      isNative: isNative || undefined,
      legacyCutoffAt,
      sdkMessagesLoaded: isNative ? true : undefined,
      currentNote: currentNote,
      externalContextPaths: externalContextPaths.length > 0 ? externalContextPaths : undefined,
      usage: state.usage ?? undefined,
      enabledMcpServers: enabledMcpServers.length > 0 ? enabledMcpServers : undefined,
    };

    if (updateLastResponse) {
      updates.lastResponseAt = Date.now();
    }

    // At this point, currentConversationId is guaranteed to be set
    // (either existed before or was created lazily above)
    await plugin.updateConversation(state.currentConversationId!, updates);
  }

  /**
   * Restores external context paths based on session state.
   * New or empty sessions get current persistent paths from settings.
   * Sessions with messages restore exactly what was saved.
   */
  private restoreExternalContextPaths(
    savedPaths: string[] | undefined,
    isEmptySession: boolean
  ): void {
    const { plugin } = this.deps;
    const externalContextSelector = this.deps.getExternalContextSelector();
    if (!externalContextSelector) {
      return;
    }

    if (isEmptySession) {
      // Empty session: use current persistent paths from settings
      externalContextSelector.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
    } else {
      // Session with messages: restore exactly what was saved
      externalContextSelector.setExternalContexts(savedPaths || []);
    }
  }


  // ============================================
  // History Dropdown
  // ============================================

  /** Toggles the history dropdown visibility. */
  toggleHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    const isVisible = dropdown.hasClass('visible');
    if (isVisible) {
      dropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      dropdown.addClass('visible');
    }
  }

  /** Updates the history dropdown content. */
  updateHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    this.renderHistoryItems(dropdown, {
      onSelectConversation: (id) => this.switchTo(id),
      onRerender: () => this.updateHistoryDropdown(),
    });
  }

  /**
   * Renders history dropdown items to a container.
   * Shared implementation for updateHistoryDropdown() and renderHistoryDropdown().
   */
  private renderHistoryItems(
    container: HTMLElement,
    options: {
      onSelectConversation: (id: string) => Promise<void>;
      onRerender: () => void;
    }
  ): void {
    const { plugin, state } = this.deps;

    container.empty();

    const dropdownHeader = container.createDiv({ cls: 'claudian-history-header' });
    dropdownHeader.createSpan({ text: 'Conversations' });

    const list = container.createDiv({ cls: 'claudian-history-list' });
    const allConversations = plugin.getConversationList();

    if (allConversations.length === 0) {
      list.createDiv({ cls: 'claudian-history-empty', text: 'No conversations' });
      return;
    }

    // Sort by lastResponseAt (fallback to createdAt) descending
    const conversations = [...allConversations].sort((a, b) => {
      return (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt);
    });

    for (const conv of conversations) {
      const isCurrent = conv.id === state.currentConversationId;
      const item = list.createDiv({
        cls: `claudian-history-item${isCurrent ? ' active' : ''}`,
      });

      const iconEl = item.createDiv({ cls: 'claudian-history-item-icon' });
      setIcon(iconEl, isCurrent ? 'message-square-dot' : 'message-square');

      const content = item.createDiv({ cls: 'claudian-history-item-content' });
      const titleEl = content.createDiv({ cls: 'claudian-history-item-title', text: conv.title });
      titleEl.setAttribute('title', conv.title);
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: isCurrent ? 'Current session' : this.formatDate(conv.lastResponseAt ?? conv.createdAt),
      });

      if (!isCurrent) {
        content.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await options.onSelectConversation(conv.id);
          } catch {
            // Silently ignore selection errors
          }
        });
      }

      const actions = item.createDiv({ cls: 'claudian-history-item-actions' });

      // Show regenerate button if title generation failed, or loading indicator if pending
      if (conv.titleGenerationStatus === 'pending') {
        const loadingEl = actions.createEl('span', { cls: 'claudian-action-btn claudian-action-loading' });
        setIcon(loadingEl, 'loader-2');
        loadingEl.setAttribute('aria-label', 'Generating title...');
      } else if (conv.titleGenerationStatus === 'failed') {
        const regenerateBtn = actions.createEl('button', { cls: 'claudian-action-btn' });
        setIcon(regenerateBtn, 'refresh-cw');
        regenerateBtn.setAttribute('aria-label', 'Regenerate title');
        regenerateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await this.regenerateTitle(conv.id);
          } catch {
            // Silently ignore regeneration errors
          }
        });
      }

      const renameBtn = actions.createEl('button', { cls: 'claudian-action-btn' });
      setIcon(renameBtn, 'pencil');
      renameBtn.setAttribute('aria-label', 'Rename');
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showRenameInput(item, conv.id, conv.title);
      });

      const deleteBtn = actions.createEl('button', { cls: 'claudian-action-btn claudian-delete-btn' });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.setAttribute('aria-label', 'Delete');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (state.isStreaming) return;
        try {
          await plugin.deleteConversation(conv.id);
          options.onRerender();

          if (conv.id === state.currentConversationId) {
            await this.loadActive();
          }
        } catch {
          // Silently ignore deletion errors
        }
      });
    }
  }

  /** Shows inline rename input for a conversation. */
  private showRenameInput(item: HTMLElement, convId: string, currentTitle: string): void {
    const titleEl = item.querySelector('.claudian-history-item-title') as HTMLElement;
    if (!titleEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'claudian-rename-input';
    input.value = currentTitle;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      try {
        const newTitle = input.value.trim() || currentTitle;
        await this.deps.plugin.renameConversation(convId, newTitle);
        this.updateHistoryDropdown();
      } catch {
        // Silently ignore rename errors
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', async (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.isComposing) {
        input.blur();
      } else if (e.key === 'Escape' && !e.isComposing) {
        input.value = currentTitle;
        input.blur();
      }
    });
  }

  // ============================================
  // Welcome & Greeting
  // ============================================

  /** Generates a dynamic greeting based on time/day. */
  getGreeting(): string {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const name = this.deps.plugin.settings.userName?.trim();

    // Helper to optionally personalize a greeting (with fallback for no-name case)
    const personalize = (base: string, noNameFallback?: string): string =>
      name ? `${base}, ${name}` : (noNameFallback ?? base);

    // Day-specific greetings (some personalized, some universal)
    const dayGreetings: Record<number, string[]> = {
      0: [personalize('Happy Sunday'), 'Sunday session?', 'Welcome to the weekend'],
      1: [personalize('Happy Monday'), personalize('Back at it', 'Back at it!')],
      2: [personalize('Happy Tuesday')],
      3: [personalize('Happy Wednesday')],
      4: [personalize('Happy Thursday')],
      5: [personalize('Happy Friday'), personalize('That Friday feeling')],
      6: [personalize('Happy Saturday', 'Happy Saturday!'), personalize('Welcome to the weekend')],
    };

    // Time-specific greetings
    const getTimeGreetings = (): string[] => {
      if (hour >= 5 && hour < 12) {
        return [personalize('Good morning'), 'Coffee and Claudian time?'];
      } else if (hour >= 12 && hour < 18) {
        return [personalize('Good afternoon'), personalize('Hey there'), personalize("How's it going") + '?'];
      } else if (hour >= 18 && hour < 22) {
        return [personalize('Good evening'), personalize('Evening'), personalize('How was your day') + '?'];
      } else {
        return ['Hello, night owl', personalize('Evening')];
      }
    };

    // General greetings
    const generalGreetings = [
      personalize('Hey there'),
      name ? `Hi ${name}, how are you?` : 'Hi, how are you?',
      personalize("How's it going") + '?',
      personalize('Welcome back') + '!',
      personalize("What's new") + '?',
      ...(name ? [`${name} returns!`] : []),
    ];

    // Combine day + time + general greetings, pick randomly
    const allGreetings = [
      ...(dayGreetings[day] || []),
      ...getTimeGreetings(),
      ...generalGreetings,
    ];

    return allGreetings[Math.floor(Math.random() * allGreetings.length)];
  }

  /** Updates welcome element visibility based on message count. */
  updateWelcomeVisibility(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    if (this.deps.state.messages.length === 0) {
      welcomeEl.style.display = '';
    } else {
      welcomeEl.style.display = 'none';
    }
  }

  /**
   * Initializes the welcome greeting for a new tab without a conversation.
   * Called when a new tab is activated and has no conversation loaded.
   */
  initializeWelcome(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    // Initialize file context to auto-attach the currently focused note
    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForNewConversation();
    fileCtx?.autoAttachActiveFile();

    // Only add greeting if not already present
    if (!welcomeEl.querySelector('.claudian-welcome-greeting')) {
      welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
    }

    this.updateWelcomeVisibility();
  }

  // ============================================
  // Utilities
  // ============================================

  /** Generates a fallback title from the first message (used when AI fails). */
  generateFallbackTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
  }

  /** Regenerates AI title for a conversation. */
  async regenerateTitle(conversationId: string): Promise<void> {
    const { plugin } = this.deps;
    if (!plugin.settings.enableAutoTitleGeneration) return;
    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) return;

    // Get the full conversation from cache
    const fullConv = await plugin.getConversationById(conversationId);
    if (!fullConv || fullConv.messages.length < 2) return;

    // Find first user and assistant messages by role (not by index)
    const firstUserMsg = fullConv.messages.find(m => m.role === 'user');
    const firstAssistantMsg = fullConv.messages.find(m => m.role === 'assistant');
    if (!firstUserMsg || !firstAssistantMsg) return;

    const userContent = firstUserMsg.displayContent || firstUserMsg.content;

    // Extract text from assistant response
    const assistantText = firstAssistantMsg.content ||
      firstAssistantMsg.contentBlocks
        ?.filter((b): b is { type: 'text'; content: string } => b.type === 'text')
        .map(b => b.content)
        .join('\n') || '';

    if (!assistantText) return;

    // Store current title to check if user renames during generation
    const expectedTitle = fullConv.title;

    // Set pending status before starting generation
    await plugin.updateConversation(conversationId, { titleGenerationStatus: 'pending' });
    this.updateHistoryDropdown();

    // Fire async AI title generation
    await titleService.generateTitle(
      conversationId,
      userContent,
      assistantText,
      async (convId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = await plugin.getConversationById(convId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches expected)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && result.title && !userManuallyRenamed) {
          await plugin.renameConversation(convId, result.title);
          await plugin.updateConversation(convId, { titleGenerationStatus: 'success' });
        } else if (!userManuallyRenamed) {
          // Keep existing title, mark as failed (only if user hasn't renamed)
          await plugin.updateConversation(convId, { titleGenerationStatus: 'failed' });
        } else {
          // User manually renamed, clear the status (user's choice takes precedence)
          await plugin.updateConversation(convId, { titleGenerationStatus: undefined });
        }
        this.updateHistoryDropdown();
      }
    );
  }

  /** Formats a timestamp for display. */
  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ============================================
  // History Dropdown Rendering (for ClaudianView)
  // ============================================

  /**
   * Renders the history dropdown content to a provided container.
   * Used by ClaudianView to render the dropdown with custom selection callback.
   */
  renderHistoryDropdown(
    container: HTMLElement,
    options: { onSelectConversation: (id: string) => Promise<void> }
  ): void {
    this.renderHistoryItems(container, {
      onSelectConversation: options.onSelectConversation,
      onRerender: () => this.renderHistoryDropdown(container, options),
    });
  }
}
