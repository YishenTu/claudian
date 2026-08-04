import { createMockEl } from '@test/helpers/MockElement';
import { Notice } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { TabManager } from '@/features/chat/tabs/TabManager';

const mockInitializeTabExecution = jest.fn().mockResolvedValue(undefined);
const mockInitializeTabControllers = jest.fn();
const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
const mockTabs: any[] = [];
const mockCreateTab = jest.fn((options: Record<string, any>) => createMockTab(options));
const mockChooseForkTarget = jest.fn();

function createMockTab(options: Record<string, any>): any {
  const tab = {
    id: options.tabId ?? `tab-${mockTabs.length + 1}`,
    conversationId: options.conversation?.id ?? null,
    draftModel: options.conversation ? null : 'claude-default',
    executionCoordinator: {
      copyInputsForFork: jest.fn().mockResolvedValue(undefined),
      prepare: jest.fn().mockResolvedValue(undefined),
      state: 'absent',
    },
    hydrationState: options.conversation ? 'idle' : 'ready',
    lifecycleState: options.lifecycleState ?? 'cold',
    providerId: options.conversation?.providerId ?? 'claude',
    state: {
      currentConversationId: options.conversation?.id ?? null,
      hasPendingConversationSave: false,
      isRewinding: false,
      isStreaming: false,
      isSwitchingConversation: false,
      messages: [],
      needsAttention: false,
    },
    controllers: {
      conversationController: {
        initializeWelcome: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
        switchTo: jest.fn().mockResolvedValue(undefined),
      },
    },
    dom: {
      contentEl: createMockEl(),
      messagesEl: createMockEl(),
    },
    ui: {},
  };
  mockTabs.push(tab);
  return tab;
}

jest.mock('@/features/chat/tabs/Tab', () => ({
  activateTab: jest.fn(),
  createTab: (options: Record<string, any>) => mockCreateTab(options),
  deactivateTab: jest.fn(),
  destroyTab: (...args: unknown[]) => mockDestroyTab(...args),
  getTabTitle: jest.fn().mockReturnValue('Tab'),
  initializeTabControllers: (...args: unknown[]) => mockInitializeTabControllers(...args),
  initializeTabExecution: (...args: unknown[]) => mockInitializeTabExecution(...args),
  initializeTabUI: jest.fn(),
  onProviderAvailabilityChanged: jest.fn().mockReturnValue(false),
  refreshTabWorkspaceServices: jest.fn(),
  wireTabInputEvents: jest.fn(),
}));

jest.mock('@/shared/modals/ForkTargetModal', () => ({
  chooseForkTarget: (...args: unknown[]) => mockChooseForkTarget(...args),
}));

const commandLoader = {
  getCacheFingerprint: jest.fn().mockReturnValue('commands-v1'),
  isAvailable: jest.fn().mockReturnValue(true),
  loadCommands: jest.fn().mockResolvedValue({
    status: 'ready',
    items: [{ description: 'Review changes', name: 'review' }],
  }),
};
const commandCatalog = {
  getDropdownConfig: jest.fn().mockReturnValue({}),
  listDropdownEntries: jest.fn().mockResolvedValue([]),
  setCommandSnapshot: jest.fn(),
};
const warmupPolicy = {
  resolveMode: jest.fn().mockReturnValue('none'),
};

jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    ensureInitialized: jest.fn().mockResolvedValue(undefined),
    getCommandCatalog: jest.fn().mockImplementation(() => commandCatalog),
    getIfInitialized: jest.fn().mockReturnValue({}),
    getCommandLoader: jest.fn().mockImplementation(() => commandLoader),
    getTabWarmupPolicy: jest.fn().mockImplementation(() => warmupPolicy),
  },
}));

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsProviderCommands: true,
    }),
    getConversationHistoryService: jest.fn().mockReturnValue({
      buildForkProviderState: jest.fn().mockReturnValue({ fork: true }),
    }),
    resolveProviderForModel: jest.fn().mockReturnValue('claude'),
  },
}));

