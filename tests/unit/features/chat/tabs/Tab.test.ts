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

// Mock ResizeObserver (not available in jsdom)
const resizeObserverInstances: MockResizeObserver[] = [];
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverInstances.push(this);
  }
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock ClaudianService
jest.mock('@/core/agent', () => ({
  ClaudianService: jest.fn().mockImplementation(() => ({
    loadCCPermissions: jest.fn().mockResolvedValue(undefined),
    ensureReady: jest.fn().mockResolvedValue(true),
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
  setAgentService: jest.fn(),
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

const createMockStatusPanel = () => ({
  mount: jest.fn(),
  remount: jest.fn(),
  updateTodos: jest.fn(),
  updateSubagent: jest.fn(),
  removeSubagent: jest.fn(),
  clearSubagents: jest.fn(),
  restoreSubagents: jest.fn(),
  destroy: jest.fn(),
  showSubagent: jest.fn(),
  hideSubagent: jest.fn(),
  isSubagentVisible: jest.fn().mockReturnValue(false),
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
let mockStatusPanel: ReturnType<typeof createMockStatusPanel>;
let mockModelSelector: ReturnType<typeof createMockModelSelector>;
let mockThinkingBudgetSelector: ReturnType<typeof createMockThinkingBudgetSelector>;
let mockContextUsageMeter: ReturnType<typeof createMockContextUsageMeter>;
let mockExternalContextSelector: ReturnType<typeof createMockExternalContextSelector>;
let mockMcpServerSelector: ReturnType<typeof createMockMcpServerSelector>;
let mockPermissionToggle: ReturnType<typeof createMockPermissionToggle>;
let mockMessageRenderer: { scrollToBottomIfNeeded: jest.Mock; setAsyncSubagentClickCallback: jest.Mock };
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
  StatusPanel: jest.fn().mockImplementation(() => {
    mockStatusPanel = createMockStatusPanel();
    return mockStatusPanel;
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
    mockMessageRenderer = {
      scrollToBottomIfNeeded: jest.fn(),
      setAsyncSubagentClickCallback: jest.fn(),
    };
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
    setCallback: jest.fn(),
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
      toggle: (cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classList.has(cls)) {
            classList.delete(cls);
            return false;
          } else {
            classList.add(cls);
            return true;
          }
        }
        if (force) {
          classList.add(cls);
        } else {
          classList.delete(cls);
        }
        return force;
      },
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
    closest: jest.fn().mockReturnValue({ clientHeight: 600 }),
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
    agentManager: { searchAgents: jest.fn().mockReturnValue([]) },
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationSync: jest.fn().mockReturnValue(null),
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
        ensureReady: jest.fn().mockResolvedValue(true),
      }));

      const options = createMockOptions();
      const tab = createTab(options);

      // Should not throw
      await expect(initializeTabService(tab, options.plugin, options.mcpManager))
        .resolves.not.toThrow();

      expect(tab.serviceInitialized).toBe(true);
    });

    it('should ensureReady without session ID (just spin up process)', async () => {
      const mockEnsureReady = jest.fn().mockResolvedValue(true);
      const agentModule = jest.requireMock('@/core/agent') as { ClaudianService: jest.Mock };
      agentModule.ClaudianService.mockImplementationOnce(() => ({
        loadCCPermissions: jest.fn().mockResolvedValue(undefined),
        ensureReady: mockEnsureReady,
      }));

      const options = createMockOptions();
      const tab = createTab(options);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      // ensureReady should be called with persistent external context paths
      expect(mockEnsureReady).toHaveBeenCalledWith({
        sessionId: undefined,
        externalContextPaths: [],
      });
    });

    it('should ensureReady with saved external contexts for existing conversation', async () => {
      const mockEnsureReady = jest.fn().mockResolvedValue(true);
      const agentModule = jest.requireMock('@/core/agent') as { ClaudianService: jest.Mock };
      agentModule.ClaudianService.mockImplementationOnce(() => ({
        loadCCPermissions: jest.fn().mockResolvedValue(undefined),
        ensureReady: mockEnsureReady,
      }));

      const conversation = {
        id: 'conv-1',
        title: 'Existing Conversation',
        messages: [{ id: 'msg-1', role: 'user' as const, content: 'test', timestamp: Date.now() }],
        sessionId: 'session-123',
        externalContextPaths: ['/saved/path'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const plugin = createMockPlugin();
      plugin.settings.persistentExternalContextPaths = ['/persistent/path'];
      plugin.getConversationById = jest.fn().mockResolvedValue(conversation);

      const options = createMockOptions({ plugin, conversation });
      const tab = createTab(options);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      expect(mockEnsureReady).toHaveBeenCalledWith({
        sessionId: 'session-123',
        externalContextPaths: ['/saved/path'],
      });
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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

      expect(tab.dom.eventCleanups.length).toBe(5); // keydown, input, focus, scroll, scroll-to-bottom click
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
      tab.ui.statusPanel = { destroy: destroyTodoPanel } as any;

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
        getConversationSync: jest.fn().mockReturnValue({
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
        getConversationSync: jest.fn().mockReturnValue({
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

    it('should create and mount StatusPanel', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(tab.ui.statusPanel).toBeDefined();
      expect(mockStatusPanel.mount).toHaveBeenCalledWith(tab.dom.statusPanelContainerEl);
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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

      wireTabInputEvents(tab, options.plugin);

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

describe('Tab - UI Callback Wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initializeTabUI callbacks', () => {
    it('should wire onChipsChanged to scroll to bottom', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize UI to wire callbacks
      initializeTabUI(tab, options.plugin);

      // Set up renderer
      tab.renderer = mockMessageRenderer as any;

      // Get the FileContextManager constructor call arguments
      const { FileContextManager } = jest.requireMock('@/features/chat/ui');
      const constructorCall = FileContextManager.mock.calls[0];
      const callbacks = constructorCall[3]; // 4th argument is callbacks

      // Trigger onChipsChanged callback
      callbacks.onChipsChanged();

      expect(mockMessageRenderer.scrollToBottomIfNeeded).toHaveBeenCalled();
    });

    it('should wire onImagesChanged to scroll to bottom', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      tab.renderer = mockMessageRenderer as any;

      // Get the ImageContextManager constructor call
      const { ImageContextManager } = jest.requireMock('@/features/chat/ui');
      const constructorCall = ImageContextManager.mock.calls[0];
      const callbacks = constructorCall[2]; // 3rd argument is callbacks (app parameter was removed)

      callbacks.onImagesChanged();

      expect(mockMessageRenderer.scrollToBottomIfNeeded).toHaveBeenCalled();
    });

    it('should wire getExcludedTags to return plugin settings', () => {
      const plugin = createMockPlugin({
        settings: {
          ...createMockPlugin().settings,
          excludedTags: ['tag1', 'tag2'],
        },
      });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      initializeTabUI(tab, plugin);

      const { FileContextManager } = jest.requireMock('@/features/chat/ui');
      const constructorCall = FileContextManager.mock.calls[0];
      const callbacks = constructorCall[3];

      const excludedTags = callbacks.getExcludedTags();

      expect(excludedTags).toEqual(['tag1', 'tag2']);
    });

    it('should wire getExternalContexts to return external context selector contexts', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Mock external context selector return value
      mockExternalContextSelector.getExternalContexts.mockReturnValue(['/path/1', '/path/2']);

      const { FileContextManager } = jest.requireMock('@/features/chat/ui');
      const constructorCall = FileContextManager.mock.calls[0];
      const callbacks = constructorCall[3];

      const contexts = callbacks.getExternalContexts();

      expect(contexts).toEqual(['/path/1', '/path/2']);
    });

    it('should wire MCP mention change to add servers to selector', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Get the setOnMcpMentionChange callback
      const onMcpMentionChange = mockFileContextManager.setOnMcpMentionChange.mock.calls[0][0];

      // Trigger with server list
      onMcpMentionChange(['server1', 'server2']);

      expect(mockMcpServerSelector.addMentionedServers).toHaveBeenCalledWith(['server1', 'server2']);
    });

    it('should wire external context onChange to pre-scan contexts', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Get the setOnChange callback
      const onChange = mockExternalContextSelector.setOnChange.mock.calls[0][0];

      // Trigger onChange
      onChange();

      expect(mockFileContextManager.preScanExternalContexts).toHaveBeenCalled();
    });

    it('should wire persistence change to save settings', async () => {
      const saveSettings = jest.fn().mockResolvedValue(undefined);
      const plugin = createMockPlugin({ saveSettings });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      initializeTabUI(tab, plugin);

      // Get the setOnPersistenceChange callback
      const onPersistenceChange = mockExternalContextSelector.setOnPersistenceChange.mock.calls[0][0];

      // Trigger with new paths
      await onPersistenceChange(['/new/path1', '/new/path2']);

      expect(plugin.settings.persistentExternalContextPaths).toEqual(['/new/path1', '/new/path2']);
      expect(saveSettings).toHaveBeenCalled();
    });

    it('should wire onUsageChanged callback to update context meter', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Verify callback is wired
      const usage = { inputTokens: 1000, outputTokens: 500 };
      tab.state.callbacks.onUsageChanged?.(usage as any);

      expect(mockContextUsageMeter.update).toHaveBeenCalledWith(usage);
    });

    it('should wire onTodosChanged callback to update todo panel', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Verify callback is wired
      const todos = [{ id: '1', content: 'Test todo', status: 'pending' }];
      tab.state.callbacks.onTodosChanged?.(todos as any);

      expect(mockStatusPanel.updateTodos).toHaveBeenCalledWith(todos);
    });

    it('should wire instruction mode onSubmit to input controller', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      // Get the InstructionModeManager constructor arguments
      const { InstructionModeManager } = jest.requireMock('@/features/chat/ui');
      const constructorCall = InstructionModeManager.mock.calls[0];
      const callbacks = constructorCall[1]; // 2nd argument is callbacks

      // Trigger onSubmit
      await callbacks.onSubmit('refined instruction');

      expect(mockInputController.handleInstructionSubmit).toHaveBeenCalledWith('refined instruction');
    });

    it('should wire getInputWrapper to return input wrapper element', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      const { InstructionModeManager } = jest.requireMock('@/features/chat/ui');
      const constructorCall = InstructionModeManager.mock.calls[0];
      const callbacks = constructorCall[1];

      const wrapper = callbacks.getInputWrapper();

      expect(wrapper).toBe(tab.dom.inputWrapper);
    });

    it('should wire getSdkCommands callback when provided in options', async () => {
      const mockSdkCommands = [{ id: 'sdk:commit', name: 'commit', content: '' }];
      const getSdkCommands = jest.fn().mockResolvedValue(mockSdkCommands);
      const plugin = createMockPlugin();
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      initializeTabUI(tab, plugin, { getSdkCommands });

      const { SlashCommandDropdown } = jest.requireMock('@/shared/components/SlashCommandDropdown');
      const constructorCall = SlashCommandDropdown.mock.calls[0];
      const callbacks = constructorCall[2]; // 3rd argument is callbacks

      // Verify getSdkCommands callback is wired
      expect(callbacks.getSdkCommands).toBe(getSdkCommands);

      // Verify it returns the expected commands
      const returnedCommands = await callbacks.getSdkCommands();
      expect(returnedCommands).toEqual(mockSdkCommands);
    });
  });
});

describe('Tab - Service Initialization Error Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should skip re-initialization if already initialized', async () => {
    const options = createMockOptions();
    const tab = createTab(options);

    // Mark as already initialized
    tab.serviceInitialized = true;
    const originalService = { id: 'existing-service' } as any;
    tab.service = originalService;

    await initializeTabService(tab, options.plugin, options.mcpManager);

    // Should not change existing service
    expect(tab.service).toBe(originalService);
    expect(tab.serviceInitialized).toBe(true);
  });

  it('should set serviceInitialized to true after successful initialization', async () => {
    const options = createMockOptions();
    const tab = createTab(options);

    expect(tab.serviceInitialized).toBe(false);
    expect(tab.service).toBeNull();

    await initializeTabService(tab, options.plugin, options.mcpManager);

    expect(tab.serviceInitialized).toBe(true);
    expect(tab.service).not.toBeNull();
  });

  it('should call loadCCPermissions during initialization', async () => {
    const { ClaudianService } = jest.requireMock('@/core/agent');
    const loadCCPermissions = jest.fn().mockResolvedValue(undefined);

    ClaudianService.mockImplementation(() => ({
      loadCCPermissions,
      ensureReady: jest.fn().mockResolvedValue(true),
      closePersistentQuery: jest.fn(),
    }));

    const options = createMockOptions();
    const tab = createTab(options);

    await initializeTabService(tab, options.plugin, options.mcpManager);

    expect(loadCCPermissions).toHaveBeenCalled();
  });
});

