/**
 * Tests for Tab - Individual tab state and lifecycle management.
 */

import { ChatState } from '@/features/chat/state/ChatState';
import {
  activateTab,
  createTab,
  deactivateTab,
  destroyTab,
  getTabTitle,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  type TabCreateOptions,
  wireTabInputEvents,
} from '@/features/chat/tabs/Tab';

// Mock ClaudianService
jest.mock('@/core/agent', () => ({
  ClaudianService: jest.fn().mockImplementation(() => ({
    loadCCPermissions: jest.fn().mockResolvedValue(undefined),
    preWarm: jest.fn().mockResolvedValue(undefined),
    closePersistentQuery: jest.fn(),
  })),
}));

// Mock SlashCommandManager
jest.mock('@/core/commands', () => ({
  SlashCommandManager: jest.fn().mockImplementation(() => ({
    setCommands: jest.fn(),
  })),
}));

// Mock factories must be defined before jest.mock calls due to hoisting
// These will be initialized fresh in beforeEach
const createMockFileContextManager = () => ({
  setMcpService: jest.fn(),
  setOnMcpMentionChange: jest.fn(),
  preScanExternalContexts: jest.fn(),
  handleInputChange: jest.fn(),
  handleMentionKeydown: jest.fn().mockReturnValue(false),
  isMentionDropdownVisible: jest.fn().mockReturnValue(false),
  destroy: jest.fn(),
});

const createMockImageContextManager = () => ({
  destroy: jest.fn(),
});

const createMockSlashCommandDropdown = () => ({
  handleKeydown: jest.fn().mockReturnValue(false),
  isVisible: jest.fn().mockReturnValue(false),
  destroy: jest.fn(),
});

const createMockInstructionModeManager = () => ({
  handleTriggerKey: jest.fn().mockReturnValue(false),
  handleKeydown: jest.fn().mockReturnValue(false),
  handleInputChange: jest.fn(),
  isActive: jest.fn().mockReturnValue(false),
  destroy: jest.fn(),
});

const createMockTodoPanel = () => ({
  mount: jest.fn(),
  updateTodos: jest.fn(),
  destroy: jest.fn(),
});

const createMockModelSelector = () => ({
  updateDisplay: jest.fn(),
  renderOptions: jest.fn(),
});

const createMockThinkingBudgetSelector = () => ({
  updateDisplay: jest.fn(),
});

const createMockContextUsageMeter = () => ({
  update: jest.fn(),
});

const createMockExternalContextSelector = () => ({
  getExternalContexts: jest.fn().mockReturnValue([]),
  setOnChange: jest.fn(),
  setPersistentPaths: jest.fn(),
  setOnPersistenceChange: jest.fn(),
});

const createMockMcpServerSelector = () => ({
  setMcpService: jest.fn(),
  addMentionedServers: jest.fn(),
});

const createMockPermissionToggle = () => ({});

// Shared mock instances (reset in beforeEach)
let mockFileContextManager: ReturnType<typeof createMockFileContextManager>;
let mockImageContextManager: ReturnType<typeof createMockImageContextManager>;
let mockSlashCommandDropdown: ReturnType<typeof createMockSlashCommandDropdown>;
let mockInstructionModeManager: ReturnType<typeof createMockInstructionModeManager>;
let mockTodoPanel: ReturnType<typeof createMockTodoPanel>;
let mockModelSelector: ReturnType<typeof createMockModelSelector>;
let mockThinkingBudgetSelector: ReturnType<typeof createMockThinkingBudgetSelector>;
let mockContextUsageMeter: ReturnType<typeof createMockContextUsageMeter>;
let mockExternalContextSelector: ReturnType<typeof createMockExternalContextSelector>;
let mockMcpServerSelector: ReturnType<typeof createMockMcpServerSelector>;
let mockPermissionToggle: ReturnType<typeof createMockPermissionToggle>;
let mockMessageRenderer: { scrollToBottomIfNeeded: jest.Mock };
let mockSelectionController: ReturnType<typeof createMockSelectionController>;
let mockStreamController: { onAsyncSubagentStateChange: jest.Mock };
let mockConversationController: { save: jest.Mock };
let mockInputController: ReturnType<typeof createMockInputController>;
let mockNavigationController: { initialize: jest.Mock; dispose: jest.Mock };

