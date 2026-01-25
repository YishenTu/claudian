/**
 * Tab - Encapsulates all per-tab state for multi-tab support.
 *
 * Each Tab represents an independent chat session with its own:
 * - ClaudianService (for concurrent streaming)
 * - ChatState
 * - Controllers
 * - UI Components
 * - DOM Elements
 */

import type { Component } from 'obsidian';

import { ClaudianService } from '../../../core/agent';
import type { McpServerManager } from '../../../core/mcp';
import type { ClaudeModel, Conversation, SlashCommand, ThinkingBudget } from '../../../core/types';
import { DEFAULT_CLAUDE_MODELS, DEFAULT_THINKING_BUDGET, getContextWindowSize } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import {
  ConversationController,
  InputController,
  NavigationController,
  SelectionController,
  StreamController,
} from '../controllers';
import { cleanupThinkingBlock, MessageRenderer } from '../rendering';
import { AsyncSubagentManager } from '../services/AsyncSubagentManager';
import { InstructionRefineService } from '../services/InstructionRefineService';
import { TitleGenerationService } from '../services/TitleGenerationService';
import { ChatState } from '../state';
import {
  createInputToolbar,
  FileContextManager,
  ImageContextManager,
  InstructionModeManager as InstructionModeManagerClass,
  StatusPanel,
} from '../ui';
import type { TabData, TabDOMElements, TabId } from './types';
import { generateTabId, TEXTAREA_MAX_HEIGHT_PERCENT, TEXTAREA_MIN_MAX_HEIGHT } from './types';

/** Options for creating a new Tab. */
export interface TabCreateOptions {
  /** Plugin instance. */
  plugin: ClaudianPlugin;

  /** MCP manager (shared across all tabs). */
  mcpManager: McpServerManager;

  /** Container element to append tab content to. */
  containerEl: HTMLElement;

  /** Optional conversation to load into this tab. */
  conversation?: Conversation;

  /** Optional existing tab ID (for restoration). */
  tabId?: TabId;

  /** Callback when streaming state changes. */
  onStreamingChanged?: (isStreaming: boolean) => void;

  /** Callback when conversation title changes. */
  onTitleChanged?: (title: string) => void;

  /** Callback when attention state changes (approval pending, etc.). */
  onAttentionChanged?: (needsAttention: boolean) => void;

  /** Callback when conversation ID changes (for lazy creation sync). */
  onConversationIdChanged?: (conversationId: string | null) => void;
}

/**
 * Creates a new Tab instance with all required state.
 */
export function createTab(options: TabCreateOptions): TabData {
  const {
    containerEl,
    conversation,
    tabId,
    onStreamingChanged,
    onAttentionChanged,
    onConversationIdChanged,
  } = options;

  const id = tabId ?? generateTabId();

  // Create per-tab content container (hidden by default)
  const contentEl = containerEl.createDiv({ cls: 'claudian-tab-content' });
  contentEl.style.display = 'none';

  // Create ChatState with callbacks
  const state = new ChatState({
    onStreamingStateChanged: (isStreaming) => {
      onStreamingChanged?.(isStreaming);
    },
    onAttentionChanged: (needsAttention) => {
      onAttentionChanged?.(needsAttention);
    },
    onConversationChanged: (conversationId) => {
      onConversationIdChanged?.(conversationId);
    },
  });

  // Create async subagent manager with no-op callback.
  // This placeholder is replaced in initializeTabControllers() with the actual
  // callback that updates the StreamController. We defer the real callback
  // because StreamController doesn't exist until controllers are initialized.
  const asyncSubagentManager = new AsyncSubagentManager(() => {});

  // Create DOM structure
  const dom = buildTabDOM(contentEl);

  // Create initial TabData (service and controllers are lazy-initialized)
  const tab: TabData = {
    id,
    conversationId: conversation?.id ?? null,
    service: null,
    serviceInitialized: false,
    state,
    controllers: {
      selectionController: null,
      conversationController: null,
      streamController: null,
      inputController: null,
      navigationController: null,
    },
    services: {
      asyncSubagentManager,
      instructionRefineService: null,
      titleGenerationService: null,
    },
    ui: {
      fileContextManager: null,
      imageContextManager: null,
      modelSelector: null,
      thinkingBudgetSelector: null,
      externalContextSelector: null,
      mcpServerSelector: null,
      permissionToggle: null,
      slashCommandDropdown: null,
      instructionModeManager: null,
      contextUsageMeter: null,
      statusPanel: null,
    },
    dom,
    renderer: null,
  };

  return tab;
}

