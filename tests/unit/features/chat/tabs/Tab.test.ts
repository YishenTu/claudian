import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ChatState } from '@/features/chat/state/ChatState';
import {
  activateTab,
  createTab,
  deactivateTab,
  destroyTab,
  getBlankTabModelOptions,
  getTabTitle,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  onProviderAvailabilityChanged,
  setupServiceCallbacks,
  type TabCreateOptions,
  wireTabInputEvents,
} from '@/features/chat/tabs/Tab';
import {
  DEFAULT_CODEX_PRIMARY_MODEL,
  DEFAULT_CODEX_PRIMARY_MODEL_LABEL,
} from '@/providers/codex/types/models';
import * as envUtils from '@/utils/env';

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

// Mock provider runtime used by ProviderRegistry
jest.mock('@/providers/claude/runtime/ClaudeChatRuntime', () => ({
  ClaudianService: jest.fn().mockImplementation(() => ({
    ensureReady: jest.fn().mockResolvedValue(true),
    cleanup: jest.fn(),
    isReady: jest.fn().mockReturnValue(false),
    syncConversationState: jest.fn(),
    onReadyStateChange: jest.fn((listener: (ready: boolean) => void) => {
      listener(false);
      return () => {};
    }),
  })),
}));

// Mock factories must be defined before jest.mock calls due to hoisting
// These will be initialized fresh in beforeEach
const createMockFileContextManager = () => ({
  setMcpManager: jest.fn(),
  setAgentService: jest.fn(),
  setOnMcpMentionChange: jest.fn(),
  preScanExternalContexts: jest.fn(),
  handleInputChange: jest.fn(),
  handleMentionKeydown: jest.fn().mockReturnValue(false),
  isMentionDropdownVisible: jest.fn().mockReturnValue(false),
  hideMentionDropdown: jest.fn(),
  destroy: jest.fn(),
});

const createMockImageContextManager = () => ({
  destroy: jest.fn(),
  clearImages: jest.fn(),
  setEnabled: jest.fn(),
});

const createMockSlashCommandDropdown = () => ({
  handleKeydown: jest.fn().mockReturnValue(false),
  isVisible: jest.fn().mockReturnValue(false),
  hide: jest.fn(),
  resetSdkSkillsCache: jest.fn(),
  setHiddenCommands: jest.fn(),
  setEnabled: jest.fn(),
  destroy: jest.fn(),
});

const createMockInstructionModeManager = () => ({
  handleTriggerKey: jest.fn().mockReturnValue(false),
  handleKeydown: jest.fn().mockReturnValue(false),
  handleInputChange: jest.fn(),
  isActive: jest.fn().mockReturnValue(false),
  destroy: jest.fn(),
});

const createMockBangBashModeManager = () => ({
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
  destroy: jest.fn(),
});

const createMockModelSelector = () => ({
  updateDisplay: jest.fn(),
  renderOptions: jest.fn(),
  setReady: jest.fn(),
});

const createMockClaudianService = (overrides?: {
  ensureReady?: jest.Mock;
  syncConversationState?: jest.Mock;
  onReadyStateChange?: jest.Mock;
  providerId?: 'claude' | 'codex';
}) => ({
  providerId: overrides?.providerId ?? 'claude',
  ensureReady: overrides?.ensureReady ?? jest.fn().mockResolvedValue(true),
  cleanup: jest.fn(),
  isReady: jest.fn().mockReturnValue(false),
  getCapabilities: jest.fn().mockReturnValue({
    providerId: overrides?.providerId ?? 'claude',
    supportsPersistentRuntime: true,
    supportsNativeHistory: true,
    supportsPlanMode: true,
    supportsRewind: true,
    supportsFork: true,
    supportsProviderCommands: true,
    supportsImageAttachments: true,
    supportsInstructionMode: true,
    supportsMcpTools: true,
    reasoningControl: 'effort',
  }),
  syncConversationState: overrides?.syncConversationState ?? jest.fn(),
  onReadyStateChange: overrides?.onReadyStateChange ?? jest.fn((listener: (ready: boolean) => void) => {
    listener(false);
    return () => {};
  }),
});

const createMockThinkingBudgetSelector = () => ({
  updateDisplay: jest.fn(),
});

const createMockContextUsageMeter = () => ({
  update: jest.fn(),
  setVisible: jest.fn(),
});

const createMockExternalContextSelector = () => ({
  getExternalContexts: jest.fn().mockReturnValue([]),
  setOnChange: jest.fn(),
  setPersistentPaths: jest.fn(),
  setOnPersistenceChange: jest.fn(),
});

const createMockMcpServerSelector = () => ({
  setMcpManager: jest.fn(),
  addMentionedServers: jest.fn(),
  clearEnabled: jest.fn(),
  setVisible: jest.fn(),
});

const createMockPermissionToggle = () => ({
  updateDisplay: jest.fn(),
});

const createMockServiceTierToggle = () => ({
  updateDisplay: jest.fn(),
});

// Shared mock instances (reset in beforeEach)
let mockFileContextManager: ReturnType<typeof createMockFileContextManager>;
let mockImageContextManager: ReturnType<typeof createMockImageContextManager>;
let mockSlashCommandDropdown: ReturnType<typeof createMockSlashCommandDropdown>;
let mockInstructionModeManager: ReturnType<typeof createMockInstructionModeManager>;
let mockBangBashModeManager: ReturnType<typeof createMockBangBashModeManager>;
let mockStatusPanel: ReturnType<typeof createMockStatusPanel>;
let mockModelSelector: ReturnType<typeof createMockModelSelector>;
let mockThinkingBudgetSelector: ReturnType<typeof createMockThinkingBudgetSelector>;
let mockContextUsageMeter: ReturnType<typeof createMockContextUsageMeter>;
let mockExternalContextSelector: ReturnType<typeof createMockExternalContextSelector>;
let mockMcpServerSelector: ReturnType<typeof createMockMcpServerSelector>;
let mockPermissionToggle: ReturnType<typeof createMockPermissionToggle>;
let mockServiceTierToggle: ReturnType<typeof createMockServiceTierToggle>;
let mockMessageRenderer: { scrollToBottomIfNeeded: jest.Mock; setAsyncSubagentClickCallback: jest.Mock };
let mockSelectionController: ReturnType<typeof createMockSelectionController>;
let mockBrowserSelectionController: ReturnType<typeof createMockBrowserSelectionController>;
let mockCanvasSelectionController: ReturnType<typeof createMockCanvasSelectionController>;
let mockStreamController: { onAsyncSubagentStateChange: jest.Mock };
let mockConversationController: { save: jest.Mock };
let mockInputController: ReturnType<typeof createMockInputController>;
let mockNavigationController: { initialize: jest.Mock; dispose: jest.Mock };

const createMockSelectionController = () => ({
  start: jest.fn(),
  stop: jest.fn(),
  clear: jest.fn(),
  showHighlight: jest.fn(),
  updateContextRowVisibility: jest.fn(),
});

const createMockBrowserSelectionController = () => ({
  start: jest.fn(),
  stop: jest.fn(),
  clear: jest.fn(),
  updateContextRowVisibility: jest.fn(),
});

const createMockCanvasSelectionController = () => ({
  start: jest.fn(),
  stop: jest.fn(),
  clear: jest.fn(),
  updateContextRowVisibility: jest.fn(),
});

const createMockInputController = () => ({
  sendMessage: jest.fn(),
  cancelStreaming: jest.fn(),
  handleInstructionSubmit: jest.fn(),
  updateQueueIndicator: jest.fn(),
  handleResumeKeydown: jest.fn().mockReturnValue(false),
  isResumeDropdownVisible: jest.fn().mockReturnValue(false),
  destroyResumeDropdown: jest.fn(),
  dismissPendingApproval: jest.fn(),
});

jest.mock('@/features/chat/ui/FileContext', () => ({
  FileContextManager: jest.fn().mockImplementation(() => {
    mockFileContextManager = createMockFileContextManager();
    return mockFileContextManager;
  }),
}));

jest.mock('@/features/chat/ui/ImageContext', () => ({
  ImageContextManager: jest.fn().mockImplementation(() => {
    mockImageContextManager = createMockImageContextManager();
    return mockImageContextManager;
  }),
}));

jest.mock('@/features/chat/ui/InstructionModeManager', () => ({
  InstructionModeManager: jest.fn().mockImplementation(() => {
    mockInstructionModeManager = createMockInstructionModeManager();
    return mockInstructionModeManager;
  }),
}));

jest.mock('@/features/chat/ui/StatusPanel', () => ({
  StatusPanel: jest.fn().mockImplementation(() => {
    mockStatusPanel = createMockStatusPanel();
    return mockStatusPanel;
  }),
}));

