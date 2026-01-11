/**
 * Claudian - Sidebar chat view
 *
 * Main chat interface for interacting with Claude. This is a thin shell that
 * delegates to specialized controllers for different concerns.
 */

import type { WorkspaceLeaf } from 'obsidian';
import { ItemView, setIcon } from 'obsidian';

import { SlashCommandManager } from '../../core/commands';
import type { ClaudeModel, ThinkingBudget } from '../../core/types';
import { DEFAULT_CLAUDE_MODELS, DEFAULT_THINKING_BUDGET, VIEW_TYPE_CLAUDIAN } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { SlashCommandDropdown } from '../../shared/components/SlashCommandDropdown';
import { getVaultPath } from '../../utils/path';
import { LOGO_SVG } from './constants';
import {
  ConversationController,
  InputController,
  NavigationController,
  SelectionController,
  StreamController,
} from './controllers';
import { cleanupThinkingBlock, MessageRenderer } from './rendering';
import { AsyncSubagentManager } from './services/AsyncSubagentManager';
import { InstructionRefineService } from './services/InstructionRefineService';
import { TitleGenerationService } from './services/TitleGenerationService';
import { ChatState } from './state';
import {
  type ContextUsageMeter,
  createInputToolbar,
  type ExternalContextSelector,
  FileContextManager,
  ImageContextManager,
  type InstructionModeManager,
  InstructionModeManager as InstructionModeManagerClass,
  type McpServerSelector,
  type ModelSelector,
  type PermissionToggle,
  type ThinkingBudgetSelector,
  TodoPanel,
} from './ui';

