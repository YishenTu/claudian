/**
 * Claudian - Sidebar chat view
 *
 * Main chat interface for interacting with Claude. Handles message streaming,
 * tool call rendering, conversation management, and file/image context.
 */

import { ItemView, WorkspaceLeaf, MarkdownRenderer, setIcon } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type ClaudianPlugin from './main';
import { VIEW_TYPE_CLAUDIAN, ChatMessage, StreamChunk, ToolCallInfo, ContentBlock, ClaudeModel, ThinkingBudget, DEFAULT_THINKING_BUDGET, DEFAULT_CLAUDE_MODELS, ImageAttachment, SubagentInfo } from './types';
import { AsyncSubagentManager } from './AsyncSubagentManager';
import { getVaultPath } from './utils';
import { readCachedImageBase64 } from './imageCache';

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
  finalizeAsyncSubagent,
  markAsyncSubagentOrphaned,
  renderStoredAsyncSubagent,
  type AsyncSubagentState,
  // Write/Edit diff renderer
  createWriteEditBlock,
  updateWriteEditWithDiff,
  finalizeWriteEditBlock,
  renderStoredWriteEdit,
  type WriteEditState,
} from './ui';

/** Main sidebar chat view for interacting with Claude. */
export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;
  private messages: ChatMessage[] = [];
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private isStreaming = false;
  private toolCallElements: Map<string, HTMLElement> = new Map();
  private activeSubagents: Map<string, SubagentState> = new Map();
  private asyncSubagentManager: AsyncSubagentManager;
  private asyncSubagentStates: Map<string, AsyncSubagentState> = new Map();
  private writeEditStates: Map<string, WriteEditState> = new Map();
  private currentContentEl: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private currentTextContent: string = '';
  private currentThinkingState: ThinkingBlockState | null = null;
  private thinkingEl: HTMLElement | null = null;
  private currentConversationId: string | null = null;
  private historyDropdown: HTMLElement | null = null;
  public fileContextManager: FileContextManager | null = null;
  private imageContextManager: ImageContextManager | null = null;
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

    const header = container.createDiv({ cls: 'claudian-header' });

    const titleContainer = header.createDiv({ cls: 'claudian-title' });
    const logoEl = titleContainer.createSpan({ cls: 'claudian-logo' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('fill', '#D97757');
    for (let i = 0; i < 12; i++) {
      const angle = (i * 30 - 90) * Math.PI / 180;
      const cx = 60, cy = 58;
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

    const headerActions = header.createDiv({ cls: 'claudian-header-actions' });

    const historyContainer = headerActions.createDiv({ cls: 'claudian-history-container' });

    const trigger = historyContainer.createDiv({ cls: 'claudian-header-btn' });
    setIcon(trigger, 'history');
    trigger.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isStreaming) {
        e.preventDefault();
        this.cancelStreaming();
      }
    });

    const newBtn = headerActions.createDiv({ cls: 'claudian-header-btn' });
    setIcon(newBtn, 'plus');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.createNewConversation());

    this.messagesEl = container.createDiv({ cls: 'claudian-messages' });

    const inputContainerEl = container.createDiv({ cls: 'claudian-input-container' });

    const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });

    this.inputEl = inputWrapper.createEl('textarea', {
      cls: 'claudian-input',
      attr: {
        placeholder: 'Ask Claudian anything...\n\n(Enter to send, Shift+Enter for newline)',
        rows: '3',
      },
    });

    this.fileContextManager = new FileContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        getExcludedTags: () => this.plugin.settings.excludedTags,
        onFileOpen: async () => {},
      }
    );

    this.imageContextManager = new ImageContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        onImagesChanged: () => {},
        getMediaFolder: () => this.plugin.settings.mediaFolder,
      }
    );

    this.registerEvent(this.plugin.app.vault.on('create', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('modify', () => this.fileContextManager?.markFilesCacheDirty()));

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

    this.inputEl.addEventListener('keydown', (e) => {
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

    this.inputEl.addEventListener('input', () => this.fileContextManager?.handleInputChange());

    this.registerDomEvent(document, 'click', (e) => {
      if (!this.fileContextManager?.containsElement(e.target as Node) && e.target !== this.inputEl) {
        this.fileContextManager?.hideMentionDropdown();
      }
    });

    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    this.plugin.agentService.setApprovalCallback(this.handleApprovalRequest.bind(this));

    await this.loadActiveConversation();
  }

  async onClose() {
    this.hideThinkingIndicator();
    cleanupThinkingBlock(this.currentThinkingState);
    this.currentThinkingState = null;
    this.plugin.agentService.setApprovalCallback(null);
    this.fileContextManager?.destroy();
    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();
    await this.saveCurrentConversation();
  }

  private async sendMessage() {
    let content = this.inputEl.value.trim();
    if (!content && !this.imageContextManager?.hasImages()) return;
    if (this.isStreaming) return;

    this.inputEl.value = '';
    this.isStreaming = true;
    this.cancelRequested = false;

    this.fileContextManager?.startSession();

    if (content && this.imageContextManager) {
      const result = await this.imageContextManager.handleImagePathInText(content);
      if (result.imageLoaded) {
        content = result.text;
      }
    }

    const images = this.imageContextManager?.getAttachedImages() || [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;

    this.imageContextManager?.clearImages();

    const attachedFiles = this.fileContextManager?.getAttachedFiles() || new Set();
    const currentFiles = Array.from(attachedFiles);
    const filesChanged = this.fileContextManager?.hasFilesChanged() ?? false;

    let promptToSend = content;
    let contextFilesForMessage: string[] | undefined;

    if (filesChanged) {
      if (currentFiles.length > 0) {
        const fileList = currentFiles.join(', ');
        promptToSend = `Context files: [${fileList}]\n\n${content}`;
        contextFilesForMessage = currentFiles;
      } else {
        promptToSend = `Context files: []\n\n${content}`;
        contextFilesForMessage = [];
      }
    }

    this.fileContextManager?.markFilesSent();

    const userMsg: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      contextFiles: contextFilesForMessage,
      images: imagesForMessage,
    };
    this.addMessage(userMsg);

    if (this.messages.length === 1 && this.currentConversationId) {
      const title = this.generateTitle(content);
      await this.plugin.renameConversation(this.currentConversationId, title);
    }

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

    this.toolCallElements.clear();
    this.currentContentEl = contentEl;
    this.currentTextEl = null;
    this.currentTextContent = '';

    this.showThinkingIndicator(contentEl);

    try {
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

      this.finalizeCurrentThinkingBlock(assistantMsg);
      this.finalizeCurrentTextBlock(assistantMsg);
      this.activeSubagents.clear();

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
    if ('parentToolUseId' in chunk && chunk.parentToolUseId) {
      await this.handleSubagentChunk(chunk, msg);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      return;
    }

    if (chunk.type === 'text' || chunk.type === 'tool_use' || chunk.type === 'thinking') {
      this.hideThinkingIndicator();
    }

    switch (chunk.type) {
      case 'thinking':
        if (this.currentTextEl) {
          this.finalizeCurrentTextBlock(msg);
        }
        await this.appendThinking(chunk.content, msg);
        break;

      case 'text':
        if (this.currentThinkingState) {
          this.finalizeCurrentThinkingBlock(msg);
        }
        msg.content += chunk.content;
        await this.appendText(chunk.content);
        break;

      case 'tool_use': {
        if (this.currentThinkingState) {
          this.finalizeCurrentThinkingBlock(msg);
        }
        this.finalizeCurrentTextBlock(msg);

        if (chunk.name === 'Task') {
          const isAsync = this.asyncSubagentManager.isAsyncTask(chunk.input);
          if (isAsync) {
            await this.handleAsyncTaskToolUse(chunk, msg);
          } else {
            await this.handleTaskToolUse(chunk, msg);
          }
          break;
        }

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

          if (chunk.name === 'TodoWrite') {
            const todos = parseTodoInput(chunk.input);
            if (todos) {
              const todoEl = renderTodoList(this.currentContentEl!, todos, true);
              todoEl.dataset.toolId = chunk.id;
              this.toolCallElements.set(chunk.id, todoEl);
            } else {
              renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements, this.plugin.settings.toolCallExpandedByDefault);
            }
          } else if (chunk.name === 'Write' || chunk.name === 'Edit') {
            const state = createWriteEditBlock(this.currentContentEl!, toolCall);
            this.writeEditStates.set(chunk.id, state);
            this.toolCallElements.set(chunk.id, state.wrapperEl);
          } else {
            renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements, this.plugin.settings.toolCallExpandedByDefault);
          }
        }
        break;
      }

      case 'tool_result': {
        const subagentState = this.activeSubagents.get(chunk.id);
        if (subagentState) {
          this.finalizeSubagent(chunk, msg, subagentState);
          break;
        }

        if (this.handleAsyncTaskToolResult(chunk, msg)) {
          if (this.currentContentEl) {
            this.showThinkingIndicator(this.currentContentEl);
          }
          break;
        }

        if (this.handleAgentOutputToolResult(chunk, msg)) {
          if (this.currentContentEl) {
            this.showThinkingIndicator(this.currentContentEl);
          }
          break;
        }

        const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
        const isBlocked = isBlockedToolResult(chunk.content, chunk.isError);

        if (existingToolCall) {
          existingToolCall.status = isBlocked ? 'blocked' : (chunk.isError ? 'error' : 'completed');
          existingToolCall.result = chunk.content;

          const writeEditState = this.writeEditStates.get(chunk.id);
          if (writeEditState && (existingToolCall.name === 'Write' || existingToolCall.name === 'Edit')) {
            if (!chunk.isError && !isBlocked) {
              const diffData = this.plugin.agentService.getDiffData(chunk.id);
              if (diffData) {
                existingToolCall.diffData = diffData;
                updateWriteEditWithDiff(writeEditState, diffData);
              }
            }
            finalizeWriteEditBlock(writeEditState, chunk.isError || isBlocked);
          } else if (this.plugin.settings.showToolUse) {
            updateToolCallResult(chunk.id, existingToolCall, this.toolCallElements);
          }
        }

        this.fileContextManager?.trackEditedFile(
          existingToolCall?.name,
          existingToolCall?.input || {},
          chunk.isError || isBlocked
        );

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

  /** Handles Task tool_use by creating a sync subagent block. */
  private async handleTaskToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage
  ): Promise<void> {
    if (!this.currentContentEl) return;

    const state = createSubagentBlock(this.currentContentEl, chunk.id, chunk.input);
    this.activeSubagents.set(chunk.id, state);

    msg.subagents = msg.subagents || [];
    msg.subagents.push(state.info);

    if (this.plugin.settings.showToolUse) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'subagent', subagentId: chunk.id });
    }
  }

  /** Routes chunks from subagents to the appropriate SubagentRenderer. */
  private async handleSubagentChunk(chunk: StreamChunk, msg: ChatMessage): Promise<void> {
    if (!('parentToolUseId' in chunk) || !chunk.parentToolUseId) {
      return;
    }
    const parentToolUseId = chunk.parentToolUseId;
    const subagentState = this.activeSubagents.get(parentToolUseId);

    if (!subagentState) {
      return;
    }

    switch (chunk.type) {
      case 'tool_use': {
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
        const toolCall = subagentState.info.toolCalls.find(tc => tc.id === chunk.id);
        if (toolCall) {
          const isBlocked = isBlockedToolResult(chunk.content, chunk.isError);
          toolCall.status = isBlocked ? 'blocked' : (chunk.isError ? 'error' : 'completed');
          toolCall.result = chunk.content;
          updateSubagentToolResult(subagentState, chunk.id, toolCall);

          this.fileContextManager?.trackEditedFile(
            toolCall.name,
            toolCall.input || {},
            chunk.isError || isBlocked
          );

          this.plugin.agentService.getDiffData(chunk.id);
        }
        break;
      }

      case 'text':
      case 'thinking':
        break;
    }
  }

  /** Finalizes a sync subagent when its Task tool_result is received. */
  private finalizeSubagent(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    msg: ChatMessage,
    state: SubagentState
  ): void {
    const isError = chunk.isError || false;
    finalizeSubagentBlock(state, chunk.content, isError);

    const subagentInfo = msg.subagents?.find(s => s.id === chunk.id);
    if (subagentInfo) {
      subagentInfo.status = isError ? 'error' : 'completed';
      subagentInfo.result = chunk.content;
    }

    this.activeSubagents.delete(chunk.id);

    if (this.currentContentEl) {
      this.showThinkingIndicator(this.currentContentEl);
    }
  }

  /** Handles async Task tool_use (run_in_background=true). */
  private async handleAsyncTaskToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage
  ): Promise<void> {
    if (!this.currentContentEl) return;

    const subagentInfo = this.asyncSubagentManager.createAsyncSubagent(chunk.id, chunk.input);

    const state = createAsyncSubagentBlock(this.currentContentEl, chunk.id, chunk.input);
    this.asyncSubagentStates.set(chunk.id, state);

    msg.subagents = msg.subagents || [];
    msg.subagents.push(subagentInfo);

    if (this.plugin.settings.showToolUse) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'subagent', subagentId: chunk.id, mode: 'async' });
    }
  }

  /** Handles AgentOutputTool tool_use (invisible, links to async subagent). */
  private handleAgentOutputToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    _msg: ChatMessage
  ): void {
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };

    this.asyncSubagentManager.handleAgentOutputToolUse(toolCall);
  }

  /** Handles async Task tool_result to extract agent_id. */
  private handleAsyncTaskToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    _msg: ChatMessage
  ): boolean {
    if (!this.asyncSubagentManager.isPendingAsyncTask(chunk.id)) {
      return false;
    }

    this.asyncSubagentManager.handleTaskToolResult(chunk.id, chunk.content, chunk.isError);
    return true;
  }

  /** Handles AgentOutputTool result to finalize async subagent. */
  private handleAgentOutputToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    _msg: ChatMessage
  ): boolean {
    const isLinked = this.asyncSubagentManager.isLinkedAgentOutputTool(chunk.id);

    const handled = this.asyncSubagentManager.handleAgentOutputToolResult(
      chunk.id,
      chunk.content,
      chunk.isError || false
    );

    return isLinked || handled !== undefined;
  }

  /** Callback from AsyncSubagentManager when state changes. */
  private onAsyncSubagentStateChange(subagent: SubagentInfo): void {
    const state = this.asyncSubagentStates.get(subagent.id);
    if (!state) {
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

  private updateAsyncSubagentUI(state: AsyncSubagentState, subagent: SubagentInfo): void {
    state.info = subagent;

    switch (subagent.asyncStatus) {
      case 'running':
        updateAsyncSubagentRunning(state, subagent.agentId || '');
        break;

      case 'completed':
      case 'error':
        finalizeAsyncSubagent(state, subagent.result || '', subagent.asyncStatus === 'error');
        break;

      case 'orphaned':
        markAsyncSubagentOrphaned(state);
        break;
    }

    this.updateSubagentInMessages(subagent);

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private updateSubagentInMessages(subagent: SubagentInfo): void {
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

    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
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

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    const close = () => {
      document.removeEventListener('keydown', handleEsc);
      overlay.remove();
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
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

    // Wrap pre elements and move buttons outside scroll area
    el.querySelectorAll('pre').forEach((pre) => {
      // Skip if already wrapped
      if (pre.parentElement?.classList.contains('claudian-code-wrapper')) return;

      // Create wrapper
      const wrapper = createEl('div', { cls: 'claudian-code-wrapper' });
      pre.parentElement?.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      // Check for language class and add label
      const code = pre.querySelector('code[class*="language-"]');
      if (code) {
        const match = code.className.match(/language-(\w+)/);
        if (match) {
          wrapper.classList.add('has-language');
          const label = createEl('span', {
            cls: 'claudian-code-lang-label',
            text: match[1],
          });
          wrapper.appendChild(label);
          label.addEventListener('click', async () => {
            await navigator.clipboard.writeText(code.textContent || '');
            label.setText('copied!');
            setTimeout(() => label.setText(match[1]), 1500);
          });
        }
      }

      // Move Obsidian's copy button outside pre into wrapper
      const copyBtn = pre.querySelector('.copy-code-button');
      if (copyBtn) {
        wrapper.appendChild(copyBtn);
      }
    });
  }

  private async createNewConversation() {
    if (this.isStreaming) return;

    if (this.messages.length > 0) {
      await this.saveCurrentConversation();
    }

    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();

    const conversation = await this.plugin.createConversation();

    this.currentConversationId = conversation.id;
    this.messages = [];
    this.messagesEl.empty();

    this.inputEl.value = '';

    this.fileContextManager?.resetForNewConversation();
    this.fileContextManager?.autoAttachActiveFile();

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

    this.plugin.agentService.setSessionId(conversation.sessionId);

    const hasMessages = this.messages.length > 0;
    this.fileContextManager?.resetForLoadedConversation(hasMessages);

    if (conversation.attachedFiles && conversation.attachedFiles.length > 0) {
      this.fileContextManager?.setAttachedFiles(conversation.attachedFiles);
    } else if (isNewConversation || !hasMessages) {
      this.fileContextManager?.autoAttachActiveFile();
    }

    this.renderMessages();
  }

  private async onConversationSelect(id: string) {
    if (id === this.currentConversationId) return;
    if (this.isStreaming) return;

    await this.saveCurrentConversation();

    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();

    const conversation = await this.plugin.switchConversation(id);
    if (!conversation) return;

    this.currentConversationId = conversation.id;
    this.messages = [...conversation.messages];

    this.inputEl.value = '';

    this.fileContextManager?.resetForLoadedConversation(this.messages.length > 0);

    if (conversation.attachedFiles && conversation.attachedFiles.length > 0) {
      this.fileContextManager?.setAttachedFiles(conversation.attachedFiles);
    }

    this.renderMessages();
    this.historyDropdown?.removeClass('visible');
  }

  private async saveCurrentConversation() {
    if (!this.currentConversationId) return;

    const sessionId = this.plugin.agentService.getSessionId();
    const attachedFiles = this.fileContextManager
      ? Array.from(this.fileContextManager.getAttachedFiles())
      : [];
    await this.plugin.updateConversation(this.currentConversationId, {
      messages: this.getPersistedMessages(),
      sessionId: sessionId,
      attachedFiles: attachedFiles,
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
              // Special rendering for Write/Edit with diff
              } else if (toolCall.name === 'Write' || toolCall.name === 'Edit') {
                renderStoredWriteEdit(contentEl, toolCall);
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
            // Special rendering for Write/Edit with diff
            } else if (toolCall.name === 'Write' || toolCall.name === 'Edit') {
              renderStoredWriteEdit(contentEl, toolCall);
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