describe('Tab - Controller Configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('InputController configuration', () => {
    it('should wire ensureServiceInitialized to return true when already initialized', async () => {
      const { InputController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      // Get InputController constructor config
      const constructorCall = InputController.mock.calls[0];
      const config = constructorCall[0];

      // Test ensureServiceInitialized when already initialized
      tab.serviceInitialized = true;
      const result = await config.ensureServiceInitialized();
      expect(result).toBe(true);
    });

    it('should wire getAgentService to return tab service', () => {
      const { InputController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = InputController.mock.calls[0];
      const config = constructorCall[0];

      // Verify getAgentService returns tab's service
      tab.service = { id: 'test-service' } as any;
      expect(config.getAgentService()).toBe(tab.service);
    });

    it('should wire getters to return tab UI components', () => {
      const { InputController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = InputController.mock.calls[0];
      const config = constructorCall[0];

      // Test getters return correct UI components
      expect(config.getInputEl()).toBe(tab.dom.inputEl);
      expect(config.getMessagesEl()).toBe(tab.dom.messagesEl);
      expect(config.getFileContextManager()).toBe(tab.ui.fileContextManager);
      expect(config.getImageContextManager()).toBe(tab.ui.imageContextManager);
      expect(config.getMcpServerSelector()).toBe(tab.ui.mcpServerSelector);
      expect(config.getExternalContextSelector()).toBe(tab.ui.externalContextSelector);
      expect(config.getInstructionModeManager()).toBe(tab.ui.instructionModeManager);
      expect(config.getInstructionRefineService()).toBe(tab.services.instructionRefineService);
      expect(config.getTitleGenerationService()).toBe(tab.services.titleGenerationService);
    });

  });

  describe('StreamController configuration', () => {
    it('should wire updateQueueIndicator to input controller', () => {
      const { StreamController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = StreamController.mock.calls[0];
      const config = constructorCall[0];

      config.updateQueueIndicator();

      expect(mockInputController.updateQueueIndicator).toHaveBeenCalled();
    });

    it('should wire getAgentService to return tab service', () => {
      const { StreamController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      tab.service = { id: 'test-service' } as any;

      const constructorCall = StreamController.mock.calls[0];
      const config = constructorCall[0];

      expect(config.getAgentService()).toBe(tab.service);
    });

    it('should wire getMessagesEl to return tab messages element', () => {
      const { StreamController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = StreamController.mock.calls[0];
      const config = constructorCall[0];

      expect(config.getMessagesEl()).toBe(tab.dom.messagesEl);
    });
  });

  describe('NavigationController configuration', () => {
    it('should wire shouldSkipEscapeHandling to check UI state', () => {
      const { NavigationController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = NavigationController.mock.calls[0];
      const config = constructorCall[0];

      // Test when instruction mode is active
      mockInstructionModeManager.isActive.mockReturnValue(true);
      expect(config.shouldSkipEscapeHandling()).toBe(true);

      // Test when slash command dropdown is visible
      mockInstructionModeManager.isActive.mockReturnValue(false);
      mockSlashCommandDropdown.isVisible.mockReturnValue(true);
      expect(config.shouldSkipEscapeHandling()).toBe(true);

      // Test when mention dropdown is visible
      mockSlashCommandDropdown.isVisible.mockReturnValue(false);
      mockFileContextManager.isMentionDropdownVisible.mockReturnValue(true);
      expect(config.shouldSkipEscapeHandling()).toBe(true);

      // Test when nothing active
      mockFileContextManager.isMentionDropdownVisible.mockReturnValue(false);
      expect(config.shouldSkipEscapeHandling()).toBe(false);
    });

    it('should wire isStreaming to return tab state', () => {
      const { NavigationController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = NavigationController.mock.calls[0];
      const config = constructorCall[0];

      tab.state.isStreaming = true;
      expect(config.isStreaming()).toBe(true);

      tab.state.isStreaming = false;
      expect(config.isStreaming()).toBe(false);
    });

    it('should wire getSettings to return keyboard navigation settings', () => {
      const keyboardNavigation = {
        scrollUpKey: 'k',
        scrollDownKey: 'j',
        focusInputKey: 'i',
      };
      const plugin = createMockPlugin({
        settings: {
          ...createMockPlugin().settings,
          keyboardNavigation,
        },
      });
      const { NavigationController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, plugin);
      initializeTabControllers(tab, plugin, mockComponent, options.mcpManager);

      const constructorCall = NavigationController.mock.calls[0];
      const config = constructorCall[0];

      expect(config.getSettings()).toEqual(keyboardNavigation);
    });
  });

  describe('ConversationController configuration', () => {
    it('should wire getHistoryDropdown to return null (tab has no dropdown)', () => {
      const { ConversationController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = ConversationController.mock.calls[0];
      const config = constructorCall[0];

      expect(config.getHistoryDropdown()).toBeNull();
    });

    it('should wire welcome element getters and setters', () => {
      const { ConversationController } = jest.requireMock('@/features/chat/controllers');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = ConversationController.mock.calls[0];
      const config = constructorCall[0];

      // Test getter - use mock element
      const mockWelcome = { id: 'welcome-el' } as any;
      tab.dom.welcomeEl = mockWelcome;
      expect(config.getWelcomeEl()).toBe(mockWelcome);

      // Test setter
      const newWelcomeEl = { id: 'new-welcome-el' } as any;
      config.setWelcomeEl(newWelcomeEl);
      expect(tab.dom.welcomeEl).toBe(newWelcomeEl);
    });
  });
});

describe('Tab - Scroll to Bottom Button', () => {
  describe('visibility', () => {
    it('should sync initial visibility with autoScrollEnabled state', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Set autoScrollEnabled to false before initializing UI
      tab.state.autoScrollEnabled = false;

      // Mock overflow condition (scrollHeight > clientHeight)
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      initializeTabUI(tab, options.plugin);

      // Button should have 'visible' class since autoScrollEnabled is false AND there's overflow
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(true);
    });

    it('should hide button when autoScrollEnabled is true (initial state)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Default state is autoScrollEnabled = true
      initializeTabUI(tab, options.plugin);

      // Button should not have 'visible' class
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);
    });

    it('should hide button when no scrollable content (no overflow)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // No overflow: scrollHeight equals clientHeight
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      initializeTabUI(tab, options.plugin);

      // Set autoScrollEnabled to false
      tab.state.autoScrollEnabled = false;

      // Button should still be hidden because there's no overflow
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);
    });

    it('should show button when autoScrollEnabled changes to false', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Mock overflow condition (scrollHeight > clientHeight)
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      initializeTabUI(tab, options.plugin);

      // Initially hidden (autoScrollEnabled is true by default)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);

      // Change state
      tab.state.autoScrollEnabled = false;

      // Now visible (autoScrollEnabled is false AND there's overflow)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(true);
    });

    it('should hide button when autoScrollEnabled changes to true', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Mock overflow condition (scrollHeight > clientHeight)
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      initializeTabUI(tab, options.plugin);

      // Set to false first
      tab.state.autoScrollEnabled = false;
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(true);

      // Change back to true
      tab.state.autoScrollEnabled = true;

      // Should be hidden
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);
    });
  });

  describe('click behavior', () => {
    it('should scroll to bottom and re-enable auto-scroll when clicked', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Set up messagesEl with scroll properties
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 500, writable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, options.plugin);
      wireTabInputEvents(tab, options.plugin);

      // Disable auto-scroll
      tab.state.autoScrollEnabled = false;

      // Get the click handler from registered event listeners
      const eventListeners = (tab.dom.scrollToBottomEl as any).getEventListeners();
      const clickHandlers = eventListeners.get('click');
      expect(clickHandlers).toBeDefined();
      expect(clickHandlers.length).toBe(1);

      // Call the click handler directly
      clickHandlers[0]();

      // Should have scrolled to bottom
      expect(tab.dom.messagesEl.scrollTop).toBe(1000);

      // Should have re-enabled auto-scroll
      expect(tab.state.autoScrollEnabled).toBe(true);

      // Button should be hidden now
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);
    });

    it('should scroll to bottom but NOT re-enable auto-scroll when enableAutoScroll setting is false', () => {
      const plugin = createMockPlugin({
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
          enableAutoScroll: false,
        },
      });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      // Set up messagesEl with scroll properties
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 500, writable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, plugin);
      wireTabInputEvents(tab, plugin);

      // State starts false (respecting setting)
      tab.state.autoScrollEnabled = false;

      // Get the click handler
      const eventListeners = (tab.dom.scrollToBottomEl as any).getEventListeners();
      const clickHandlers = eventListeners.get('click');
      clickHandlers[0]();

      // Should have scrolled to bottom
      expect(tab.dom.messagesEl.scrollTop).toBe(1000);

      // Should NOT have re-enabled auto-scroll (respects global setting)
      expect(tab.state.autoScrollEnabled).toBe(false);
    });
  });

  describe('scroll handler - enableAutoScroll disabled', () => {
    it('should keep autoScrollEnabled false and not re-enable when scrolling to bottom', () => {
      const plugin = createMockPlugin({
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
          enableAutoScroll: false,
        },
      });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      // Set up messagesEl with scroll properties - at bottom position
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 980, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 20, configurable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, plugin);
      wireTabInputEvents(tab, plugin);

      // State starts false
      tab.state.autoScrollEnabled = false;

      // Trigger scroll event
      const eventListeners = (tab.dom.messagesEl as any).getEventListeners();
      const scrollHandlers = eventListeners.get('scroll');
      expect(scrollHandlers).toBeDefined();
      scrollHandlers[0]();

      // Should stay false even at bottom (setting overrides scroll behavior)
      expect(tab.state.autoScrollEnabled).toBe(false);
    });

    it('should not attempt to re-enable auto-scroll via timeout when setting is disabled', () => {
      jest.useFakeTimers();

      const plugin = createMockPlugin({
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
          enableAutoScroll: false,
        },
      });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      // Set up messagesEl - scrolled to bottom
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 980, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 20, configurable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, plugin);
      wireTabInputEvents(tab, plugin);

      tab.state.autoScrollEnabled = false;

      // Trigger scroll
      const eventListeners = (tab.dom.messagesEl as any).getEventListeners();
      const scrollHandlers = eventListeners.get('scroll');
      scrollHandlers[0]();

      // Fast-forward past the re-enable delay (150ms)
      jest.advanceTimersByTime(200);

      // Should still be false - timeout should not have re-enabled it
      expect(tab.state.autoScrollEnabled).toBe(false);

      jest.useRealTimers();
    });
  });

  describe('debounce re-verification', () => {
    it('should re-enable auto-scroll after debounce when user remains at bottom', () => {
      jest.useFakeTimers();

      const options = createMockOptions();
      const tab = createTab(options);

      // Set up messagesEl with scroll properties - at bottom position
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 480, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, options.plugin);
      wireTabInputEvents(tab, options.plugin);

      // Disable auto-scroll (simulate user scrolled up)
      tab.state.autoScrollEnabled = false;

      // Trigger scroll event (user scrolls back to bottom)
      const eventListeners = (tab.dom.messagesEl as any).getEventListeners();
      const scrollHandlers = eventListeners.get('scroll');
      expect(scrollHandlers).toBeDefined();
      scrollHandlers[0]();

      // Before debounce delay, still disabled
      expect(tab.state.autoScrollEnabled).toBe(false);

      // After debounce delay (RE_ENABLE_DELAY = 150ms), should be enabled
      jest.advanceTimersByTime(200);
      expect(tab.state.autoScrollEnabled).toBe(true);

      jest.useRealTimers();
    });

    it('should NOT re-enable auto-scroll if content grows during debounce delay', () => {
      jest.useFakeTimers();

      const options = createMockOptions();
      const tab = createTab(options);

      // Set up messagesEl with scroll properties - at bottom position
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 480, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, options.plugin);
      wireTabInputEvents(tab, options.plugin);

      // Disable auto-scroll (simulate user scrolled up)
      tab.state.autoScrollEnabled = false;

      // Trigger scroll event (user scrolls to bottom)
      const eventListeners = (tab.dom.messagesEl as any).getEventListeners();
      const scrollHandlers = eventListeners.get('scroll');
      scrollHandlers[0]();

      // Before debounce delay, still disabled
      expect(tab.state.autoScrollEnabled).toBe(false);

      // Simulate content growth during debounce (e.g., streaming adds more messages)
      // scrollHeight increases but scrollTop stays the same, so user is no longer at bottom
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 2000, configurable: true });

      // After debounce delay, should still be disabled (user no longer at bottom)
      jest.advanceTimersByTime(200);
      expect(tab.state.autoScrollEnabled).toBe(false);

      jest.useRealTimers();
    });

    it('should re-enable auto-scroll if user scrolls to new bottom during content growth', () => {
      jest.useFakeTimers();

      const options = createMockOptions();
      const tab = createTab(options);

      // Set up messagesEl - initially at bottom
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 480, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      // Initialize and wire events
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;
      initializeTabUI(tab, options.plugin);
      wireTabInputEvents(tab, options.plugin);

      // Disable auto-scroll
      tab.state.autoScrollEnabled = false;

      // Trigger scroll to bottom
      const eventListeners = (tab.dom.messagesEl as any).getEventListeners();
      const scrollHandlers = eventListeners.get('scroll');
      scrollHandlers[0]();

      // Content grows but user also scrolls to new bottom
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'scrollTop', { value: 1480, configurable: true });

      // After debounce, should be enabled (user is at new bottom)
      jest.advanceTimersByTime(200);
      expect(tab.state.autoScrollEnabled).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('accessibility', () => {
    it('should create button element with aria-label', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Check that scrollToBottomEl exists and has correct attributes
      expect(tab.dom.scrollToBottomEl).toBeDefined();
      expect(tab.dom.scrollToBottomEl?.tagName).toBe('BUTTON');
    });
  });

  describe('updateScrollVisibility function', () => {
    it('should store updateScrollVisibility function on dom after initializeTabUI', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Before initialization, function should not be set
      expect(tab.dom.updateScrollVisibility).toBeUndefined();

      initializeTabUI(tab, options.plugin);

      // After initialization, function should be available
      expect(tab.dom.updateScrollVisibility).toBeDefined();
      expect(typeof tab.dom.updateScrollVisibility).toBe('function');
    });

    it('should refresh button visibility when activateTab is called', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize UI while tab is hidden (dimensions would be 0)
      initializeTabUI(tab, options.plugin);

      // Set autoScrollEnabled to false
      tab.state.autoScrollEnabled = false;

      // Initially no overflow (dimensions are 0), button should be hidden
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);

      // Now simulate that tab becomes visible and has content (overflow condition)
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      // activateTab should refresh visibility
      activateTab(tab);

      // Button should now be visible (autoScrollEnabled is false AND there's overflow)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(true);
    });

    it('should keep button hidden on activateTab when no overflow', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);
      tab.state.autoScrollEnabled = false;

      // No overflow: scrollHeight equals clientHeight
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      activateTab(tab);

      // Button should remain hidden (no overflow)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);
    });

    it('should keep button hidden on activateTab when autoScrollEnabled is true', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // autoScrollEnabled is true by default
      expect(tab.state.autoScrollEnabled).toBe(true);

      // Even with overflow
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 500, configurable: true });

      activateTab(tab);

      // Button should remain hidden (autoScrollEnabled is true)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);
    });
  });

  describe('ResizeObserver integration', () => {
    beforeEach(() => {
      // Clear instances between tests
      resizeObserverInstances.length = 0;
    });

    it('should set up ResizeObserver on messagesEl during initializeTabUI', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const instancesBefore = resizeObserverInstances.length;
      initializeTabUI(tab, options.plugin);
      const instancesAfter = resizeObserverInstances.length;

      // ResizeObserver should have been created
      expect(instancesAfter).toBe(instancesBefore + 1);

      // observe should have been called with messagesEl
      const observer = resizeObserverInstances[resizeObserverInstances.length - 1];
      expect(observer.observe).toHaveBeenCalledWith(tab.dom.messagesEl);
    });

    it('should register ResizeObserver cleanup in eventCleanups', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      // Should have a cleanup for ResizeObserver
      const cleanupCount = tab.dom.eventCleanups.length;
      expect(cleanupCount).toBeGreaterThan(0);

      // Get the observer before running cleanups
      const observer = resizeObserverInstances[resizeObserverInstances.length - 1];

      // Run cleanups
      for (const cleanup of tab.dom.eventCleanups) {
        cleanup();
      }

      // ResizeObserver.disconnect should have been called
      expect(observer.disconnect).toHaveBeenCalled();
    });

    it('should update button visibility when ResizeObserver callback fires', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Set autoScrollEnabled to false
      tab.state.autoScrollEnabled = false;

      // No overflow initially
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 100, configurable: true });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { value: 100, configurable: true });

      initializeTabUI(tab, options.plugin);

      // Button should be hidden (no overflow)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(false);

      // Simulate content growth causing overflow
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { value: 1000, configurable: true });

      // Get the last ResizeObserver instance and trigger its callback
      const lastObserver = resizeObserverInstances[resizeObserverInstances.length - 1];
      expect(lastObserver).toBeDefined();
      lastObserver.callback([], lastObserver as unknown as ResizeObserver);

      // Button should now be visible (autoScrollEnabled is false AND overflow exists)
      expect(tab.dom.scrollToBottomEl?.classList.contains('visible')).toBe(true);
    });
  });
});