/**
 * Auto-resizes a textarea based on its content.
 *
 * Logic:
 * - At minimum wrapper height: let flexbox allocate space (textarea fills available)
 * - When content exceeds flex allocation: set min-height to force wrapper growth
 * - When content shrinks: remove min-height override to let wrapper shrink
 * - Max height is capped at 55% of view height (minimum 150px)
 */
function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  // Clear inline min-height to let flexbox compute natural allocation
  textarea.style.minHeight = '';

  // Calculate max height: 55% of view height, minimum 150px
  const viewHeight = textarea.closest('.claudian-container')?.clientHeight ?? window.innerHeight;
  const maxHeight = Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);

  // Get flex-allocated height (what flexbox gives the textarea)
  const flexAllocatedHeight = textarea.offsetHeight;

  // Get content height (what the content actually needs), capped at max
  const contentHeight = Math.min(textarea.scrollHeight, maxHeight);

  // Only set min-height if content exceeds flex allocation
  // This forces the wrapper to grow while letting it shrink when content reduces
  if (contentHeight > flexAllocatedHeight) {
    textarea.style.minHeight = `${contentHeight}px`;
  }

  // Always set max-height to enforce the cap
  textarea.style.maxHeight = `${maxHeight}px`;
}

/**
 * Builds the DOM structure for a tab.
 */
function buildTabDOM(contentEl: HTMLElement): TabDOMElements {
  // Messages wrapper (for scroll-to-bottom button positioning)
  const messagesWrapperEl = contentEl.createDiv({ cls: 'claudian-messages-wrapper' });

  // Messages area (inside wrapper)
  const messagesEl = messagesWrapperEl.createDiv({ cls: 'claudian-messages' });

  // Welcome message placeholder
  const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });

  // Scroll-to-bottom button (positioned absolutely in wrapper, overlays bottom of messages)
  const scrollToBottomEl = messagesWrapperEl.createEl('button', {
    cls: 'claudian-scroll-to-bottom',
    attr: {
      'aria-label': 'Scroll to bottom',
      type: 'button',
    },
  });
  scrollToBottomEl.textContent = 'Scroll to bottom';

  // Status panel container (fixed between messages and input)
  const statusPanelContainerEl = contentEl.createDiv({ cls: 'claudian-status-panel-container' });

  // Input container
  const inputContainerEl = contentEl.createDiv({ cls: 'claudian-input-container' });

  // Nav row (for tab badges and header icons, populated by ClaudianView)
  const navRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-nav-row' });

  const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });

  // Context row inside input wrapper (file chips + selection indicator)
  const contextRowEl = inputWrapper.createDiv({ cls: 'claudian-context-row' });

  // Input textarea
  const inputEl = inputWrapper.createEl('textarea', {
    cls: 'claudian-input',
    attr: {
      placeholder: 'How can I help you today?',
      rows: '3',
    },
  });

  return {
    contentEl,
    messagesEl,
    welcomeEl,
    statusPanelContainerEl,
    inputContainerEl,
    inputWrapper,
    inputEl,
    navRowEl,
    contextRowEl,
    selectionIndicatorEl: null,
    scrollToBottomEl,
    eventCleanups: [],
  };
}

/**
 * Initializes the tab's ClaudianService (lazy initialization).
 * Call this when the tab becomes active or when the first message is sent.
 *
 * Session ID resolution:
 * - If tab has conversationId (existing chat) → lookup conversation's sessionId → ensureReady with it
 * - If tab has no conversationId (new chat) → ensureReady without sessionId
 *
 * This ensures the single source of truth (tab.conversationId) determines session behavior.
 *
 * Ensures consistent state: if initialization fails, tab.service is null
 * and tab.serviceInitialized remains false for retry.
 */
