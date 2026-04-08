import { createMockEl } from '@test/helpers/mockElement';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { TabManager } from '@/features/chat/tabs/TabManager';
import {
  DEFAULT_MAX_TABS,
  type PersistedTabManagerState,
  type TabManagerCallbacks,
} from '@/features/chat/tabs/types';

// Mock Tab module functions
const mockCreateTab = jest.fn();
const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
const mockActivateTab = jest.fn();
const mockDeactivateTab = jest.fn();
const mockInitializeTabUI = jest.fn();
const mockInitializeTabControllers = jest.fn();
const mockInitializeTabService = jest.fn().mockResolvedValue(undefined);
const mockWireTabInputEvents = jest.fn();
const mockGetTabTitle = jest.fn().mockReturnValue('Test Tab');
const mockSetupApprovalCallback = jest.fn();

jest.mock('@/features/chat/tabs/Tab', () => ({
  createTab: (...args: any[]) => mockCreateTab(...args),
  destroyTab: (...args: any[]) => mockDestroyTab(...args),
  activateTab: (...args: any[]) => mockActivateTab(...args),
  deactivateTab: (...args: any[]) => mockDeactivateTab(...args),
  initializeTabUI: (...args: any[]) => mockInitializeTabUI(...args),
  initializeTabControllers: (...args: any[]) => mockInitializeTabControllers(...args),
  initializeTabService: (...args: any[]) => mockInitializeTabService(...args),
  wireTabInputEvents: (...args: any[]) => mockWireTabInputEvents(...args),
  getTabTitle: (...args: any[]) => mockGetTabTitle(...args),
  setupApprovalCallback: (...args: any[]) => mockSetupApprovalCallback(...args),
}));

const mockChooseForkTarget = jest.fn();
jest.mock('@/shared/modals/ForkTargetModal', () => ({
  chooseForkTarget: (...args: any[]) => mockChooseForkTarget(...args),
}));

const mockBuildForkProviderState = jest.fn(
  (sourceSessionId: string, resumeAt: string) => ({
    forkSource: { sessionId: sourceSessionId, resumeAt },
  }),
);
const mockGetCapabilities = jest.fn().mockReturnValue({
  providerId: 'claude',
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
});
const mockCommandCatalogs: Record<string, any> = {};
jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    getConversationHistoryService: () => ({
      buildForkProviderState: mockBuildForkProviderState,
    }),
    getCapabilities: (...args: any[]) => mockGetCapabilities(...args),
    resolveProviderForModel: (model: string) => (
      model.startsWith('gpt-') || /^o\d/.test(model) ? 'codex' : 'claude'
    ),
  },
}));

jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    getCommandCatalog: (providerId: string) => mockCommandCatalogs[providerId] ?? null,
    setServices: (providerId: string, services: any) => {
      if (services?.commandCatalog) {
        mockCommandCatalogs[providerId] = services.commandCatalog;
      } else {
        delete mockCommandCatalogs[providerId];
      }
    },
  },
}));

function createMockPlugin(overrides: Record<string, any> = {}): any {
  return {
    app: {
      workspace: {
        revealLeaf: jest.fn(),
      },
    },
    settings: {
      maxTabs: DEFAULT_MAX_TABS,
      ...(overrides.settings || {}),
    },
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationSync: jest.fn().mockReturnValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    findConversationAcrossViews: jest.fn().mockReturnValue(null),
    ...overrides,
  };
}

function createMockMcpManager(): any {
  return {};
}

function createMockView(): any {
  return {
    leaf: { id: 'leaf-1' },
    getTabManager: jest.fn().mockReturnValue(null),
  };
}

function createMockTabData(overrides: Record<string, any> = {}): any {
  const defaultState = {
    isStreaming: false,
    needsAttention: false,
    messages: [],
    currentConversationId: null,
  };

  const defaultControllers = {
    conversationController: {
      save: jest.fn().mockResolvedValue(undefined),
      switchTo: jest.fn().mockResolvedValue(undefined),
      initializeWelcome: jest.fn(),
    },
    inputController: {
      handleApprovalRequest: jest.fn(),
    },
  };

  // Extract state and controllers from overrides to merge properly
  const { state: stateOverrides, controllers: controllersOverrides, ...restOverrides } = overrides;

  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    providerId: 'claude',
    conversationId: null,
    service: null,
    serviceInitialized: false,
    state: {
      ...defaultState,
      ...(stateOverrides || {}),
    },
    controllers: {
      ...defaultControllers,
      ...(controllersOverrides || {}),
    },
    dom: {
      contentEl: createMockEl(),
    },
    ...restOverrides,
  };
}

function createManager(options: {
  plugin?: any;
  callbacks?: TabManagerCallbacks;
  tabFactory?: (counter: number) => any;
} = {}): TabManager {
  jest.clearAllMocks();
  let tabCounter = 0;
  const factory = options.tabFactory ?? ((n: number) => createMockTabData({ id: `tab-${n}` }));
  mockCreateTab.mockImplementation(() => {
    tabCounter++;
    return factory(tabCounter);
  });

  return new TabManager(
    options.plugin ?? createMockPlugin(),
    createMockMcpManager(),
    createMockEl(),
    createMockView(),
    options.callbacks
  );
}

