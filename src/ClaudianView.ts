import { ItemView, WorkspaceLeaf, MarkdownRenderer, setIcon } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type ClaudianPlugin from './main';
import { VIEW_TYPE_CLAUDIAN, ChatMessage, StreamChunk, ToolCallInfo, ContentBlock, ClaudeModel, ThinkingBudget, DEFAULT_THINKING_BUDGET, DEFAULT_CLAUDE_MODELS, ImageAttachment, SubagentInfo } from './types';
import { AsyncSubagentManager } from './AsyncSubagentManager';
import { getVaultPath } from './utils';
import { readCachedImageBase64 } from './imageCache';

// Import UI components
import {
  ApprovalModal,
  createInputToolbar,
  ModelSelector,
  ThinkingBudgetSelector,
  PermissionToggle,
  FileContextManager,
  ImageContextManager,
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
  parseTodoInput,
  renderTodoList,
  renderStoredTodoList,
  // Sync subagent
  createSubagentBlock,
  addSubagentToolCall,
  updateSubagentToolResult,
  finalizeSubagentBlock,
  renderStoredSubagent,
  type SubagentState,
  // Async subagent
  createAsyncSubagentBlock,
  updateAsyncSubagentRunning,
  updateAsyncSubagentAwaiting,
  finalizeAsyncSubagent,
  markAsyncSubagentOrphaned,
  renderStoredAsyncSubagent,
  type AsyncSubagentState,
} from './ui';