export async function initializeTabService(
  tab: TabData,
  plugin: ClaudianPlugin,
  mcpManager: McpServerManager
): Promise<void> {
  if (tab.serviceInitialized) {
    return;
  }

  let service: ClaudianService | null = null;

  try {
    // Create per-tab ClaudianService
    service = new ClaudianService(plugin, mcpManager);

    // Load Claude Code permissions with error handling
    try {
      await service.loadCCPermissions();
    } catch {
      // Continue without permissions - service can still function
    }

    // Resolve session ID and external contexts from conversation if this is an existing chat
    // Single source of truth: tab.conversationId determines if we have a session to resume
    let sessionId: string | undefined;
    let externalContextPaths = plugin.settings.persistentExternalContextPaths || [];
    if (tab.conversationId) {
      const conversation = await plugin.getConversationById(tab.conversationId);
      sessionId = conversation?.sessionId ?? undefined;
      if (conversation) {
        const hasMessages = conversation.messages.length > 0;
        externalContextPaths = hasMessages
          ? conversation.externalContextPaths || []
          : (plugin.settings.persistentExternalContextPaths || []);
      }
    }

    // Ensure SDK process is ready
    // - Existing chat: with sessionId for resume
    // - New chat: without sessionId
    service.ensureReady({
      sessionId,
      externalContextPaths,
    }).catch(() => {
      // Best-effort, ignore failures
    });

    // Only set tab state after successful initialization
    tab.service = service;
    tab.serviceInitialized = true;
  } catch (error) {
    // Clean up partial state on failure
    service?.closePersistentQuery('initialization failed');
    tab.service = null;
    tab.serviceInitialized = false;

    // Re-throw to let caller handle (e.g., show error to user)
    throw error;
  }
}

/**
 * Initializes file and image context managers for a tab.
 */
function initializeContextManagers(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom } = tab;
  const app = plugin.app;

  // File context manager - chips in contextRowEl, dropdown in inputContainerEl
  tab.ui.fileContextManager = new FileContextManager(
    app,
    dom.contextRowEl,
    dom.inputEl,
    {
      getExcludedTags: () => plugin.settings.excludedTags,
      onChipsChanged: () => {
        tab.controllers.selectionController?.updateContextRowVisibility();
        autoResizeTextarea(dom.inputEl);
        tab.renderer?.scrollToBottomIfNeeded();
      },
      getExternalContexts: () => tab.ui.externalContextSelector?.getExternalContexts() || [],
    },
    dom.inputContainerEl
  );
  tab.ui.fileContextManager.setMcpService(plugin.mcpService);
  tab.ui.fileContextManager.setAgentService(plugin.agentManager);

  // Image context manager - drag/drop uses inputContainerEl, preview in contextRowEl
  tab.ui.imageContextManager = new ImageContextManager(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onImagesChanged: () => {
        tab.controllers.selectionController?.updateContextRowVisibility();
        autoResizeTextarea(dom.inputEl);
        tab.renderer?.scrollToBottomIfNeeded();
      },
    },
    dom.contextRowEl
  );
}

/**
 * Initializes slash command dropdown for a tab.
 * @param getSdkCommands Callback to get SDK commands from any ready service (shared across tabs).
 * @param getHiddenCommands Callback to get current hidden commands from settings.
 */
function initializeSlashCommands(
  tab: TabData,
  getSdkCommands?: () => Promise<SlashCommand[]>,
  getHiddenCommands?: () => Set<string>
): void {
  const { dom } = tab;

  tab.ui.slashCommandDropdown = new SlashCommandDropdown(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onSelect: () => {},
      onHide: () => {},
      getSdkCommands,
    },
    {
      hiddenCommands: getHiddenCommands?.() ?? new Set(),
    }
  );
}

/**
 * Initializes instruction mode and todo panel for a tab.
 */
function initializeInstructionAndTodo(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom } = tab;

  tab.services.instructionRefineService = new InstructionRefineService(plugin);
  tab.services.titleGenerationService = new TitleGenerationService(plugin);
  tab.ui.instructionModeManager = new InstructionModeManagerClass(
    dom.inputEl,
    {
      onSubmit: async (rawInstruction) => {
        await tab.controllers.inputController?.handleInstructionSubmit(rawInstruction);
      },
      getInputWrapper: () => dom.inputWrapper,
    }
  );

  tab.ui.statusPanel = new StatusPanel();
  tab.ui.statusPanel.mount(dom.statusPanelContainerEl);
}