jest.mock('@/features/chat/ui/InputToolbar', () => ({
  createInputToolbar: jest.fn().mockImplementation(() => {
    mockModelSelector = createMockModelSelector();
    mockThinkingBudgetSelector = createMockThinkingBudgetSelector();
    mockContextUsageMeter = createMockContextUsageMeter();
    mockExternalContextSelector = createMockExternalContextSelector();
    mockMcpServerSelector = createMockMcpServerSelector();
    mockPermissionToggle = createMockPermissionToggle();
    mockServiceTierToggle = createMockServiceTierToggle();
    return {
      modelSelector: mockModelSelector,
      thinkingBudgetSelector: mockThinkingBudgetSelector,
      contextUsageMeter: mockContextUsageMeter,
      externalContextSelector: mockExternalContextSelector,
      mcpServerSelector: mockMcpServerSelector,
      permissionToggle: mockPermissionToggle,
      serviceTierToggle: mockServiceTierToggle,
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
jest.mock('@/features/chat/rendering/MessageRenderer', () => ({
  MessageRenderer: jest.fn().mockImplementation(() => {
    mockMessageRenderer = {
      scrollToBottomIfNeeded: jest.fn(),
      setAsyncSubagentClickCallback: jest.fn(),
    };
    return mockMessageRenderer;
  }),
}));

jest.mock('@/features/chat/rendering/ThinkingBlockRenderer', () => ({
  cleanupThinkingBlock: jest.fn(),
}));

// Mock controllers
jest.mock('@/features/chat/controllers/SelectionController', () => ({
  SelectionController: jest.fn().mockImplementation(() => {
    mockSelectionController = createMockSelectionController();
    return mockSelectionController;
  }),
}));

jest.mock('@/features/chat/controllers/BrowserSelectionController', () => ({
  BrowserSelectionController: jest.fn().mockImplementation(() => {
    mockBrowserSelectionController = createMockBrowserSelectionController();
    return mockBrowserSelectionController;
  }),
}));

jest.mock('@/features/chat/controllers/CanvasSelectionController', () => ({
  CanvasSelectionController: jest.fn().mockImplementation(() => {
    mockCanvasSelectionController = createMockCanvasSelectionController();
    return mockCanvasSelectionController;
  }),
}));

jest.mock('@/features/chat/controllers/StreamController', () => ({
  StreamController: jest.fn().mockImplementation(() => {
    mockStreamController = { onAsyncSubagentStateChange: jest.fn() };
    return mockStreamController;
  }),
}));

jest.mock('@/features/chat/controllers/ConversationController', () => ({
  ConversationController: jest.fn().mockImplementation(() => {
    mockConversationController = { save: jest.fn().mockResolvedValue(undefined) };
    return mockConversationController;
  }),
}));

jest.mock('@/features/chat/controllers/InputController', () => ({
  InputController: jest.fn().mockImplementation(() => {
    mockInputController = createMockInputController();
    return mockInputController;
  }),
}));

jest.mock('@/features/chat/controllers/NavigationController', () => ({
  NavigationController: jest.fn().mockImplementation(() => {
    mockNavigationController = { initialize: jest.fn(), dispose: jest.fn() };
    return mockNavigationController;
  }),
}));

// Mock services
jest.mock('@/features/chat/services/SubagentManager', () => ({
  SubagentManager: jest.fn().mockImplementation(() => ({
    orphanAllActive: jest.fn(),
    setCallback: jest.fn(),
    clear: jest.fn(),
  })),
}));

jest.mock('@/providers/claude/auxiliary/ClaudeInstructionRefineService', () => ({
  InstructionRefineService: jest.fn().mockImplementation(() => ({
    cancel: jest.fn(),
    resetConversation: jest.fn(),
  })),
}));

jest.mock('@/providers/claude/auxiliary/ClaudeTitleGenerationService', () => ({
  TitleGenerationService: jest.fn().mockImplementation(() => ({
    cancel: jest.fn(),
  })),
}));

// Mock path util
jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

// Helper to create mock plugin
function createMockPlugin(overrides: Record<string, any> = {}): any {
  const claudeAgentMentionProvider = { searchAgents: jest.fn().mockReturnValue([]) };
  const codexAgentMentionProvider = { searchAgents: jest.fn().mockReturnValue([]) };
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
      effortLevel: 'high',
      serviceTier: 'default',
      permissionMode: 'yolo',
      keyboardNavigation: {
        scrollUpKey: 'k',
        scrollDownKey: 'j',
        focusInputKey: 'i',
      },
      persistentExternalContextPaths: [],
      settingsProvider: 'claude',
      codexEnabled: true,
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
      },
      savedProviderEffort: {
        claude: 'high',
      },
      savedProviderServiceTier: {
        claude: 'default',
      },
      savedProviderThinkingBudget: {
        claude: 'low',
      },
    },
    mcpManager: { getMcpServers: jest.fn().mockReturnValue([]) },
    agentManager: claudeAgentMentionProvider,
    codexAgentMentionProvider,
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationSync: jest.fn().mockReturnValue(null),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    ...overrides,
  };
}

// Helper to create mock MCP manager
function createMockMcpManager(): any {
  return {
    getMcpServers: jest.fn().mockReturnValue([]),
  };
}

type TestTabCreateOptions = TabCreateOptions & {
  mcpManager: ReturnType<typeof createMockMcpManager>;
};

// Helper to create TabCreateOptions
function createMockOptions(overrides: Partial<TestTabCreateOptions> = {}): TestTabCreateOptions {
  const options = {
    plugin: createMockPlugin(),
    mcpManager: createMockMcpManager(),
    containerEl: createMockEl(),
    ...overrides,
  } as TestTabCreateOptions;

  const plugin = options.plugin as any;
  ProviderWorkspaceRegistry.setServices('claude', {
    mcpManager: plugin.mcpManager,
    mcpServerManager: plugin.mcpManager,
    agentMentionProvider: plugin.agentManager,
  } as any);
  ProviderWorkspaceRegistry.setServices('codex', {
    agentMentionProvider: plugin.codexAgentMentionProvider,
  } as any);

  return options;
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
          providerId: 'claude',
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
      const containerEl = createMockEl();
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

    it('should derive the blank-tab provider from the default draft model', () => {
      const plugin = createMockPlugin();
      plugin.settings.model = DEFAULT_CODEX_PRIMARY_MODEL;

      const tab = createTab(createMockOptions({ plugin }));

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(tab.providerId).toBe('codex');
    });

    it('should resolve draft model from defaultProviderId via projection', () => {
      const plugin = createMockPlugin();
      // Top-level model is Claude, but Codex has its own saved model
      plugin.settings.model = 'claude-sonnet-4-5';
      plugin.settings.settingsProvider = 'claude';
      plugin.settings.savedProviderModel = { claude: 'claude-sonnet-4-5', codex: DEFAULT_CODEX_PRIMARY_MODEL };

      const tab = createTab(createMockOptions({ plugin, defaultProviderId: 'codex' }));

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(tab.providerId).toBe('codex');
    });

    it('should resolve draft model for Claude when defaultProviderId is claude', () => {
      const plugin = createMockPlugin();
      // Simulate settings where top-level model drifted to a codex value
      plugin.settings.model = 'gpt-5.4-mini';
      plugin.settings.settingsProvider = 'claude';
      plugin.settings.savedProviderModel = { claude: 'opus', codex: 'gpt-5.4-mini' };

      const tab = createTab(createMockOptions({ plugin, defaultProviderId: 'claude' }));

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe('opus');
      expect(tab.providerId).toBe('claude');
    });

    it('should fall back to settings.model when no defaultProviderId is given', () => {
      const plugin = createMockPlugin();
      plugin.settings.model = 'opus';

      const tab = createTab(createMockOptions({ plugin }));

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe('opus');
      expect(tab.providerId).toBe('claude');
    });

    it('should keep a Claude custom gpt model on Claude when Codex is disabled', () => {
      const plugin = createMockPlugin();
      plugin.settings.settingsProvider = 'claude';
      plugin.settings.model = DEFAULT_CODEX_PRIMARY_MODEL;
      plugin.settings.providerConfigs = {
        claude: {
          environmentVariables: `ANTHROPIC_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
        },
        codex: {
          enabled: false,
        },
      };

      const tab = createTab(createMockOptions({ plugin }));

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(tab.providerId).toBe('claude');
    });

    it('should fall back to an enabled provider when defaultProviderId is disabled', () => {
      const plugin = createMockPlugin();
      plugin.settings.settingsProvider = 'claude';
      plugin.settings.model = 'claude-sonnet-4-5';
      plugin.settings.providerConfigs = {
        claude: {},
        codex: {
          enabled: false,
        },
      };
      plugin.settings.savedProviderModel = {
        claude: 'opus',
        codex: DEFAULT_CODEX_PRIMARY_MODEL,
      };

      const tab = createTab(createMockOptions({ plugin, defaultProviderId: 'codex' }));

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe('opus');
      expect(tab.providerId).toBe('claude');
    });
  });
});

describe('Tab - Service Initialization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initializeTabService', () => {
    it('should not reinitialize if already initialized', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      tab.serviceInitialized = true;
      tab.service = createMockClaudianService() as any;

      await initializeTabService(tab, options.plugin, options.mcpManager);

      // Service should not be replaced
      expect(tab.service).toEqual(expect.objectContaining({ providerId: 'claude' }));
    });

    it('should create ClaudianService on first initialization', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      expect(tab.service).toBeDefined();
      expect(tab.serviceInitialized).toBe(true);
    });

    it('should create the runtime for the conversation provider', async () => {
      const createChatRuntimeSpy = jest.spyOn(ProviderRegistry, 'createChatRuntime');
      const mockRuntime = createMockClaudianService({ providerId: 'codex' });
      createChatRuntimeSpy.mockReturnValue(mockRuntime as any);

      const conversation = {
        id: 'conv-codex',
        providerId: 'codex' as const,
        title: 'Codex Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockResolvedValue(conversation),
      });

      const tab = createTab(createMockOptions({
        plugin,
        conversation,
      }));

      await initializeTabService(tab, plugin, createMockMcpManager());

      expect(createChatRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
        plugin,
        providerId: 'codex',
      }));
    });

    it('should recreate the runtime when the conversation provider changes', async () => {
      const createChatRuntimeSpy = jest.spyOn(ProviderRegistry, 'createChatRuntime');
      const oldService = createMockClaudianService({ providerId: 'claude' });
      const newService = createMockClaudianService({ providerId: 'codex' });
      createChatRuntimeSpy.mockReturnValue(newService as any);

      const conversation = {
        id: 'conv-codex',
        providerId: 'codex' as const,
        title: 'Codex Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockResolvedValue(conversation),
      });

      const tab = createTab(createMockOptions({
        plugin,
        conversation,
      }));
      tab.service = oldService as any;
      tab.serviceInitialized = true;

      await initializeTabService(tab, plugin, createMockMcpManager());

      expect(oldService.cleanup).toHaveBeenCalled();
      expect(createChatRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
        plugin,
        providerId: 'codex',
      }));
      expect(tab.service).toBe(newService);
    });

    it('should NOT call ensureReady for blank tabs (lazy start)', async () => {
      const mockEnsureReady = jest.fn().mockResolvedValue(true);
      const runtimeModule = jest.requireMock('@/providers/claude/runtime/ClaudeChatRuntime') as { ClaudianService: jest.Mock };
      runtimeModule.ClaudianService.mockImplementationOnce(() => createMockClaudianService({ ensureReady: mockEnsureReady }));

      const options = createMockOptions();
      const tab = createTab(options);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      // Runtime starts on demand in query(), not during initialization
      expect(mockEnsureReady).not.toHaveBeenCalled();
      expect(tab.serviceInitialized).toBe(true);
      expect(tab.lifecycleState).toBe('bound_active');
    });

    it('should sync existing conversations with saved external contexts', async () => {
      const mockSyncConversationState = jest.fn();
      const runtimeModule = jest.requireMock('@/providers/claude/runtime/ClaudeChatRuntime') as { ClaudianService: jest.Mock };
      runtimeModule.ClaudianService.mockImplementationOnce(() => createMockClaudianService({
        syncConversationState: mockSyncConversationState,
      }));

      const conversation = {
        id: 'conv-1',
        providerId: 'claude' as const,
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

      expect(mockSyncConversationState).toHaveBeenCalledWith(conversation, ['/saved/path']);
    });

    it('should initialize toolbar config for the tab provider', () => {
      const getChatUIConfigSpy = jest.spyOn(ProviderRegistry, 'getChatUIConfig');
      const getCapabilitiesSpy = jest.spyOn(ProviderRegistry, 'getCapabilities');
      jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
      getChatUIConfigSpy.mockReturnValue({
        getModelOptions: jest.fn().mockReturnValue([]),
        ownsModel: jest.fn().mockReturnValue(false),
        isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
        getReasoningOptions: jest.fn().mockReturnValue([]),
        getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
        getContextWindowSize: jest.fn().mockReturnValue(200000),
        isDefaultModel: jest.fn().mockReturnValue(true),
        applyModelDefaults: jest.fn(),
        normalizeModelVariant: jest.fn((model: string) => model),
        getCustomModelIds: jest.fn().mockReturnValue(new Set()),
      });
      getCapabilitiesSpy.mockReturnValue({
        providerId: 'codex',
        supportsPersistentRuntime: true,
        supportsNativeHistory: true,
        supportsPlanMode: false,
        supportsRewind: false,
        supportsFork: false,
        supportsProviderCommands: false,
        supportsImageAttachments: true,
        supportsInstructionMode: false,
        supportsMcpTools: false,
        reasoningControl: 'none',
      });

      const options = createMockOptions({
        conversation: {
          id: 'conv-codex',
          providerId: 'codex',
          title: 'Codex Conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
        createInputToolbar: jest.Mock;
      };
      const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];
      expect(toolbarCallbacks).toBeDefined();

      toolbarCallbacks.getUIConfig();
      toolbarCallbacks.getCapabilities();

      expect(getChatUIConfigSpy).toHaveBeenCalledWith('codex');
      expect(getCapabilitiesSpy).toHaveBeenCalledWith('codex');
    });

    it('resolves the agent mention service through the provider-specific lookup', () => {
      jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

      const codexAgentMentionProvider = { searchAgents: jest.fn().mockReturnValue([]) };
      const getAgentMentionProviderSpy = jest.spyOn(ProviderWorkspaceRegistry, 'getAgentMentionProvider')
        .mockReturnValue(codexAgentMentionProvider as any);
      const plugin = createMockPlugin({
        codexAgentMentionProvider,
      });
      const tab = createTab(createMockOptions({
        plugin,
        conversation: {
          id: 'conv-codex-agent-split',
          providerId: 'codex',
          title: 'Codex agent split',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }));

      initializeTabUI(tab, plugin);

      expect(getAgentMentionProviderSpy).toHaveBeenCalledWith('codex');
      expect(mockFileContextManager.setAgentService).toHaveBeenCalledWith(codexAgentMentionProvider);
    });

    it('falls back blank Codex draft to Claude when Codex is disabled', () => {
      jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

      const plugin = createMockPlugin();
      const tab = createTab(createMockOptions({ plugin }));
      initializeTabUI(tab, plugin);

      // Simulate blank tab with Codex draft model
      tab.draftModel = DEFAULT_CODEX_PRIMARY_MODEL;
      tab.providerId = 'codex';
      tab.lifecycleState = 'blank';

      const staleService = createMockClaudianService({ providerId: 'codex' });
      tab.service = staleService as any;
      tab.serviceInitialized = true;

      // Disable Codex
      plugin.settings.codexEnabled = false;

      onProviderAvailabilityChanged(tab, plugin);

      expect(staleService.cleanup).toHaveBeenCalled();
      expect(tab.providerId).toBe('claude');
      expect(tab.service).toBeNull();
      expect(tab.serviceInitialized).toBe(false);
      expect(mockSlashCommandDropdown.resetSdkSkillsCache).toHaveBeenCalled();
    });

    it('rebinds blank-tab helper services when a newly enabled provider takes over the draft model', () => {
      const createInstructionRefineServiceSpy = jest.spyOn(ProviderRegistry, 'createInstructionRefineService')
        .mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      const createTitleGenerationServiceSpy = jest.spyOn(ProviderRegistry, 'createTitleGenerationService')
        .mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

      const plugin = createMockPlugin();
      plugin.settings.settingsProvider = 'claude';
      plugin.settings.model = DEFAULT_CODEX_PRIMARY_MODEL;
      plugin.settings.providerConfigs = {
        claude: {
          environmentVariables: `ANTHROPIC_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
        },
        codex: {
          enabled: false,
        },
      };

      const tab = createTab(createMockOptions({ plugin }));
      initializeTabUI(tab, plugin);

      expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(tab.providerId).toBe('claude');

      plugin.settings.providerConfigs = {
        ...plugin.settings.providerConfigs,
        codex: {
          enabled: true,
        },
      };

      onProviderAvailabilityChanged(tab, plugin);

      expect(tab.providerId).toBe('codex');
      expect(createInstructionRefineServiceSpy).toHaveBeenLastCalledWith(plugin, 'codex');
      expect(createTitleGenerationServiceSpy).toHaveBeenLastCalledWith(plugin, 'codex');
    });

    it('surfaces provider-scoped model settings for inactive-provider tabs and saves back to that provider snapshot', async () => {
      const plugin = createMockPlugin({
        settings: {
          excludedTags: [],
          model: 'claude-sonnet-4-5',
          thinkingBudget: 'low',
          effortLevel: 'high',
          permissionMode: 'yolo',
              keyboardNavigation: {
            scrollUpKey: 'k',
            scrollDownKey: 'j',
            focusInputKey: 'i',
          },
          persistentExternalContextPaths: [],
          settingsProvider: 'claude',
          codexEnabled: true,
          savedProviderModel: {
            claude: 'claude-sonnet-4-5',
            codex: DEFAULT_CODEX_PRIMARY_MODEL,
          },
          savedProviderEffort: {
            claude: 'high',
            codex: 'medium',
          },
          savedProviderThinkingBudget: {
            claude: 'low',
            codex: 'off',
          },
        },
      });

      const tab = createTab(createMockOptions({
        plugin,
        conversation: {
          id: 'conv-codex-settings',
          providerId: 'codex',
          title: 'Codex conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }));

      initializeTabUI(tab, plugin);

      const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
        createInputToolbar: jest.Mock;
      };
      const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

      expect(toolbarCallbacks.getSettings()).toEqual(expect.objectContaining({
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        effortLevel: 'medium',
      }));

      await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);

      expect(plugin.settings.model).toBe('claude-sonnet-4-5');
      expect(plugin.settings.savedProviderModel).toEqual(expect.objectContaining({
        claude: 'claude-sonnet-4-5',
        codex: DEFAULT_CODEX_PRIMARY_MODEL,
      }));
      expect(plugin.saveSettings).toHaveBeenCalled();
    });

    it('resets to blank state when the new-conversation callback fires', () => {
      jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

      const plugin = createMockPlugin();
      const tab = createTab(createMockOptions({ plugin }));
      initializeTabUI(tab, plugin);
      initializeTabControllers(tab, plugin, {} as any, createMockMcpManager());

      // Simulate a bound tab
      tab.lifecycleState = 'bound_cold';
      tab.conversationId = 'conv-1';

      const convCtrlModule = jest.requireMock('@/features/chat/controllers/ConversationController') as {
        ConversationController: jest.Mock;
      };
      const callback = convCtrlModule.ConversationController.mock.calls.at(-1)?.[1]?.onNewConversation;

      expect(callback).toBeDefined();

      callback();

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.conversationId).toBeNull();
      // Draft model is resolved via provider projection, not raw settings.model
      expect(tab.draftModel).toBe(plugin.settings.savedProviderModel.claude);
      expect(tab.serviceInitialized).toBe(false);
    });

    it('preserves codex provider on new session when tab was codex', () => {
      jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

      const plugin = createMockPlugin();
      plugin.settings.savedProviderModel = { claude: 'claude-sonnet-4-5', codex: DEFAULT_CODEX_PRIMARY_MODEL };
      const tab = createTab(createMockOptions({ plugin }));
      initializeTabUI(tab, plugin);
      initializeTabControllers(tab, plugin, {} as any, createMockMcpManager());

      // Simulate a bound Codex tab
      tab.lifecycleState = 'bound_cold';
      tab.conversationId = 'conv-1';
      tab.providerId = 'codex';

      const convCtrlModule = jest.requireMock('@/features/chat/controllers/ConversationController') as {
        ConversationController: jest.Mock;
      };
      const callback = convCtrlModule.ConversationController.mock.calls.at(-1)?.[1]?.onNewConversation;

      callback();

      expect(tab.lifecycleState).toBe('blank');
      expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(tab.providerId).toBe('codex');
    });

    it('cleans up the active runtime when resetting to a new blank session', () => {
      jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
      jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

      const plugin = createMockPlugin();
      plugin.settings.savedProviderModel = { claude: 'claude-sonnet-4-5', codex: DEFAULT_CODEX_PRIMARY_MODEL };
      const tab = createTab(createMockOptions({ plugin }));
      initializeTabUI(tab, plugin);
      initializeTabControllers(tab, plugin, {} as any, createMockMcpManager());

      const staleService = createMockClaudianService({ providerId: 'codex' });
      tab.lifecycleState = 'bound_active';
      tab.conversationId = 'conv-1';
      tab.providerId = 'codex';
      tab.service = staleService as any;
      tab.serviceInitialized = true;

      const convCtrlModule = jest.requireMock('@/features/chat/controllers/ConversationController') as {
        ConversationController: jest.Mock;
      };
      const callback = convCtrlModule.ConversationController.mock.calls.at(-1)?.[1]?.onNewConversation;

      callback();

      expect(staleService.cleanup).toHaveBeenCalledTimes(1);
      expect(tab.service).toBeNull();
      expect(tab.serviceInitialized).toBe(false);
      expect(tab.lifecycleState).toBe('blank');
      expect(tab.providerId).toBe('codex');
      expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
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
      const inputListeners = (tab.dom.inputEl as any).getEventListeners();
      expect(inputListeners.get('keydown')).toBeDefined();
      expect(inputListeners.get('input')).toBeDefined();
      // focusin is registered on contentEl (not inputEl) to catch focus on any sidebar element
      const contentListeners = (tab.dom.contentEl as any).getEventListeners();
      expect(contentListeners.get('focusin')).toBeDefined();
    });

    it('should store cleanup functions for memory management', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize minimal controllers
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;

      wireTabInputEvents(tab, options.plugin);

      expect(tab.dom.eventCleanups.length).toBe(4); // keydown, input, focus, scroll
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

    it('should unsubscribe from ready state changes when tab is destroyed', async () => {
      const unsubscribeFn = jest.fn();
      const mockOnReadyStateChange = jest.fn(() => unsubscribeFn);

      const runtimeModule = jest.requireMock('@/providers/claude/runtime/ClaudeChatRuntime') as { ClaudianService: jest.Mock };
      runtimeModule.ClaudianService.mockImplementationOnce(() => createMockClaudianService({ onReadyStateChange: mockOnReadyStateChange }));

      const options = createMockOptions();
      const tab = createTab(options);
      initializeTabUI(tab, options.plugin);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      expect(mockOnReadyStateChange).toHaveBeenCalled();

      await destroyTab(tab);

      expect(unsubscribeFn).toHaveBeenCalled();
    });

    it('should cleanup the runtime service', async () => {
      const mockCleanup = jest.fn();
      const options = createMockOptions();
      const tab = createTab(options);

      tab.service = {
        cleanup: mockCleanup,
      } as any;

      await destroyTab(tab);

      expect(mockCleanup).toHaveBeenCalled();
      expect(tab.service).toBeNull();
    });

    it('should remove DOM element', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const removeSpy = jest.spyOn(tab.dom.contentEl, 'remove');

      await destroyTab(tab);

      expect(removeSpy).toHaveBeenCalled();
    });

    it('should cleanup subagents', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const orphanAllActive = jest.fn();
      const clear = jest.fn();
      tab.services.subagentManager = { orphanAllActive, clear } as any;

      await destroyTab(tab);

      expect(orphanAllActive).toHaveBeenCalled();
      expect(clear).toHaveBeenCalled();
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
      const destroyResumeDropdown = jest.fn();

      tab.controllers.inputController = { destroyResumeDropdown, dismissPendingApproval: jest.fn() } as any;
      tab.ui.fileContextManager = { destroy: destroyFileContext } as any;
      tab.ui.slashCommandDropdown = { destroy: destroySlashDropdown } as any;
      tab.ui.instructionModeManager = { destroy: destroyInstructionMode } as any;
      tab.services.instructionRefineService = { cancel: cancelInstructionRefine, resetConversation: jest.fn() } as any;
      tab.services.titleGenerationService = { cancel: cancelTitleGeneration } as any;
      tab.ui.statusPanel = { destroy: destroyTodoPanel } as any;

      await destroyTab(tab);

      expect(destroyResumeDropdown).toHaveBeenCalled();
      expect(destroyFileContext).toHaveBeenCalled();
      expect(destroySlashDropdown).toHaveBeenCalled();
      expect(destroyInstructionMode).toHaveBeenCalled();
      expect(cancelInstructionRefine).toHaveBeenCalled();
      expect(cancelTitleGeneration).toHaveBeenCalled();
      expect(destroyTodoPanel).toHaveBeenCalled();
    });
  });
});