describe('TabManager - Tab Lifecycle', () => {
  let callbacks: TabManagerCallbacks;

  beforeEach(() => {
    callbacks = {
      onTabCreated: jest.fn(),
      onTabSwitched: jest.fn(),
      onTabClosed: jest.fn(),
      onTabStreamingChanged: jest.fn(),
      onTabTitleChanged: jest.fn(),
      onTabAttentionChanged: jest.fn(),
    };
  });

  describe('createTab', () => {
    it('should create a new tab', async () => {
      const manager = createManager({ callbacks });

      const tab = await manager.createTab();

      expect(tab).toBeDefined();
      expect(mockCreateTab).toHaveBeenCalled();
      expect(mockInitializeTabUI).toHaveBeenCalled();
      expect(mockInitializeTabControllers).toHaveBeenCalled();
      expect(mockWireTabInputEvents).toHaveBeenCalled();
    });

    it('should call onTabCreated callback', async () => {
      const manager = createManager({ callbacks });

      await manager.createTab();

      expect(callbacks.onTabCreated).toHaveBeenCalled();
    });

    it('should activate first tab automatically', async () => {
      const manager = createManager({ callbacks });

      await manager.createTab();

      expect(mockActivateTab).toHaveBeenCalled();
      // Service initialization is now lazy (on first query), not on switch
      expect(mockInitializeTabService).not.toHaveBeenCalled();
    });

    it('should enforce max tabs limit', async () => {
      const manager = createManager({ callbacks });

      for (let i = 0; i < DEFAULT_MAX_TABS; i++) {
        await manager.createTab();
      }

      const extraTab = await manager.createTab();

      expect(extraTab).toBeNull();
      expect(manager.getTabCount()).toBe(DEFAULT_MAX_TABS);
    });

    it('should use provided tab ID for restoration', async () => {
      const manager = createManager({ callbacks });
      mockCreateTab.mockImplementationOnce(() =>
        createMockTabData({ id: 'restored-tab-id' })
      );

      await manager.createTab('conv-123', 'restored-tab-id');

      expect(mockCreateTab).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 'restored-tab-id' })
      );
    });
  });

  describe('switchToTab', () => {
    it('should switch to existing tab', async () => {
      const manager = createManager({ callbacks });

      const tab1 = await manager.createTab();
      const tab2 = await manager.createTab();

      // First, switch to tab2 to make it active (tab1 is active after creation)
      await manager.switchToTab(tab2!.id);

      jest.clearAllMocks();

      await manager.switchToTab(tab1!.id);

      expect(mockDeactivateTab).toHaveBeenCalled();
      expect(mockActivateTab).toHaveBeenCalled();
      expect(callbacks.onTabSwitched).toHaveBeenCalled();
    });

    it('should not switch to non-existent tab', async () => {
      const manager = createManager({ callbacks });
      await manager.createTab();

      jest.clearAllMocks();
      await manager.switchToTab('non-existent-id');

      expect(mockActivateTab).not.toHaveBeenCalled();
    });

    it('should NOT initialize service on switch (lazy until first query)', async () => {
      const manager = createManager({ callbacks });

      await manager.createTab();

      // Service initialization is now lazy (on first query), not on switch
      expect(mockInitializeTabService).not.toHaveBeenCalled();
    });
  });

  describe('closeTab', () => {
    it('should close a tab', async () => {
      const manager = createManager({ callbacks });

      const tab1 = await manager.createTab();
      await manager.createTab(); // Need at least 2 tabs to close one

      const closed = await manager.closeTab(tab1!.id);

      expect(closed).toBe(true);
      expect(mockDestroyTab).toHaveBeenCalled();
      expect(callbacks.onTabClosed).toHaveBeenCalledWith(tab1!.id);
    });

    it('should not close streaming tab unless forced', async () => {
      const streamingTab = createMockTabData({
        id: 'streaming-tab',
        state: { isStreaming: true },
      });
      mockCreateTab.mockReturnValueOnce(streamingTab);

      const manager = createManager({ callbacks });
      await manager.createTab();

      const closed = await manager.closeTab('streaming-tab');

      expect(closed).toBe(false);
      expect(mockDestroyTab).not.toHaveBeenCalled();
    });

    it('should close streaming tab when forced', async () => {
      const streamingTab = createMockTabData({
        id: 'streaming-tab',
        state: { isStreaming: true },
      });
      mockCreateTab.mockReturnValueOnce(streamingTab);

      const manager = createManager({ callbacks });
      await manager.createTab();
      await manager.createTab(); // Need second tab

      const closed = await manager.closeTab('streaming-tab', true);

      expect(closed).toBe(true);
      expect(mockDestroyTab).toHaveBeenCalled();
    });

    it('should switch to another tab after closing active tab', async () => {
      const manager = createManager({ callbacks });

      // Create two tabs (variables intentionally unused - we just need tabs to exist)
      await manager.createTab();
      await manager.createTab();

      // Close active tab
      await manager.closeTab(manager.getActiveTabId()!);

      // Should have switched to remaining tab
      expect(manager.getTabCount()).toBe(1);
    });

    it('should prefer previous tab when closing a middle tab', async () => {
      const manager = createManager({ callbacks });

      const tab1 = await manager.createTab();
      const tab2 = await manager.createTab();
      await manager.createTab();

      await manager.switchToTab(tab2!.id);

      const switchSpy = jest.spyOn(manager, 'switchToTab');

      await manager.closeTab(tab2!.id);

      expect(switchSpy).toHaveBeenCalledWith(tab1!.id);
    });

    it('should fall back to next tab when closing the first tab', async () => {
      const manager = createManager({ callbacks });

      const tab1 = await manager.createTab();
      const tab2 = await manager.createTab();
      await manager.createTab();

      await manager.switchToTab(tab1!.id);

      const switchSpy = jest.spyOn(manager, 'switchToTab');

      await manager.closeTab(tab1!.id);

      expect(switchSpy).toHaveBeenCalledWith(tab2!.id);
    });

    it('should create new tab if all tabs are closed', async () => {
      const manager = createManager({ callbacks });

      const tab = await manager.createTab();
      await manager.closeTab(tab!.id, true);

      expect(manager.getTabCount()).toBe(1);
    });

    it('should save conversation before closing', async () => {
      const mockSave = jest.fn().mockResolvedValue(undefined);
      const tabWithSave = createMockTabData({ id: 'tab-with-save' });
      tabWithSave.controllers.conversationController.save = mockSave;

      mockCreateTab.mockReturnValueOnce(tabWithSave);

      const manager = createManager({ callbacks });
      await manager.createTab();
      await manager.createTab(); // Need second tab

      await manager.closeTab('tab-with-save', true);

      expect(mockSave).toHaveBeenCalled();
    });

    it('should switch to next tab when closing first tab', async () => {
      const manager = createManager({ callbacks });

      const tab1 = await manager.createTab();
      const tab2 = await manager.createTab();
      await manager.createTab(); // tab-3

      await manager.switchToTab(tab1!.id);
      expect(manager.getActiveTabId()).toBe(tab1!.id);

      await manager.closeTab(tab1!.id);

      // Should switch to tab-2 (next tab, not previous since there is none)
      expect(manager.getActiveTabId()).toBe(tab2!.id);
    });

    it('should switch to previous tab when closing middle tab', async () => {
      const manager = createManager({ callbacks });

      const tab1 = await manager.createTab();
      const tab2 = await manager.createTab();
      await manager.createTab(); // tab-3

      await manager.switchToTab(tab2!.id);
      expect(manager.getActiveTabId()).toBe(tab2!.id);

      await manager.closeTab(tab2!.id);

      // Should switch to tab-1 (previous tab)
      expect(manager.getActiveTabId()).toBe(tab1!.id);
    });

    it('should switch to previous tab when closing last tab in list', async () => {
      const manager = createManager({ callbacks });

      await manager.createTab(); // tab-1
      const tab2 = await manager.createTab();
      const tab3 = await manager.createTab();

      await manager.switchToTab(tab3!.id);
      expect(manager.getActiveTabId()).toBe(tab3!.id);

      await manager.closeTab(tab3!.id);

      // Should switch to tab-2 (previous tab)
      expect(manager.getActiveTabId()).toBe(tab2!.id);
    });
  });
});

describe('TabManager - Tab Queries', () => {
  let manager: TabManager;

  beforeEach(async () => {
    manager = createManager();
    await manager.createTab();
  });

  describe('getActiveTab', () => {
    it('should return the active tab', () => {
      const activeTab = manager.getActiveTab();
      expect(activeTab).toBeDefined();
    });
  });

  describe('getActiveTabId', () => {
    it('should return the active tab ID', () => {
      const activeTabId = manager.getActiveTabId();
      expect(activeTabId).toBeDefined();
    });
  });

  describe('getTab', () => {
    it('should return tab by ID', () => {
      const activeTabId = manager.getActiveTabId()!;
      const tab = manager.getTab(activeTabId);
      expect(tab).toBeDefined();
      expect(tab?.id).toBe(activeTabId);
    });

    it('should return null for non-existent tab', () => {
      const tab = manager.getTab('non-existent');
      expect(tab).toBeNull();
    });
  });

  describe('getAllTabs', () => {
    it('should return all tabs', async () => {
      await manager.createTab();
      await manager.createTab();

      const tabs = manager.getAllTabs();
      expect(tabs.length).toBe(3);
    });
  });

  describe('getTabCount', () => {
    it('should return correct count', async () => {
      expect(manager.getTabCount()).toBe(1);

      await manager.createTab();
      expect(manager.getTabCount()).toBe(2);
    });
  });

  describe('canCreateTab', () => {
    it('should return true when under limit', () => {
      expect(manager.canCreateTab()).toBe(true);
    });

    it('should return false when at limit', async () => {
      for (let i = 1; i < DEFAULT_MAX_TABS; i++) {
        await manager.createTab();
      }
      expect(manager.canCreateTab()).toBe(false);
    });
  });
});