/** Main sidebar chat view for interacting with Claude. */
export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;

  // State - public for test access
  public readonly state: ChatState;

  // Controllers
  private selectionController: SelectionController | null = null;
  private conversationController: ConversationController | null = null;
  private streamController: StreamController | null = null;
  private inputController: InputController | null = null;
  private navigationController: NavigationController | null = null;

  // Rendering
  private renderer: MessageRenderer | null = null;

  // Services
  private asyncSubagentManager: AsyncSubagentManager;
  private instructionRefineService: InstructionRefineService | null = null;
  private titleGenerationService: TitleGenerationService | null = null;

  // DOM Elements
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private inputWrapper: HTMLElement | null = null;
  private historyDropdown: HTMLElement | null = null;
  private welcomeEl: HTMLElement | null = null;
  private selectionIndicatorEl: HTMLElement | null = null;

  // UI Components
  public fileContextManager: FileContextManager | null = null;
  private imageContextManager: ImageContextManager | null = null;
  private modelSelector: ModelSelector | null = null;
  private thinkingBudgetSelector: ThinkingBudgetSelector | null = null;
  private externalContextSelector: ExternalContextSelector | null = null;
  private mcpServerSelector: McpServerSelector | null = null;
  private permissionToggle: PermissionToggle | null = null;
  private slashCommandManager: SlashCommandManager | null = null;
  private slashCommandDropdown: SlashCommandDropdown | null = null;
  private instructionModeManager: InstructionModeManager | null = null;
  private contextUsageMeter: ContextUsageMeter | null = null;
  private todoPanel: TodoPanel | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudianPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = new ChatState({
      onUsageChanged: (usage) => this.contextUsageMeter?.update(usage),
      onTodosChanged: (todos) => this.todoPanel?.updateTodos(todos),
    });
    this.asyncSubagentManager = new AsyncSubagentManager(
      (subagent) => this.streamController?.onAsyncSubagentStateChange(subagent)
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

  /** Refreshes the model selector display (used after env var changes). */
  refreshModelSelector(): void {
    this.modelSelector?.updateDisplay();
    this.modelSelector?.renderOptions();
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('claudian-container');

    // Build header
    const header = container.createDiv({ cls: 'claudian-header' });
    this.buildHeader(header);

    // Build messages area
    this.messagesEl = container.createDiv({ cls: 'claudian-messages' });

    // Welcome message
    this.welcomeEl = this.messagesEl.createDiv({ cls: 'claudian-welcome' });

    // Create todo panel (mounts to messages area, shows at bottom)
    this.todoPanel = new TodoPanel();
    this.todoPanel.mount(this.messagesEl);

    // Build input area
    const inputContainerEl = container.createDiv({ cls: 'claudian-input-container' });
    this.buildInputArea(inputContainerEl);

    // Initialize renderer
    this.renderer = new MessageRenderer(
      this.plugin,
      this,
      this.messagesEl
    );

    // Initialize controllers
    this.initializeControllers();

    // Wire up event handlers
    this.wireEventHandlers();

    // Start selection polling
    this.selectionController?.start();

    // Load conversation
    await this.conversationController?.loadActive();
  }

  async onClose() {
    // Stop polling
    this.selectionController?.stop();
    this.selectionController?.clear();

    // Cleanup navigation controller
    this.navigationController?.dispose();

    // Cleanup thinking state
    cleanupThinkingBlock(this.state.currentThinkingState);
    this.state.currentThinkingState = null;

    // Cleanup services
    this.plugin.agentService.setApprovalCallback(null);

    // Cleanup UI components
    this.fileContextManager?.destroy();
    this.slashCommandDropdown?.destroy();
    this.slashCommandDropdown = null;
    this.slashCommandManager = null;
    this.instructionModeManager?.destroy();
    this.instructionModeManager = null;
    this.instructionRefineService?.cancel();
    this.instructionRefineService = null;
    this.titleGenerationService?.cancel();
    this.titleGenerationService = null;
    this.todoPanel?.destroy();
    this.todoPanel = null;

    // Cleanup async subagents
    this.asyncSubagentManager.orphanAllActive();
    this.state.asyncSubagentStates.clear();

    // Save conversation
    await this.conversationController?.save();
  }

  // ============================================
  // UI Building
  // ============================================

  private buildHeader(header: HTMLElement) {
    const titleContainer = header.createDiv({ cls: 'claudian-title' });
    const logoEl = titleContainer.createSpan({ cls: 'claudian-logo' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', LOGO_SVG.viewBox);
    svg.setAttribute('width', LOGO_SVG.width);
    svg.setAttribute('height', LOGO_SVG.height);
    svg.setAttribute('fill', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', LOGO_SVG.path);
    path.setAttribute('fill', LOGO_SVG.fill);
    svg.appendChild(path);
    logoEl.appendChild(svg);
    titleContainer.createEl('h4', { text: 'Claudian' });

    const headerActions = header.createDiv({ cls: 'claudian-header-actions' });

    // History dropdown
    const historyContainer = headerActions.createDiv({ cls: 'claudian-history-container' });
    const trigger = historyContainer.createDiv({ cls: 'claudian-header-btn' });
    setIcon(trigger, 'history');
    trigger.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.conversationController?.toggleHistoryDropdown();
    });

    // New conversation button
    const newBtn = headerActions.createDiv({ cls: 'claudian-header-btn' });
    setIcon(newBtn, 'plus');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.conversationController?.createNew());
  }

  private buildInputArea(inputContainerEl: HTMLElement) {
    this.inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });

    // Input textarea
    this.inputEl = this.inputWrapper.createEl('textarea', {
      cls: 'claudian-input',
      attr: {
        placeholder: 'How can I help you today?',
        rows: '3',
      },
    });

    // File context manager
    this.fileContextManager = new FileContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        getExcludedTags: () => this.plugin.settings.excludedTags,
        onChipsChanged: () => this.renderer?.scrollToBottomIfNeeded(),
        getExternalContexts: () => this.externalContextSelector?.getExternalContexts() || [],
      }
    );
    this.fileContextManager.setMcpService(this.plugin.mcpService);

    // Image context manager (must be before context row wrapper)
    this.imageContextManager = new ImageContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        onImagesChanged: () => this.renderer?.scrollToBottomIfNeeded(),
      }
    );

    // Context row wrapper (holds file chip and selection indicator)
    // Created after ImageContextManager so it sees the original DOM structure
    const fileIndicatorEl = inputContainerEl.querySelector('.claudian-file-indicator');
    if (fileIndicatorEl) {
      const contextRowEl = inputContainerEl.createDiv({ cls: 'claudian-context-row' });
      inputContainerEl.insertBefore(contextRowEl, fileIndicatorEl);
      contextRowEl.appendChild(fileIndicatorEl);
      this.selectionIndicatorEl = contextRowEl.createDiv({ cls: 'claudian-selection-indicator' });
    } else {
      // Fallback: create indicator directly if file indicator was not created
      this.selectionIndicatorEl = inputContainerEl.createDiv({ cls: 'claudian-selection-indicator' });
    }
    this.selectionIndicatorEl.style.display = 'none';

    // Slash command manager
    const vaultPath = getVaultPath(this.plugin.app);
    if (vaultPath) {
      this.slashCommandManager = new SlashCommandManager(this.plugin.app, vaultPath);
      this.slashCommandManager.setCommands(this.plugin.settings.slashCommands);

      this.slashCommandDropdown = new SlashCommandDropdown(
        inputContainerEl,
        this.inputEl,
        {
          onSelect: () => { },
          onHide: () => { },
          getCommands: () => this.plugin.settings.slashCommands,
        }
      );
    }

    // Instruction mode manager
    this.instructionRefineService = new InstructionRefineService(this.plugin);
    this.titleGenerationService = new TitleGenerationService(this.plugin);
    this.instructionModeManager = new InstructionModeManagerClass(
      this.inputEl,
      {
        onSubmit: async (rawInstruction) => {
          await this.inputController?.handleInstructionSubmit(rawInstruction);
        },
        getInputWrapper: () => this.inputWrapper,
      }
    );

    // Input toolbar
    const inputToolbar = this.inputWrapper.createDiv({ cls: 'claudian-input-toolbar' });
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
    this.contextUsageMeter = toolbarComponents.contextUsageMeter;
    this.externalContextSelector = toolbarComponents.externalContextSelector;
    this.mcpServerSelector = toolbarComponents.mcpServerSelector;
    this.permissionToggle = toolbarComponents.permissionToggle;

    // Wire MCP service
    this.mcpServerSelector.setMcpService(this.plugin.mcpService);

    // Sync @-mentions to UI selector so icon glows when MCP is mentioned
    this.fileContextManager?.setOnMcpMentionChange((servers) => {
      this.mcpServerSelector?.addMentionedServers(servers);
    });

    // Wire external context changes to pre-scan files
    this.externalContextSelector.setOnChange(() => {
      this.fileContextManager?.preScanExternalContexts();
    });

    // Initialize persistent paths from settings
    this.externalContextSelector.setPersistentPaths(
      this.plugin.settings.persistentExternalContextPaths || []
    );

    // Wire persistence changes to save to settings
    this.externalContextSelector.setOnPersistenceChange(async (paths) => {
      this.plugin.settings.persistentExternalContextPaths = paths;
      await this.plugin.saveSettings();
    });
  }

  // ============================================
  // Controller Initialization
  // ============================================

  private initializeControllers() {
    // Selection controller
    this.selectionController = new SelectionController(
      this.plugin.app,
      this.selectionIndicatorEl!,
      this.inputEl!
    );

    // Stream controller
    this.streamController = new StreamController({
      plugin: this.plugin,
      state: this.state,
      renderer: this.renderer!,
      asyncSubagentManager: this.asyncSubagentManager,
      getMessagesEl: () => this.messagesEl!,
      getFileContextManager: () => this.fileContextManager,
      updateQueueIndicator: () => this.inputController?.updateQueueIndicator(),
    });

    // Conversation controller
    this.conversationController = new ConversationController(
      {
        plugin: this.plugin,
        state: this.state,
        renderer: this.renderer!,
        asyncSubagentManager: this.asyncSubagentManager,
        getHistoryDropdown: () => this.historyDropdown,
        getWelcomeEl: () => this.welcomeEl,
        setWelcomeEl: (el) => { this.welcomeEl = el; },
        getMessagesEl: () => this.messagesEl!,
        getInputEl: () => this.inputEl!,
        getFileContextManager: () => this.fileContextManager,
        getImageContextManager: () => this.imageContextManager,
        getMcpServerSelector: () => this.mcpServerSelector,
        getExternalContextSelector: () => this.externalContextSelector,
        clearQueuedMessage: () => this.inputController?.clearQueuedMessage(),
        getTitleGenerationService: () => this.titleGenerationService,
        getTodoPanel: () => this.todoPanel,
      },
      {}
    );

    // Input controller
    this.inputController = new InputController({
      plugin: this.plugin,
      state: this.state,
      renderer: this.renderer!,
      streamController: this.streamController,
      selectionController: this.selectionController,
      conversationController: this.conversationController,
      getInputEl: () => this.inputEl!,
      getWelcomeEl: () => this.welcomeEl,
      getMessagesEl: () => this.messagesEl!,
      getFileContextManager: () => this.fileContextManager,
      getImageContextManager: () => this.imageContextManager,
      getSlashCommandManager: () => this.slashCommandManager,
      getMcpServerSelector: () => this.mcpServerSelector,
      getExternalContextSelector: () => this.externalContextSelector,
      getInstructionModeManager: () => this.instructionModeManager,
      getInstructionRefineService: () => this.instructionRefineService,
      getTitleGenerationService: () => this.titleGenerationService,
      generateId: () => this.generateId(),
      resetContextMeter: () => this.contextUsageMeter?.update(null),
    });

    // Set approval callback
    this.plugin.agentService.setApprovalCallback(
      (toolName, input, description) => this.inputController!.handleApprovalRequest(toolName, input, description)
    );

    // Navigation controller (vim-style keyboard navigation)
    this.navigationController = new NavigationController({
      getMessagesEl: () => this.messagesEl!,
      getInputEl: () => this.inputEl!,
      getSettings: () => this.plugin.settings.keyboardNavigation,
      isStreaming: () => this.state.isStreaming,
      shouldSkipEscapeHandling: () => {
        // Skip if instruction mode, slash dropdown, or mention dropdown is active
        if (this.instructionModeManager?.isActive()) return true;
        if (this.slashCommandDropdown?.isVisible()) return true;
        if (this.fileContextManager?.isMentionDropdownVisible()) return true;
        return false;
      },
    });
    this.navigationController.initialize();
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers() {
    // Document-level events
    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Escape' && !e.isComposing && this.state.isStreaming) {
        e.preventDefault();
        this.inputController?.cancelStreaming();
      }
    });

    // File context manager events
    this.registerEvent(this.plugin.app.vault.on('create', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('modify', () => this.fileContextManager?.markFilesCacheDirty()));

    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    this.registerDomEvent(document, 'click', (e) => {
      if (!this.fileContextManager?.containsElement(e.target as Node) && e.target !== this.inputEl) {
        this.fileContextManager?.hideMentionDropdown();
      }
    });



    // Input events
    this.inputEl!.addEventListener('keydown', (e) => {
      // Check for # trigger first (empty input + # keystroke)
      if (this.instructionModeManager?.handleTriggerKey(e)) {
        return;
      }

      if (this.instructionModeManager?.handleKeydown(e)) {
        return;
      }

      if (this.slashCommandDropdown?.handleKeydown(e)) {
        return;
      }

      if (this.fileContextManager?.handleMentionKeydown(e)) {
        return;
      }

      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Escape' && !e.isComposing && this.state.isStreaming) {
        e.preventDefault();
        this.inputController?.cancelStreaming();
        return;
      }

      // Enter: Send message
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.inputController?.sendMessage();
      }
    });

    this.inputEl!.addEventListener('input', () => {
      this.fileContextManager?.handleInputChange();
      this.instructionModeManager?.handleInputChange();
    });

    this.inputEl!.addEventListener('focus', () => {
      this.selectionController?.showHighlight();
    });
  }

  // ============================================
  // Utilities
  // ============================================

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}