const createMockSelectionController = () => ({
  start: jest.fn(),
  stop: jest.fn(),
  clear: jest.fn(),
  showHighlight: jest.fn(),
});

const createMockInputController = () => ({
  sendMessage: jest.fn(),
  cancelStreaming: jest.fn(),
  handleInstructionSubmit: jest.fn(),
  updateQueueIndicator: jest.fn(),
});

jest.mock('@/features/chat/ui', () => ({
  FileContextManager: jest.fn().mockImplementation(() => {
    mockFileContextManager = createMockFileContextManager();
    return mockFileContextManager;
  }),
  ImageContextManager: jest.fn().mockImplementation(() => {
    mockImageContextManager = createMockImageContextManager();
    return mockImageContextManager;
  }),
  InstructionModeManager: jest.fn().mockImplementation(() => {
    mockInstructionModeManager = createMockInstructionModeManager();
    return mockInstructionModeManager;
  }),
  TodoPanel: jest.fn().mockImplementation(() => {
    mockTodoPanel = createMockTodoPanel();
    return mockTodoPanel;
  }),
  createInputToolbar: jest.fn().mockImplementation(() => {
    mockModelSelector = createMockModelSelector();
    mockThinkingBudgetSelector = createMockThinkingBudgetSelector();
    mockContextUsageMeter = createMockContextUsageMeter();
    mockExternalContextSelector = createMockExternalContextSelector();
    mockMcpServerSelector = createMockMcpServerSelector();
    mockPermissionToggle = createMockPermissionToggle();
    return {
      modelSelector: mockModelSelector,
      thinkingBudgetSelector: mockThinkingBudgetSelector,
      contextUsageMeter: mockContextUsageMeter,
      externalContextSelector: mockExternalContextSelector,
      mcpServerSelector: mockMcpServerSelector,
      permissionToggle: mockPermissionToggle,
    };
  }),
}));

jest.mock('@/shared/components/SlashCommandDropdown', () => ({
  SlashCommandDropdown: jest.fn().mockImplementation(() => {
    mockSlashCommandDropdown = createMockSlashCommandDropdown();
    return mockSlashCommandDropdown;
  }),
}));

// Mock rendering
jest.mock('@/features/chat/rendering', () => ({
  MessageRenderer: jest.fn().mockImplementation(() => {
    mockMessageRenderer = { scrollToBottomIfNeeded: jest.fn() };
    return mockMessageRenderer;
  }),
  cleanupThinkingBlock: jest.fn(),
}));

// Mock controllers
jest.mock('@/features/chat/controllers', () => ({
  SelectionController: jest.fn().mockImplementation(() => {
    mockSelectionController = createMockSelectionController();
    return mockSelectionController;
  }),
  StreamController: jest.fn().mockImplementation(() => {
    mockStreamController = { onAsyncSubagentStateChange: jest.fn() };
    return mockStreamController;
  }),
  ConversationController: jest.fn().mockImplementation(() => {
    mockConversationController = { save: jest.fn().mockResolvedValue(undefined) };
    return mockConversationController;
  }),
  InputController: jest.fn().mockImplementation(() => {
    mockInputController = createMockInputController();
    return mockInputController;
  }),
  NavigationController: jest.fn().mockImplementation(() => {
    mockNavigationController = { initialize: jest.fn(), dispose: jest.fn() };
    return mockNavigationController;
  }),
}));

// Mock services
jest.mock('@/features/chat/services/AsyncSubagentManager', () => ({
  AsyncSubagentManager: jest.fn().mockImplementation(() => ({
    orphanAllActive: jest.fn(),
  })),
}));