describe('TabManager - Tab Bar Data', () => {
  let manager: TabManager;

  beforeEach(async () => {
    manager = createManager({
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        state: {
          isStreaming: n === 2,
          needsAttention: n === 3,
        },
      }),
    });
  });

  describe('getTabBarItems', () => {
    it('should return tab bar items with correct structure', async () => {
      await manager.createTab();
      await manager.createTab();

      const items = manager.getTabBarItems();

      expect(items.length).toBe(2);
      expect(items[0]).toHaveProperty('id');
      expect(items[0]).toHaveProperty('index');
      expect(items[0]).toHaveProperty('title');
      expect(items[0]).toHaveProperty('isActive');
      expect(items[0]).toHaveProperty('isStreaming');
      expect(items[0]).toHaveProperty('needsAttention');
      expect(items[0]).toHaveProperty('canClose');
    });

    it('should have 1-based indices', async () => {
      await manager.createTab();
      await manager.createTab();
      await manager.createTab();

      const items = manager.getTabBarItems();

      expect(items[0].index).toBe(1);
      expect(items[1].index).toBe(2);
      expect(items[2].index).toBe(3);
    });

    it('should mark streaming tabs', async () => {
      await manager.createTab(); // Not streaming
      await manager.createTab(); // Streaming

      const items = manager.getTabBarItems();

      expect(items[0].isStreaming).toBe(false);
      expect(items[1].isStreaming).toBe(true);
    });
  });
});

describe('TabManager - Conversation Management', () => {
  let manager: TabManager;
  let plugin: any;

  beforeEach(async () => {
    plugin = createMockPlugin();
    manager = createManager({ plugin });
    await manager.createTab();
  });

  describe('openConversation', () => {
    it('should switch to tab if conversation is already open', async () => {
      const tabWithConv = createMockTabData({
        id: 'tab-with-conv',
        conversationId: 'conv-123',
      });
      mockCreateTab.mockReturnValueOnce(tabWithConv);
      await manager.createTab();

      const switchSpy = jest.spyOn(manager, 'switchToTab');
      await manager.openConversation('conv-123');

      expect(switchSpy).toHaveBeenCalledWith('tab-with-conv');
    });

    it('should create new tab when preferNewTab is true', async () => {
      plugin.getConversationById.mockResolvedValue({ id: 'conv-new' });

      await manager.openConversation('conv-new', true);

      expect(mockCreateTab).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: { id: 'conv-new' },
        })
      );
    });

    it('should create a background tab without switching focus', async () => {
      plugin.getConversationById.mockResolvedValue({ id: 'conv-background' });
      const initialActiveTabId = manager.getActiveTabId();

      await manager.openConversation('conv-background', {
        preferNewTab: true,
        activate: false,
      });

      expect(mockCreateTab).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: { id: 'conv-background' },
        })
      );
      expect(manager.getActiveTabId()).toBe(initialActiveTabId);
    });

    it('should check for cross-view duplicates', async () => {
      plugin.findConversationAcrossViews.mockReturnValue({
        view: { leaf: { id: 'other-leaf' }, getTabManager: () => ({ switchToTab: jest.fn() }) },
        tabId: 'other-tab',
      });

      await manager.openConversation('conv-123');

      expect(plugin.app.workspace.revealLeaf).toHaveBeenCalled();
    });
  });

  describe('createNewConversation', () => {
    it('should create new conversation in active tab', async () => {
      const activeTab = manager.getActiveTab();
      const createNew = jest.fn().mockResolvedValue(undefined);
      activeTab!.controllers.conversationController = { createNew } as any;

      await manager.createNewConversation();

      expect(createNew).toHaveBeenCalled();
    });
  });
});