describe('Tab - Service Callbacks', () => {
  describe('setupServiceCallbacks', () => {
    function setupAutoTurnTest() {
      const plugin = createMockPlugin();
      const tab = createTab(createMockOptions({ plugin }));
      const addMessageSpy = jest.spyOn(tab.state, 'addMessage');
      const renderStoredMessage = jest.fn();
      const scrollToBottom = jest.fn();

      Object.defineProperty(tab.dom.contentEl, 'isConnected', {
        value: true,
        writable: true,
        configurable: true,
      });

      tab.renderer = { renderStoredMessage, scrollToBottom } as any;
      tab.controllers.inputController = {
        handleApprovalRequest: jest.fn(),
        dismissPendingApproval: jest.fn(),
        handleAskUserQuestion: jest.fn(),
        handleExitPlanMode: jest.fn(),
      } as any;
      tab.services.subagentManager = {
        hasRunningSubagents: jest.fn().mockReturnValue(false),
      } as any;

      const service = {
        setApprovalCallback: jest.fn(),
        setApprovalDismisser: jest.fn(),
        setAskUserQuestionCallback: jest.fn(),
        setExitPlanModeCallback: jest.fn(),
        setSubagentHookProvider: jest.fn(),
        setAutoTurnCallback: jest.fn(),
        setPermissionModeSyncCallback: jest.fn(),
      };
      tab.service = service as any;

      setupServiceCallbacks(tab, plugin);

      const autoTurnCallback = service.setAutoTurnCallback.mock.calls[0][0];
      return { tab, addMessageSpy, renderStoredMessage, scrollToBottom, autoTurnCallback };
    }

    it('renders tool-only auto-triggered turns with a placeholder assistant message', () => {
      const { addMessageSpy, renderStoredMessage, scrollToBottom, autoTurnCallback } = setupAutoTurnTest();

      autoTurnCallback({
        chunks: [
          { type: 'tool_result', id: 'task-1', content: 'done' },
        ],
        metadata: {},
      });

      expect(addMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          content: '(background task completed)',
        })
      );
      expect(renderStoredMessage).toHaveBeenCalled();
      expect(scrollToBottom).toHaveBeenCalled();
    });

    it('skips auto-triggered rendering after the tab DOM is detached', () => {
      const { tab, addMessageSpy, renderStoredMessage, scrollToBottom, autoTurnCallback } = setupAutoTurnTest();

      (tab.dom.contentEl as any).isConnected = false;
      autoTurnCallback({
        chunks: [
          { type: 'text', content: 'Background result' },
        ],
        metadata: {},
      });

      expect(addMessageSpy).not.toHaveBeenCalled();
      expect(renderStoredMessage).not.toHaveBeenCalled();
      expect(scrollToBottom).not.toHaveBeenCalled();
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

      expect(mockFileContextManager.setMcpManager).toHaveBeenCalledWith((options.plugin as any).mcpManager);
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

    it('should create bang-bash mode from provider UI config', () => {
      const getEnhancedPathSpy = jest
        .spyOn(envUtils, 'getEnhancedPath')
        .mockReturnValue('/usr/bin');
      const plugin = createMockPlugin({
        settings: {
          ...createMockPlugin().settings,
          providerConfigs: {
            claude: { enableBangBash: true },
            codex: { enabled: true },
          },
        },
      });
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      initializeTabUI(tab, plugin);

      expect(tab.ui.bangBashModeManager).toBeDefined();

      getEnhancedPathSpy.mockRestore();
    });

    it('should wire MCP server selector to MCP service', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      initializeTabUI(tab, options.plugin);

      expect(mockMcpServerSelector.setMcpManager).toHaveBeenCalledWith((options.plugin as any).mcpManager);
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

    it('should update SubagentManager with StreamController callback', () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      // The subagent manager should have its callback set
      expect(tab.services.subagentManager).toBeDefined();
    });

    it('persists async subagent state changes when not streaming', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      tab.state.currentConversationId = 'conv-1';
      tab.state.isStreaming = false;

      const setCallback = tab.services.subagentManager.setCallback as jest.Mock;
      const callback = setCallback.mock.calls[0][0] as (subagent: any) => void;

      callback({
        id: 'task-1',
        description: 'Background task',
        mode: 'async',
        asyncStatus: 'completed',
        status: 'completed',
        prompt: 'do work',
        result: 'done',
        toolCalls: [],
        isExpanded: false,
      });

      // Wait one microtask so Promise chain from save(false) can run.
      await Promise.resolve();

      expect(mockStreamController.onAsyncSubagentStateChange).toHaveBeenCalled();
      expect(mockConversationController.save).toHaveBeenCalledWith(false);
    });

    it('does not persist async subagent state while main stream is active', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      tab.state.currentConversationId = 'conv-1';
      tab.state.isStreaming = true;

      const setCallback = tab.services.subagentManager.setCallback as jest.Mock;
      const callback = setCallback.mock.calls[0][0] as (subagent: any) => void;

      callback({
        id: 'task-1',
        description: 'Background task',
        mode: 'async',
        asyncStatus: 'running',
        status: 'running',
        toolCalls: [],
        isExpanded: false,
      });

      await Promise.resolve();

      expect(mockConversationController.save).not.toHaveBeenCalled();
    });
  });
});