jest.mock('@/features/chat/services/InstructionRefineService', () => ({
  InstructionRefineService: jest.fn().mockImplementation(() => ({
    cancel: jest.fn(),
  })),
}));

jest.mock('@/features/chat/services/TitleGenerationService', () => ({
  TitleGenerationService: jest.fn().mockImplementation(() => ({
    cancel: jest.fn(),
  })),
}));

// Mock path util
jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

// Type for event handlers
type EventHandler = (...args: unknown[]) => void;

// Helper to create mock DOM element
function createMockElement(): any {
  const style: Record<string, string> = {};
  const classList = new Set<string>();
  const children: any[] = [];
  const eventListeners: Map<string, EventHandler[]> = new Map();

  const el: any = {
    style,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    empty: () => { children.length = 0; },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.classList.add(opts.cls);
      children.push(child);
      return child;
    },
    createEl: (tag: string, opts?: { cls?: string; attr?: Record<string, string> }) => {
      const child = createMockElement();
      child.tagName = tag.toUpperCase();
      if (opts?.cls) child.classList.add(opts.cls);
      children.push(child);
      return child;
    },
    querySelector: jest.fn().mockReturnValue(null),
    insertBefore: jest.fn(),
    remove: jest.fn(),
    addEventListener: (event: string, handler: EventHandler) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(handler);
    },
    removeEventListener: (event: string, handler: EventHandler) => {
      const handlers = eventListeners.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
      }
    },
    getEventListeners: () => eventListeners,
    value: '',
  };

  return el;
}

// Helper to create mock plugin
function createMockPlugin(overrides: Record<string, any> = {}): any {
  return {
    app: {
      vault: {
        adapter: { basePath: '/test/vault' },
      },
    },
    settings: {
      excludedTags: [],
      model: 'claude-sonnet-4-5',
      thinkingBudget: 'low',
      permissionMode: 'yolo',
      slashCommands: [],
      keyboardNavigation: {
        scrollUpKey: 'k',
        scrollDownKey: 'j',
        focusInputKey: 'i',
      },
      persistentExternalContextPaths: [],
    },
    mcpService: { getMcpServers: jest.fn().mockReturnValue([]) },
    getConversationById: jest.fn().mockReturnValue(null),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue({}),
    ...overrides,
  };
}

// Helper to create mock MCP manager
function createMockMcpManager(): any {
  return {
    getMcpServers: jest.fn().mockReturnValue([]),
  };
}

// Helper to create TabCreateOptions
function createMockOptions(overrides: Partial<TabCreateOptions> = {}): TabCreateOptions {
  return {
    plugin: createMockPlugin(),
    mcpManager: createMockMcpManager(),
    containerEl: createMockElement(),
    ...overrides,
  };
}

describe('Tab - Creation', () => {
  describe('createTab', () => {
    it('should create a new tab with unique ID', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.id).toBeDefined();
      expect(tab.id).toMatch(/^tab-/);
    });

    it('should use provided tab ID when specified', () => {
      const options = createMockOptions({ tabId: 'custom-tab-id' });
      const tab = createTab(options);

      expect(tab.id).toBe('custom-tab-id');
    });

    it('should initialize with null conversationId when no conversation provided', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.conversationId).toBeNull();
    });

    it('should set conversationId when conversation is provided', () => {
      const options = createMockOptions({
        conversation: {
          id: 'conv-123',
          title: 'Test Conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      const tab = createTab(options);

      expect(tab.conversationId).toBe('conv-123');
    });

    it('should create tab with lazy-initialized service (null)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.service).toBeNull();
      expect(tab.serviceInitialized).toBe(false);
    });

    it('should create ChatState with callbacks', () => {
      const onStreamingChanged = jest.fn();
      const onAttentionChanged = jest.fn();
      const onConversationIdChanged = jest.fn();

      const options = createMockOptions({
        onStreamingChanged,
        onAttentionChanged,
        onConversationIdChanged,
      });
      const tab = createTab(options);

      expect(tab.state).toBeInstanceOf(ChatState);
    });

    it('should create DOM structure with hidden content', () => {
      const containerEl = createMockElement();
      const options = createMockOptions({ containerEl });
      const tab = createTab(options);

      expect(tab.dom.contentEl).toBeDefined();
      expect(tab.dom.contentEl.style.display).toBe('none');
      expect(tab.dom.messagesEl).toBeDefined();
      expect(tab.dom.inputEl).toBeDefined();
    });

    it('should initialize empty eventCleanups array', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.dom.eventCleanups).toEqual([]);
    });

    it('should initialize all controllers as null', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.controllers.selectionController).toBeNull();
      expect(tab.controllers.conversationController).toBeNull();
      expect(tab.controllers.streamController).toBeNull();
      expect(tab.controllers.inputController).toBeNull();
      expect(tab.controllers.navigationController).toBeNull();
    });
  });
});