describe('TabManager - Persistence', () => {
  let manager: TabManager;

  beforeEach(async () => {
    manager = createManager({
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        conversationId: n === 2 ? 'conv-456' : null,
      }),
    });
  });

  describe('getPersistedState', () => {
    it('should return current tab state for persistence', async () => {
      await manager.createTab();
      await manager.createTab();

      const state = manager.getPersistedState();

      expect(state.openTabs).toHaveLength(2);
      expect(state.activeTabId).toBeDefined();
      expect(state.openTabs[0]).toHaveProperty('tabId');
      expect(state.openTabs[0]).toHaveProperty('conversationId');
    });
  });

  describe('restoreState', () => {
    it('should restore tabs from persisted state', async () => {
      const persistedState: PersistedTabManagerState = {
        openTabs: [
          { tabId: 'restored-1', conversationId: 'conv-1' },
          { tabId: 'restored-2', conversationId: 'conv-2' },
        ],
        activeTabId: 'restored-2',
      };

      await manager.restoreState(persistedState);

      expect(mockCreateTab).toHaveBeenCalledTimes(2);
    });

    it('should switch to previously active tab', async () => {
      mockCreateTab.mockImplementation((opts: any) =>
        createMockTabData({ id: opts.tabId || 'default-tab' })
      );

      const persistedState: PersistedTabManagerState = {
        openTabs: [
          { tabId: 'restored-1', conversationId: null },
          { tabId: 'restored-2', conversationId: null },
        ],
        activeTabId: 'restored-2',
      };

      await manager.restoreState(persistedState);

      expect(manager.getActiveTabId()).toBe('restored-2');
    });

    it('should create default tab if no tabs restored', async () => {
      // Reset mock to return valid tab data
      mockCreateTab.mockReturnValue(createMockTabData({ id: 'default-tab' }));

      await manager.restoreState({ openTabs: [], activeTabId: null });

      expect(mockCreateTab).toHaveBeenCalled();
      expect(manager.getTabCount()).toBe(1);
    });

    it('should handle tab restoration errors gracefully', async () => {
      let callCount = 0;
      mockCreateTab.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Tab creation failed');
        }
        return createMockTabData({ id: `tab-${callCount}` });
      });

      const persistedState: PersistedTabManagerState = {
        openTabs: [
          { tabId: 'fail-tab', conversationId: null },
          { tabId: 'success-tab', conversationId: null },
        ],
        activeTabId: null,
      };

      // Should not throw
      await expect(manager.restoreState(persistedState)).resolves.not.toThrow();

      // Should have created at least one tab
      expect(manager.getTabCount()).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('TabManager - Broadcast', () => {
  let manager: TabManager;

  beforeEach(async () => {
    manager = createManager({
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        service: { someMethod: jest.fn() },
        serviceInitialized: true,
      }),
    });
    await manager.createTab();
    await manager.createTab();
  });

  describe('broadcastToAllTabs', () => {
    it('should call function on all initialized services', async () => {
      const broadcastFn = jest.fn().mockResolvedValue(undefined);

      await manager.broadcastToAllTabs(broadcastFn);

      expect(broadcastFn).toHaveBeenCalledTimes(2);
    });

    it('should handle errors in broadcast gracefully', async () => {
      const broadcastFn = jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Broadcast failed'));

      // Should not throw
      await expect(manager.broadcastToAllTabs(broadcastFn)).resolves.not.toThrow();
    });

    it('should skip tabs without initialized services', async () => {
      // Create tab without initialized service
      mockCreateTab.mockReturnValueOnce(
        createMockTabData({ service: null, serviceInitialized: false })
      );
      await manager.createTab();

      const broadcastFn = jest.fn().mockResolvedValue(undefined);
      await manager.broadcastToAllTabs(broadcastFn);

      // Should only be called for the 2 initialized tabs, not the 3rd
      expect(broadcastFn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('TabManager - SDK Commands', () => {
  beforeEach(() => {
    mockGetCapabilities.mockReset();
    mockGetCapabilities.mockReturnValue({
      providerId: 'claude',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: true,
      supportsFork: true,
      supportsProviderCommands: true,
      reasoningControl: 'effort',
    });
  });

  it('should return commands from the target tab runtime when it is ready', async () => {
    const supportedCommands = [{ id: 'sdk:commit', name: 'commit', content: '' }];
    const readyService = {
      providerId: 'claude',
      isReady: jest.fn().mockReturnValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue(supportedCommands),
    };
    const manager = createManager({
      tabFactory: () => createMockTabData({
        id: 'tab-ready',
        providerId: 'claude',
        service: readyService,
      }),
    });

    const tab = await manager.createTab();

    await expect(manager.getSdkCommands(tab!.id)).resolves.toEqual(supportedCommands);
    expect(readyService.getSupportedCommands).toHaveBeenCalledTimes(1);
  });

  it('should reuse commands from another ready tab with the same provider', async () => {
    const supportedCommands = [{ id: 'sdk:commit', name: 'commit', content: '' }];
    const readyClaudeService = {
      providerId: 'claude',
      isReady: jest.fn().mockReturnValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue(supportedCommands),
    };
    const manager = createManager({
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        providerId: 'claude',
        service: n === 1 ? readyClaudeService : null,
      }),
    });

    await manager.createTab();
    const lazyClaudeTab = await manager.createTab();

    await expect(manager.getSdkCommands(lazyClaudeTab!.id)).resolves.toEqual(supportedCommands);
    expect(readyClaudeService.getSupportedCommands).toHaveBeenCalledTimes(1);
  });

  it('should not leak commands across providers', async () => {
    const claudeCommands = [{ id: 'sdk:commit', name: 'commit', content: '' }];
    const readyClaudeService = {
      providerId: 'claude',
      isReady: jest.fn().mockReturnValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue(claudeCommands),
    };
    const manager = createManager({
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        providerId: n === 2 ? 'codex' : 'claude',
        service: n === 1 ? readyClaudeService : null,
      }),
    });

    await manager.createTab();
    const codexTab = await manager.createTab();
    mockGetCapabilities.mockImplementation((providerId: string) => ({
      providerId,
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: providerId === 'claude',
      supportsRewind: providerId === 'claude',
      supportsFork: providerId === 'claude',
      supportsProviderCommands: providerId === 'claude',
      reasoningControl: providerId === 'claude' ? 'effort' : 'none',
    }));

    await expect(manager.getSdkCommands(codexTab!.id)).resolves.toEqual([]);
    expect(readyClaudeService.getSupportedCommands).not.toHaveBeenCalled();
  });

  it('should resolve blank-tab SDK command provider from draftModel instead of stale providerId', async () => {
    const claudeCommands = [{ id: 'sdk:commit', name: 'commit', content: '' }];
    const readyClaudeService = {
      providerId: 'claude',
      isReady: jest.fn().mockReturnValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue(claudeCommands),
    };
    const manager = createManager({
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        lifecycleState: n === 2 ? 'blank' : 'bound_cold',
        draftModel: n === 2 ? 'gpt-5.4' : null,
        providerId: 'claude',
        service: n === 1 ? readyClaudeService : null,
      }),
    });

    await manager.createTab();
    const blankCodexTab = await manager.createTab();
    mockGetCapabilities.mockImplementation((providerId: string) => ({
      providerId,
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: providerId === 'claude',
      supportsRewind: providerId === 'claude',
      supportsFork: providerId === 'claude',
      supportsProviderCommands: providerId === 'claude',
      reasoningControl: providerId === 'claude' ? 'effort' : 'none',
    }));

    await expect(manager.getSdkCommands(blankCodexTab!.id)).resolves.toEqual([]);
    expect(readyClaudeService.getSupportedCommands).not.toHaveBeenCalled();
  });
});