describe('Tab - Event Handler Behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileContextManager = createMockFileContextManager();
    mockSlashCommandDropdown = createMockSlashCommandDropdown();
    mockInstructionModeManager = createMockInstructionModeManager();
    mockBangBashModeManager = createMockBangBashModeManager();
    mockInputController = createMockInputController();
    mockSelectionController = createMockSelectionController();
  });

  // Wire up a tab with all UI managers and controllers needed for keydown tests,
  // then return the tab + a helper to fire keydown events.
  function setupKeydownTab(overrides?: {
    bangBashManager?: typeof mockBangBashModeManager;
  }) {
    const options = createMockOptions();
    const tab = createTab(options);

    tab.ui.bangBashModeManager = (overrides?.bangBashManager ?? mockBangBashModeManager) as any;
    tab.ui.instructionModeManager = mockInstructionModeManager as any;
    tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
    tab.ui.fileContextManager = mockFileContextManager as any;
    tab.controllers.inputController = mockInputController as any;
    tab.controllers.selectionController = mockSelectionController as any;

    wireTabInputEvents(tab, options.plugin);

    const listeners = (tab.dom.inputEl as any).getEventListeners();
    const fireKeydown = (event: Record<string, any>) => listeners.get('keydown')[0](event);

    return { tab, options, listeners, fireKeydown };
  }

  describe('wireTabInputEvents - keydown handlers', () => {
    it('should not pass keydown events to other handlers when bang-bash mode is active', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.bangBashModeManager = mockBangBashModeManager as any;
      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockBangBashModeManager.isActive.mockReturnValue(true);

      wireTabInputEvents(tab, options.plugin);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];
      const event = { key: '#', preventDefault: jest.fn() };
      keydownHandler(event);

      expect(mockBangBashModeManager.handleKeydown).toHaveBeenCalled();
      expect(mockInstructionModeManager.handleTriggerKey).not.toHaveBeenCalled();
      expect(mockSlashCommandDropdown.handleKeydown).not.toHaveBeenCalled();
      expect(mockFileContextManager.handleMentionKeydown).not.toHaveBeenCalled();
    });

    it('should suppress slash dropdown and mention handling on bang-bash enter/exit', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      let active = false;
      tab.ui.bangBashModeManager = {
        isActive: jest.fn(() => active),
        handleTriggerKey: jest.fn((e: any) => {
          active = true;
          e.preventDefault();
          return true;
        }),
        handleKeydown: jest.fn((e: any) => {
          if (!active) return false;
          if (e.key === 'Escape') {
            active = false;
            e.preventDefault();
            return true;
          }
          return false;
        }),
        handleInputChange: jest.fn(),
        destroy: jest.fn(),
      } as any;

      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;
      tab.controllers.inputController = mockInputController as any;
      tab.controllers.selectionController = mockSelectionController as any;

      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);

      wireTabInputEvents(tab, options.plugin);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const keydownHandler = listeners.get('keydown')[0];

      keydownHandler({ key: '!', preventDefault: jest.fn() });
      expect(mockSlashCommandDropdown.setEnabled).toHaveBeenCalledWith(false);
      expect(mockFileContextManager.hideMentionDropdown).toHaveBeenCalled();

      keydownHandler({ key: 'Escape', preventDefault: jest.fn() });
      expect(mockSlashCommandDropdown.setEnabled).toHaveBeenCalledWith(true);
    });

    it('should handle instruction mode trigger key', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValueOnce(true);
      const { fireKeydown } = setupKeydownTab();

      fireKeydown({ key: '#', preventDefault: jest.fn() });

      expect(mockInstructionModeManager.handleTriggerKey).toHaveBeenCalled();
    });

    it('should handle instruction mode keydown', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValueOnce(true);
      const { fireKeydown } = setupKeydownTab();

      fireKeydown({ key: 'Tab', preventDefault: jest.fn() });

      expect(mockInstructionModeManager.handleKeydown).toHaveBeenCalled();
    });

    it('should handle slash command dropdown keydown', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValueOnce(true);
      const { fireKeydown } = setupKeydownTab();

      fireKeydown({ key: 'ArrowDown', preventDefault: jest.fn() });

      expect(mockSlashCommandDropdown.handleKeydown).toHaveBeenCalled();
    });

    it('should handle resume dropdown keydown', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockInputController.handleResumeKeydown.mockReturnValueOnce(true);
      const { fireKeydown } = setupKeydownTab();

      fireKeydown({ key: 'ArrowDown', preventDefault: jest.fn() });

      expect(mockInputController.handleResumeKeydown).toHaveBeenCalled();
      expect(mockSlashCommandDropdown.handleKeydown).not.toHaveBeenCalled();
      expect(mockFileContextManager.handleMentionKeydown).not.toHaveBeenCalled();
    });

    it('should handle file context mention keydown', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValueOnce(true);
      const { fireKeydown } = setupKeydownTab();

      fireKeydown({ key: 'ArrowUp', preventDefault: jest.fn() });

      expect(mockFileContextManager.handleMentionKeydown).toHaveBeenCalled();
    });

    it('should cancel streaming on Escape when streaming', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);
      const { tab, fireKeydown } = setupKeydownTab();
      tab.state.isStreaming = true;

      const event = { key: 'Escape', isComposing: false, preventDefault: jest.fn() };
      fireKeydown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockInputController.cancelStreaming).toHaveBeenCalled();
    });

    it('should not cancel streaming on Escape when isComposing (IME)', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);
      const { tab, fireKeydown } = setupKeydownTab();
      tab.state.isStreaming = true;

      const event = { key: 'Escape', isComposing: true, preventDefault: jest.fn() };
      fireKeydown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockInputController.cancelStreaming).not.toHaveBeenCalled();
    });

    it('should send message on Enter (without Shift)', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);
      const { fireKeydown } = setupKeydownTab();

      const event = { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: jest.fn() };
      fireKeydown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockInputController.sendMessage).toHaveBeenCalled();
    });

    it('should not send message on Shift+Enter (newline)', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);
      const { fireKeydown } = setupKeydownTab();

      const event = { key: 'Enter', shiftKey: true, isComposing: false, preventDefault: jest.fn() };
      fireKeydown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockInputController.sendMessage).not.toHaveBeenCalled();
    });

    it('should not send message on Enter when isComposing (IME)', () => {
      mockInstructionModeManager.handleTriggerKey.mockReturnValue(false);
      mockInstructionModeManager.handleKeydown.mockReturnValue(false);
      mockSlashCommandDropdown.handleKeydown.mockReturnValue(false);
      mockFileContextManager.handleMentionKeydown.mockReturnValue(false);
      const { fireKeydown } = setupKeydownTab();

      const event = { key: 'Enter', shiftKey: false, isComposing: true, preventDefault: jest.fn() };
      fireKeydown(event);

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
    it('should show selection highlight on focusin (any sidebar element)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.controllers.selectionController = mockSelectionController as any;
      tab.controllers.inputController = mockInputController as any;

      wireTabInputEvents(tab, options.plugin);

      const listeners = (tab.dom.contentEl as any).getEventListeners();
      const focusHandler = listeners.get('focusin')[0];
      // Simulate focus entering from outside (relatedTarget is null)
      focusHandler({ relatedTarget: null });

      expect(mockSelectionController.showHighlight).toHaveBeenCalled();
    });
  });

  describe('wireTabInputEvents - input handlers', () => {
    it('should not call FileContextManager.handleInputChange when bang-bash mode is active', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.ui.bangBashModeManager = mockBangBashModeManager as any;
      tab.ui.instructionModeManager = mockInstructionModeManager as any;
      tab.ui.slashCommandDropdown = mockSlashCommandDropdown as any;
      tab.ui.fileContextManager = mockFileContextManager as any;

      mockBangBashModeManager.isActive.mockReturnValue(true);

      wireTabInputEvents(tab, options.plugin);

      const listeners = (tab.dom.inputEl as any).getEventListeners();
      const inputHandler = listeners.get('input')[0];
      inputHandler();

      expect(mockFileContextManager.handleInputChange).not.toHaveBeenCalled();
      expect(mockBangBashModeManager.handleInputChange).toHaveBeenCalled();
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
      const { FileContextManager } = jest.requireMock('@/features/chat/ui/FileContext');
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
      const { ImageContextManager } = jest.requireMock('@/features/chat/ui/ImageContext');
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

      const { FileContextManager } = jest.requireMock('@/features/chat/ui/FileContext');
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

      const { FileContextManager } = jest.requireMock('@/features/chat/ui/FileContext');
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

    it('should update context meter for Codex tabs on usage change', () => {
      const getCapabilitiesSpy = jest.spyOn(ProviderRegistry, 'getCapabilities');
      getCapabilitiesSpy.mockReturnValue({
        providerId: 'codex',
        supportsPersistentRuntime: true,
        supportsNativeHistory: true,
        supportsPlanMode: false,
        supportsRewind: false,
        supportsFork: false,
        supportsProviderCommands: false,
        supportsImageAttachments: true,
        supportsInstructionMode: false,
        supportsMcpTools: false,
        reasoningControl: 'none',
      });

      const options = createMockOptions({
        conversation: {
          id: 'conv-codex',
          providerId: 'codex',
          title: 'Codex Conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      const tab = createTab(options);
      initializeTabUI(tab, options.plugin);

      mockContextUsageMeter.update.mockClear();

      const usage = {
        inputTokens: 5000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1000,
        contextWindow: 200000,
        contextTokens: 6000,
        percentage: 3,
      };
      tab.state.callbacks.onUsageChanged?.(usage as any);

      expect(mockContextUsageMeter.update).toHaveBeenCalledWith(usage);

      getCapabilitiesSpy.mockRestore();
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
      const { InstructionModeManager } = jest.requireMock('@/features/chat/ui/InstructionModeManager');
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

      const { InstructionModeManager } = jest.requireMock('@/features/chat/ui/InstructionModeManager');
      const constructorCall = InstructionModeManager.mock.calls[0];
      const callbacks = constructorCall[1];

      const wrapper = callbacks.getInputWrapper();

      expect(wrapper).toBe(tab.dom.inputWrapper);
    });

    it('should wire provider catalog config when provided in options', async () => {
      const mockEntries = [{
        id: 'cmd-review',
        providerId: 'claude' as const,
        kind: 'command' as const,
        name: 'review',
        description: 'Review code',
        content: '',
        scope: 'vault' as const,
        source: 'user' as const,
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      }];
      const mockConfig = { providerId: 'claude' as const, triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' };
      const plugin = createMockPlugin();
      const options = createMockOptions({ plugin });
      const tab = createTab(options);

      initializeTabUI(tab, plugin, {
        getProviderCatalogConfig: () => ({
          config: mockConfig,
          getEntries: jest.fn().mockResolvedValue(mockEntries),
        }),
      });

      const { SlashCommandDropdown } = jest.requireMock('@/shared/components/SlashCommandDropdown');
      const constructorCall = SlashCommandDropdown.mock.calls[0];
      const opts = constructorCall[3]; // 4th argument is options

      expect(opts.providerConfig).toEqual(mockConfig);
      expect(typeof opts.getProviderEntries).toBe('function');
    });

    it('should wire provider-scoped hidden commands into the slash dropdown', () => {
      const plugin = createMockPlugin({
        settings: {
          excludedTags: [],
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          thinkingBudget: 'low',
          effortLevel: 'high',
          permissionMode: 'yolo',
          keyboardNavigation: {
            scrollUpKey: 'k',
            scrollDownKey: 'j',
            focusInputKey: 'i',
          },
          persistentExternalContextPaths: [],
          settingsProvider: 'claude',
          codexEnabled: true,
          savedProviderModel: {
            claude: 'claude-sonnet-4-5',
            codex: DEFAULT_CODEX_PRIMARY_MODEL,
          },
          savedProviderEffort: {
            claude: 'high',
            codex: 'medium',
          },
          savedProviderThinkingBudget: {
            claude: 'low',
            codex: 'off',
          },
          hiddenProviderCommands: {
            claude: ['commit'],
            codex: ['analyze'],
          },
        },
      });
      const tab = createTab(createMockOptions({ plugin }));

      initializeTabUI(tab, plugin);

      const { SlashCommandDropdown } = jest.requireMock('@/shared/components/SlashCommandDropdown');
      const constructorCall = SlashCommandDropdown.mock.calls[0];
      const opts = constructorCall[3];

      expect(Array.from(opts.hiddenCommands)).toEqual(['analyze']);
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
    const originalService = createMockClaudianService() as any;
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

});

describe('Tab - Controller Configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('InputController configuration', () => {
    it('should wire ensureServiceInitialized to return true when already initialized and bound_active', async () => {
      const { InputController } = jest.requireMock('@/features/chat/controllers/InputController');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      // Get InputController constructor config
      const constructorCall = InputController.mock.calls[0];
      const config = constructorCall[0];

      // Test ensureServiceInitialized when already initialized and bound_active
      tab.serviceInitialized = true;
      tab.lifecycleState = 'bound_active';
      const result = await config.ensureServiceInitialized();
      expect(result).toBe(true);
    });

    it('should wire getAgentService to return tab service', () => {
      const { InputController } = jest.requireMock('@/features/chat/controllers/InputController');
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
      const { InputController } = jest.requireMock('@/features/chat/controllers/InputController');
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
      const { StreamController } = jest.requireMock('@/features/chat/controllers/StreamController');
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
      const { StreamController } = jest.requireMock('@/features/chat/controllers/StreamController');
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
      const { StreamController } = jest.requireMock('@/features/chat/controllers/StreamController');
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
      const { NavigationController } = jest.requireMock('@/features/chat/controllers/NavigationController');
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

      // Test when resume dropdown is visible
      mockFileContextManager.isMentionDropdownVisible.mockReturnValue(false);
      mockInputController.isResumeDropdownVisible.mockReturnValue(true);
      expect(config.shouldSkipEscapeHandling()).toBe(true);

      // Test when nothing active
      mockInputController.isResumeDropdownVisible.mockReturnValue(false);
      expect(config.shouldSkipEscapeHandling()).toBe(false);
    });

    it('should wire isStreaming to return tab state', () => {
      const { NavigationController } = jest.requireMock('@/features/chat/controllers/NavigationController');
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
      const { NavigationController } = jest.requireMock('@/features/chat/controllers/NavigationController');
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
      const { ConversationController } = jest.requireMock('@/features/chat/controllers/ConversationController');
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
      const { ConversationController } = jest.requireMock('@/features/chat/controllers/ConversationController');
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

    it('should reset slash-command cache across conversation lifecycle events', () => {
      const { ConversationController } = jest.requireMock('@/features/chat/controllers/ConversationController');
      const options = createMockOptions();
      const tab = createTab(options);
      const mockComponent = {} as any;

      initializeTabUI(tab, options.plugin);
      initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

      const constructorCall = ConversationController.mock.calls[0];
      const callbacks = constructorCall[1];

      callbacks.onNewConversation();
      callbacks.onConversationLoaded();
      callbacks.onConversationSwitched();

      expect(mockSlashCommandDropdown.resetSdkSkillsCache).toHaveBeenCalledTimes(3);
    });
  });
});

const mockNotice = Notice as jest.Mock;

describe('Tab - handleForkRequest', () => {

  function setupForkTest(overrides: Record<string, any> = {}) {
    const options = createMockOptions(overrides);
    const tab = createTab(options);
    const mockComponent = {} as any;
    const forkRequestCallback = jest.fn().mockResolvedValue(undefined);

    initializeTabUI(tab, options.plugin);
    initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager, forkRequestCallback);

    // Extract the fork callback from the MessageRenderer constructor
    const { MessageRenderer } = jest.requireMock('@/features/chat/rendering/MessageRenderer') as { MessageRenderer: jest.Mock };
    const lastCall = MessageRenderer.mock.calls[MessageRenderer.mock.calls.length - 1];
    const forkCallback = lastCall[4]; // 5th argument is forkCallback

    return { tab, forkCallback, forkRequestCallback, plugin: options.plugin };
  }

  beforeEach(() => {
    mockNotice.mockClear();
  });

  it('should show notice when streaming', async () => {
    const { tab, forkCallback } = setupForkTest();

    tab.state.isStreaming = true;
    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u' },
    ];

    await forkCallback('u1');

    expect(mockNotice).toHaveBeenCalled();
  });

  it('should show notice when message ID not found', async () => {
    const { forkCallback, forkRequestCallback } = setupForkTest();

    await forkCallback('nonexistent');

    expect(forkRequestCallback).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith('Fork failed: Message not found');
  });

  it('should show notice when user message has no userMessageId', async () => {
    const { tab, forkCallback, forkRequestCallback } = setupForkTest();

    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
    ];

    await forkCallback('u1');

    expect(mockNotice).toHaveBeenCalled();
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should show notice when no assistant response follows the user message', async () => {
    const { tab, forkCallback, forkRequestCallback } = setupForkTest();

    // User message without a following assistant response with UUID
    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      // No assistant response after u1
    ];

    await forkCallback('u1');

    expect(mockNotice).toHaveBeenCalled();
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should show notice when no session ID is available', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue(null),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    // No service and no conversation
    tab.service = null;

    await forkCallback('u1');

    expect(mockNotice).toHaveBeenCalled();
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should call forkRequestCallback with correct ForkContext on success', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        title: 'My Conversation',
        currentNote: 'notes/test.md',
      }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
      { id: 'u2', role: 'user', content: 'world', timestamp: 4, userMessageId: 'user-u2' },
      { id: 'a2', role: 'assistant', content: 'resp2', timestamp: 5, assistantMessageId: 'asst-2' },
    ];

    // Service has a session ID
    tab.service = {
      getSessionId: jest.fn().mockReturnValue('session-abc'),
      resolveSessionIdForFork: jest.fn().mockReturnValue('session-abc'),
    } as any;
    tab.conversationId = 'conv-1';

    await forkCallback('u2');

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'session-abc',
      resumeAt: 'asst-1', // prev assistant UUID before u2
      sourceTitle: 'My Conversation',
      currentNote: 'notes/test.md',
      forkAtUserMessage: 2, // u2 is the 2nd user message
    }));

    // Messages should be deep-cloned and sliced before the fork point
    const ctx = forkRequestCallback.mock.calls[0][0];
    expect(ctx.messages).toHaveLength(3); // a0, u1, a1 (before u2)
    expect(ctx.messages.map((m: any) => m.id)).toEqual(['a0', 'u1', 'a1']);
  });

  it('should fall back to conversation session ID when service has none', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        providerState: { providerSessionId: 'conv-session-xyz' },
        title: 'Fallback Chat',
      }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    tab.service = null;
    tab.conversationId = 'conv-1';

    await forkCallback('u1');

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'conv-session-xyz',
    }));
  });

  it('should produce deep-cloned messages that do not share references with originals', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({ title: 'Test' }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    const originalMsg = { id: 'a0', role: 'assistant' as const, content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' };
    tab.state.messages = [
      originalMsg,
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('session-1'), resolveSessionIdForFork: jest.fn().mockReturnValue('session-1') } as any;
    tab.conversationId = 'conv-1';

    await forkCallback('u1');

    const ctx = forkRequestCallback.mock.calls[0][0];
    // Deep clone should not share references
    expect(ctx.messages[0]).not.toBe(originalMsg);
    expect(ctx.messages[0]).toEqual(originalMsg);
  });

  it('should fork at first user message with empty messages before fork', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({ title: 'First Fork' }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u1' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2, assistantMessageId: 'asst-1' },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('session-1'), resolveSessionIdForFork: jest.fn().mockReturnValue('session-1') } as any;
    tab.conversationId = 'conv-1';

    await forkCallback('u1');

    // No assistant message before u1, so findRewindContext returns no prevAssistantUuid
    expect(forkRequestCallback).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalled();
  });

  it('should fall back to conversation forkSource.sessionId when no sessionId or providerSessionId', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        title: 'Nested Fork',
        providerState: { forkSource: { sessionId: 'original-source-session', resumeAt: 'asst-prev' } },
      }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    tab.service = null;
    tab.conversationId = 'conv-1';

    await forkCallback('u1');

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'original-source-session',
    }));
  });

  it('should prefer service session ID over conversation metadata', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        title: 'Test',
        providerState: { providerSessionId: 'conv-session' },
        sessionId: 'old-session',
      }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('service-session'), resolveSessionIdForFork: jest.fn().mockReturnValue('service-session') } as any;
    tab.conversationId = 'conv-1';

    await forkCallback('u1');

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'service-session',
    }));
  });

  it('should set forkAtUserMessage to 1 for the first user message', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({ title: 'Test' }),
    });
    const { tab, forkCallback, forkRequestCallback } = setupForkTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u1' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('session-1'), resolveSessionIdForFork: jest.fn().mockReturnValue('session-1') } as any;
    tab.conversationId = 'conv-1';

    await forkCallback('u1');

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      forkAtUserMessage: 1,
    }));
  });

  it('should not set forkCallback on renderer when no forkRequestCallback provided', () => {
    const options = createMockOptions();
    const tab = createTab(options);
    const mockComponent = {} as any;

    initializeTabUI(tab, options.plugin);
    initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

    const { MessageRenderer } = jest.requireMock('@/features/chat/rendering/MessageRenderer') as { MessageRenderer: jest.Mock };
    const lastCall = MessageRenderer.mock.calls[MessageRenderer.mock.calls.length - 1];
    const forkCallback = lastCall[4];

    expect(forkCallback).toBeUndefined();
  });
});