describe('Tab - Service Initialization', () => {
  describe('initializeTabService', () => {
    it('should not reinitialize if already initialized', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      tab.serviceInitialized = true;
      tab.service = {} as any;

      await initializeTabService(tab, options.plugin, options.mcpManager);

      // Service should not be replaced
      expect(tab.service).toEqual({});
    });

    it('should create ClaudianService on first initialization', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      expect(tab.service).toBeDefined();
      expect(tab.serviceInitialized).toBe(true);
    });

    it('should handle loadCCPermissions errors gracefully', async () => {
      const agentModule = jest.requireMock('@/core/agent') as { ClaudianService: jest.Mock };
      agentModule.ClaudianService.mockImplementationOnce(() => ({
        loadCCPermissions: jest.fn().mockRejectedValue(new Error('Permission load failed')),
        preWarm: jest.fn().mockResolvedValue(undefined),
      }));

      const options = createMockOptions();
      const tab = createTab(options);

      // Should not throw
      await expect(initializeTabService(tab, options.plugin, options.mcpManager))
        .resolves.not.toThrow();

      expect(tab.serviceInitialized).toBe(true);
    });

    it('should pre-warm when conversation has sessionId', async () => {
      const mockPreWarm = jest.fn().mockResolvedValue(undefined);
      const agentModule = jest.requireMock('@/core/agent') as { ClaudianService: jest.Mock };
      agentModule.ClaudianService.mockImplementationOnce(() => ({
        loadCCPermissions: jest.fn().mockResolvedValue(undefined),
        preWarm: mockPreWarm,
      }));

      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockReturnValue({
          id: 'conv-123',
          sessionId: 'session-456',
        }),
      });

      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      tab.conversationId = 'conv-123';

      await initializeTabService(tab, plugin, options.mcpManager);

      expect(mockPreWarm).toHaveBeenCalledWith('session-456');
    });
  });
});

describe('Tab - Activation/Deactivation', () => {
  describe('activateTab', () => {
    it('should show tab content', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      activateTab(tab);

      expect(tab.dom.contentEl.style.display).toBe('flex');
    });
  });

  describe('deactivateTab', () => {
    it('should hide tab content', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // First activate, then deactivate
      activateTab(tab);
      deactivateTab(tab);

      expect(tab.dom.contentEl.style.display).toBe('none');
    });
  });
});

describe('Tab - Event Wiring', () => {
  describe('wireTabInputEvents', () => {
    it('should register event listeners on input element', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize minimal controllers needed
      tab.controllers.inputController = {
        sendMessage: jest.fn(),
        cancelStreaming: jest.fn(),
      } as any;
      tab.controllers.selectionController = {
        showHighlight: jest.fn(),
      } as any;

      wireTabInputEvents(tab);

      // Check that event listeners were added (cast to any to access mock method)
      const listeners = (tab.dom.inputEl as any).getEventListeners();
      expect(listeners.get('keydown')).toBeDefined();
      expect(listeners.get('input')).toBeDefined();
      expect(listeners.get('focus')).toBeDefined();
    });

    it('should store cleanup functions for memory management', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize minimal controllers
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;

      wireTabInputEvents(tab);

      expect(tab.dom.eventCleanups.length).toBe(3); // keydown, input, focus
    });
  });
});