describe('TabManager - Provider Command Catalog', () => {
  const mockCatalogEntries = [
    {
      id: 'codex-skill-analyze', providerId: 'codex', kind: 'skill',
      name: 'analyze', description: 'Analyze code', content: '',
      scope: 'vault', source: 'user', isEditable: true, isDeletable: true,
      displayPrefix: '$', insertPrefix: '$',
    },
  ];

  const mockCatalog = {
    listDropdownEntries: jest.fn().mockResolvedValue(mockCatalogEntries),
    listVaultEntries: jest.fn().mockResolvedValue(mockCatalogEntries),
    saveVaultEntry: jest.fn(),
    deleteVaultEntry: jest.fn(),
    setRuntimeCommands: jest.fn(),
    getDropdownConfig: jest.fn().mockReturnValue({
      triggerChars: ['/', '$'],
      builtInPrefix: '/',
      skillPrefix: '$',
      commandPrefix: '/',
    }),
    refresh: jest.fn(),
  };

  afterEach(() => {
    ProviderWorkspaceRegistry.setServices('codex', undefined);
    ProviderWorkspaceRegistry.setServices('claude', undefined);
  });

  it('should pass provider catalog config to initializeTabUI for Codex tab', async () => {
    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: mockCatalog as any });

    const manager = createManager({
      tabFactory: () => createMockTabData({ id: 'tab-1', providerId: 'codex' }),
    });

    await manager.createTab();

    const options = mockInitializeTabUI.mock.calls[0][2];
    const catalogConfig = options.getProviderCatalogConfig();

    expect(catalogConfig).not.toBeNull();
    expect(catalogConfig.config.triggerChars).toEqual(['/', '$']);
    expect(catalogConfig.config.skillPrefix).toBe('$');
  });

  it('should provide scan-backed entries for Codex without runtime', async () => {
    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: mockCatalog as any });

    const manager = createManager({
      tabFactory: () => createMockTabData({ id: 'tab-1', providerId: 'codex' }),
    });

    await manager.createTab();

    const options = mockInitializeTabUI.mock.calls[0][2];
    const catalogConfig = options.getProviderCatalogConfig();
    const entries = await catalogConfig.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('analyze');
    expect(entries[0].displayPrefix).toBe('$');
  });

  it('should resolve the blank-tab catalog from draftModel instead of stale providerId', async () => {
    const claudeCatalog = {
      listDropdownEntries: jest.fn().mockResolvedValue([
        {
          id: 'claude-command-test', providerId: 'claude', kind: 'command',
          name: 'claude-only', description: 'Claude command', content: '',
          scope: 'vault', source: 'user', isEditable: true, isDeletable: true,
          displayPrefix: '/', insertPrefix: '/',
        },
      ]),
      listVaultEntries: jest.fn().mockResolvedValue([]),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      setRuntimeCommands: jest.fn(),
      getDropdownConfig: jest.fn().mockReturnValue({
        triggerChars: ['/'],
        builtInPrefix: '/',
        skillPrefix: '/',
        commandPrefix: '/',
      }),
      refresh: jest.fn(),
    };
    ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: claudeCatalog as any });
    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: mockCatalog as any });

    const manager = createManager({
      tabFactory: () => createMockTabData({
        id: 'tab-1',
        lifecycleState: 'blank',
        draftModel: 'gpt-5.4',
        providerId: 'claude',
      }),
    });

    await manager.createTab();

    const options = mockInitializeTabUI.mock.calls[0][2];
    const catalogConfig = options.getProviderCatalogConfig();
    const entries = await catalogConfig.getEntries();

    expect(catalogConfig).not.toBeNull();
    expect(catalogConfig.config.skillPrefix).toBe('$');
    expect(entries).toHaveLength(1);
    expect(entries[0].providerId).toBe('codex');
    expect(mockCatalog.listDropdownEntries).toHaveBeenCalledWith({ includeBuiltIns: false });
    expect(claudeCatalog.listDropdownEntries).not.toHaveBeenCalled();
  });

  it('should refresh Claude runtime commands before listing catalog entries', async () => {
    const supportedCommands = [{ id: 'sdk:commit', name: 'commit', content: '', source: 'sdk' }];
    const readyService = {
      providerId: 'claude',
      isReady: jest.fn().mockReturnValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue(supportedCommands),
    };
    const claudeCatalog = {
      listDropdownEntries: jest.fn().mockResolvedValue([]),
      listVaultEntries: jest.fn().mockResolvedValue([]),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      setRuntimeCommands: jest.fn(),
      getDropdownConfig: jest.fn().mockReturnValue({
        triggerChars: ['/'],
        builtInPrefix: '/',
        skillPrefix: '/',
        commandPrefix: '/',
      }),
      refresh: jest.fn(),
    };
    ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: claudeCatalog as any });

    const manager = createManager({
      tabFactory: () => createMockTabData({
        id: 'tab-1',
        providerId: 'claude',
        service: readyService,
      }),
    });

    await manager.createTab();

    const options = mockInitializeTabUI.mock.calls[0][2];
    const catalogConfig = options.getProviderCatalogConfig();
    await catalogConfig.getEntries();

    expect(readyService.getSupportedCommands).toHaveBeenCalledTimes(1);
    expect(claudeCatalog.setRuntimeCommands).toHaveBeenCalledWith(supportedCommands);
    expect(claudeCatalog.listDropdownEntries).toHaveBeenCalledWith({ includeBuiltIns: false });
  });

  it('should clear Claude runtime commands when revalidation returns no commands', async () => {
    const readyService = {
      providerId: 'claude',
      isReady: jest.fn().mockReturnValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue([]),
    };
    const claudeCatalog = {
      listDropdownEntries: jest.fn().mockResolvedValue([]),
      listVaultEntries: jest.fn().mockResolvedValue([]),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      setRuntimeCommands: jest.fn(),
      getDropdownConfig: jest.fn().mockReturnValue({
        triggerChars: ['/'],
        builtInPrefix: '/',
        skillPrefix: '/',
        commandPrefix: '/',
      }),
      refresh: jest.fn(),
    };
    ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: claudeCatalog as any });

    const manager = createManager({
      tabFactory: () => createMockTabData({
        id: 'tab-1',
        providerId: 'claude',
        service: readyService,
      }),
    });

    const tab = await manager.createTab();

    await expect(manager.getSdkCommands(tab!.id)).resolves.toEqual([]);
    expect(claudeCatalog.setRuntimeCommands).toHaveBeenCalledWith([]);
  });

  it('should return null catalog config when provider has no catalog', async () => {
    // No catalog assigned to registry for 'claude'

    const manager = createManager({
      tabFactory: () => createMockTabData({ id: 'tab-1', providerId: 'claude' }),
    });

    await manager.createTab();

    const options = mockInitializeTabUI.mock.calls[0][2];
    const catalogConfig = options.getProviderCatalogConfig();

    expect(catalogConfig).toBeNull();
  });
});

describe('TabManager - Cleanup', () => {
  let manager: TabManager;

  beforeEach(async () => {
    manager = createManager();
    await manager.createTab();
    await manager.createTab();
  });

  describe('destroy', () => {
    it('should destroy all tabs', async () => {
      await manager.destroy();

      expect(mockDestroyTab).toHaveBeenCalledTimes(2);
      expect(manager.getTabCount()).toBe(0);
    });

    it('should save all conversations before destroying', async () => {
      const tabs = manager.getAllTabs();
      const saveFns = tabs.map(tab => tab.controllers.conversationController?.save);

      await manager.destroy();

      saveFns.forEach(save => {
        expect(save).toHaveBeenCalled();
      });
    });

    it('should clear active tab ID', async () => {
      expect(manager.getActiveTabId()).not.toBeNull();

      await manager.destroy();

      expect(manager.getActiveTabId()).toBeNull();
    });
  });
});

describe('TabManager - Callback Wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ChatState callbacks during tab creation', () => {
    it('should wire onStreamingChanged callback to TabManager callbacks', async () => {
      const onTabStreamingChanged = jest.fn();
      const callbacks: TabManagerCallbacks = { onTabStreamingChanged };

      let capturedCallbacks: any;
      mockCreateTab.mockImplementation((opts: any) => {
        capturedCallbacks = opts;
        return createMockTabData({ id: 'test-tab' });
      });

      const manager = new TabManager(createMockPlugin(), createMockMcpManager(), createMockEl(), createMockView(), callbacks);
      await manager.createTab();

      // Trigger the onStreamingChanged callback
      capturedCallbacks.onStreamingChanged(true);

      expect(onTabStreamingChanged).toHaveBeenCalledWith('test-tab', true);
    });

    it('should wire onTitleChanged callback to TabManager callbacks', async () => {
      const onTabTitleChanged = jest.fn();
      const callbacks: TabManagerCallbacks = { onTabTitleChanged };

      let capturedCallbacks: any;
      mockCreateTab.mockImplementation((opts: any) => {
        capturedCallbacks = opts;
        return createMockTabData({ id: 'test-tab' });
      });

      const manager = new TabManager(createMockPlugin(), createMockMcpManager(), createMockEl(), createMockView(), callbacks);
      await manager.createTab();

      capturedCallbacks.onTitleChanged('New Title');

      expect(onTabTitleChanged).toHaveBeenCalledWith('test-tab', 'New Title');
    });

    it('should wire onAttentionChanged callback to TabManager callbacks', async () => {
      const onTabAttentionChanged = jest.fn();
      const callbacks: TabManagerCallbacks = { onTabAttentionChanged };

      let capturedCallbacks: any;
      mockCreateTab.mockImplementation((opts: any) => {
        capturedCallbacks = opts;
        return createMockTabData({ id: 'test-tab' });
      });

      const manager = new TabManager(createMockPlugin(), createMockMcpManager(), createMockEl(), createMockView(), callbacks);
      await manager.createTab();

      capturedCallbacks.onAttentionChanged(true);

      expect(onTabAttentionChanged).toHaveBeenCalledWith('test-tab', true);
    });

    it('should wire onConversationIdChanged callback to sync tab conversationId', async () => {
      const onTabConversationChanged = jest.fn();
      const callbacks: TabManagerCallbacks = { onTabConversationChanged };

      let capturedCallbacks: any;
      const tabData = createMockTabData({ id: 'test-tab', conversationId: null });
      mockCreateTab.mockImplementation((opts: any) => {
        capturedCallbacks = opts;
        return tabData;
      });

      const manager = new TabManager(createMockPlugin(), createMockMcpManager(), createMockEl(), createMockView(), callbacks);
      await manager.createTab();

      // Trigger the onConversationIdChanged callback (simulating conversation creation)
      capturedCallbacks.onConversationIdChanged('new-conv-id');

      // Tab's conversationId should be synced
      expect(tabData.conversationId).toBe('new-conv-id');
      expect(onTabConversationChanged).toHaveBeenCalledWith('test-tab', 'new-conv-id');
    });
  });
});