export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;
  private messages: ChatMessage[] = [];
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private isStreaming = false;
  private toolCallElements: Map<string, HTMLElement> = new Map();

  // Sync subagent tracking
  private activeSubagents: Map<string, SubagentState> = new Map();

  // Async subagent tracking
  private asyncSubagentManager: AsyncSubagentManager;
  private asyncSubagentStates: Map<string, AsyncSubagentState> = new Map();

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
  public fileContextManager: FileContextManager | null = null;

  // Image context manager
  private imageContextManager: ImageContextManager | null = null;

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

    // Initialize async subagent manager with UI update callback
    this.asyncSubagentManager = new AsyncSubagentManager(
      this.onAsyncSubagentStateChange.bind(this)
    );
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
    // Create SVG logo using DOM API (avoid innerHTML per Obsidian guidelines)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('fill', '#D97757');
    for (let i = 0; i < 12; i++) {
      const angle = (i * 30 - 90) * Math.PI / 180;
      const cx = 53, cy = 50;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(cx + 15 * Math.cos(angle)));
      line.setAttribute('y1', String(cy + 15 * Math.sin(angle)));
      line.setAttribute('x2', String(cx + 45 * Math.cos(angle)));
      line.setAttribute('y2', String(cy + 45 * Math.sin(angle)));
      line.setAttribute('stroke', '#D97757');
      line.setAttribute('stroke-width', '8');
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);
    }
    svg.appendChild(g);
    logoEl.appendChild(svg);
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

    // Document-level ESC handler for cancel streaming (works regardless of focus)
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isStreaming) {
        e.preventDefault();
        this.cancelStreaming();
      }
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

    // Initialize image context manager (creates its own preview elements in inputContainerEl)
    this.imageContextManager = new ImageContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        onImagesChanged: () => {
          // Images changed - could update UI state if needed
        },
        getMediaFolder: () => this.plugin.settings.mediaFolder,
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
          this.plugin.settings.lastClaudeModel = model;
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
    // Clean up file context manager (unregister vault event listeners)
    this.fileContextManager?.destroy();
    // Orphan any active async subagents (view closing = conversation ending)
    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();
    // Save current conversation before closing
    await this.saveCurrentConversation();
  }

  private async sendMessage() {
    let content = this.inputEl.value.trim();
    if (!content && !this.imageContextManager?.hasImages()) return;
    if (this.isStreaming) return;

    this.inputEl.value = '';
    this.isStreaming = true;
    this.cancelRequested = false;

    // Mark session as started
    this.fileContextManager?.startSession();

    // Check for image path in message and try to load it
    if (content && this.imageContextManager) {
      const result = await this.imageContextManager.handleImagePathInText(content);
      if (result.imageLoaded) {
        content = result.text;
      }
    }

    // Get attached images
    const images = this.imageContextManager?.getAttachedImages() || [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;

    // Clear images after collecting them
    this.imageContextManager?.clearImages();

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
      images: imagesForMessage,
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
      for await (const chunk of this.plugin.agentService.query(promptToSend, imagesForMessage, this.messages)) {
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

      // Clean up any orphaned sync subagents (sync must complete within one turn)
      this.activeSubagents.clear();

      // NOTE: Do NOT orphan async subagents here - they persist across message turns
      // Async subagents are only orphaned when:
      // 1. User creates a new conversation
      // 2. View closes

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
    // Route messages by parentToolUseId - if non-null, this chunk belongs to a subagent
    if ('parentToolUseId' in chunk && chunk.parentToolUseId) {
      await this.handleSubagentChunk(chunk, msg);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      return;
    }

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

        // Special handling for Task tool - check sync vs async
        if (chunk.name === 'Task') {
          const isAsync = this.asyncSubagentManager.isAsyncTask(chunk.input);
          if (isAsync) {
            await this.handleAsyncTaskToolUse(chunk, msg);
          } else {
            await this.handleTaskToolUse(chunk, msg);
          }
          break;
        }

        // Special handling for AgentOutputTool - link to async subagent
        if (chunk.name === 'AgentOutputTool') {
          this.handleAgentOutputToolUse(chunk, msg);
          break;
        }

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

          // Special rendering for TodoWrite
          if (chunk.name === 'TodoWrite') {
            const todos = parseTodoInput(chunk.input);
            if (todos) {
              const todoEl = renderTodoList(this.currentContentEl!, todos, true);
              todoEl.dataset.toolId = chunk.id;
              this.toolCallElements.set(chunk.id, todoEl);
            } else {
              renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements);
            }
          } else {
            renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements);
          }
        }
        break;
      }

      case 'tool_result': {
        // Check if this is a sync subagent (Task tool) completion
        const subagentState = this.activeSubagents.get(chunk.id);
        if (subagentState) {
          this.finalizeSubagent(chunk, msg, subagentState);
          break;
        }

        // Check if this is an async Task result (extracts agent_id)
        if (this.handleAsyncTaskToolResult(chunk, msg)) {
          // Show thinking indicator while waiting for AgentOutputTool
          if (this.currentContentEl) {
            this.showThinkingIndicator(this.currentContentEl);
          }
          break;
        }

        // Check if this is an AgentOutputTool result (finalizes async subagent)
        if (this.handleAgentOutputToolResult(chunk, msg)) {
          // Show thinking indicator for next main agent response
          if (this.currentContentEl) {
            this.showThinkingIndicator(this.currentContentEl);
          }
          break;
        }

        // Normal tool result handling
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

  // ============================================
  // Subagent Handling
  // ============================================

  /**
   * Handle Task tool_use by creating a subagent block
   */
  private async handleTaskToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage
  ): Promise<void> {
    if (!this.currentContentEl) return;

    // Create subagent block
    const state = createSubagentBlock(this.currentContentEl, chunk.id, chunk.input);
    this.activeSubagents.set(chunk.id, state);

    // Track in message for persistence
    msg.subagents = msg.subagents || [];
    msg.subagents.push(state.info);

    // Add to content blocks
    if (this.plugin.settings.showToolUse) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'subagent', subagentId: chunk.id });
    }
  }

  /**
   * Handle chunks from subagents - route to appropriate SubagentRenderer
   */
  private async handleSubagentChunk(chunk: StreamChunk, msg: ChatMessage): Promise<void> {
    // Extract parentToolUseId from chunk (caller already verified it exists and is truthy)
    if (!('parentToolUseId' in chunk) || !chunk.parentToolUseId) {
      console.warn('handleSubagentChunk called without parentToolUseId');
      return;
    }
    const parentToolUseId = chunk.parentToolUseId;
    const subagentState = this.activeSubagents.get(parentToolUseId);

    if (!subagentState) {
      // Orphan subagent message - shouldn't happen for sync subagents
      console.warn(`Received chunk for unknown subagent: ${parentToolUseId}`);
      return;
    }

    switch (chunk.type) {
      case 'tool_use': {
        // Add nested tool to subagent
        const toolCall: ToolCallInfo = {
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
          status: 'running',
          isExpanded: false,
        };
        addSubagentToolCall(subagentState, toolCall);
        break;
      }

      case 'tool_result': {
        // Update nested tool in subagent
        const toolCall = subagentState.info.toolCalls.find(tc => tc.id === chunk.id);
        if (toolCall) {
          const isBlocked = isBlockedToolResult(chunk.content, chunk.isError);
          toolCall.status = isBlocked ? 'blocked' : (chunk.isError ? 'error' : 'completed');
          toolCall.result = chunk.content;
          updateSubagentToolResult(subagentState, chunk.id, toolCall);

          // Track edited files from subagent tool calls
          this.fileContextManager?.trackEditedFile(
            toolCall.name,
            toolCall.input || {},
            chunk.isError || isBlocked
          );
        }
        break;
      }

      case 'text':
      case 'thinking':
        // Ignore text/thinking from subagents per requirements
        break;
    }
  }

  /**
   * Finalize a subagent when its Task tool_result is received
   */
  private finalizeSubagent(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    msg: ChatMessage,
    state: SubagentState
  ): void {
    const isError = chunk.isError || false;
    finalizeSubagentBlock(state, chunk.content, isError);

    // Update in message for persistence
    const subagentInfo = msg.subagents?.find(s => s.id === chunk.id);
    if (subagentInfo) {
      subagentInfo.status = isError ? 'error' : 'completed';
      subagentInfo.result = chunk.content;
    }

    // Remove from active tracking
    this.activeSubagents.delete(chunk.id);

    // Show thinking indicator for next main agent response
    if (this.currentContentEl) {
      this.showThinkingIndicator(this.currentContentEl);
    }
  }

  // ============================================
  // Async Subagent Handling
  // ============================================

  /**
   * Handle async Task tool_use (run_in_background=true)
   */
  private async handleAsyncTaskToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage
  ): Promise<void> {
    if (!this.currentContentEl) return;

    // Create async subagent via manager
    const subagentInfo = this.asyncSubagentManager.createAsyncSubagent(chunk.id, chunk.input);

    // Create UI block
    const state = createAsyncSubagentBlock(this.currentContentEl, chunk.id, chunk.input);
    this.asyncSubagentStates.set(chunk.id, state);

    // Track in message for persistence
    msg.subagents = msg.subagents || [];
    msg.subagents.push(subagentInfo);

    // Add to content blocks
    if (this.plugin.settings.showToolUse) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'subagent', subagentId: chunk.id, mode: 'async' });
    }
  }

  /**
   * Handle AgentOutputTool tool_use - link to async subagent (invisible, not rendered)
   */
  private handleAgentOutputToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    _msg: ChatMessage
  ): void {
    // Create minimal tool call info for internal tracking only
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };

    // Link to async subagent via manager - this is the only thing we need
    // AgentOutputTool is NOT rendered - its result will update the async subagent block
    this.asyncSubagentManager.handleAgentOutputToolUse(toolCall);
  }

  /**
   * Handle async Task tool_result - extract agent_id
   */
  private handleAsyncTaskToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    _msg: ChatMessage
  ): boolean {
    // Check if this is a pending async subagent
    if (!this.asyncSubagentManager.isPendingAsyncTask(chunk.id)) {
      return false;
    }

    console.log('[ClaudianView] Async Task tool_result:', {
      id: chunk.id,
      content: chunk.content,
      isError: chunk.isError,
    });

    // Handle result via manager (extracts agent_id, transitions state)
    // Note: For async tasks, isError=true means the task failed to LAUNCH
    // If the task launched but the work fails, that comes via AgentOutputTool
    this.asyncSubagentManager.handleTaskToolResult(chunk.id, chunk.content, chunk.isError);

    // Note: UI update happens via onAsyncSubagentStateChange callback
    return true;
  }

  /**
   * Handle AgentOutputTool tool_result - finalize async subagent
   */
  private handleAgentOutputToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    _msg: ChatMessage
  ): boolean {
    // Handle result via manager (finalizes subagent)
    // UI update happens via onAsyncSubagentStateChange callback
    this.asyncSubagentManager.handleAgentOutputToolResult(
      chunk.id,
      chunk.content,
      chunk.isError || false
    );

    // Treat as handled if any async subagent existed; manager will no-op otherwise
    return this.asyncSubagentManager.hasActiveAsync();
  }

  /**
   * Callback from AsyncSubagentManager when state changes
   */
  private onAsyncSubagentStateChange(subagent: SubagentInfo): void {
    // Find UI state by subagent id
    const state = this.asyncSubagentStates.get(subagent.id);
    if (!state) {
      // Try to find by agentId mapping (for running/completed states)
      for (const [id, s] of this.asyncSubagentStates) {
        if (s.info.agentId === subagent.agentId) {
          this.updateAsyncSubagentUI(s, subagent);
          return;
        }
      }
      return;
    }

    this.updateAsyncSubagentUI(state, subagent);
  }

  /**
   * Update async subagent UI based on state change
   */
  private updateAsyncSubagentUI(state: AsyncSubagentState, subagent: SubagentInfo): void {
    // Sync state info
    state.info = subagent;

    switch (subagent.asyncStatus) {
      case 'running':
        updateAsyncSubagentRunning(state, subagent.agentId || '');
        break;

      case 'awaiting_result':
        updateAsyncSubagentAwaiting(state);
        break;

      case 'completed':
      case 'error':
        finalizeAsyncSubagent(state, subagent.result || '', subagent.asyncStatus === 'error');
        break;

      case 'orphaned':
        markAsyncSubagentOrphaned(state);
        break;
    }

    // Update in message storage
    this.updateSubagentInMessages(subagent);

    // Auto-scroll
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * Update subagent info in current message
   */
  private updateSubagentInMessages(subagent: SubagentInfo): void {
    // Find the last assistant message with this subagent
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && msg.subagents) {
        const idx = msg.subagents.findIndex(s => s.id === subagent.id);
        if (idx !== -1) {
          msg.subagents[idx] = subagent;
          return;
        }
      }
    }
  }

  private addMessage(msg: ChatMessage): HTMLElement {
    this.messages.push(msg);

    // For user messages with images, render images above the bubble
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      // Render text content only (images are above)
      if (msg.content) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        this.renderContent(textEl, msg.content);
      }
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return msgEl;
  }

  private renderMessageImages(containerEl: HTMLElement, images: ImageAttachment[]) {
    const imagesEl = containerEl.createDiv({ cls: 'claudian-message-images' });

    for (const image of images) {
      const imageWrapper = imagesEl.createDiv({ cls: 'claudian-message-image' });
      const imgEl = imageWrapper.createEl('img', {
        attr: {
          alt: image.name,
        },
      });

      void this.setImageSrc(imgEl, image);

      // Click to view full size
      imgEl.addEventListener('click', () => {
        void this.showFullImage(image);
      });
    }
  }

  private async showFullImage(image: ImageAttachment) {
    const dataUri = await this.getImageDataUri(image);
    if (!dataUri) return;

    const overlay = document.body.createDiv({ cls: 'claudian-image-modal-overlay' });
    const modal = overlay.createDiv({ cls: 'claudian-image-modal' });

    modal.createEl('img', {
      attr: {
        src: dataUri,
        alt: image.name,
      },
    });

    const closeBtn = modal.createDiv({ cls: 'claudian-image-modal-close' });
    closeBtn.setText('\u00D7');

    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', handleEsc);
      }
    };
    document.addEventListener('keydown', handleEsc);
  }

  private async setImageSrc(imgEl: HTMLImageElement, image: ImageAttachment) {
    const dataUri = await this.getImageDataUri(image);
    if (dataUri) {
      imgEl.setAttribute('src', dataUri);
    } else {
      imgEl.setAttribute('alt', `${image.name} (missing)`);
    }
  }

  private async getImageDataUri(image: ImageAttachment): Promise<string | null> {
    const base64 = await this.loadImageBase64(image);
    if (!base64) return null;
    return `data:${image.mediaType};base64,${base64}`;
  }

  private async loadImageBase64(image: ImageAttachment): Promise<string | null> {
    if (image.data) return image.data;

    if (image.cachePath) {
      const cached = readCachedImageBase64(this.plugin.app, image.cachePath);
      if (cached) {
        image.data = cached;
        return cached;
      }
    }

    if (image.filePath) {
      const vaultPath = getVaultPath(this.plugin.app);
      const absPath = path.isAbsolute(image.filePath)
        ? image.filePath
        : (vaultPath ? path.join(vaultPath, image.filePath) : null);

      if (absPath && fs.existsSync(absPath)) {
        try {
          const buffer = fs.readFileSync(absPath);
          const base64 = buffer.toString('base64');
          image.data = base64;
          return base64;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  private async renderContent(el: HTMLElement, markdown: string) {
    el.empty();
    await MarkdownRenderer.renderMarkdown(markdown, el, '', this);

    // Add clickable language label to code blocks
    el.querySelectorAll('pre > code[class*="language-"]').forEach((code) => {
      const pre = code.parentElement;
      if (pre) {
        const match = code.className.match(/language-(\w+)/);
        if (match) {
          pre.classList.add('has-language');
          const label = pre.createEl('span', {
            cls: 'claudian-code-lang-label',
            text: match[1],
          });
          label.addEventListener('click', async () => {
            await navigator.clipboard.writeText(code.textContent || '');
            label.setText('copied!');
            setTimeout(() => label.setText(match[1]), 1500);
          });
        }
      }
    });
  }

  // ============================================
  // Conversation Management
  // ============================================

  private async createNewConversation() {
    if (this.isStreaming) return;

    if (this.messages.length > 0) {
      await this.saveCurrentConversation();
    }

    // Orphan any active async subagents from previous conversation
    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();

    const conversation = await this.plugin.createConversation();

    this.currentConversationId = conversation.id;
    this.messages = [];
    this.messagesEl.empty();

    // Reset file context
    this.fileContextManager?.resetForNewConversation();
    this.fileContextManager?.autoAttachActiveFile();

    // Clear any attached images
    this.imageContextManager?.clearImages();
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

    // Orphan any active async subagents from previous conversation
    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();

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
      messages: this.getPersistedMessages(),
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
    // For user messages with images, render images above the bubble
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      // Render text content only (images are above)
      if (msg.content) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        this.renderContent(textEl, msg.content);
      }
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
              // Special rendering for TodoWrite
              if (toolCall.name === 'TodoWrite') {
                renderStoredTodoList(contentEl, toolCall.input);
              } else {
                renderStoredToolCall(contentEl, toolCall);
              }
            }
          } else if (block.type === 'subagent' && this.plugin.settings.showToolUse) {
            const subagent = msg.subagents?.find(s => s.id === block.subagentId);
            if (subagent) {
              // Use mode from block or infer from subagent
              const mode = block.mode || subagent.mode || 'sync';
              if (mode === 'async') {
                renderStoredAsyncSubagent(contentEl, subagent);
              } else {
                renderStoredSubagent(contentEl, subagent);
              }
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
            // Special rendering for TodoWrite
            if (toolCall.name === 'TodoWrite') {
              renderStoredTodoList(contentEl, toolCall.input);
            } else {
              renderStoredToolCall(contentEl, toolCall);
            }
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
    const allConversations = this.plugin.getConversationList();

    if (allConversations.length === 0) {
      list.createDiv({ cls: 'claudian-history-empty', text: 'No conversations' });
      return;
    }

    // Sort: current session first, then by updatedAt descending
    const conversations = [...allConversations].sort((a, b) => {
      if (a.id === this.currentConversationId) return -1;
      if (b.id === this.currentConversationId) return 1;
      return b.updatedAt - a.updatedAt;
    });

    for (const conv of conversations) {
      const isCurrent = conv.id === this.currentConversationId;
      const item = list.createDiv({
        cls: `claudian-history-item${isCurrent ? ' active' : ''}`,
      });

      const iconEl = item.createDiv({ cls: 'claudian-history-item-icon' });
      setIcon(iconEl, isCurrent ? 'message-square-dot' : 'message-square');

      const content = item.createDiv({ cls: 'claudian-history-item-content' });
      content.createDiv({ cls: 'claudian-history-item-title', text: conv.title });
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: isCurrent ? 'Current session' : this.formatDate(conv.updatedAt),
      });

      if (!isCurrent) {
        content.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.onConversationSelect(conv.id);
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

  private getPersistedMessages(): ChatMessage[] {
    return this.messages.map(msg => ({
      ...msg,
      images: msg.images?.map(img => {
        const { data, ...rest } = img;
        return { ...rest };
      }),
    }));
  }

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
