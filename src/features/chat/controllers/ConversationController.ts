/**
 * Conversation controller for chat session management.
 *
 * Handles conversation lifecycle (create, load, save, switch),
 * history dropdown UI, and greeting/welcome state.
 */

import { setIcon } from 'obsidian';

import type { Conversation } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { type ExternalContextSelector, extractLastTodosFromMessages, type FileContextManager, type ImageContextManager, type McpServerSelector, type TodoPanel } from '../../../ui';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { AsyncSubagentManager } from '../services/AsyncSubagentManager';
import type { TitleGenerationService } from '../services/TitleGenerationService';
import type { ChatState } from '../state/ChatState';

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

  // ============================================
  // Conversation Lifecycle
  // ============================================

  /** Creates a new conversation, or switches to an existing empty one. */
  async createNew(): Promise<void> {
    const { plugin, state, asyncSubagentManager } = this.deps;
    if (state.isStreaming) return;

    if (state.messages.length > 0) {
      await this.save();
    }

    asyncSubagentManager.orphanAllActive();
    state.asyncSubagentStates.clear();

    // Check for existing empty conversation to reuse
    const emptyConv = plugin.findEmptyConversation();
    const conversation = emptyConv
      ? await plugin.switchConversation(emptyConv.id) ?? await plugin.createConversation()
      : await plugin.createConversation();

    state.currentConversationId = conversation.id;
    state.clearMessages();
    state.usage = null;
    state.currentTodos = null;

    const messagesEl = this.deps.getMessagesEl();
    messagesEl.empty();

    // Remount TodoPanel after clearing (messagesEl.empty() removes it from DOM)
    this.deps.getTodoPanel()?.remount();

    // Recreate welcome element after clearing messages
    const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
    welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
    this.deps.setWelcomeEl(welcomeEl);

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
  }

  /** Loads the active conversation or creates a new one. */
  async loadActive(): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    let conversation = plugin.getActiveConversation();
    const isNewConversation = !conversation;

    if (!conversation) {
      conversation = await plugin.createConversation();
    }

    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;

    plugin.agentService.setSessionId(conversation.sessionId);

    const hasMessages = state.messages.length > 0;
    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForLoadedConversation(hasMessages);

    if (conversation.currentNote) {
      fileCtx?.setCurrentNote(conversation.currentNote);
    } else if (isNewConversation || !hasMessages) {
      fileCtx?.autoAttachActiveFile();
    }

    // Restore external context paths based on session state
    this.restoreExternalContextPaths(
      conversation.externalContextPaths,
      isNewConversation || !hasMessages
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

    await this.save();

    asyncSubagentManager.orphanAllActive();
    state.asyncSubagentStates.clear();

    const conversation = await plugin.switchConversation(id);
    if (!conversation) return;

    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;

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
  }

  /** Saves the current conversation. */
  async save(updateLastResponse = false): Promise<void> {
    const { plugin, state } = this.deps;
    if (!state.currentConversationId) return;

    const sessionId = plugin.agentService.getSessionId();
    const fileCtx = this.deps.getFileContextManager();
    const currentNote = fileCtx?.getCurrentNotePath() || undefined;
    const externalContextSelector = this.deps.getExternalContextSelector();
    const externalContextPaths = externalContextSelector?.getExternalContexts() ?? [];
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const enabledMcpServers = mcpServerSelector ? Array.from(mcpServerSelector.getEnabledServers()) : [];

    const updates: Partial<Conversation> = {
      messages: state.getPersistedMessages(),
      sessionId: sessionId,
      currentNote: currentNote,
      externalContextPaths: externalContextPaths.length > 0 ? externalContextPaths : undefined,
      usage: state.usage ?? undefined,
      enabledMcpServers: enabledMcpServers.length > 0 ? enabledMcpServers : undefined,
    };

    if (updateLastResponse) {
      updates.lastResponseAt = Date.now();
    }

    await plugin.updateConversation(state.currentConversationId, updates);
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
      console.warn('[ConversationController] External context selector not available, skipping path restoration');
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

    const { plugin, state } = this.deps;

    dropdown.empty();

    const dropdownHeader = dropdown.createDiv({ cls: 'claudian-history-header' });
    dropdownHeader.createSpan({ text: 'Conversations' });

    const list = dropdown.createDiv({ cls: 'claudian-history-list' });
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
          await this.switchTo(conv.id);
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
          } catch (error) {
            console.error('[ConversationController] Failed to regenerate title:', error);
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
        await plugin.deleteConversation(conv.id);
        this.updateHistoryDropdown();

        if (conv.id === state.currentConversationId) {
          await this.loadActive();
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
      const newTitle = input.value.trim() || currentTitle;
      await this.deps.plugin.renameConversation(convId, newTitle);
      this.updateHistoryDropdown();
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
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

    // Day-specific greetings
    const dayGreetings: Record<number, string[]> = name
      ? {
        0: [`Happy Sunday, ${name}`, 'Sunday session?', 'Welcome to the weekend'],
        1: [`Happy Monday, ${name}`, `Back at it, ${name}`],
        2: [`Happy Tuesday, ${name}`],
        3: [`Happy Wednesday, ${name}`],
        4: [`Happy Thursday, ${name}`],
        5: [`Happy Friday, ${name}`, `That Friday feeling, ${name}`],
        6: [`Happy Saturday, ${name}`, `Welcome to the weekend, ${name}`],
      }
      : {
        0: ['Happy Sunday', 'Sunday session?', 'Welcome to the weekend'],
        1: ['Happy Monday', 'Back at it!'],
        2: ['Happy Tuesday'],
        3: ['Happy Wednesday'],
        4: ['Happy Thursday'],
        5: ['Happy Friday', 'That Friday feeling'],
        6: ['Happy Saturday!', 'Welcome to the weekend'],
      };

    // Time-specific greetings
    const getTimeGreetings = (): string[] => {
      if (hour >= 5 && hour < 12) {
        return name
          ? [`Good morning, ${name}`, 'Coffee and Claudian time?']
          : ['Good morning', 'Coffee and Claudian time?'];
      } else if (hour >= 12 && hour < 18) {
        return name
          ? [`Good afternoon, ${name}`, `Hey there, ${name}`, `How's it going, ${name}?`]
          : ['Good afternoon', 'Hey there', "How's it going?"];
      } else if (hour >= 18 && hour < 22) {
        return name
          ? [`Good evening, ${name}`, `Evening, ${name}`, `How was your day, ${name}?`]
          : ['Good evening', 'Evening', "How was your day?"];
      } else {
        return name
          ? ['Hello, night owl', `Evening, ${name}`]
          : ['Hello, night owl', 'Evening'];
      }
    };

    // General greetings
    const generalGreetings = name
      ? [
        `Hey there, ${name}`,
        `Hi ${name}, how are you?`,
        `How's it going, ${name}?`,
        `Welcome Back!, ${name}`,
        `What's new, ${name}?`,
        `${name} returns!`,
      ]
      : [
        'Hey there',
        'Hi, how are you?',
        "How's it going?",
        'Welcome Back!',
        "What's new?",
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
    const fullConv = plugin.getConversationById(conversationId);
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
        const currentConv = plugin.getConversationById(convId);
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
}
