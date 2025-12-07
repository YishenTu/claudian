import { ItemView, WorkspaceLeaf, MarkdownRenderer, setIcon } from 'obsidian';
import type ClaudianPlugin from './main';
import { VIEW_TYPE_CLAUDIAN, ChatMessage, StreamChunk, ToolCallInfo, ContentBlock, ClaudeModel, ThinkingBudget, DEFAULT_THINKING_BUDGET, DEFAULT_CLAUDE_MODELS } from './types';

// Import UI components
import {
  ApprovalModal,
  createInputToolbar,
  ModelSelector,
  ThinkingBudgetSelector,
  PermissionToggle,
  FileContextManager,
  renderToolCall,
  updateToolCallResult,
  renderStoredToolCall,
  isBlockedToolResult,
  createThinkingBlock,
  appendThinkingContent,
  finalizeThinkingBlock,
  cleanupThinkingBlock,
  renderStoredThinkingBlock,
  type ThinkingBlockState,
} from './ui';

export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;
  private messages: ChatMessage[] = [];
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private isStreaming = false;
  private toolCallElements: Map<string, HTMLElement> = new Map();

  // For maintaining stream order
  private currentContentEl: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private currentTextContent: string = '';

  // Thinking block tracking
  private currentThinkingState: ThinkingBlockState | null = null;

  // Thinking indicator
  private thinkingEl: HTMLElement | null = null;

  // Conversation history UI
  private currentConversationId: string | null = null;
  private historyDropdown: HTMLElement | null = null;

  // File context manager
  private fileContextManager: FileContextManager | null = null;

  // Toolbar components
  private modelSelector: ModelSelector | null = null;
  private thinkingBudgetSelector: ThinkingBudgetSelector | null = null;
  private permissionToggle: PermissionToggle | null = null;

  private cancelRequested = false;

  private static readonly FLAVOR_TEXTS = [
    'Thinking...',
    'Ruminating...',
    'Pondering...',
    'Contemplating...',
    'Processing...',
    'Analyzing...',
    'Considering...',
    'Reflecting...',
    'Mulling it over...',
    'Working on it...',
    'Let me think...',
    'Hmm...',
    'One moment...',
    'On it...',
  ];

  constructor(leaf: WorkspaceLeaf, plugin: ClaudianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return 'Claudian';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('claudian-container');

    // Header
    const header = container.createDiv({ cls: 'claudian-header' });

    // Left side: Logo + Title
    const titleContainer = header.createDiv({ cls: 'claudian-title' });
    const logoEl = titleContainer.createSpan({ cls: 'claudian-logo' });
    logoEl.innerHTML = `<svg viewBox="0 0 100 100" width="16" height="16">
      <g fill="#D97757">
        ${Array.from({ length: 12 }, (_, i) => {
      const angle = (i * 30 - 90) * Math.PI / 180;
      const cx = 53, cy = 50;
      const x1 = cx + 15 * Math.cos(angle);
      const y1 = cy + 15 * Math.sin(angle);
      const x2 = cx + 45 * Math.cos(angle);
      const y2 = cy + 45 * Math.sin(angle);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#D97757" stroke-width="8" stroke-linecap="round"/>`;
    }).join('')}
      </g>
    </svg>`;
    titleContainer.createEl('h4', { text: 'Claudian' });

    // Right side: Header actions
    const headerActions = header.createDiv({ cls: 'claudian-header-actions' });

    // History dropdown container
    const historyContainer = headerActions.createDiv({ cls: 'claudian-history-container' });

    // Dropdown trigger (icon button)
    const trigger = historyContainer.createDiv({ cls: 'claudian-header-btn' });
    setIcon(trigger, 'history');
    trigger.setAttribute('aria-label', 'Chat history');

    // Dropdown menu
    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    // Toggle dropdown on trigger click
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    // Close dropdown when clicking outside
    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    // New conversation button
    const newBtn = headerActions.createDiv({ cls: 'claudian-header-btn' });
    setIcon(newBtn, 'plus');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.createNewConversation());

    // Messages area
    this.messagesEl = container.createDiv({ cls: 'claudian-messages' });

    // Input area
    const inputContainerEl = container.createDiv({ cls: 'claudian-input-container' });

    // Input box wrapper (contains textarea + toolbar)
    const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });

    this.inputEl = inputWrapper.createEl('textarea', {
      cls: 'claudian-input',
      attr: {
        placeholder: 'Ask Claudian anything...\n\n(Enter to send, Shift+Enter for newline)',
        rows: '3',
      },
    });

    // Initialize file context manager (creates its own indicator elements in inputContainerEl)
    this.fileContextManager = new FileContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        getExcludedTags: () => this.plugin.settings.excludedTags,
        onFileOpen: async (path) => {
          // This callback is available if needed for additional file open handling
        },
      }
    );

    // Keep file cache fresh
    this.registerEvent(this.plugin.app.vault.on('create', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('modify', () => this.fileContextManager?.markFilesCacheDirty()));

    // Input toolbar (model selector + thinking budget + permission toggle)
    const inputToolbar = inputWrapper.createDiv({ cls: 'claudian-input-toolbar' });
    const toolbarComponents = createInputToolbar(inputToolbar, {
      getSettings: () => ({
        model: this.plugin.settings.model,
        thinkingBudget: this.plugin.settings.thinkingBudget,
        permissionMode: this.plugin.settings.permissionMode,
      }),
      getEnvironmentVariables: () => this.plugin.getActiveEnvironmentVariables(),
      onModelChange: async (model: ClaudeModel) => {
        this.plugin.settings.model = model;

        // Update thinking budget if it's a default Claude model
        const isDefaultModel = DEFAULT_CLAUDE_MODELS.find((m: any) => m.value === model);
        if (isDefaultModel) {
          this.plugin.settings.thinkingBudget = DEFAULT_THINKING_BUDGET[model];
          this.plugin.settings.lastDefaultModel = model;
        } else {
          this.plugin.settings.lastCustomModel = model;
        }

        await this.plugin.saveSettings();
        this.thinkingBudgetSelector?.updateDisplay();
        this.modelSelector?.updateDisplay();
        this.modelSelector?.renderOptions();
      },
      onThinkingBudgetChange: async (budget: ThinkingBudget) => {
        this.plugin.settings.thinkingBudget = budget;
        await this.plugin.saveSettings();
      },
      onPermissionModeChange: async (mode) => {
        this.plugin.settings.permissionMode = mode;
        await this.plugin.saveSettings();
      },
    });
    this.modelSelector = toolbarComponents.modelSelector;
    this.thinkingBudgetSelector = toolbarComponents.thinkingBudgetSelector;
    this.permissionToggle = toolbarComponents.permissionToggle;

    // Event handlers
    this.inputEl.addEventListener('keydown', (e) => {
      // Handle @ mention dropdown navigation
      if (this.fileContextManager?.handleMentionKeydown(e)) {
        return;
      }

      if (e.key === 'Escape' && this.isStreaming) {
        e.preventDefault();
        this.cancelStreaming();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Listen for @ mentions
    this.inputEl.addEventListener('input', () => this.fileContextManager?.handleInputChange());

    // Close mention dropdown when clicking outside
    this.registerDomEvent(document, 'click', (e) => {
      if (!this.fileContextManager?.containsElement(e.target as Node) && e.target !== this.inputEl) {
        this.fileContextManager?.hideMentionDropdown();
      }
    });

    // Listen for focus changes - update attachment before session starts
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Set up approval callback for permission prompts
    this.plugin.agentService.setApprovalCallback(this.handleApprovalRequest.bind(this));

    // Load active conversation or create new
    await this.loadActiveConversation();
  }

  async onClose() {
    // Clean up thinking indicator
    this.hideThinkingIndicator();
    // Clean up thinking block timer
    cleanupThinkingBlock(this.currentThinkingState);
    this.currentThinkingState = null;
    // Remove approval callback
    this.plugin.agentService.setApprovalCallback(null);
    // Save current conversation before closing
    await this.saveCurrentConversation();
  }

  private async sendMessage() {
    const content = this.inputEl.value.trim();
    if (!content || this.isStreaming) return;

    this.inputEl.value = '';
    this.isStreaming = true;
    this.cancelRequested = false;

    // Mark session as started
    this.fileContextManager?.startSession();

    // Check if attached files have changed since last message
    const attachedFiles = this.fileContextManager?.getAttachedFiles() || new Set();
    const currentFiles = Array.from(attachedFiles);
    const filesChanged = this.fileContextManager?.hasFilesChanged() ?? false;

    // Build prompt - only include context if files changed
    let promptToSend = content;
    let contextFilesForMessage: string[] | undefined;

    if (filesChanged) {
      if (currentFiles.length > 0) {
        const fileList = currentFiles.join(', ');
        promptToSend = `Context files: [${fileList}]\n\n${content}`;
        contextFilesForMessage = currentFiles;
      } else {
        // Explicitly signal removal after a prior attachment
        promptToSend = `Context files: []\n\n${content}`;
        contextFilesForMessage = [];
      }
    }

    // Mark files as sent
    this.fileContextManager?.markFilesSent();

    // Add user message (display original content, send with context)
    const userMsg: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      contextFiles: contextFilesForMessage,
    };
    this.addMessage(userMsg);

    // Auto-generate title from first user message
    if (this.messages.length === 1 && this.currentConversationId) {
      const title = this.generateTitle(content);
      await this.plugin.renameConversation(this.currentConversationId, title);
    }

    // Create assistant message placeholder
    const assistantMsg: ChatMessage = {
      id: this.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    const msgEl = this.addMessage(assistantMsg);
    const contentEl = msgEl.querySelector('.claudian-message-content') as HTMLElement;

    // Reset streaming state
    this.toolCallElements.clear();
    this.currentContentEl = contentEl;
    this.currentTextEl = null;
    this.currentTextContent = '';

    // Show thinking indicator
    this.showThinkingIndicator(contentEl);

    try {
      // Pass conversation history for session expiration recovery
      for await (const chunk of this.plugin.agentService.query(promptToSend, this.messages)) {
        if (this.cancelRequested) {
          break;
        }
        await this.handleStreamChunk(chunk, assistantMsg);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.appendText(`\n\n**Error:** ${errorMsg}`);
    } finally {
      this.hideThinkingIndicator();
      this.isStreaming = false;
      this.cancelRequested = false;
      this.currentContentEl = null;

      // Finalize any remaining blocks
      this.finalizeCurrentThinkingBlock(assistantMsg);
      this.finalizeCurrentTextBlock(assistantMsg);

      // Auto-save after message completion
      await this.saveCurrentConversation();
    }
  }

  private showThinkingIndicator(parentEl: HTMLElement) {
    if (this.thinkingEl) return;

    this.thinkingEl = parentEl.createDiv({ cls: 'claudian-thinking' });
    const texts = ClaudianView.FLAVOR_TEXTS;
    const randomText = texts[Math.floor(Math.random() * texts.length)];
    this.thinkingEl.setText(randomText);
  }

  private hideThinkingIndicator() {
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
  }

  private cancelStreaming() {
    if (!this.isStreaming) return;
    this.cancelRequested = true;
    this.plugin.agentService.cancel();
    this.hideThinkingIndicator();
  }

  private async handleStreamChunk(chunk: StreamChunk, msg: ChatMessage) {
    // Hide thinking indicator when real content arrives
    if (chunk.type === 'text' || chunk.type === 'tool_use' || chunk.type === 'thinking') {
      this.hideThinkingIndicator();
    }

    switch (chunk.type) {
      case 'thinking':
        // Finalize any current text block first
        if (this.currentTextEl) {
          this.finalizeCurrentTextBlock(msg);
        }
        await this.appendThinking(chunk.content, msg);
        break;

      case 'text':
        // Finalize any current thinking block first
        if (this.currentThinkingState) {
          this.finalizeCurrentThinkingBlock(msg);
        }
        msg.content += chunk.content;
        await this.appendText(chunk.content);
        break;

      case 'tool_use': {
        // Finalize current blocks before adding tool
        if (this.currentThinkingState) {
          this.finalizeCurrentThinkingBlock(msg);
        }
        this.finalizeCurrentTextBlock(msg);

        const toolCall: ToolCallInfo = {
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
          status: 'running',
          isExpanded: false,
        };
        msg.toolCalls = msg.toolCalls || [];
        msg.toolCalls.push(toolCall);

        if (this.plugin.settings.showToolUse) {
          msg.contentBlocks = msg.contentBlocks || [];
          msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });
          renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements);
        }
        break;
      }

      case 'tool_result': {
        const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
        const isBlocked = isBlockedToolResult(chunk.content, chunk.isError);

        if (existingToolCall) {
          existingToolCall.status = isBlocked ? 'blocked' : (chunk.isError ? 'error' : 'completed');
          existingToolCall.result = chunk.content;

          if (this.plugin.settings.showToolUse) {
            updateToolCallResult(chunk.id, existingToolCall, this.toolCallElements);
          }
        }

        // Track edited files
        this.fileContextManager?.trackEditedFile(
          existingToolCall?.name,
          existingToolCall?.input || {},
          chunk.isError || isBlocked
        );

        // Show thinking indicator again
        if (this.currentContentEl) {
          this.showThinkingIndicator(this.currentContentEl);
        }
        break;
      }

      case 'blocked':
        await this.appendText(`\n\n⚠️ **Blocked:** ${chunk.content}`);
        break;

      case 'error':
        await this.appendText(`\n\n❌ **Error:** ${chunk.content}`);
        break;

      case 'done':
        break;
    }

    // Auto-scroll to bottom
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async appendText(text: string) {
    if (!this.currentContentEl) return;

    if (!this.currentTextEl) {
      this.currentTextEl = this.currentContentEl.createDiv({ cls: 'claudian-text-block' });
      this.currentTextContent = '';
    }

    this.currentTextContent += text;
    await this.renderContent(this.currentTextEl, this.currentTextContent);
  }

  private finalizeCurrentTextBlock(msg?: ChatMessage) {
    if (msg && this.currentTextContent) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'text', content: this.currentTextContent });
    }
    this.currentTextEl = null;
    this.currentTextContent = '';
  }

  private async appendThinking(content: string, msg: ChatMessage) {
    if (!this.currentContentEl) return;

    if (!this.currentThinkingState) {
      this.currentThinkingState = createThinkingBlock(
        this.currentContentEl,
        (el, md) => this.renderContent(el, md)
      );
    }

    await appendThinkingContent(this.currentThinkingState, content, (el, md) => this.renderContent(el, md));
  }

  private finalizeCurrentThinkingBlock(msg?: ChatMessage) {
    if (!this.currentThinkingState) return;

    const durationSeconds = finalizeThinkingBlock(this.currentThinkingState);

    if (msg && this.currentThinkingState.content) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({
        type: 'thinking',
        content: this.currentThinkingState.content,
        durationSeconds,
      });
    }

    this.currentThinkingState = null;
  }

  private addMessage(msg: ChatMessage): HTMLElement {
    this.messages.push(msg);

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user' && msg.content) {
      const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
      this.renderContent(textEl, msg.content);
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return msgEl;
  }

  private async renderContent(el: HTMLElement, markdown: string) {
    el.empty();
    await MarkdownRenderer.renderMarkdown(markdown, el, '', this);
  }

  // ============================================
  // Conversation Management
  // ============================================

  private async createNewConversation() {
    if (this.isStreaming) return;

    if (this.messages.length > 0) {
      await this.saveCurrentConversation();
    }

    const conversation = await this.plugin.createConversation();

    this.currentConversationId = conversation.id;
    this.messages = [];
    this.messagesEl.empty();

    // Reset file context
    this.fileContextManager?.resetForNewConversation();
    this.fileContextManager?.autoAttachActiveFile();
  }

  private async loadActiveConversation() {
    let conversation = this.plugin.getActiveConversation();
    const isNewConversation = !conversation;

    if (!conversation) {
      conversation = await this.plugin.createConversation();
    }

    this.currentConversationId = conversation.id;
    this.messages = [...conversation.messages];

    // Restore session ID
    this.plugin.agentService.setSessionId(conversation.sessionId);

    // Reset file context
    const hasMessages = this.messages.length > 0;
    this.fileContextManager?.resetForLoadedConversation(hasMessages);

    if (isNewConversation || !hasMessages) {
      this.fileContextManager?.autoAttachActiveFile();
    }

    this.renderMessages();
  }

  private async onConversationSelect(id: string) {
    if (id === this.currentConversationId) return;
    if (this.isStreaming) return;

    await this.saveCurrentConversation();

    const conversation = await this.plugin.switchConversation(id);
    if (!conversation) return;

    this.currentConversationId = conversation.id;
    this.messages = [...conversation.messages];

    // Reset file context
    this.fileContextManager?.resetForLoadedConversation(this.messages.length > 0);

    this.renderMessages();
    this.historyDropdown?.removeClass('visible');
  }

  private async saveCurrentConversation() {
    if (!this.currentConversationId) return;

    const sessionId = this.plugin.agentService.getSessionId();
    await this.plugin.updateConversation(this.currentConversationId, {
      messages: this.messages,
      sessionId: sessionId,
    });
  }

  private renderMessages() {
    this.messagesEl.empty();

    for (const msg of this.messages) {
      this.renderStoredMessage(msg);
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderStoredMessage(msg: ChatMessage) {
    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
      this.renderContent(textEl, msg.content);
    } else if (msg.role === 'assistant') {
      if (msg.contentBlocks && msg.contentBlocks.length > 0) {
        for (const block of msg.contentBlocks) {
          if (block.type === 'thinking') {
            renderStoredThinkingBlock(
              contentEl,
              block.content,
              block.durationSeconds,
              (el, md) => this.renderContent(el, md)
            );
          } else if (block.type === 'text') {
            const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
            this.renderContent(textEl, block.content);
          } else if (block.type === 'tool_use' && this.plugin.settings.showToolUse) {
            const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
            if (toolCall) {
              renderStoredToolCall(contentEl, toolCall);
            }
          }
        }
      } else {
        // Fallback for old conversations without contentBlocks
        if (msg.content) {
          const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
          this.renderContent(textEl, msg.content);
        }
        if (msg.toolCalls && this.plugin.settings.showToolUse) {
          for (const toolCall of msg.toolCalls) {
            renderStoredToolCall(contentEl, toolCall);
          }
        }
      }
    }
  }

  // ============================================
  // History Dropdown
  // ============================================

  private toggleHistoryDropdown() {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.historyDropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      this.historyDropdown.addClass('visible');
    }
  }

  private updateHistoryDropdown() {
    if (!this.historyDropdown) return;

    this.historyDropdown.empty();

    const dropdownHeader = this.historyDropdown.createDiv({ cls: 'claudian-history-header' });
    dropdownHeader.createSpan({ text: 'Conversations' });

    const list = this.historyDropdown.createDiv({ cls: 'claudian-history-list' });
    const conversations = this.plugin.getConversationList()
      .filter(conv => conv.id !== this.currentConversationId);

    if (conversations.length === 0) {
      list.createDiv({ cls: 'claudian-history-empty', text: 'No other conversations' });
      return;
    }

    for (const conv of conversations) {
      const item = list.createDiv({ cls: 'claudian-history-item' });

      const iconEl = item.createDiv({ cls: 'claudian-history-item-icon' });
      setIcon(iconEl, 'message-square');

      const content = item.createDiv({ cls: 'claudian-history-item-content' });
      content.createDiv({ cls: 'claudian-history-item-title', text: conv.title });
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: this.formatDate(conv.updatedAt),
      });

      content.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.onConversationSelect(conv.id);
      });

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
        if (this.isStreaming) return;
        await this.plugin.deleteConversation(conv.id);
        this.updateHistoryDropdown();

        if (conv.id === this.currentConversationId) {
          await this.loadActiveConversation();
        }
      });
    }
  }

  private showRenameInput(item: HTMLElement, convId: string, currentTitle: string) {
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
      await this.plugin.renameConversation(convId, newTitle);
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
  // Utility Methods
  // ============================================

  private generateTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  // ============================================
  // Approval Dialog
  // ============================================

  private async handleApprovalRequest(
    toolName: string,
    input: Record<string, unknown>,
    description: string
  ): Promise<'allow' | 'allow-always' | 'deny'> {
    return new Promise((resolve) => {
      const modal = new ApprovalModal(this.plugin.app, toolName, input, description, resolve);
      modal.open();
    });
  }
}