/**
 * Creates and wires the input toolbar for a tab.
 */
function initializeInputToolbar(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom } = tab;

  const inputToolbar = dom.inputWrapper.createDiv({ cls: 'claudian-input-toolbar' });
  const toolbarComponents = createInputToolbar(inputToolbar, {
    getSettings: () => ({
      model: plugin.settings.model,
      thinkingBudget: plugin.settings.thinkingBudget,
      permissionMode: plugin.settings.permissionMode,
      show1MModel: plugin.settings.show1MModel,
    }),
    getEnvironmentVariables: () => plugin.getActiveEnvironmentVariables(),
    onModelChange: async (model: ClaudeModel) => {
      plugin.settings.model = model;
      const isDefaultModel = DEFAULT_CLAUDE_MODELS.find((m) => m.value === model);
      if (isDefaultModel) {
        plugin.settings.thinkingBudget = DEFAULT_THINKING_BUDGET[model];
        plugin.settings.lastClaudeModel = model;
      } else {
        plugin.settings.lastCustomModel = model;
      }
      await plugin.saveSettings();
      tab.ui.thinkingBudgetSelector?.updateDisplay();
      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();

      // Recalculate context usage percentage for the new model's context window
      const currentUsage = tab.state.usage;
      if (currentUsage) {
        const newContextWindow = getContextWindowSize(model, plugin.settings.show1MModel, plugin.settings.customContextLimits);
        const newPercentage = Math.min(100, Math.max(0, Math.round((currentUsage.contextTokens / newContextWindow) * 100)));
        tab.state.usage = {
          ...currentUsage,
          model,
          contextWindow: newContextWindow,
          percentage: newPercentage,
        };
      }
    },
    onThinkingBudgetChange: async (budget: ThinkingBudget) => {
      plugin.settings.thinkingBudget = budget;
      await plugin.saveSettings();
    },
    onPermissionModeChange: async (mode) => {
      plugin.settings.permissionMode = mode;
      await plugin.saveSettings();
    },
  });

  tab.ui.modelSelector = toolbarComponents.modelSelector;
  tab.ui.thinkingBudgetSelector = toolbarComponents.thinkingBudgetSelector;
  tab.ui.contextUsageMeter = toolbarComponents.contextUsageMeter;
  tab.ui.externalContextSelector = toolbarComponents.externalContextSelector;
  tab.ui.mcpServerSelector = toolbarComponents.mcpServerSelector;
  tab.ui.permissionToggle = toolbarComponents.permissionToggle;

  // Wire MCP service
  tab.ui.mcpServerSelector.setMcpService(plugin.mcpService);

  // Sync @-mentions to UI selector
  tab.ui.fileContextManager?.setOnMcpMentionChange((servers) => {
    tab.ui.mcpServerSelector?.addMentionedServers(servers);
  });

  // Wire external context changes
  tab.ui.externalContextSelector.setOnChange(() => {
    tab.ui.fileContextManager?.preScanExternalContexts();
  });

  // Initialize persistent paths
  tab.ui.externalContextSelector.setPersistentPaths(
    plugin.settings.persistentExternalContextPaths || []
  );

  // Wire persistence changes
  tab.ui.externalContextSelector.setOnPersistenceChange(async (paths) => {
    plugin.settings.persistentExternalContextPaths = paths;
    await plugin.saveSettings();
  });
}

/** Options for initializing tab UI. */
export interface InitializeTabUIOptions {
  /** Callback to get SDK commands from any ready service (shared across tabs). */
  getSdkCommands?: () => Promise<SlashCommand[]>;
}

/**
 * Initializes the tab's UI components.
 * Call this after the tab is created and before it becomes active.
 */