describe('Tab - handleForkAll (via /fork command)', () => {

  function setupForkAllTest(overrides: Record<string, any> = {}) {
    const options = createMockOptions(overrides);
    const tab = createTab(options);
    const mockComponent = {} as any;
    const forkRequestCallback = jest.fn().mockResolvedValue(undefined);

    initializeTabUI(tab, options.plugin);
    initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager, forkRequestCallback);

    // Extract onForkAll from InputController constructor call
    const { InputController } = jest.requireMock('@/features/chat/controllers/InputController') as { InputController: jest.Mock };
    const lastCall = InputController.mock.calls[InputController.mock.calls.length - 1];
    const config = lastCall[0];
    const onForkAll = config.onForkAll as (() => Promise<void>) | undefined;

    return { tab, onForkAll: onForkAll!, forkRequestCallback, plugin: options.plugin };
  }

  beforeEach(() => {
    mockNotice.mockClear();
  });

  it('should call forkRequestCallback with all messages and last assistant UUID', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        title: 'My Conversation',
        currentNote: 'notes/test.md',
      }),
    });
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u1' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
      { id: 'u2', role: 'user', content: 'world', timestamp: 4, userMessageId: 'user-u2' },
      { id: 'a2', role: 'assistant', content: 'resp2', timestamp: 5, assistantMessageId: 'asst-2' },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('session-abc'), resolveSessionIdForFork: jest.fn().mockReturnValue('session-abc') } as any;
    tab.conversationId = 'conv-1';

    await onForkAll();

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'session-abc',
      resumeAt: 'asst-2', // last assistant UUID
      sourceTitle: 'My Conversation',
      currentNote: 'notes/test.md',
    }));

    const ctx = forkRequestCallback.mock.calls[0][0];
    expect(ctx.messages).toHaveLength(5); // all messages
    expect(ctx.messages.map((m: any) => m.id)).toEqual(['a0', 'u1', 'a1', 'u2', 'a2']);
    expect(ctx.forkAtUserMessage).toBe(3); // 2 user messages + 1
  });

  it('should include trailing user + interrupt messages and not count interrupt for fork number', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        title: 'My Conversation',
        currentNote: 'notes/test.md',
      }),
    });
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest({ plugin });

    tab.state.messages = [
      { id: 'a0', role: 'assistant', content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u1' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
      { id: 'u2', role: 'user', content: 'world', timestamp: 4, userMessageId: 'user-u2' },
      { id: 'a2', role: 'assistant', content: 'resp2', timestamp: 5, assistantMessageId: 'asst-2' },
      { id: 'u3', role: 'user', content: 'more', timestamp: 6, userMessageId: 'user-u3' },
      { id: 'int-1', role: 'user', content: '[Request interrupted by user]', timestamp: 7, userMessageId: 'user-int', isInterrupt: true },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('session-abc'), resolveSessionIdForFork: jest.fn().mockReturnValue('session-abc') } as any;
    tab.conversationId = 'conv-1';

    await onForkAll();

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'session-abc',
      resumeAt: 'asst-2',
      forkAtUserMessage: 4, // u1, u2, u3 + 1 (interrupt excluded)
    }));

    const ctx = forkRequestCallback.mock.calls[0][0];
    expect(ctx.messages).toHaveLength(7);
    expect(ctx.messages.map((m: any) => m.id)).toEqual(['a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'int-1']);
  });

  it('should show notice when streaming', async () => {
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest();

    tab.state.isStreaming = true;
    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'asst-1' },
    ];

    await onForkAll();

    expect(mockNotice).toHaveBeenCalled();
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should show notice when no messages', async () => {
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest();

    tab.state.messages = [];

    await onForkAll();

    expect(mockNotice).toHaveBeenCalledWith('Cannot fork: no messages in conversation');
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should show notice when no assistant message has assistantMessageId', async () => {
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest();

    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 2 },
    ];

    await onForkAll();

    expect(mockNotice).toHaveBeenCalledWith('Cannot fork: no assistant response with identifiers');
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should show notice when no session ID is available', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue(null),
    });
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest({ plugin });

    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'asst-1' },
    ];
    tab.service = null;

    await onForkAll();

    expect(mockNotice).toHaveBeenCalled();
    expect(forkRequestCallback).not.toHaveBeenCalled();
  });

  it('should fall back to conversation session ID when service has none', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({
        providerState: { providerSessionId: 'conv-session-xyz' },
        title: 'Fallback Chat',
      }),
    });
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest({ plugin });

    tab.state.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'asst-1' },
    ];
    tab.service = null;
    tab.conversationId = 'conv-1';

    await onForkAll();

    expect(forkRequestCallback).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'conv-session-xyz',
    }));
  });

  it('should deep-clone messages (not share references)', async () => {
    const plugin = createMockPlugin({
      getConversationSync: jest.fn().mockReturnValue({ title: 'Test' }),
    });
    const { tab, onForkAll, forkRequestCallback } = setupForkAllTest({ plugin });

    const originalMsg = { id: 'a0', role: 'assistant' as const, content: 'hi', timestamp: 1, assistantMessageId: 'asst-0' };
    tab.state.messages = [
      originalMsg,
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'asst-1' },
    ];
    tab.service = { getSessionId: jest.fn().mockReturnValue('session-1'), resolveSessionIdForFork: jest.fn().mockReturnValue('session-1') } as any;
    tab.conversationId = 'conv-1';

    await onForkAll();

    const ctx = forkRequestCallback.mock.calls[0][0];
    expect(ctx.messages[0]).not.toBe(originalMsg);
    expect(ctx.messages[0]).toEqual(originalMsg);
  });

  it('should not set onForkAll on InputController when no forkRequestCallback provided', () => {
    const options = createMockOptions();
    const tab = createTab(options);
    const mockComponent = {} as any;

    initializeTabUI(tab, options.plugin);
    initializeTabControllers(tab, options.plugin, mockComponent, options.mcpManager);

    const { InputController } = jest.requireMock('@/features/chat/controllers/InputController') as { InputController: jest.Mock };
    const lastCall = InputController.mock.calls[InputController.mock.calls.length - 1];
    const config = lastCall[0];
    expect(config.onForkAll).toBeUndefined();
  });
});