describe('Tab - Destruction', () => {
  describe('destroyTab', () => {
    it('should be an async function', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const result = destroyTab(tab);

      expect(result).toBeInstanceOf(Promise);
      await result; // Should resolve without error
    });

    it('should call cleanup functions for event listeners', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const cleanup1 = jest.fn();
      const cleanup2 = jest.fn();
      tab.dom.eventCleanups = [cleanup1, cleanup2];

      await destroyTab(tab);

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
    });

    it('should clear eventCleanups array after cleanup', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.dom.eventCleanups = [jest.fn(), jest.fn()];

      await destroyTab(tab);

      expect(tab.dom.eventCleanups.length).toBe(0);
    });

    it('should close service persistent query', async () => {
      const mockClosePersistentQuery = jest.fn();
      const options = createMockOptions();
      const tab = createTab(options);

      tab.service = {
        closePersistentQuery: mockClosePersistentQuery,
      } as any;

      await destroyTab(tab);

      expect(mockClosePersistentQuery).toHaveBeenCalledWith('tab closed');
      expect(tab.service).toBeNull();
    });

    it('should remove DOM element', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      await destroyTab(tab);

      expect(tab.dom.contentEl.remove).toHaveBeenCalled();
    });

    it('should cleanup async subagents', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const orphanAllActive = jest.fn();
      tab.services.asyncSubagentManager = { orphanAllActive } as any;

      await destroyTab(tab);

      expect(orphanAllActive).toHaveBeenCalled();
    });

    it('should cleanup UI components', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const destroyFileContext = jest.fn();
      const destroySlashDropdown = jest.fn();
      const destroyInstructionMode = jest.fn();
      const cancelInstructionRefine = jest.fn();
      const cancelTitleGeneration = jest.fn();
      const destroyTodoPanel = jest.fn();

      tab.ui.fileContextManager = { destroy: destroyFileContext } as any;
      tab.ui.slashCommandDropdown = { destroy: destroySlashDropdown } as any;
      tab.ui.instructionModeManager = { destroy: destroyInstructionMode } as any;
      tab.services.instructionRefineService = { cancel: cancelInstructionRefine } as any;
      tab.services.titleGenerationService = { cancel: cancelTitleGeneration } as any;
      tab.ui.todoPanel = { destroy: destroyTodoPanel } as any;

      await destroyTab(tab);

      expect(destroyFileContext).toHaveBeenCalled();
      expect(destroySlashDropdown).toHaveBeenCalled();
      expect(destroyInstructionMode).toHaveBeenCalled();
      expect(cancelInstructionRefine).toHaveBeenCalled();
      expect(cancelTitleGeneration).toHaveBeenCalled();
      expect(destroyTodoPanel).toHaveBeenCalled();
    });
  });
});

describe('Tab - Title', () => {
  describe('getTabTitle', () => {
    it('should return "New Chat" for tab without conversation', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const title = getTabTitle(tab, options.plugin);

      expect(title).toBe('New Chat');
    });

    it('should return conversation title when available', () => {
      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockReturnValue({
          id: 'conv-123',
          title: 'My Conversation',
        }),
      });

      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      tab.conversationId = 'conv-123';

      const title = getTabTitle(tab, plugin);

      expect(title).toBe('My Conversation');
    });

    it('should return "New Chat" when conversation has no title', () => {
      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockReturnValue({
          id: 'conv-123',
          title: null,
        }),
      });

      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      tab.conversationId = 'conv-123';

      const title = getTabTitle(tab, plugin);

      expect(title).toBe('New Chat');
    });
  });
});