export function initializeTabUI(
  tab: TabData,
  plugin: ClaudianPlugin,
  options: InitializeTabUIOptions = {}
): void {
  const { dom, state } = tab;

  // Initialize context managers (file/image)
  initializeContextManagers(tab, plugin);

  // Selection indicator - add to contextRowEl
  dom.selectionIndicatorEl = dom.contextRowEl.createDiv({ cls: 'claudian-selection-indicator' });
  dom.selectionIndicatorEl.style.display = 'none';

  // Initialize slash commands with shared SDK commands callback and hidden commands
  initializeSlashCommands(
    tab,
    options.getSdkCommands,
    () => new Set((plugin.settings.hiddenSlashCommands || []).map(c => c.toLowerCase()))
  );

  // Initialize instruction mode and todo panel
  initializeInstructionAndTodo(tab, plugin);

  // Initialize input toolbar
  initializeInputToolbar(tab, plugin);

  // Helper to update scroll-to-bottom button visibility
  const updateScrollToBottomVisibility = () => {
    if (dom.scrollToBottomEl) {
      // Show button when user has scrolled up AND there's content to scroll to
      const hasOverflow = dom.messagesEl.scrollHeight > dom.messagesEl.clientHeight;
      const shouldShow = !state.autoScrollEnabled && hasOverflow;
      dom.scrollToBottomEl.classList.toggle('visible', shouldShow);
    }
  };

  // Store reference for use in activateTab
  dom.updateScrollVisibility = updateScrollToBottomVisibility;

  // Update ChatState callbacks for UI updates
  state.callbacks = {
    ...state.callbacks,
    onUsageChanged: (usage) => tab.ui.contextUsageMeter?.update(usage),
    onTodosChanged: (todos) => tab.ui.statusPanel?.updateTodos(todos),
    onAutoScrollChanged: () => updateScrollToBottomVisibility(),
  };

  // ResizeObserver to detect overflow changes (e.g., content growth)
  const resizeObserver = new ResizeObserver(() => {
    updateScrollToBottomVisibility();
  });
  resizeObserver.observe(dom.messagesEl);
  dom.eventCleanups.push(() => resizeObserver.disconnect());

  // Sync initial button visibility with current state
  updateScrollToBottomVisibility();
}

/**
 * Initializes the tab's controllers.
 * Call this after UI components are initialized.
 *
 * @param tab The tab data to initialize controllers for.
 * @param plugin The plugin instance.
 * @param component The Obsidian Component for registering event handlers (typically ClaudianView).
 */