describe('Tab - Blank Tab Model Selector', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
    jest.restoreAllMocks();
  });

  it('returns Claude-only models when Codex is disabled', () => {
    const claudeModels = [
      { value: 'haiku', label: 'Haiku' },
      { value: 'sonnet', label: 'Sonnet' },
    ];
    jest.spyOn(ProviderRegistry, 'getEnabledProviderIds').mockReturnValue(['claude']);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName').mockImplementation((providerId) => (
      providerId === 'claude' ? 'Claude' : 'Codex'
    ));
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockImplementation((providerId?: string) => ({
      getModelOptions: () => providerId === 'claude' ? claudeModels : [],
      getProviderIcon: jest.fn().mockReturnValue(null),
    } as any));

    const result = getBlankTabModelOptions({ codexEnabled: false });
    expect(result).toEqual(claudeModels.map(m => ({ ...m, group: 'Claude' })));
  });

  it('returns Claude + Codex models when Codex is enabled', () => {
    const claudeModels = [
      { value: 'haiku', label: 'Haiku' },
      { value: 'sonnet', label: 'Sonnet' },
    ];
    const codexModels = [
      { value: DEFAULT_CODEX_PRIMARY_MODEL, label: DEFAULT_CODEX_PRIMARY_MODEL_LABEL },
    ];

    jest.spyOn(ProviderRegistry, 'getEnabledProviderIds').mockReturnValue(['codex', 'claude']);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName').mockImplementation((providerId) => (
      providerId === 'codex' ? 'Codex' : 'Claude'
    ));
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockImplementation((providerId?: string) => ({
      getModelOptions: () => providerId === 'codex' ? codexModels : claudeModels,
      getProviderIcon: jest.fn().mockReturnValue(null),
    } as any));

    const result = getBlankTabModelOptions({ codexEnabled: true });
    expect(result).toEqual([
      ...codexModels.map(m => ({ ...m, group: 'Codex' })),
      ...claudeModels.map(m => ({ ...m, group: 'Claude' })),
    ]);
  });
});