function createPlugin(overrides: Record<string, unknown> = {}) {
  return {
    app: {
      vault: { adapter: { basePath: '/vault' } },
      workspace: {
        revealLeaf: jest.fn(),
        setActiveLeaf: jest.fn(),
      },
    },
    settings: {
      maxWarmAgentProcesses: 5,
      persistentExternalContextPaths: [],
    },
    providerHost: {
      executionLifecycleRegistry: {
        getProviderGeneration: jest.fn().mockReturnValue(0),
      },
    },
    createConversation: jest.fn().mockResolvedValue({
      id: 'forked',
      providerId: 'claude',
    }),
    deleteConversation: jest.fn().mockResolvedValue(undefined),
    findConversationAcrossViews: jest.fn().mockReturnValue(null),
    getAgentSkillResourceGeneration: jest.fn().mockReturnValue(0),
    getCachedConversation: jest.fn().mockReturnValue(null),
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    getConversationSync: jest.fn().mockReturnValue(null),
    updateConversation: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function createManager(plugin = createPlugin(), callbacks: Record<string, unknown> = {}) {
  const view = {
    leaf: {},
    getTabManager: jest.fn(),
  } as any;
  return {
    manager: new TabManager(plugin, createMockEl() as any, view, callbacks),
    plugin,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('TabManager provider execution orchestration', () => {
  beforeEach(() => {
    mockTabs.length = 0;
    jest.clearAllMocks();
    warmupPolicy.resolveMode.mockReturnValue('none');
    commandLoader.loadCommands.mockResolvedValue({
      status: 'ready',
      items: [{ description: 'Review changes', name: 'review' }],
    });
  });

  it('creates tabs without installing runtime callbacks', async () => {
    const { manager } = createManager();

    const tab = await manager.createTab();

    expect(tab).not.toBeNull();
    expect(tab?.lifecycleState).toBe('cold');
    const options = mockCreateTab.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('onRuntimeInstalled');
  });

  it('allows unlimited runtime tabs independently from the warm process limit', async () => {
    const { manager } = createManager(createPlugin({
      settings: {
        maxWarmAgentProcesses: 1,
        persistentExternalContextPaths: [],
      },
    }));

    const tabs = await Promise.all(
      Array.from({ length: 12 }, () => manager.createTab()),
    );

    expect(tabs.every(Boolean)).toBe(true);
    expect(manager.getTabCount()).toBe(12);
    expect(manager.canCreateTab()).toBe(true);
  });

  it('creates session selections as provisional runtime tabs', async () => {
    const conversation = {
      id: 'conversation-1',
      providerId: 'claude',
    };
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(conversation),
    }));

    await manager.openConversation(conversation.id, {
      activate: true,
      preferNewTab: true,
      provisional: true,
    });

    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
  });

  it('reuses the provisional preview while browsing unopened sessions', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));

    await manager.openConversation('conversation-1', {
      preferNewTab: true,
      provisional: true,
    });
    const preview = manager.getActiveTab()!;
    await manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });

    expect(manager.getTabCount()).toBe(1);
    expect(preview.controllers.conversationController?.switchTo)
      .toHaveBeenCalledWith('conversation-2');
    expect(preview.lifecycleState).toBe('provisional');
  });

  it('discards provisional previews without removing cold or warm runtime tabs', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const cold = await manager.createTab('conversation-1');
    const warm = await manager.createTab('conversation-2', undefined, { activate: false });
    warm!.lifecycleState = 'warm';
    await manager.openConversation('conversation-3', {
      activate: false,
      preferNewTab: true,
      provisional: true,
    });

    await manager.discardProvisionalTabs();

    expect(manager.getAllTabs()).toEqual([cold, warm]);
    expect(mockDestroyTab).toHaveBeenCalledTimes(1);
  });

  it('keeps the active preview when every runtime tab is provisional', async () => {
    const { manager } = createManager();
    const first = await manager.createTab(null, undefined, {
      lifecycleState: 'provisional',
    });
    const current = await manager.createTab(null, undefined, {
      lifecycleState: 'provisional',
    });

    await manager.discardProvisionalTabs();

    expect(manager.getAllTabs()).toEqual([current]);
    expect(current?.lifecycleState).toBe('cold');
    expect(mockDestroyTab).toHaveBeenCalledWith(first);
  });

  it('runs command discovery without a runtime or provider session', async () => {
    const { manager } = createManager();
    await manager.createTab();

    await expect(manager.getSdkCommands()).resolves.toEqual([
      { description: 'Review changes', name: 'review' },
    ]);

    expect(commandLoader.loadCommands).toHaveBeenCalledWith(expect.objectContaining({
      allowIsolatedMetadataCreation: false,
      conversation: null,
      externalContextPaths: [],
    }));
    expect(commandLoader.loadCommands.mock.calls[0][0]).not.toHaveProperty('runtime');
  });

  it('reloads cached commands after the provider lifecycle generation advances', async () => {
    const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
    const { manager } = createManager(createPlugin({
      providerHost: { executionLifecycleRegistry },
    }));
    await manager.createTab();

    await expect(manager.getSdkCommands()).resolves.toEqual([
      { description: 'Review changes', name: 'review' },
    ]);
    await expect(manager.getSdkCommands()).resolves.toHaveLength(1);
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(1);

    await executionLifecycleRegistry.runTransition(['claude'], async () => undefined);

    await expect(manager.getSdkCommands()).resolves.toHaveLength(1);
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(2);
    await executionLifecycleRegistry.dispose();
  });

  it('rejects an old command result across a provider lifecycle transition', async () => {
    const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
    const oldDiscovery = deferred<{
      status: 'ready';
      items: [{ description: string; name: string }];
    }>();
    commandLoader.loadCommands.mockReturnValueOnce(oldDiscovery.promise);
    const { manager } = createManager(createPlugin({
      providerHost: { executionLifecycleRegistry },
    }));
    await manager.createTab();

    const oldLoad = manager.getSdkCommands();
    for (let attempt = 0; attempt < 10 && commandLoader.loadCommands.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(1);

    await executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
    oldDiscovery.resolve({
      status: 'ready',
      items: [{ description: 'Old command', name: 'old' }],
    });
    await expect(oldLoad).resolves.toEqual([
      { description: 'Old command', name: 'old' },
    ]);
    expect(commandCatalog.setCommandSnapshot).not.toHaveBeenCalled();

    commandLoader.loadCommands.mockResolvedValueOnce({
      status: 'ready',
      items: [{ description: 'Fresh command', name: 'fresh' }],
    });
    await expect(manager.getSdkCommands()).resolves.toEqual([
      { description: 'Fresh command', name: 'fresh' },
    ]);
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(2);
    expect(commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([
      { description: 'Fresh command', name: 'fresh' },
    ]);
    await executionLifecycleRegistry.dispose();
  });

  it('does not warm tab execution during metadata warmup', async () => {
    const { manager } = createManager();
    await manager.createTab();
    warmupPolicy.resolveMode.mockReturnValue('execution');

    manager.primeProviderExecution();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInitializeTabExecution).not.toHaveBeenCalled();
  });

  it('copies the accepted input ledger when forking', async () => {
    const { manager, plugin } = createManager();
    const source = await manager.createTab();

    await manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceSessionId: 'native-session',
    });

    expect((source!.executionCoordinator!.copyInputsForFork as jest.Mock)).toHaveBeenCalledWith(
      'forked',
      'assistant-checkpoint',
    );
    expect(plugin.updateConversation).toHaveBeenCalledWith(
      'forked',
      expect.objectContaining({ providerState: { fork: true } }),
    );
  });

  it('forks into a new runtime tab without prompting in dual mode', async () => {
    const { manager } = createManager(createPlugin(), {
      shouldForkToNewTab: () => true,
    });
    await manager.createTab();
    const forkRequest = mockInitializeTabControllers.mock.calls[0]?.[3];

    await forkRequest({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceSessionId: 'native-session',
    });

    expect(mockChooseForkTarget).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(manager.getTabCount()).toBe(2);
  });

  it('deletes a partial fork if ledger copy fails', async () => {
    const { manager, plugin } = createManager();
    const source = await manager.createTab();
    (source!.executionCoordinator!.copyInputsForFork as jest.Mock).mockRejectedValueOnce(
      new Error('ledger copy failed'),
    );

    await expect(manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceSessionId: 'native-session',
    })).rejects.toThrow('ledger copy failed');

    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });

  it('deletes a partial fork if async provider-state construction fails', async () => {
    const { manager, plugin } = createManager();
    await manager.createTab();
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({
      buildForkProviderState: jest.fn().mockRejectedValue(new Error('fork state failed')),
    });

    await expect(manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceSessionId: 'native-session',
    })).rejects.toThrow('fork state failed');

    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });
});
