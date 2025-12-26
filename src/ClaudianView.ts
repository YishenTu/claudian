/**
 * Claudian - Sidebar chat view
 *
 * Main chat interface for interacting with Claude. Handles message streaming,
 * tool call rendering, conversation management, and file/image context.
 */

import type { EditorView } from '@codemirror/view';
import type { WorkspaceLeaf } from 'obsidian';
import { ItemView, MarkdownRenderer, MarkdownView, Notice, setIcon } from 'obsidian';

import { getImageAttachmentDataUri } from './images/imageLoader';
import type ClaudianPlugin from './main';
import { AsyncSubagentManager } from './services/AsyncSubagentManager';
import { InstructionRefineService } from './services/InstructionRefineService';
import { isWriteEditTool, TOOL_AGENT_OUTPUT, TOOL_BASH, TOOL_TASK, TOOL_TODO_WRITE } from './tools/toolNames';
import {
  type ChatMessage,
  type ClaudeModel,
  type Conversation,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_THINKING_BUDGET,
  getCurrentPlatformBlockedCommands,
  type ImageAttachment,
  type StreamChunk,
  type SubagentInfo,
  type ThinkingBudget,
  type ToolCallInfo,
  VIEW_TYPE_CLAUDIAN,
} from './types';
import type { AsyncSubagentState, ContextPathSelector, ModelSelector, PermissionToggle, SubagentState, ThinkingBlockState, ThinkingBudgetSelector, WriteEditState } from './ui';
import {
  formatSlashCommandWarnings,
  hideSelectionHighlight,
  showSelectionHighlight,
} from './ui';
import {
  addSubagentToolCall,
  appendThinkingContent,
  ApprovalModal,
  cleanupThinkingBlock,
  createAsyncSubagentBlock,
  createInputToolbar,
  createSubagentBlock,
  createThinkingBlock,
  createWriteEditBlock,
  FileContextManager,
  finalizeAsyncSubagent,
  finalizeSubagentBlock,
  finalizeThinkingBlock,
  finalizeWriteEditBlock,
  ImageContextManager,
  InstructionModal,
  InstructionModeManager,
  isBlockedToolResult,
  markAsyncSubagentOrphaned,
  parseTodoInput,
  renderStoredAsyncSubagent,
  renderStoredSubagent,
  renderStoredThinkingBlock,
  renderStoredTodoList,
  renderStoredToolCall,
  renderStoredWriteEdit,
  renderTodoList,
  renderToolCall,
  SlashCommandDropdown,
  SlashCommandManager,
  updateAsyncSubagentRunning,
  updateSubagentToolResult,
  updateToolCallResult,
  updateWriteEditWithDiff,
} from './ui';
import { appendMarkdownSnippet, type EditorSelectionContext, getVaultPath, isCommandBlocked, prependContextFiles, prependEditorContext } from './utils';

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
  private contextPathSelector: ContextPathSelector | null = null;
  private permissionToggle: PermissionToggle | null = null;
  private slashCommandManager: SlashCommandManager | null = null;
  private slashCommandDropdown: SlashCommandDropdown | null = null;
  private instructionModeManager: InstructionModeManager | null = null;
  private instructionRefineService: InstructionRefineService | null = null;
  private inputWrapper: HTMLElement | null = null;
  private cancelRequested = false;
  private welcomeEl: HTMLElement | null = null;
  private queuedMessage: {
    content: string;
    images?: ImageAttachment[];
    editorContext: EditorSelectionContext | null;
  } | null = null;
  private queueIndicatorEl: HTMLElement | null = null;
  private selectionIndicatorEl: HTMLElement | null = null;
  private storedSelection: {
    notePath: string;
    selectedText: string;
    lineCount: number;
    startLine: number;
    from: number;
    to: number;
    editorView: EditorView;
  } | null = null;
  private selectionPollInterval: ReturnType<typeof setInterval> | null = null;

  private static readonly FLAVOR_TEXTS = [
    // Classic
    'Thinking...',
    'Pondering...',
    'Processing...',
    'Analyzing...',
    'Considering...',
    'Working on it...',
    'One moment...',
    'On it...',
    // Thoughtful
    'Ruminating...',
    'Contemplating...',
    'Reflecting...',
    'Mulling it over...',
    'Let me think...',
    'Hmm...',
    'Cogitating...',
    'Deliberating...',
    'Weighing options...',
    'Gathering thoughts...',
    // Playful
    'Brewing ideas...',
    'Connecting dots...',
    'Assembling thoughts...',
    'Spinning up neurons...',
    'Loading brilliance...',
    'Consulting the oracle...',
    'Summoning knowledge...',
    'Crunching thoughts...',
    'Dusting off neurons...',
    'Wrangling ideas...',
    'Herding thoughts...',
    'Juggling concepts...',
    'Untangling this...',
    'Piecing it together...',
    // Cozy
    'Sipping coffee...',
    'Warming up...',
    'Getting cozy with this...',
    'Settling in...',
    'Making tea...',
    'Grabbing a snack...',
    // Technical
    'Parsing...',
    'Compiling thoughts...',
    'Running inference...',
    'Querying the void...',
    'Defragmenting brain...',
    'Allocating memory...',
    'Optimizing...',
    'Indexing...',
    'Syncing neurons...',
    // Zen
    'Breathing...',
    'Finding clarity...',
    'Channeling focus...',
    'Centering...',
    'Aligning chakras...',
    'Meditating on this...',
    // Whimsical
    'Asking the stars...',
    'Reading tea leaves...',
    'Shaking the magic 8-ball...',
    'Consulting ancient scrolls...',
    'Decoding the matrix...',
    'Communing with the ether...',
    'Peering into the abyss...',
    'Channeling the cosmos...',
    // Action
    'Diving in...',
    'Rolling up sleeves...',
    'Getting to work...',
    'Tackling this...',
    'On the case...',
    'Investigating...',
    'Exploring...',
    'Digging deeper...',
    // Casual
    'Bear with me...',
    'Hang tight...',
    'Just a sec...',
    'Working my magic...',
    'Almost there...',
    'Give me a moment...',
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
    svg.setAttribute('viewBox', '0 -.01 39.5 39.53');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm7.75 26.27 7.77-4.36.13-.38-.13-.21h-.38l-1.3-.08-4.44-.12-3.85-.16-3.73-.2-.94-.2-.88-1.16.09-.58.79-.53 1.13.1 2.5.17 3.75.26 2.72.16 4.03.42h.64l.09-.26-.22-.16-.17-.16-3.88-2.63-4.2-2.78-2.2-1.6-1.19-.81-.6-.76-.26-1.66 1.08-1.19 1.45.1.37.1 1.47 1.13 3.14 2.43 4.1 3.02.6.5.24-.17.03-.12-.27-.45-2.23-4.03-2.38-4.1-1.06-1.7-.28-1.02c-.1-.42-.17-.77-.17-1.2l1.23-1.67.68-.22 1.64.22.69.6 1.02 2.33 1.65 3.67 2.56 4.99.75 1.48.4 1.37.15.42h.26v-.24l.21-2.81.39-3.45.38-4.44.13-1.25.62-1.5 1.23-.81.96.46.79 1.13-.11.73-.47 3.05-.92 4.78-.6 3.2h.35l.4-.4 1.62-2.15 2.72-3.4 1.2-1.35 1.4-1.49.9-.71h1.7l1.25 1.86-.56 1.92-1.75 2.22-1.45 1.88-2.08 2.8-1.3 2.24.12.18.31-.03 4.7-1 2.54-.46 3.03-.52 1.37.64.15.65-.54 1.33-3.24.8-3.8.76-5.66 1.34-.07.05.08.1 2.55.24 1.09.06h2.67l4.97.37 1.3.86.78 1.05-.13.8-2 1.02-2.7-.64-6.3-1.5-2.16-.54h-.3v.18l1.8 1.76 3.3 2.98 4.13 3.84.21.95-.53.75-.56-.08-3.63-2.73-1.4-1.23-3.17-2.67h-.21v.28l.73 1.07 3.86 5.8.2 1.78-.28.58-1 .35-1.1-.2-2.26-3.17-2.33-3.57-1.88-3.2-.23.13-1.11 11.95-.52.61-1.2.46-1-.76-.53-1.23.53-2.43.64-3.17.52-2.52.47-3.13.28-1.04-.02-.07-.23.03-2.36 3.24-3.59 4.85-2.84 3.04-.68.27-1.18-.61.11-1.09.66-.97 3.93-5 2.37-3.1 1.53-1.79-.01-.26h-.09l-10.44 6.78-1.86.24-.8-.75.1-1.23.38-.4 3.14-2.16z');
    path.setAttribute('fill', '#d97757');
    svg.appendChild(path);
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

    // Welcome message - shown when no messages
    this.welcomeEl = this.messagesEl.createDiv({ cls: 'claudian-welcome' });
    this.welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });

    const inputContainerEl = container.createDiv({ cls: 'claudian-input-container' });

    this.inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });

    // Selection indicator (top-right of input wrapper)
    this.selectionIndicatorEl = this.inputWrapper.createDiv({ cls: 'claudian-selection-indicator' });
    this.selectionIndicatorEl.style.display = 'none';

    this.inputEl = this.inputWrapper.createEl('textarea', {
      cls: 'claudian-input',
      attr: {
        placeholder: 'How can I help you today?',
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
        onChipsChanged: () => this.scrollToBottomIfNeeded(),
      }
    );
    this.plugin.agentService.setFileEditTracker(this.fileContextManager);

    this.imageContextManager = new ImageContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        onImagesChanged: () => this.scrollToBottomIfNeeded(),
        getMediaFolder: () => this.plugin.settings.mediaFolder,
      }
    );

    // Initialize slash command manager and dropdown
    const vaultPath = getVaultPath(this.plugin.app);
    if (vaultPath) {
      this.slashCommandManager = new SlashCommandManager(this.plugin.app, vaultPath);
      this.slashCommandManager.setCommands(this.plugin.settings.slashCommands);

      this.slashCommandDropdown = new SlashCommandDropdown(
        inputContainerEl,
        this.inputEl,
        {
          onSelect: () => {
            // Command selected, cursor is now after "/commandName "
          },
          onHide: () => {},
          getCommands: () => this.plugin.settings.slashCommands,
        }
      );
    }

    // Initialize instruction mode manager and refine service
    this.instructionRefineService = new InstructionRefineService(this.plugin);
    this.instructionModeManager = new InstructionModeManager(
      this.inputEl,
      {
        onSubmit: (rawInstruction) => this.handleInstructionSubmit(rawInstruction),
        getInputWrapper: () => this.inputWrapper,
      }
    );

    this.registerEvent(this.plugin.app.vault.on('create', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('modify', () => this.fileContextManager?.markFilesCacheDirty()));

    const inputToolbar = this.inputWrapper.createDiv({ cls: 'claudian-input-toolbar' });
    const toolbarComponents = createInputToolbar(inputToolbar, {
      getSettings: () => ({
        model: this.plugin.settings.model,
        thinkingBudget: this.plugin.settings.thinkingBudget,
        permissionMode: this.plugin.settings.permissionMode,
        allowedContextPaths: this.plugin.settings.allowedContextPaths,
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
      onContextPathsChange: async (paths) => {
        this.plugin.settings.allowedContextPaths = paths;
        await this.plugin.saveSettings();
      },
    });
    this.modelSelector = toolbarComponents.modelSelector;
    this.thinkingBudgetSelector = toolbarComponents.thinkingBudgetSelector;
    this.contextPathSelector = toolbarComponents.contextPathSelector;
    this.permissionToggle = toolbarComponents.permissionToggle;

    this.inputEl.addEventListener('keydown', (e) => {
      // Check instruction mode first (# at start)
      if (this.instructionModeManager?.handleKeydown(e)) {
        return;
      }

      // Check slash command dropdown
      if (this.slashCommandDropdown?.handleKeydown(e)) {
        return;
      }

      if (this.fileContextManager?.handleMentionKeydown(e)) {
        return;
      }

      if (e.key === 'Escape' && this.isStreaming) {
        e.preventDefault();
        this.cancelStreaming();
        return;
      }

      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      // When composing, Enter confirms the character input, not sends the message
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.inputEl.addEventListener('input', () => {
      this.fileContextManager?.handleInputChange();
      this.instructionModeManager?.handleInputChange();
    });

    // Show selection highlight when input is focused
    this.inputEl.addEventListener('focus', () => {
      this.showStoredSelectionHighlight();
    });

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

    // Poll for editor selection changes to update indicator
    this.selectionPollInterval = setInterval(() => {
      this.pollEditorSelection();
    }, 250);

    await this.loadActiveConversation();
  }

  async onClose() {
    if (this.selectionPollInterval) {
      clearInterval(this.selectionPollInterval);
      this.selectionPollInterval = null;
    }
    this.clearStoredSelection();
    this.hideThinkingIndicator();
    cleanupThinkingBlock(this.currentThinkingState);
    this.currentThinkingState = null;
    this.plugin.agentService.setApprovalCallback(null);
    this.plugin.agentService.setFileEditTracker(null);
    this.fileContextManager?.destroy();
    this.slashCommandDropdown?.destroy();
    this.slashCommandDropdown = null;
    this.slashCommandManager = null;
    this.instructionModeManager?.destroy();
    this.instructionModeManager = null;
    this.instructionRefineService?.cancel();
    this.instructionRefineService = null;
    this.asyncSubagentManager.orphanAllActive();
    this.asyncSubagentStates.clear();
    await this.saveCurrentConversation();
  }

  private async sendMessage(options?: { editorContextOverride?: EditorSelectionContext | null }): Promise<void> {
    let content = this.inputEl.value.trim();
    const hasImages = this.imageContextManager?.hasImages() ?? false;
    if (!content && !hasImages) return;

    // If agent is working, queue the message instead of dropping it
    if (this.isStreaming) {
      const images = hasImages ? [...(this.imageContextManager?.getAttachedImages() || [])] : undefined;
      const editorContext = this.getStoredSelectionContext();

      // Append to existing queued message if any
      if (this.queuedMessage) {
        this.queuedMessage.content += '\n\n' + content;
        // Merge images if any
        if (images && images.length > 0) {
          this.queuedMessage.images = [...(this.queuedMessage.images || []), ...images];
        }
        this.queuedMessage.editorContext = editorContext;
      } else {
        this.queuedMessage = { content, images, editorContext };
      }

      this.inputEl.value = '';
      this.imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

    this.inputEl.value = '';
    this.isStreaming = true;
    this.cancelRequested = false;

    // Hide welcome message when sending first message
    if (this.welcomeEl) {
      this.welcomeEl.style.display = 'none';
    }

    this.fileContextManager?.startSession();

    // Check for slash command and expand it
    // displayContent: what user sees in chat (e.g., "/tests")
    // content: what gets sent to agent (expanded prompt)
    const displayContent = content;
    let queryOptions: { allowedTools?: string[]; model?: string } | undefined;
    if (content && this.slashCommandManager) {
      // Refresh commands from settings to pick up any changes
      this.slashCommandManager.setCommands(this.plugin.settings.slashCommands);
      const detected = this.slashCommandManager.detectCommand(content);
      if (detected) {
        const cmd = this.plugin.settings.slashCommands.find(
          c => c.name.toLowerCase() === detected.commandName.toLowerCase()
        );
        if (cmd) {
          const result = await this.slashCommandManager.expandCommand(cmd, detected.args, {
            bash: {
              enabled: true,
              shouldBlockCommand: (bashCommand) =>
                isCommandBlocked(
                  bashCommand,
                  getCurrentPlatformBlockedCommands(this.plugin.settings.blockedCommands),
                  this.plugin.settings.enableBlocklist
                ),
              requestApproval:
                this.plugin.settings.permissionMode === 'normal'
                  ? (bashCommand) => this.requestInlineBashApproval(bashCommand)
                  : undefined,
            },
          });
          // Keep displayContent as original "/command args", update content to expanded
          content = result.expandedPrompt;

          if (result.errors.length > 0) {
            new Notice(formatSlashCommandWarnings(result.errors));
          }

          // Set query options if command has overrides
          if (result.allowedTools || result.model) {
            queryOptions = {
              allowedTools: result.allowedTools,
              model: result.model,
            };
          }
        }
      }
    }

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

    const editorContextOverride = options?.editorContextOverride;
    const editorContext = editorContextOverride !== undefined
      ? editorContextOverride
      : this.getStoredSelectionContext();

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

    this.fileContextManager?.markFilesSent();

    const userMsg: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content,  // Store expanded prompt in history
      displayContent: displayContent !== content ? displayContent : undefined,  // Only set if different (e.g., "/tests")
      timestamp: Date.now(),
      contextFiles: contextFilesForMessage,
      images: imagesForMessage,
    };
    this.addMessage(userMsg);

    if (this.messages.length === 1 && this.currentConversationId) {
      const title = this.generateTitle(displayContent);  // Use original "/tests" for title
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

    let wasInterrupted = false;
    try {
      for await (const chunk of this.plugin.agentService.query(promptToSend, imagesForMessage, this.messages, queryOptions)) {
        if (this.cancelRequested) {
          wasInterrupted = true;
          break;
        }
        await this.handleStreamChunk(chunk, assistantMsg);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.appendText(`\n\n**Error:** ${errorMsg}`);
    } finally {
      if (wasInterrupted) {
        await this.appendText('\n\n<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>');
      }
      this.hideThinkingIndicator();
      this.isStreaming = false;
      this.cancelRequested = false;
      this.currentContentEl = null;

      this.finalizeCurrentThinkingBlock(assistantMsg);
      this.finalizeCurrentTextBlock(assistantMsg);
      this.activeSubagents.clear();

      await this.saveCurrentConversation(true); // Update lastResponseAt on agent completion

      // Process queued message if any
      this.processQueuedMessage();
    }
  }

  /** Updates the queue indicator UI to show/hide queued message status. */
  private updateQueueIndicator(): void {
    if (!this.queueIndicatorEl) return;

    if (this.queuedMessage) {
      const rawContent = this.queuedMessage.content.trim();
      const preview = rawContent.length > 40
        ? rawContent.slice(0, 40) + '...'
        : rawContent;
      const hasImages = (this.queuedMessage.images?.length ?? 0) > 0;
      let display = preview;

      if (hasImages) {
        display = display ? `${display} [images]` : '[images]';
      }

      this.queueIndicatorEl.setText(`⌙ Queued: ${display}`);
      this.queueIndicatorEl.style.display = 'block';
    } else {
      this.queueIndicatorEl.style.display = 'none';
    }
  }

  /** Clears the queued message. */
  private clearQueuedMessage(): void {
    this.queuedMessage = null;
    this.updateQueueIndicator();
  }

  /** Processes the queued message by setting it as input and triggering send. */
  private processQueuedMessage(): void {
    if (!this.queuedMessage) return;

    const { content, images, editorContext } = this.queuedMessage;
    this.queuedMessage = null;
    this.updateQueueIndicator();

    // Set the content and images, then send
    this.inputEl.value = content;
    if (images && images.length > 0) {
      this.imageContextManager?.setImages(images);
    }

    // Use setTimeout to ensure the UI updates before sending
    setTimeout(() => this.sendMessage({ editorContextOverride: editorContext }), 0);
  }

  /** Handles instruction mode submission - opens modal immediately and refines. */
  private async handleInstructionSubmit(rawInstruction: string): Promise<void> {
    if (!this.instructionRefineService) return;

    const existingPrompt = this.plugin.settings.systemPrompt;
    let modal: InstructionModal | null = null;
    let wasCancelled = false;

    try {
      // Open modal immediately in loading state
      modal = new InstructionModal(
        this.plugin.app,
        rawInstruction,
        {
          onAccept: async (finalInstruction) => {
            // Append to system prompt
            const currentPrompt = this.plugin.settings.systemPrompt;
            this.plugin.settings.systemPrompt = appendMarkdownSnippet(currentPrompt, finalInstruction);
            await this.plugin.saveSettings();

            new Notice('Instruction added to custom system prompt');
            this.instructionModeManager?.clear();
          },
          onReject: () => {
            wasCancelled = true;
            this.instructionRefineService?.cancel();
            this.instructionModeManager?.clear();
          },
          onClarificationSubmit: async (response) => {
            // Continue conversation with user's response
            const result = await this.instructionRefineService!.continueConversation(response);

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
              // Another clarification needed
              modal?.showClarification(result.clarification);
            } else if (result.refinedInstruction) {
              // Got final instruction
              modal?.showConfirmation(result.refinedInstruction);
            }
          }
        }
      );
      modal.open();

      // Start refining (modal shows loading state)
      this.instructionRefineService.resetConversation();
      const result = await this.instructionRefineService.refineInstruction(
        rawInstruction,
        existingPrompt
      );

      if (wasCancelled) {
        return;
      }

      if (!result.success) {
        if (result.error === 'Cancelled') {
          this.instructionModeManager?.clear();
          return;
        }
        new Notice(result.error || 'Failed to refine instruction');
        modal.showError(result.error || 'Failed to refine instruction');
        this.instructionModeManager?.clear();
        return;
      }

      if (result.clarification) {
        // Agent needs clarification
        modal.showClarification(result.clarification);
      } else if (result.refinedInstruction) {
        // Got final instruction - show confirmation
        modal.showConfirmation(result.refinedInstruction);
      } else {
        new Notice('No instruction received');
        modal.showError('No instruction received');
        this.instructionModeManager?.clear();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error: ${errorMsg}`);
      modal?.showError(errorMsg);
      this.instructionModeManager?.clear();
    }
  }

  private showThinkingIndicator(parentEl: HTMLElement) {
    if (this.thinkingEl) {
      // Re-append to ensure it's at the bottom
      parentEl.appendChild(this.thinkingEl);
      this.updateQueueIndicator();
      return;
    }

    this.thinkingEl = parentEl.createDiv({ cls: 'claudian-thinking' });
    const texts = ClaudianView.FLAVOR_TEXTS;
    const randomText = texts[Math.floor(Math.random() * texts.length)];
    this.thinkingEl.createSpan({ text: randomText });
    this.thinkingEl.createSpan({ text: ' (esc to interrupt)', cls: 'claudian-thinking-hint' });

    // Queue indicator line (initially hidden)
    this.queueIndicatorEl = this.thinkingEl.createDiv({ cls: 'claudian-queue-indicator' });
    this.updateQueueIndicator();
  }

  private cancelStreaming() {
    if (!this.isStreaming) return;
    this.cancelRequested = true;
    this.clearQueuedMessage();
    this.plugin.agentService.cancel();
    this.hideThinkingIndicator();
  }

  /** Scrolls to bottom if already near bottom (within 100px threshold). */
  private scrollToBottomIfNeeded() {
    if (!this.messagesEl) return;
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    if (isNearBottom) {
      // Use requestAnimationFrame to ensure layout has updated
      requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    }
  }

  private async handleStreamChunk(chunk: StreamChunk, msg: ChatMessage) {
    if ('parentToolUseId' in chunk && chunk.parentToolUseId) {
      await this.handleSubagentChunk(chunk, msg);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      return;
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
        if (this.currentContentEl) {
          this.showThinkingIndicator(this.currentContentEl);
        }
        break;

      case 'tool_use': {
        if (this.currentThinkingState) {
          this.finalizeCurrentThinkingBlock(msg);
        }
        this.finalizeCurrentTextBlock(msg);

        if (chunk.name === TOOL_TASK) {
          const isAsync = this.asyncSubagentManager.isAsyncTask(chunk.input);
          if (isAsync) {
            await this.handleAsyncTaskToolUse(chunk, msg);
          } else {
            await this.handleTaskToolUse(chunk, msg);
          }
          break;
        }

        if (chunk.name === TOOL_AGENT_OUTPUT) {
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

          if (chunk.name === TOOL_TODO_WRITE) {
            const todos = parseTodoInput(chunk.input);
            if (todos) {
              const todoEl = renderTodoList(this.currentContentEl!, todos, true);
              todoEl.dataset.toolId = chunk.id;
              this.toolCallElements.set(chunk.id, todoEl);
            } else {
              renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements, this.plugin.settings.toolCallExpandedByDefault);
            }
          } else if (isWriteEditTool(chunk.name)) {
            const state = createWriteEditBlock(this.currentContentEl!, toolCall);
            this.writeEditStates.set(chunk.id, state);
            this.toolCallElements.set(chunk.id, state.wrapperEl);
          } else {
            renderToolCall(this.currentContentEl!, toolCall, this.toolCallElements, this.plugin.settings.toolCallExpandedByDefault);
          }
        }
        if (this.currentContentEl) {
          this.showThinkingIndicator(this.currentContentEl);
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
          if (writeEditState && isWriteEditTool(existingToolCall.name)) {
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

    this.hideThinkingIndicator();
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
    if (this.currentContentEl) {
      this.showThinkingIndicator(this.currentContentEl);
    }

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

    if (this.currentContentEl) {
      this.showThinkingIndicator(this.currentContentEl);
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
        if (this.currentContentEl) {
          this.showThinkingIndicator(this.currentContentEl);
        }
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

    if (this.currentContentEl) {
      this.showThinkingIndicator(this.currentContentEl);
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
      for (const s of this.asyncSubagentStates.values()) {
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

    // For user messages, check if there's text content to show
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      // Skip creating empty bubble for image-only messages
      if (!textToShow) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        // Return the images container or create a placeholder
        const lastChild = this.messagesEl.lastElementChild as HTMLElement;
        return lastChild ?? this.messagesEl;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        this.renderContent(textEl, textToShow);
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
    const dataUri = getImageAttachmentDataUri(this.plugin.app, image);
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
    const dataUri = getImageAttachmentDataUri(this.plugin.app, image);
    if (dataUri) {
      imgEl.setAttribute('src', dataUri);
    } else {
      imgEl.setAttribute('alt', `${image.name} (missing)`);
    }
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

    // Recreate welcome element after clearing messages
    this.welcomeEl = this.messagesEl.createDiv({ cls: 'claudian-welcome' });
    this.welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });

    this.inputEl.value = '';

    this.fileContextManager?.resetForNewConversation();
    this.fileContextManager?.autoAttachActiveFile();

    this.imageContextManager?.clearImages();
    this.clearQueuedMessage();
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
    this.updateWelcomeVisibility();
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
    this.clearQueuedMessage();

    this.fileContextManager?.resetForLoadedConversation(this.messages.length > 0);

    if (conversation.attachedFiles && conversation.attachedFiles.length > 0) {
      this.fileContextManager?.setAttachedFiles(conversation.attachedFiles);
    }

    this.renderMessages();
    this.historyDropdown?.removeClass('visible');
  }

  private async saveCurrentConversation(updateLastResponse = false) {
    if (!this.currentConversationId) return;

    const sessionId = this.plugin.agentService.getSessionId();
    const attachedFiles = this.fileContextManager
      ? Array.from(this.fileContextManager.getAttachedFiles())
      : [];
    const updates: Partial<Conversation> = {
      messages: this.getPersistedMessages(),
      sessionId: sessionId,
      attachedFiles: attachedFiles,
    };
    if (updateLastResponse) {
      updates.lastResponseAt = Date.now();
    }
    await this.plugin.updateConversation(this.currentConversationId, updates);
  }

  private renderMessages() {
    this.messagesEl.empty();

    // Recreate welcome element after clearing
    this.welcomeEl = this.messagesEl.createDiv({ cls: 'claudian-welcome' });
    this.welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });

    for (const msg of this.messages) {
      this.renderStoredMessage(msg);
    }

    this.updateWelcomeVisibility();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderStoredMessage(msg: ChatMessage) {
    // For user messages with images, render images above the bubble
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // For user messages, skip creating empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        return;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      // Use displayContent for UI (e.g., "/tests"), fall back to content
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        this.renderContent(textEl, textToShow);
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
              if (toolCall.name === TOOL_TODO_WRITE) {
                renderStoredTodoList(contentEl, toolCall.input);
              // Special rendering for Write/Edit with diff
              } else if (isWriteEditTool(toolCall.name)) {
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
            if (toolCall.name === TOOL_TODO_WRITE) {
              renderStoredTodoList(contentEl, toolCall.input);
            // Special rendering for Write/Edit with diff
            } else if (isWriteEditTool(toolCall.name)) {
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

    // Sort by lastResponseAt (fallback to createdAt) descending
    const conversations = [...allConversations].sort((a, b) => {
      return (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt);
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
        text: isCurrent ? 'Current session' : this.formatDate(conv.lastResponseAt ?? conv.createdAt),
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
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Polls editor selection and updates stored selection (called by interval). */
  private pollEditorSelection(): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;
    const editorView = (editor as any).cm as EditorView;
    if (!editorView) return;

    const selectedText = editor.getSelection();

    if (selectedText.trim()) {
      // Get selection range
      const fromPos = editor.getCursor('from');
      const toPos = editor.getCursor('to');
      const from = editor.posToOffset(fromPos);
      const to = editor.posToOffset(toPos);
      const startLine = fromPos.line + 1; // 1-indexed for display

      const notePath = view.file?.path || 'unknown';
      const lineCount = selectedText.split(/\r?\n/).length;
      const sameRange = this.storedSelection
        && this.storedSelection.editorView === editorView
        && this.storedSelection.from === from
        && this.storedSelection.to === to
        && this.storedSelection.notePath === notePath;
      const sameText = sameRange && this.storedSelection?.selectedText === selectedText;
      const sameLineCount = sameRange && this.storedSelection?.lineCount === lineCount;
      const sameStartLine = sameRange && this.storedSelection?.startLine === startLine;

      if (!sameRange || !sameText || !sameLineCount || !sameStartLine) {
        if (this.storedSelection && !sameRange) {
          this.clearStoredSelectionHighlight();
        }
        this.storedSelection = { notePath, selectedText, lineCount, startLine, from, to, editorView };
        this.updateSelectionIndicator();
      }
    } else if (document.activeElement !== this.inputEl) {
      // No selection AND input not focused = user cleared selection in editor
      this.clearStoredSelectionHighlight();
      this.storedSelection = null;
      this.updateSelectionIndicator();
    }
    // If no selection but input IS focused, keep storedSelection (user clicked input)
  }

  /** Shows the selection highlight in the editor using shared utility. */
  private showStoredSelectionHighlight(): void {
    if (!this.storedSelection) return;
    const { from, to, editorView } = this.storedSelection;
    showSelectionHighlight(editorView, from, to);
  }

  /** Clears the selection highlight from the editor using shared utility. */
  private clearStoredSelectionHighlight(): void {
    if (!this.storedSelection) return;
    hideSelectionHighlight(this.storedSelection.editorView);
  }

  /** Updates selection indicator based on stored selection (matches system prompt logic). */
  private updateSelectionIndicator(): void {
    if (!this.selectionIndicatorEl) return;

    if (this.storedSelection) {
      const lineText = this.storedSelection.lineCount === 1 ? 'line' : 'lines';
      this.selectionIndicatorEl.textContent = `${this.storedSelection.lineCount} ${lineText} selected`;
      this.selectionIndicatorEl.style.display = 'block';
    } else {
      this.selectionIndicatorEl.style.display = 'none';
    }
  }

  /** Returns stored selection as EditorSelectionContext, or null if none. */
  private getStoredSelectionContext(): EditorSelectionContext | null {
    if (!this.storedSelection) return null;
    return {
      notePath: this.storedSelection.notePath,
      mode: 'selection',
      selectedText: this.storedSelection.selectedText,
      lineCount: this.storedSelection.lineCount,
      startLine: this.storedSelection.startLine,
    };
  }

  /** Clears the stored selection and highlight. */
  private clearStoredSelection(): void {
    this.clearStoredSelectionHighlight();
    this.storedSelection = null;
    this.updateSelectionIndicator();
  }

  private getGreeting(): string {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const name = this.plugin.settings.userName?.trim();

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

  private updateWelcomeVisibility(): void {
    if (!this.welcomeEl) return;
    if (this.messages.length === 0) {
      this.welcomeEl.style.display = '';
    } else {
      this.welcomeEl.style.display = 'none';
    }
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

  private async requestInlineBashApproval(command: string): Promise<boolean> {
    const description = `Execute inline bash command:\n${command}`;
    return new Promise((resolve) => {
      const modal = new ApprovalModal(
        this.plugin.app,
        TOOL_BASH,
        { command },
        description,
        (decision) => resolve(decision === 'allow' || decision === 'allow-always'),
        { showAlwaysAllow: false, title: 'Inline bash execution' }
      );
      modal.open();
    });
  }

  private hideThinkingIndicator() {
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
    this.queueIndicatorEl = null;
  }
}