describe('Tab - Cross-Provider Model Rejection', () => {
  it('rejects cross-provider model change on bound tab via toolbar onModelChange', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    // Simulate bound Claude tab
    tab.lifecycleState = 'bound_cold';
    tab.providerId = 'claude';
    tab.conversationId = 'conv-1';

    // Get the onModelChange callback from toolbar
    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];
    expect(toolbarCallbacks).toBeDefined();

    // Attempt cross-provider model change (Claude -> Codex)
    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);

    // Should show a Notice rejecting it
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Cannot switch provider'));
    // Provider should remain Claude
    expect(tab.providerId).toBe('claude');
  });

  it('allows same-provider model change on bound tab', async () => {
    (Notice as unknown as jest.Mock).mockClear();
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([]),
      ownsModel: jest.fn((model: string) => model.startsWith('gpt-') || /^o\d/.test(model)),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      isDefaultModel: jest.fn().mockReturnValue(false),
      applyModelDefaults: jest.fn(),
      normalizeModelVariant: jest.fn((model: string) => model),
      getCustomModelIds: jest.fn().mockReturnValue(new Set()),
    } as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    // Simulate bound Claude tab
    tab.lifecycleState = 'bound_cold';
    tab.providerId = 'claude';
    tab.conversationId = 'conv-1';

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    // Same-provider model change (Claude -> Claude)
    await toolbarCallbacks.onModelChange('opus');

    expect(Notice).not.toHaveBeenCalled();
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

describe('Tab - Blank Tab Draft Model Change', () => {
  it('updates draft model and provider without creating runtime', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([]),
      ownsModel: jest.fn((model: string) => model.startsWith('gpt-') || /^o\d/.test(model)),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      isDefaultModel: jest.fn().mockReturnValue(false),
      applyModelDefaults: jest.fn(),
      normalizeModelVariant: jest.fn((model: string) => model),
      getCustomModelIds: jest.fn().mockReturnValue(new Set()),
    } as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    expect(tab.lifecycleState).toBe('blank');
    expect(tab.service).toBeNull();

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    // Switch to Codex model on blank tab
    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);

    expect(tab.draftModel).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
    expect(tab.providerId).toBe('codex');
    // No runtime should have been created
    expect(tab.service).toBeNull();
    expect(tab.serviceInitialized).toBe(false);
    expect(tab.lifecycleState).toBe('blank');
  });

  it('refreshes the service-tier toggle when the model changes on a blank tab', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([]),
      ownsModel: jest.fn((model: string) => model.startsWith('gpt-') || /^o\d/.test(model)),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      isDefaultModel: jest.fn().mockReturnValue(false),
      applyModelDefaults: jest.fn(),
      normalizeModelVariant: jest.fn((model: string) => model),
      getCustomModelIds: jest.fn().mockReturnValue(new Set()),
    } as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    mockServiceTierToggle.updateDisplay.mockClear();

    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);

    expect(mockServiceTierToggle.updateDisplay).toHaveBeenCalled();
  });

  it('preserves the saved Codex fast preference when switching away and back', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

    const plugin = createMockPlugin();
    plugin.settings.settingsProvider = 'codex';
    plugin.settings.model = DEFAULT_CODEX_PRIMARY_MODEL;
    plugin.settings.effortLevel = 'medium';
    plugin.settings.serviceTier = 'fast';
    plugin.settings.savedProviderModel = {
      claude: 'claude-sonnet-4-5',
      codex: DEFAULT_CODEX_PRIMARY_MODEL,
    };
    plugin.settings.savedProviderEffort = {
      claude: 'high',
      codex: 'medium',
    };
    plugin.settings.savedProviderServiceTier = {
      claude: 'default',
      codex: 'fast',
    };
    plugin.settings.savedProviderThinkingBudget = {
      claude: 'low',
      codex: 'off',
    };

    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    await toolbarCallbacks.onModelChange('gpt-5.4-mini');
    expect(plugin.settings.savedProviderServiceTier.codex).toBe('fast');

    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);
    expect(plugin.settings.savedProviderServiceTier.codex).toBe('fast');
  });

  it('swaps dropdown provider catalog on blank tab model change', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([]),
      ownsModel: jest.fn((model: string) => model.startsWith('gpt-') || /^o\d/.test(model)),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      isDefaultModel: jest.fn().mockReturnValue(false),
      applyModelDefaults: jest.fn(),
      normalizeModelVariant: jest.fn((model: string) => model),
      getCustomModelIds: jest.fn().mockReturnValue(new Set()),
    } as any);

    const codexCatalog = {
      listDropdownEntries: jest.fn().mockResolvedValue([]),
      listVaultEntries: jest.fn(),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      getDropdownConfig: jest.fn().mockReturnValue({
        triggerChars: ['/', '$'],
        builtInPrefix: '/',
        skillPrefix: '$',
        commandPrefix: '/',
      }),
      refresh: jest.fn(),
    };
    const managerGetEntries = jest.fn().mockResolvedValue([
      {
        id: 'codex-skill-analyze',
        providerId: 'codex',
        kind: 'skill',
        name: 'analyze',
        description: 'Analyze',
        content: 'Analyze code',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
      },
    ]);

    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: codexCatalog as any });

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin, {
      getProviderCatalogConfig: () => (
        tab.providerId === 'codex'
          ? {
            config: codexCatalog.getDropdownConfig(),
            getEntries: managerGetEntries,
          }
          : null
      ),
    });

    // Mock setProviderCatalog on the dropdown
    const setProviderCatalogSpy = jest.fn();
    tab.ui.slashCommandDropdown!.setProviderCatalog = setProviderCatalogSpy;

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    // Switch to Codex model → should swap catalog
    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);

    expect(setProviderCatalogSpy).toHaveBeenCalledTimes(1);
    const [config, getEntries] = setProviderCatalogSpy.mock.calls[0];
    expect(config.triggerChars).toEqual(['/', '$']);
    expect(config.skillPrefix).toBe('$');
    expect(typeof getEntries).toBe('function');
    await getEntries();
    expect(managerGetEntries).toHaveBeenCalledTimes(1);
    expect(codexCatalog.listDropdownEntries).not.toHaveBeenCalled();
  });

  it('updates hidden commands on blank tab model change', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([]),
      ownsModel: jest.fn((model: string) => model.startsWith('gpt-') || /^o\d/.test(model)),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      isDefaultModel: jest.fn().mockReturnValue(false),
      applyModelDefaults: jest.fn(),
      normalizeModelVariant: jest.fn((model: string) => model),
      getCustomModelIds: jest.fn().mockReturnValue(new Set()),
    } as any);

    const codexCatalog = {
      listDropdownEntries: jest.fn().mockResolvedValue([]),
      listVaultEntries: jest.fn(),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      getDropdownConfig: jest.fn().mockReturnValue({
        providerId: 'codex',
        triggerChars: ['/', '$'],
        builtInPrefix: '/',
        skillPrefix: '$',
        commandPrefix: '/',
      }),
      refresh: jest.fn(),
    };

    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: codexCatalog as any });

    const plugin = createMockPlugin({
      settings: {
        excludedTags: [],
        model: 'claude-sonnet-4-5',
        thinkingBudget: 'low',
        effortLevel: 'high',
        permissionMode: 'yolo',
        keyboardNavigation: {
          scrollUpKey: 'k',
          scrollDownKey: 'j',
          focusInputKey: 'i',
        },
        persistentExternalContextPaths: [],
        settingsProvider: 'claude',
        codexEnabled: true,
        savedProviderModel: {
          claude: 'claude-sonnet-4-5',
          codex: DEFAULT_CODEX_PRIMARY_MODEL,
        },
        savedProviderEffort: {
          claude: 'high',
          codex: 'medium',
        },
        savedProviderThinkingBudget: {
          claude: 'low',
          codex: 'off',
        },
        hiddenProviderCommands: {
          claude: ['commit'],
          codex: ['analyze'],
        },
      },
    });
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    const setProviderCatalogSpy = jest.fn();
    const setHiddenCommandsSpy = jest.fn();
    tab.ui.slashCommandDropdown!.setProviderCatalog = setProviderCatalogSpy;
    tab.ui.slashCommandDropdown!.setHiddenCommands = setHiddenCommandsSpy;

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);

    expect(setHiddenCommandsSpy).toHaveBeenCalledWith(new Set(['analyze']));
  });

  it('rebinds provider helper services and clears stale runtime on blank tab provider change', async () => {
    const createInstructionRefineServiceSpy = jest.spyOn(ProviderRegistry, 'createInstructionRefineService')
      .mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    const createTitleGenerationServiceSpy = jest.spyOn(ProviderRegistry, 'createTitleGenerationService')
      .mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([]),
      ownsModel: jest.fn((model: string) => model.startsWith('gpt-') || /^o\d/.test(model)),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      isDefaultModel: jest.fn().mockReturnValue(false),
      applyModelDefaults: jest.fn(),
      normalizeModelVariant: jest.fn((model: string) => model),
      getCustomModelIds: jest.fn().mockReturnValue(new Set()),
    } as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);

    const staleService = createMockClaudianService({ providerId: 'codex' });
    tab.service = staleService as any;
    tab.serviceInitialized = false;

    const toolbarModule = jest.requireMock('@/features/chat/ui/InputToolbar') as {
      createInputToolbar: jest.Mock;
    };
    const toolbarCallbacks = toolbarModule.createInputToolbar.mock.calls.at(-1)?.[1];

    const initialInstructionCalls = createInstructionRefineServiceSpy.mock.calls.length;
    const initialTitleCalls = createTitleGenerationServiceSpy.mock.calls.length;

    await toolbarCallbacks.onModelChange(DEFAULT_CODEX_PRIMARY_MODEL);
    await toolbarCallbacks.onModelChange('opus');

    expect(staleService.cleanup).toHaveBeenCalledTimes(1);
    expect(tab.service).toBeNull();
    expect(tab.serviceInitialized).toBe(false);
    expect(tab.providerId).toBe('claude');
    expect(createInstructionRefineServiceSpy.mock.calls.length).toBeGreaterThan(initialInstructionCalls);
    expect(createTitleGenerationServiceSpy.mock.calls.length).toBeGreaterThan(initialTitleCalls);
  });
});