describe('TabManager - openConversation Current Tab Path', () => {
  let manager: TabManager;
  let plugin: any;

  beforeEach(async () => {
    plugin = createMockPlugin();
    manager = createManager({ plugin });
    await manager.createTab();
  });

  it('should open conversation in current tab when preferNewTab is false', async () => {
    const activeTab = manager.getActiveTab();
    const switchTo = jest.fn().mockResolvedValue(undefined);
    activeTab!.controllers.conversationController = { switchTo } as any;

    plugin.getConversationById.mockResolvedValue({ id: 'conv-to-open' });

    await manager.openConversation('conv-to-open', false);

    expect(switchTo).toHaveBeenCalledWith('conv-to-open');
  });

  it('should open conversation in current tab by default (preferNewTab defaults to false)', async () => {
    const activeTab = manager.getActiveTab();
    const switchTo = jest.fn().mockResolvedValue(undefined);
    activeTab!.controllers.conversationController = { switchTo } as any;

    plugin.getConversationById.mockResolvedValue({ id: 'conv-default' });

    await manager.openConversation('conv-default');

    expect(switchTo).toHaveBeenCalledWith('conv-default');
  });

  it('should not modify tab.conversationId directly (waits for callback)', async () => {
    const activeTab = manager.getActiveTab();
    const switchTo = jest.fn().mockResolvedValue(undefined);
    activeTab!.controllers.conversationController = { switchTo } as any;
    activeTab!.conversationId = null;

    plugin.getConversationById.mockResolvedValue({ id: 'conv-123' });

    await manager.openConversation('conv-123', false);

    // conversationId should NOT be set by openConversation - it's synced via callback
    expect(activeTab!.conversationId).toBeNull();
  });

  it('should not open in current tab if at max tabs and preferNewTab is true', async () => {
    for (let i = 0; i < DEFAULT_MAX_TABS - 1; i++) {
      await manager.createTab();
    }
    expect(manager.getTabCount()).toBe(DEFAULT_MAX_TABS);

    const activeTab = manager.getActiveTab();
    const switchTo = jest.fn().mockResolvedValue(undefined);
    activeTab!.controllers.conversationController = { switchTo } as any;

    plugin.getConversationById.mockResolvedValue({ id: 'conv-max' });

    // preferNewTab=true but at max, so should open in current tab
    await manager.openConversation('conv-max', true);

    expect(switchTo).toHaveBeenCalledWith('conv-max');
  });
});

describe('TabManager - Service Initialization Errors', () => {
  it('should restore state without pre-warming any tabs', async () => {
    mockCreateTab.mockReturnValue(
      createMockTabData({ id: 'test-tab', serviceInitialized: false })
    );

    const manager = new TabManager(
      createMockPlugin(),
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    const persistedState: PersistedTabManagerState = {
      openTabs: [{ tabId: 'restored-tab', conversationId: null }],
      activeTabId: 'restored-tab',
    };

    await manager.restoreState(persistedState);

    // No pre-warm: all restored tabs stay cold until send
    expect(mockInitializeTabService).not.toHaveBeenCalled();
  });
});

describe('TabManager - Concurrent Switch Guard', () => {
  it('should prevent concurrent tab switches', async () => {
    const callbacks: TabManagerCallbacks = {
      onTabSwitched: jest.fn(),
    };
    const manager = createManager({ callbacks });

    const tab1 = await manager.createTab();
    const tab2 = await manager.createTab();

    // Set up tab-1 to trigger the async conversationController.switchTo path
    // so that switchToTab hangs mid-execution with isSwitchingTab = true
    let resolveSwitchTo!: () => void;
    const hangingPromise = new Promise<void>(resolve => {
      resolveSwitchTo = resolve;
    });
    tab1!.conversationId = 'conv-1';
    tab1!.state.messages = [];
    tab1!.controllers.conversationController!.switchTo = jest.fn().mockReturnValue(hangingPromise);

    jest.clearAllMocks();

    // Start first switch to tab-1 (will hang on conversationController.switchTo)
    const firstSwitch = manager.switchToTab(tab1!.id);

    // While first switch is in progress, try a second switch.
    // isSwitchingTab is true, so this should return immediately (lines 143-144)
    await manager.switchToTab(tab2!.id);

    expect(mockDeactivateTab).toHaveBeenCalledTimes(1);
    expect(mockActivateTab).toHaveBeenCalledTimes(1);

    // Resolve the hanging first switch
    resolveSwitchTo();
    await firstSwitch;

    expect(callbacks.onTabSwitched).toHaveBeenCalledTimes(1);

    // After first switch completes, isSwitchingTab is false
    // and subsequent switches should work normally
    await manager.switchToTab(tab2!.id);
    expect(callbacks.onTabSwitched).toHaveBeenCalledTimes(2);
  });
});

describe('TabManager - closeTab Edge Cases', () => {
  it('should return false for non-existent tab', async () => {
    const manager = createManager();
    await manager.createTab();

    const result = await manager.closeTab('non-existent-tab');
    expect(result).toBe(false);
  });

  it('should not close last empty tab (preserves warm service)', async () => {
    const manager = createManager({
      tabFactory: () => createMockTabData({ id: 'only-tab' }),
    });
    await manager.createTab();

    const result = await manager.closeTab('only-tab');
    expect(result).toBe(false);
    expect(manager.getTabCount()).toBe(1);
  });

  it('should create new blank tab (stays cold) when closing the last tab with conversation', async () => {
    const callbacks: TabManagerCallbacks = {
      onTabCreated: jest.fn(),
      onTabClosed: jest.fn(),
    };

    const manager = createManager({
      callbacks,
      tabFactory: (n) => createMockTabData({
        id: `tab-${n}`,
        conversationId: n === 1 ? 'conv-existing' : null,
      }),
    });
    await manager.createTab();

    jest.clearAllMocks();

    // Close the only tab (has conversationId so it bypasses the last-empty-tab guard)
    const result = await manager.closeTab('tab-1');

    expect(result).toBe(true);
    expect(manager.getTabCount()).toBe(1); // New tab was created
    expect(mockCreateTab).toHaveBeenCalled();
    // No pre-warm: replacement blank tabs stay cold until send
    expect(mockInitializeTabService).not.toHaveBeenCalled();
    expect(callbacks.onTabClosed).toHaveBeenCalledWith('tab-1');
  });
});

describe('TabManager - forkToNewTab', () => {
  it('should propagate currentNote from context to forked conversation', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-1', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [
        { id: 'msg-1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 'msg-2', role: 'assistant', content: 'hi', timestamp: 2 },
      ] as any,
      sourceSessionId: 'session-1',
      resumeAt: 'assistant-uuid-1',
      currentNote: 'notes/test.md',
    });

    expect(mockUpdateConversation).toHaveBeenCalledWith('fork-conv-1', expect.objectContaining({
      currentNote: 'notes/test.md',
    }));
  });

  it('should not set currentNote when context has none', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-2', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [
        { id: 'msg-1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 'msg-2', role: 'assistant', content: 'hi', timestamp: 2 },
      ] as any,
      sourceSessionId: 'session-1',
      resumeAt: 'assistant-uuid-1',
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.currentNote).toBeUndefined();
  });
});

