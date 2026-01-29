import { createMockEl } from '@test/helpers/mockElement';

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
  it('should handle initializeActiveTabService errors gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    // Make initializeTabService fail
    mockInitializeTabService.mockRejectedValueOnce(new Error('Service init failed'));

    mockCreateTab.mockReturnValue(
      createMockTabData({ id: 'test-tab', serviceInitialized: false })
    );

    const manager = new TabManager(
      createMockPlugin(),
      createMockMcpManager(),
      createMockEl(),
      createMockView()
    );

    // Restore state triggers initializeActiveTabService
    const persistedState: PersistedTabManagerState = {
      openTabs: [{ tabId: 'restored-tab', conversationId: null }],
      activeTabId: 'restored-tab',
    };

    // Should not throw even if service init fails
    await expect(manager.restoreState(persistedState)).resolves.not.toThrow();

    consoleSpy.mockRestore();
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

  it('should create new tab and initialize service when closing the last tab with conversation', async () => {
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
    expect(mockInitializeTabService).toHaveBeenCalled();
    expect(callbacks.onTabClosed).toHaveBeenCalledWith('tab-1');
  });
});

describe('TabManager - switchToTab Session Sync', () => {
  it('should sync service session for already-loaded tab with conversation', async () => {
    jest.clearAllMocks();

    const mockSetSessionId = jest.fn();
    const mockService = {
      setSessionId: mockSetSessionId,
      closePersistentQuery: jest.fn(),
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
    plugin.getConversationById = jest.fn().mockResolvedValue({
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
    expect(mockSetSessionId).toHaveBeenCalledWith('session-xyz', ['/some/path']);
  });

  it('should use persistentExternalContextPaths when conversation has no messages', async () => {
    jest.clearAllMocks();

    const mockSetSessionId = jest.fn();
    const mockService = {
      setSessionId: mockSetSessionId,
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
    plugin.getConversationById = jest.fn().mockResolvedValue({
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
    expect(mockSetSessionId).toHaveBeenCalledWith('session-abc', ['/persistent/path']);
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