describe('Tab - First Send Binding', () => {
  it('derives provider from draft model on first send (Claude)', async () => {
    const mockEnsureReady = jest.fn().mockResolvedValue(true);
    const runtimeModule = jest.requireMock('@/providers/claude/runtime/ClaudeChatRuntime') as { ClaudianService: jest.Mock };
    runtimeModule.ClaudianService.mockImplementationOnce(() => createMockClaudianService({ ensureReady: mockEnsureReady }));
    const createChatRuntimeSpy = jest.spyOn(ProviderRegistry, 'createChatRuntime')
      .mockReturnValue(createMockClaudianService() as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));

    tab.draftModel = 'sonnet';
    tab.lifecycleState = 'blank';

    await initializeTabService(tab, plugin, createMockMcpManager());

    expect(createChatRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude',
    }));
    expect(tab.lifecycleState).toBe('bound_active');
    expect(tab.draftModel).toBeNull();
  });

  it('derives provider from draft model on first send (Codex)', async () => {
    const createChatRuntimeSpy = jest.spyOn(ProviderRegistry, 'createChatRuntime')
      .mockReturnValue(createMockClaudianService({ providerId: 'codex' }) as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));

    tab.draftModel = DEFAULT_CODEX_PRIMARY_MODEL;
    tab.providerId = 'codex';
    tab.lifecycleState = 'blank';

    await initializeTabService(tab, plugin, createMockMcpManager());

    expect(createChatRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
    }));
    expect(tab.lifecycleState).toBe('bound_active');
    expect(tab.draftModel).toBeNull();
  });
});

describe('Tab - History Bind Without Runtime', () => {
  it('ensureServiceForConversation binds to bound_cold without starting runtime', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);
    initializeTabControllers(tab, plugin, {} as any, createMockMcpManager());

    const convCtrlModule = jest.requireMock('@/features/chat/controllers/ConversationController') as {
      ConversationController: jest.Mock;
    };
    const deps = convCtrlModule.ConversationController.mock.calls.at(-1)?.[0];
    const ensureServiceForConversation = deps?.ensureServiceForConversation;

    const conversation = {
      id: 'conv-history',
      providerId: 'codex' as const,
      messages: [{ id: 'msg-1', role: 'user' as const, content: 'hi', timestamp: Date.now() }],
    };

    await ensureServiceForConversation(conversation);

    expect(tab.lifecycleState).toBe('bound_cold');
    expect(tab.providerId).toBe('codex');
    expect(tab.conversationId).toBe('conv-history');
    expect(tab.draftModel).toBeNull();
    // No runtime created
    expect(tab.serviceInitialized).toBe(false);
  });

  it('ensureServiceForConversation updates hidden commands when the provider changes', async () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

    const codexCatalog = {
      listDropdownEntries: jest.fn().mockResolvedValue([]),
      listVaultEntries: jest.fn(),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      getDropdownConfig: jest.fn().mockReturnValue({
        providerId: 'codex',
        triggerChars: ['/', '$'],
        builtInPrefix: '/',
        skillPrefix: '$',
        commandPrefix: '/',
      }),
      refresh: jest.fn(),
    };
    const managerGetEntries = jest.fn().mockResolvedValue([
      {
        id: 'codex-skill-analyze',
        providerId: 'codex',
        kind: 'skill',
        name: 'analyze',
        description: 'Analyze',
        content: 'Analyze code',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
      },
    ]);
    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: codexCatalog as any });

    const plugin = createMockPlugin({
      settings: {
        excludedTags: [],
        model: 'claude-sonnet-4-5',
        thinkingBudget: 'low',
        effortLevel: 'high',
        permissionMode: 'yolo',
        keyboardNavigation: {
          scrollUpKey: 'k',
          scrollDownKey: 'j',
          focusInputKey: 'i',
        },
        persistentExternalContextPaths: [],
        settingsProvider: 'claude',
        codexEnabled: true,
        savedProviderModel: {
          claude: 'claude-sonnet-4-5',
          codex: DEFAULT_CODEX_PRIMARY_MODEL,
        },
        savedProviderEffort: {
          claude: 'high',
          codex: 'medium',
        },
        savedProviderThinkingBudget: {
          claude: 'low',
          codex: 'off',
        },
        hiddenProviderCommands: {
          claude: ['commit'],
          codex: ['analyze'],
        },
      },
    });
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin, {
      getProviderCatalogConfig: () => (
        tab.providerId === 'codex'
          ? {
            config: codexCatalog.getDropdownConfig(),
            getEntries: managerGetEntries,
          }
          : null
      ),
    });
    initializeTabControllers(
      tab,
      plugin,
      {} as any,
      createMockMcpManager(),
      undefined,
      undefined,
      () => (
        tab.providerId === 'codex'
          ? {
            config: codexCatalog.getDropdownConfig(),
            getEntries: managerGetEntries,
          }
          : null
      ),
    );

    const setProviderCatalogSpy = jest.fn();
    const setHiddenCommandsSpy = jest.fn();
    tab.ui.slashCommandDropdown!.setProviderCatalog = setProviderCatalogSpy;
    tab.ui.slashCommandDropdown!.setHiddenCommands = setHiddenCommandsSpy;

    const convCtrlModule = jest.requireMock('@/features/chat/controllers/ConversationController') as {
      ConversationController: jest.Mock;
    };
    const deps = convCtrlModule.ConversationController.mock.calls.at(-1)?.[0];
    const ensureServiceForConversation = deps?.ensureServiceForConversation;

    await ensureServiceForConversation({
      id: 'conv-history',
      providerId: 'codex' as const,
      messages: [{ id: 'msg-1', role: 'user' as const, content: 'hi', timestamp: Date.now() }],
    });

    expect(setProviderCatalogSpy).toHaveBeenCalledTimes(1);
    expect(setHiddenCommandsSpy).toHaveBeenCalledWith(new Set(['analyze']));
    const [, getEntries] = setProviderCatalogSpy.mock.calls[0];
    await getEntries();
    expect(managerGetEntries).toHaveBeenCalledTimes(1);
    expect(codexCatalog.listDropdownEntries).not.toHaveBeenCalled();
  });
});

describe('Tab - Destroy Lifecycle Transition', () => {
  it('transitions to closing state and cleans up runtime', async () => {
    const mockCleanup = jest.fn();
    const options = createMockOptions();
    const tab = createTab(options);

    tab.lifecycleState = 'bound_active';
    tab.service = { cleanup: mockCleanup } as any;
    tab.serviceInitialized = true;

    await destroyTab(tab);

    expect(tab.lifecycleState).toBe('closing');
    expect(mockCleanup).toHaveBeenCalled();
    expect(tab.service).toBeNull();
  });

  it('does not fail when destroying a blank tab with no runtime', async () => {
    const options = createMockOptions();
    const tab = createTab(options);

    expect(tab.lifecycleState).toBe('blank');
    expect(tab.service).toBeNull();

    await destroyTab(tab);

    expect(tab.lifecycleState).toBe('closing');
  });

  it('does not fail when destroying a bound_cold tab with no runtime', async () => {
    const options = createMockOptions({
      conversation: {
        id: 'conv-1',
        providerId: 'claude' as any,
        title: 'Test',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    const tab = createTab(options);

    expect(tab.lifecycleState).toBe('bound_cold');
    expect(tab.service).toBeNull();

    await destroyTab(tab);

    expect(tab.lifecycleState).toBe('closing');
  });
});

describe('Tab - InputController getTabProviderId wiring', () => {
  it('wires getTabProviderId to InputController deps', () => {
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService').mockReturnValue({ cancel: jest.fn(), resetConversation: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService').mockReturnValue({ cancel: jest.fn() } as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter').mockReturnValue({} as any);

    const plugin = createMockPlugin();
    const tab = createTab(createMockOptions({ plugin }));
    initializeTabUI(tab, plugin);
    initializeTabControllers(tab, plugin, {} as any, createMockMcpManager());

    const { InputController } = jest.requireMock('@/features/chat/controllers/InputController') as { InputController: jest.Mock };
    const lastCall = InputController.mock.calls[InputController.mock.calls.length - 1];
    const config = lastCall[0];
    expect(config.getTabProviderId).toBeDefined();
    expect(typeof config.getTabProviderId).toBe('function');

    // For a blank tab with default model, should resolve to claude
    const result = config.getTabProviderId();
    expect(result).toBe('claude');
  });
});