describe('TabManager - forkInCurrentTab', () => {
  it('should create fork conversation and switch active tab to it', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-1', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);
    const mockSwitchTo = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      return createMockTabData({
        id: `tab-${tabCounter}`,
        controllers: {
          conversationController: {
            save: jest.fn().mockResolvedValue(undefined),
            switchTo: mockSwitchTo,
            initializeWelcome: jest.fn(),
          },
          inputController: { handleApprovalRequest: jest.fn() },
        },
      });
    });

    const manager = new TabManager(
      plugin,
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );
    await manager.createTab();

    const success = await manager.forkInCurrentTab({
      messages: [{ id: 'msg-1', role: 'user', content: 'hello', timestamp: 1 }] as any,
      sourceSessionId: 'session-1',
      resumeAt: 'assistant-uuid-1',
      currentNote: 'notes/test.md',
      sourceTitle: 'My Chat',
      forkAtUserMessage: 1,
    });

    expect(success).toBe(true);
    expect(mockCreateConversation).toHaveBeenCalled();
    expect(mockUpdateConversation).toHaveBeenCalledWith('fork-conv-1', expect.objectContaining({
      providerState: { forkSource: { sessionId: 'session-1', resumeAt: 'assistant-uuid-1' } },
      currentNote: 'notes/test.md',
    }));
    expect(mockSwitchTo).toHaveBeenCalledWith('fork-conv-1');
  });

  it('should return false when no active tab exists', async () => {
    const plugin = createMockPlugin({
      createConversation: jest.fn().mockResolvedValue({ id: 'fork-conv-2', providerId: 'claude' }),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });

    const manager = createManager({ plugin });
    // Don't create any tabs

    const success = await manager.forkInCurrentTab({
      messages: [] as any,
      sourceSessionId: 'session-1',
      resumeAt: 'assistant-uuid-1',
    });

    expect(success).toBe(false);
  });

  it('should not check tab count limit', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-3', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);
    const mockSwitchTo = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
      settings: { maxTabs: 3 },
    });

    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      return createMockTabData({
        id: `tab-${tabCounter}`,
        controllers: {
          conversationController: {
            save: jest.fn().mockResolvedValue(undefined),
            switchTo: mockSwitchTo,
            initializeWelcome: jest.fn(),
          },
          inputController: { handleApprovalRequest: jest.fn() },
        },
      });
    });

    const manager = new TabManager(
      plugin,
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    // Fill all tabs to max
    await manager.createTab();
    await manager.createTab();
    await manager.createTab();

    // forkInCurrentTab should still work even at max tabs
    const success = await manager.forkInCurrentTab({
      messages: [{ id: 'msg-1', role: 'user', content: 'hello', timestamp: 1 }] as any,
      sourceSessionId: 'session-1',
      resumeAt: 'assistant-uuid-1',
    });

    expect(success).toBe(true);
    expect(mockSwitchTo).toHaveBeenCalled();
  });
});

describe('TabManager - switchToTab Session Sync', () => {
  it('should sync service session for already-loaded tab with conversation', async () => {
    jest.clearAllMocks();

    const mockSyncConversationState = jest.fn();
    const mockService = {
      syncConversationState: mockSyncConversationState,
      cleanup: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      onReadyStateChange: jest.fn(() => () => {}),
      isReady: jest.fn().mockReturnValue(true),
    };

    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      const tab = createMockTabData({
        id: `tab-${tabCounter}`,
        conversationId: tabCounter === 2 ? 'conv-loaded' : null,
        service: tabCounter === 2 ? mockService : null,
        serviceInitialized: tabCounter === 2,
      });
      // For tab-2, simulate already having messages loaded
      if (tabCounter === 2) {
        tab.state.messages = [{ id: 'msg-1', role: 'user', content: 'test' }] as any;
      }
      return tab;
    });

    const plugin = createMockPlugin();
    plugin.getConversationSync = jest.fn().mockReturnValue({
      id: 'conv-loaded',
      messages: [{ id: 'msg-1', role: 'user', content: 'test' }],
      sessionId: 'session-xyz',
      externalContextPaths: ['/some/path'],
    });

    const manager = new TabManager(
      plugin,
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    await manager.createTab(); // tab-1, active
    await manager.createTab(); // tab-2, auto-switches and triggers session sync

    // Should have synced the service session during auto-switch to tab-2
    expect(mockSyncConversationState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-loaded', sessionId: 'session-xyz' }),
      ['/some/path'],
    );
  });

  it('should use persistentExternalContextPaths when conversation has no messages', async () => {
    jest.clearAllMocks();

    const mockSyncConversationState = jest.fn();
    const mockService = {
      syncConversationState: mockSyncConversationState,
    };

    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      const tab = createMockTabData({
        id: `tab-${tabCounter}`,
        conversationId: tabCounter === 2 ? 'conv-empty' : null,
        service: tabCounter === 2 ? mockService : null,
        serviceInitialized: tabCounter === 2,
      });
      // Tab has local messages but the persisted conversation does not
      if (tabCounter === 2) {
        tab.state.messages = [{ id: 'msg-1', role: 'user', content: 'test' }] as any;
      }
      return tab;
    });

    const plugin = createMockPlugin({
      settings: {
        maxTabs: DEFAULT_MAX_TABS,
        persistentExternalContextPaths: ['/persistent/path'],
      },
    });
    plugin.getConversationSync = jest.fn().mockReturnValue({
      id: 'conv-empty',
      messages: [],
      sessionId: 'session-abc',
      externalContextPaths: [],
    });

    const manager = new TabManager(
      plugin,
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    await manager.createTab(); // tab-1
    await manager.createTab(); // tab-2, auto-switches and triggers session sync

    // conversation.messages is empty, so should fall back to persistentExternalContextPaths
    expect(mockSyncConversationState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-empty', sessionId: 'session-abc' }),
      ['/persistent/path'],
    );
  });

  it('should initialize welcome for new tab without conversation', async () => {
    jest.clearAllMocks();

    const mockInitializeWelcome = jest.fn();
    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      const tab = createMockTabData({ id: `tab-${tabCounter}` });
      tab.controllers.conversationController = {
        ...tab.controllers.conversationController,
        initializeWelcome: mockInitializeWelcome,
      };
      return tab;
    });

    const manager = new TabManager(
      createMockPlugin(),
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    await manager.createTab(); // tab-1
    await manager.createTab(); // tab-2 (now active)

    // Switch to tab-1 first so we can switch back to tab-2
    await manager.switchToTab('tab-1');
    mockInitializeWelcome.mockClear();

    // Switch to tab-2 (no conversationId, no messages -> should call initializeWelcome)
    await manager.switchToTab('tab-2');

    expect(mockInitializeWelcome).toHaveBeenCalled();
  });
});