export function initializeTabControllers(
  tab: TabData,
  plugin: ClaudianPlugin,
  component: Component,
  mcpManager: McpServerManager
): void {
  const { dom, state, services, ui } = tab;

  // Create renderer
  tab.renderer = new MessageRenderer(plugin, component, dom.messagesEl);

  // Selection controller
  tab.controllers.selectionController = new SelectionController(
    plugin.app,
    dom.selectionIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl)
  );

  // Stream controller
  tab.controllers.streamController = new StreamController({
    plugin,
    state,
    renderer: tab.renderer,
    asyncSubagentManager: services.asyncSubagentManager,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    updateQueueIndicator: () => tab.controllers.inputController?.updateQueueIndicator(),
    getAgentService: () => tab.service,
  });

  // Wire async subagent callback now that StreamController exists
  services.asyncSubagentManager.setCallback(
    (subagent) => {
      // Update inline renderer
      tab.controllers.streamController?.onAsyncSubagentStateChange(subagent);

      // Update status panel (hidden by default - inline is shown first)
      if (subagent.mode === 'async' && ui.statusPanel) {
        ui.statusPanel.updateSubagent({
          id: subagent.id,
          description: subagent.description,
          status: subagent.asyncStatus === 'completed' ? 'completed'
            : subagent.asyncStatus === 'error' ? 'error'
            : subagent.asyncStatus === 'orphaned' ? 'orphaned'
            : subagent.asyncStatus === 'running' ? 'running'
            : 'pending',
          prompt: subagent.prompt,
          result: subagent.result,
        });
      }
    }
  );

  // Conversation controller
  tab.controllers.conversationController = new ConversationController(
    {
      plugin,
      state,
      renderer: tab.renderer,
      asyncSubagentManager: services.asyncSubagentManager,
      getHistoryDropdown: () => null, // Tab doesn't have its own history dropdown
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: (el) => { dom.welcomeEl = el; },
      getMessagesEl: () => dom.messagesEl,
      getInputEl: () => dom.inputEl,
      getFileContextManager: () => ui.fileContextManager,
      getImageContextManager: () => ui.imageContextManager,
      getMcpServerSelector: () => ui.mcpServerSelector,
      getExternalContextSelector: () => ui.externalContextSelector,
      clearQueuedMessage: () => tab.controllers.inputController?.clearQueuedMessage(),
      getTitleGenerationService: () => services.titleGenerationService,
      getStatusPanel: () => ui.statusPanel,
      getAgentService: () => tab.service, // Use tab's service instead of plugin's
    },
    {}
  );

  // Input controller - needs the tab's service
  const generateId = () => `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  tab.controllers.inputController = new InputController({
    plugin,
    state,
    renderer: tab.renderer,
    streamController: tab.controllers.streamController,
    selectionController: tab.controllers.selectionController,
    conversationController: tab.controllers.conversationController,
    getInputEl: () => dom.inputEl,
    getWelcomeEl: () => dom.welcomeEl,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    getImageContextManager: () => ui.imageContextManager,
    getMcpServerSelector: () => ui.mcpServerSelector,
    getExternalContextSelector: () => ui.externalContextSelector,
    getInstructionModeManager: () => ui.instructionModeManager,
    getInstructionRefineService: () => services.instructionRefineService,
    getTitleGenerationService: () => services.titleGenerationService,
    getStatusPanel: () => ui.statusPanel,
    generateId,
    resetInputHeight: () => {
      // Per-tab input height is managed by CSS, no dynamic adjustment needed
    },
    // Override to use tab's service instead of plugin.agentService
    getAgentService: () => tab.service,
    // Lazy initialization: ensure service is ready before first query
    // initializeTabService() handles session ID resolution from tab.conversationId
    ensureServiceInitialized: async () => {
      if (tab.serviceInitialized) {
        return true;
      }
      try {
        await initializeTabService(tab, plugin, mcpManager);
        setupApprovalCallback(tab);
        return true;
      } catch {
        return false;
      }
    },
  });

  // Navigation controller
  tab.controllers.navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming,
    shouldSkipEscapeHandling: () => {
      if (ui.instructionModeManager?.isActive()) return true;
      if (ui.slashCommandDropdown?.isVisible()) return true;
      if (ui.fileContextManager?.isMentionDropdownVisible()) return true;
      return false;
    },
  });
  tab.controllers.navigationController.initialize();
}

/**
 * Wires up input event handlers for a tab.
 * Call this after controllers are initialized.
 * Stores cleanup functions in dom.eventCleanups for proper memory management.
 */
export function wireTabInputEvents(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom, ui, state, controllers } = tab;

  // Input keydown handler
  const keydownHandler = (e: KeyboardEvent) => {
    // Check for # trigger first (empty input + # keystroke)
    if (ui.instructionModeManager?.handleTriggerKey(e)) {
      return;
    }

    if (ui.instructionModeManager?.handleKeydown(e)) {
      return;
    }

    if (ui.slashCommandDropdown?.handleKeydown(e)) {
      return;
    }

    if (ui.fileContextManager?.handleMentionKeydown(e)) {
      return;
    }

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Escape' && !e.isComposing && state.isStreaming) {
      e.preventDefault();
      controllers.inputController?.cancelStreaming();
      return;
    }

    // Enter: Send message
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void controllers.inputController?.sendMessage();
    }
  };
  dom.inputEl.addEventListener('keydown', keydownHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('keydown', keydownHandler));

  // Input change handler (includes auto-resize)
  const inputHandler = () => {
    ui.fileContextManager?.handleInputChange();
    ui.instructionModeManager?.handleInputChange();
    // Auto-resize textarea based on content
    autoResizeTextarea(dom.inputEl);
  };
  dom.inputEl.addEventListener('input', inputHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('input', inputHandler));

  // Input focus handler
  const focusHandler = () => {
    controllers.selectionController?.showHighlight();
  };
  dom.inputEl.addEventListener('focus', focusHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('focus', focusHandler));

  // Scroll listener for auto-scroll control (tracks position always, not just during streaming)
  const SCROLL_THRESHOLD = 20; // pixels from bottom to consider "at bottom"
  const RE_ENABLE_DELAY = 150; // ms to wait before re-enabling auto-scroll
  let reEnableTimeout: ReturnType<typeof setTimeout> | null = null;

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      if (reEnableTimeout) {
        clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;

    if (!isAtBottom) {
      // Immediately disable when user scrolls up
      if (reEnableTimeout) {
        clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
    } else if (!state.autoScrollEnabled) {
      // Debounce re-enabling to avoid bounce during scroll animation
      if (!reEnableTimeout) {
        reEnableTimeout = setTimeout(() => {
          reEnableTimeout = null;
          // Re-verify position before enabling (content may have changed)
          const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
          if (scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD) {
            state.autoScrollEnabled = true;
          }
        }, RE_ENABLE_DELAY);
      }
    }
  };
  dom.messagesEl.addEventListener('scroll', scrollHandler, { passive: true });
  dom.eventCleanups.push(() => {
    dom.messagesEl.removeEventListener('scroll', scrollHandler);
    if (reEnableTimeout) clearTimeout(reEnableTimeout);
  });

  // Scroll-to-bottom button click handler
  if (dom.scrollToBottomEl) {
    const scrollToBottomHandler = () => {
      // Scroll to bottom
      dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
      // Re-enable auto-scroll only if allowed by settings
      if (isAutoScrollAllowed()) {
        state.autoScrollEnabled = true;
      }
    };
    dom.scrollToBottomEl.addEventListener('click', scrollToBottomHandler);
    dom.eventCleanups.push(() => dom.scrollToBottomEl?.removeEventListener('click', scrollToBottomHandler));
  }
}

/**
 * Activates a tab (shows it and starts services).
 */
export function activateTab(tab: TabData): void {
  tab.dom.contentEl.style.display = 'flex';
  tab.controllers.selectionController?.start();
  // Refresh scroll-to-bottom button visibility (dimensions now available after display)
  tab.dom.updateScrollVisibility?.();
}

/**
 * Deactivates a tab (hides it and stops services).
 */
export function deactivateTab(tab: TabData): void {
  tab.dom.contentEl.style.display = 'none';
  tab.controllers.selectionController?.stop();
}

/**
 * Cleans up a tab and releases all resources.
 * Made async to ensure proper cleanup ordering.
 */
export async function destroyTab(tab: TabData): Promise<void> {
  // Stop polling
  tab.controllers.selectionController?.stop();
  tab.controllers.selectionController?.clear();

  // Cleanup navigation controller
  tab.controllers.navigationController?.dispose();

  // Cleanup thinking state
  cleanupThinkingBlock(tab.state.currentThinkingState);
  tab.state.currentThinkingState = null;

  // Cleanup UI components
  tab.ui.fileContextManager?.destroy();
  tab.ui.slashCommandDropdown?.destroy();
  tab.ui.slashCommandDropdown = null;
  tab.ui.instructionModeManager?.destroy();
  tab.ui.instructionModeManager = null;
  tab.services.instructionRefineService?.cancel();
  tab.services.instructionRefineService = null;
  tab.services.titleGenerationService?.cancel();
  tab.services.titleGenerationService = null;
  tab.ui.statusPanel?.destroy();
  tab.ui.statusPanel = null;

  // Cleanup async subagents
  tab.services.asyncSubagentManager.orphanAllActive();
  tab.state.asyncSubagentStates.clear();

  // Remove event listeners to prevent memory leaks
  for (const cleanup of tab.dom.eventCleanups) {
    cleanup();
  }
  tab.dom.eventCleanups.length = 0;

  // Close the tab's service
  // Note: closePersistentQuery is synchronous but we make destroyTab async
  // for future-proofing and proper cleanup ordering
  tab.service?.closePersistentQuery('tab closed');
  tab.service = null;

  // Remove DOM element
  tab.dom.contentEl.remove();
}

/**
 * Gets the display title for a tab.
 * Uses synchronous access since we only need the title, not messages.
 */
export function getTabTitle(tab: TabData, plugin: ClaudianPlugin): string {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.title) {
      return conversation.title;
    }
  }
  return 'New Chat';
}

/**
 * Sets up the approval callback for a tab's service.
 * Extracted to avoid duplication between Tab.ts and TabManager.ts.
 */
export function setupApprovalCallback(tab: TabData): void {
  if (tab.service && tab.controllers.inputController) {
    tab.service.setApprovalCallback(
      (toolName, input, description) =>
        tab.controllers.inputController!.handleApprovalRequest(toolName, input, description)
    );
  }
}