describe('Tab - UI Initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initializeTabUI', () => {
    it('should create FileContextManager', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.fileContextManager).toBeDefined();
    });

    it('should wire FileContextManager to MCP service', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(mockFileContextManager.setMcpService).toHaveBeenCalledWith(options.plugin.mcpService);
    });

    it('should create ImageContextManager', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.imageContextManager).toBeDefined();
    });

    it('should create selection indicator element', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.dom.selectionIndicatorEl).toBeDefined();
      expect(tab.dom.selectionIndicatorEl!.style.display).toBe('none');
    });

    it('should create SlashCommandManager when vault path exists', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.slashCommandManager).toBeDefined();
    });

    it('should create SlashCommandDropdown', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.slashCommandDropdown).toBeDefined();
    });

    it('should create InstructionRefineService', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.services.instructionRefineService).toBeDefined();
    });

    it('should create TitleGenerationService', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.services.titleGenerationService).toBeDefined();
    });

    it('should create InstructionModeManager', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.instructionModeManager).toBeDefined();
    });

    it('should create and mount TodoPanel', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.todoPanel).toBeDefined();
      expect(mockTodoPanel.mount).toHaveBeenCalledWith(tab.dom.messagesEl);
    });

    it('should create input toolbar components', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.modelSelector).toBeDefined();
      expect(tab.ui.thinkingBudgetSelector).toBeDefined();
      expect(tab.ui.contextUsageMeter).toBeDefined();
      expect(tab.ui.externalContextSelector).toBeDefined();
      expect(tab.ui.mcpServerSelector).toBeDefined();
      expect(tab.ui.permissionToggle).toBeDefined();
    });

    it('should wire MCP server selector to MCP service', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(mockMcpServerSelector.setMcpService).toHaveBeenCalledWith(options.plugin.mcpService);
    });

    it('should wire external context selector onChange', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(mockExternalContextSelector.setOnChange).toHaveBeenCalled();
    });

    it('should initialize persistent paths from settings', () => {
      const plugin = createMockPlugin({
        settings: {
          ...createMockPlugin().settings,
          persistentExternalContextPaths: ['/path/1', '/path/2'],
        },
      });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      initializeTabUI(tab, plugin);

      expect(mockExternalContextSelector.setPersistentPaths).toHaveBeenCalledWith(['/path/1', '/path/2']);
    });

    it('should update ChatState callbacks for UI updates', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Verify callbacks are set by checking the state
      expect(tab.state.callbacks.onUsageChanged).toBeDefined();
      expect(tab.state.callbacks.onTodosChanged).toBeDefined();
    });
  });
});

describe('Tab - Controller Initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initializeTabControllers', () => {
    it('should create MessageRenderer', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      expect(tab.renderer).toBeDefined();
    });

    it('should create SelectionController', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      expect(tab.controllers.selectionController).toBeDefined();
    });

    it('should create StreamController', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      expect(tab.controllers.streamController).toBeDefined();
    });

    it('should create ConversationController', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      expect(tab.controllers.conversationController).toBeDefined();
    });

    it('should create InputController', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      expect(tab.controllers.inputController).toBeDefined();
    });

    it('should create and initialize NavigationController', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      expect(tab.controllers.navigationController).toBeDefined();
      expect(mockNavigationController.initialize).toHaveBeenCalled();
    });

    it('should update AsyncSubagentManager with StreamController callback', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      // The async subagent manager should be recreated with the new callback
      expect(tab.services.asyncSubagentManager).toBeDefined();
    });
  });
});