describe('TabManager - handleForkRequest (modal dispatch)', () => {
  it('should fork to new tab when user selects "new-tab"', async () => {
    mockChooseForkTarget.mockResolvedValue('new-tab');

    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-1', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    let capturedForkCallback: any;
    mockInitializeTabControllers.mockImplementation(
      (_tab: any, _plugin: any, _view: any, forkCb: any) => {
        capturedForkCallback = forkCb;
      }
    );

    const manager = createManager({ plugin });
    await manager.createTab();

    // Invoke the fork callback that was passed to initializeTabControllers
    await capturedForkCallback({
      messages: [{ id: 'msg-1', role: 'user', content: 'hello', timestamp: 1 }],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      sourceTitle: 'Test Chat',
      forkAtUserMessage: 1,
    });

    expect(mockChooseForkTarget).toHaveBeenCalled();
    expect(mockCreateConversation).toHaveBeenCalled();
    expect(mockUpdateConversation).toHaveBeenCalled();
  });

  it('should fork in current tab when user selects "current-tab"', async () => {
    mockChooseForkTarget.mockResolvedValue('current-tab');

    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-2', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);
    const mockSwitchTo = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    let capturedForkCallback: any;
    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      return createMockTabData({
        id: `tab-${tabCounter}`,
        controllers: {
          conversationController: {
            save: jest.fn().mockResolvedValue(undefined),
            switchTo: mockSwitchTo,
            initializeWelcome: jest.fn(),
          },
          inputController: { handleApprovalRequest: jest.fn() },
        },
      });
    });
    mockInitializeTabControllers.mockImplementation(
      (_tab: any, _plugin: any, _view: any, forkCb: any) => {
        capturedForkCallback = forkCb;
      }
    );

    const manager = new TabManager(
      plugin,
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );
    await manager.createTab();

    await capturedForkCallback({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
    });

    expect(mockChooseForkTarget).toHaveBeenCalled();
    expect(mockSwitchTo).toHaveBeenCalledWith('fork-conv-2');
  });

  it('should do nothing when user cancels modal', async () => {
    mockChooseForkTarget.mockResolvedValue(null);

    const mockCreateConversation = jest.fn();
    const plugin = createMockPlugin({ createConversation: mockCreateConversation });

    let capturedForkCallback: any;
    mockInitializeTabControllers.mockImplementation(
      (_tab: any, _plugin: any, _view: any, forkCb: any) => {
        capturedForkCallback = forkCb;
      }
    );

    const manager = createManager({ plugin });
    await manager.createTab();

    await capturedForkCallback({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
    });

    expect(mockChooseForkTarget).toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});

describe('TabManager - forkToNewTab at max tabs', () => {
  it('should return null when at max tabs', async () => {
    jest.clearAllMocks();

    const plugin = createMockPlugin();
    // MIN_TABS is 3, so maxTabs must be >= 3 to avoid clamping
    plugin.settings.maxTabs = 3;
    plugin.createConversation = jest.fn().mockResolvedValue({ id: 'fork-conv', providerId: 'claude' });
    plugin.updateConversation = jest.fn().mockResolvedValue(undefined);

    let tabCounter = 0;
    mockCreateTab.mockImplementation(() => {
      tabCounter++;
      return createMockTabData({ id: `tab-${tabCounter}` });
    });

    const manager = new TabManager(
      plugin,
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    await manager.createTab();
    await manager.createTab();
    await manager.createTab();
    expect(manager.getTabCount()).toBe(3);

    const result = await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid',
    });

    expect(result).toBeNull();
  });
});

describe('TabManager - createForkConversation', () => {
  it('should set forkSource with sessionId and resumeAt', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-1', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-abc',
      resumeAt: 'asst-uuid-xyz',
    });

    expect(mockUpdateConversation).toHaveBeenCalledWith('fork-conv-1', expect.objectContaining({
      providerState: { forkSource: { sessionId: 'session-abc', resumeAt: 'asst-uuid-xyz' } },
    }));
  });

  it('should create the fork conversation with the source provider', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-codex', providerId: 'codex' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      providerId: 'codex',
      sourceSessionId: 'session-codex',
      resumeAt: 'asst-codex',
    });

    expect(mockCreateConversation).toHaveBeenCalledWith({ providerId: 'codex' });
  });

  it('should not set title when sourceTitle is undefined', async () => {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv-1', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
    });

    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      // no sourceTitle
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.title).toBeUndefined();
  });
});

describe('TabManager - buildForkTitle', () => {
  function setupTitleTest(existingTitles: string[] = []) {
    const mockCreateConversation = jest.fn().mockResolvedValue({ id: 'fork-conv', providerId: 'claude' });
    const mockUpdateConversation = jest.fn().mockResolvedValue(undefined);

    const plugin = createMockPlugin({
      createConversation: mockCreateConversation,
      updateConversation: mockUpdateConversation,
      getConversationList: jest.fn().mockReturnValue(
        existingTitles.map((t, i) => ({ id: `conv-${i}`, title: t }))
      ),
    });

    return { plugin, mockUpdateConversation };
  }

  it('should format title as "Fork: {source} (#{num})"', async () => {
    const { plugin, mockUpdateConversation } = setupTitleTest();
    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      sourceTitle: 'My Chat',
      forkAtUserMessage: 3,
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.title).toBe('Fork: My Chat (#3)');
  });

  it('should format title without message number when not provided', async () => {
    const { plugin, mockUpdateConversation } = setupTitleTest();
    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      sourceTitle: 'My Chat',
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.title).toBe('Fork: My Chat');
  });

  it('should truncate long source titles', async () => {
    const { plugin, mockUpdateConversation } = setupTitleTest();
    const manager = createManager({ plugin });
    await manager.createTab();

    const longTitle = 'A'.repeat(100);
    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      sourceTitle: longTitle,
      forkAtUserMessage: 1,
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.title.length).toBeLessThanOrEqual(50);
    expect(updateCall.title).toContain('…');
    expect(updateCall.title).toContain('Fork: ');
    expect(updateCall.title).toContain('(#1)');
  });

  it('should deduplicate title when same fork title exists', async () => {
    const { plugin, mockUpdateConversation } = setupTitleTest(['Fork: My Chat (#1)']);
    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      sourceTitle: 'My Chat',
      forkAtUserMessage: 1,
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.title).toBe('Fork: My Chat (#1) 2');
  });

  it('should find next available dedup number', async () => {
    const { plugin, mockUpdateConversation } = setupTitleTest([
      'Fork: My Chat (#1)',
      'Fork: My Chat (#1) 2',
      'Fork: My Chat (#1) 3',
    ]);
    const manager = createManager({ plugin });
    await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      sourceSessionId: 'session-1',
      resumeAt: 'asst-uuid-1',
      sourceTitle: 'My Chat',
      forkAtUserMessage: 1,
    });

    const updateCall = mockUpdateConversation.mock.calls[0][1];
    expect(updateCall.title).toBe('Fork: My Chat (#1) 4');
  });
});
