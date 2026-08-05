import { createMockEl } from '@test/helpers/MockElement';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { TabManager } from '@/features/chat/tabs/TabManager';

const mockInitializeTabExecution = jest.fn().mockResolvedValue(undefined);
const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
const mockTabs: any[] = [];
const mockCreateTab = jest.fn((options: Record<string, any>) => createMockTab(options));

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
    lifecycleState: options.conversation ? 'bound_cold' : 'blank',
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
  initializeTabControllers: jest.fn(),
  initializeTabExecution: (...args: unknown[]) => mockInitializeTabExecution(...args),
  initializeTabUI: jest.fn(),
  onProviderAvailabilityChanged: jest.fn().mockReturnValue(false),
  refreshTabWorkspaceServices: jest.fn(),
  wireTabInputEvents: jest.fn(),
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
      maxTabs: 3,
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

function createManager(plugin = createPlugin()) {
  const view = {
    leaf: {},
    getTabManager: jest.fn(),
  } as any;
  return {
    manager: new TabManager(plugin, createMockEl() as any, view),
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
    const options = mockCreateTab.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('onRuntimeInstalled');
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

  it('routes execution warmup through tab execution initialization', async () => {
    const { manager } = createManager();
    await manager.createTab();
    warmupPolicy.resolveMode.mockReturnValue('execution');

    manager.primeProviderExecution();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInitializeTabExecution).toHaveBeenCalled();
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
