/**
 * Conversation controller for chat session management.
 *
 * Handles conversation lifecycle (create, load, save, switch),
 * history dropdown UI, and greeting/welcome state.
 */

import { setIcon } from 'obsidian';

import type { Conversation } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import type { FileContextManager, ImageContextManager, McpServerSelector } from '../../../ui';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { AsyncSubagentManager } from '../services/AsyncSubagentManager';
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
  clearQueuedMessage: () => void;
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

  /** Creates a new conversation. */
  async createNew(): Promise<void> {
    const { plugin, state, asyncSubagentManager } = this.deps;
    if (state.isStreaming) return;

    if (state.messages.length > 0) {
      await this.save();
    }

    asyncSubagentManager.orphanAllActive();
    state.asyncSubagentStates.clear();

    const conversation = await plugin.createConversation();

    state.currentConversationId = conversation.id;
    state.clearMessages();

    const messagesEl = this.deps.getMessagesEl();
    messagesEl.empty();

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

    plugin.agentService.setSessionId(conversation.sessionId);

    const hasMessages = state.messages.length > 0;
    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForLoadedConversation(hasMessages);

    if (conversation.attachedFiles && conversation.attachedFiles.length > 0) {
      fileCtx?.setAttachedFiles(conversation.attachedFiles);
    } else if (isNewConversation || !hasMessages) {
      fileCtx?.autoAttachActiveFile();
    }

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);
    this.updateWelcomeVisibility();

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

    this.deps.getInputEl().value = '';
    this.deps.clearQueuedMessage();

    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForLoadedConversation(state.messages.length > 0);

    if (conversation.attachedFiles && conversation.attachedFiles.length > 0) {
      fileCtx?.setAttachedFiles(conversation.attachedFiles);
    }

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);

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
    const attachedFiles = fileCtx ? Array.from(fileCtx.getAttachedFiles()) : [];

    const updates: Partial<Conversation> = {
      messages: state.getPersistedMessages(),
      sessionId: sessionId,
      attachedFiles: attachedFiles,
    };

    if (updateLastResponse) {
      updates.lastResponseAt = Date.now();
    }

    await plugin.updateConversation(state.currentConversationId, updates);
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
      content.createDiv({ cls: 'claudian-history-item-title', text: conv.title });
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

  /** Generates a title from the first message. */
  generateTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
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