describe('Tab - Event Handler Behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('wireTabInputEvents - keydown handlers', () => {
    it('should handle instruction mode trigger key', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Set up UI managers
      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      // Make instruction mode handle the trigger
      mockInstructionModeManager.handleTriggerKey.mockReturnValueOnce(true);

      wireTabInputEvents(tab);

      // Simulate keydown
      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: '#', preventDefault: jest.fn() };
      keydownHandler(event);

      expect(mockInstructionModeManager.handleTriggerKey).toHaveBeenCalled();
    });

    it('should handle instruction mode keydown', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      // Make instruction mode handle keydown
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValueOnce(true);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'Tab', preventDefault: jest.fn() };
      keydownHandler(event);

      expect(mockInstructionModeManager.handleKeydown).toHaveBeenCalled();
    });

    it('should handle slash command dropdown keydown', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValueOnce(true);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'ArrowDown', preventDefault: jest.fn() };
      keydownHandler(event);

      expect(mockSlashCommandDropdown.handleKeydown).toHaveBeenCalled();
    });

    it('should handle file context mention keydown', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValueOnce(true);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'ArrowUp', preventDefault: jest.fn() };
      keydownHandler(event);

      expect(mockFileContextManager.handleMentionKeydown).toHaveBeenCalled();
    });

    it('should cancel streaming on Escape when streaming', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;
      tab.state.isStreaming = true;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'Escape', isComposing: false, preventDefault: jest.fn() };
      keydownHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockInputController.cancelStreaming).toHaveBeenCalled();
    });

    it('should not cancel streaming on Escape when isComposing (IME)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;
      tab.state.isStreaming = true;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'Escape', isComposing: true, preventDefault: jest.fn() };
      keydownHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockInputController.cancelStreaming).not.toHaveBeenCalled();
    });

    it('should send message on Enter (without Shift)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: jest.fn() };
      keydownHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockInputController.sendMessage).toHaveBeenCalled();
    });

    it('should not send message on Shift+Enter (newline)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'Enter', shiftKey: true, isComposing: false, preventDefault: jest.fn() };
      keydownHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockInputController.sendMessage).not.toHaveBeenCalled();
    });

    it('should not send message on Enter when isComposing (IME)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: 'Enter', shiftKey: false, isComposing: true, preventDefault: jest.fn() };
      keydownHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockInputController.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('wireTabInputEvents - input handler', () => {
    it('should trigger file context input change', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const inputHandler = listeners.get('input')[0];
      inputHandler();

      expect(mockFileContextManager.handleInputChange).toHaveBeenCalled();
      expect(mockInstructionModeManager.handleInputChange).toHaveBeenCalled();
    });
  });

  describe('wireTabInputEvents - focus handler', () => {
    it('should show selection highlight on focus', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.controllers.selectionController = mockSelectionController as any;
      tab.controllers.inputController = mockInputController as any;

      wireTabInputEvents(tab);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const focusHandler = listeners.get('focus')[0];
      focusHandler();

      expect(mockSelectionController.showHighlight).toHaveBeenCalled();
    });
  });
});

describe('Tab - ChatState Callback Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should invoke onStreamingChanged callback when streaming state changes', () => {
    const onStreamingChanged = jest.fn();
    const options = createMockOptions({ onStreamingChanged });
    const tab = createTab(options);

    // Trigger the callback through ChatState
    tab.state.callbacks.onStreamingStateChanged?.(true);

    expect(onStreamingChanged).toHaveBeenCalledWith(true);
  });

  it('should invoke onAttentionChanged callback when attention state changes', () => {
    const onAttentionChanged = jest.fn();
    const options = createMockOptions({ onAttentionChanged });
    const tab = createTab(options);

    // Trigger the callback through ChatState
    tab.state.callbacks.onAttentionChanged?.(true);

    expect(onAttentionChanged).toHaveBeenCalledWith(true);
  });

  it('should invoke onConversationIdChanged callback when conversation changes', () => {
    const onConversationIdChanged = jest.fn();
    const options = createMockOptions({ onConversationIdChanged });
    const tab = createTab(options);

    // Trigger the callback through ChatState
    tab.state.callbacks.onConversationChanged?.('new-conv-id');

    expect(onConversationIdChanged).toHaveBeenCalledWith('new-conv-id');
  });
});
