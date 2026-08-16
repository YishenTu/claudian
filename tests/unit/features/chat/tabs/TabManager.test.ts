import { createMockEl } from '@test/helpers/MockElement';
import { Notice } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { TabManager } from '@/features/chat/tabs/TabManager';

const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
const mockDrainTabForShutdownSnapshot = jest.fn().mockResolvedValue({
  cancelledActiveTurn: false,
  cleanupFailures: [],
});
const mockTabs: any[] = [];
const mockCreateTab = jest.fn((options: Record<string, any>) => createMockTab(options));
const mockCreateTabRuntime = jest.fn(async (options: Record<string, any>) => {
  const captureReviewableSettlement = options.captureReviewableSettlement
    ? () => options.captureReviewableSettlement(tab)
    : undefined;
  const tab = mockCreateTab({
    ...options,
    captureReviewableSettlement,
  });
  return tab;
});
const mockChooseForkTarget = jest.fn();

function createMockTab(options: Record<string, any>): any {
  let intentAdmissionPauseDepth = 0;
  const session = {
    userOwnershipRevision: 0,
    get acceptsIntents() {
      return intentAdmissionPauseDepth === 0;
    },
    claimUserOwnership: jest.fn(() => {
      session.userOwnershipRevision += 1;
    }),
    pauseIntentAdmission: jest.fn(() => {
      intentAdmissionPauseDepth += 1;
    }),
    resumeIntentAdmission: jest.fn(() => {
      intentAdmissionPauseDepth = Math.max(0, intentAdmissionPauseDepth - 1);
    }),
  };
  const tab = {
    id: options.tabId ?? `tab-${mockTabs.length + 1}`,
    conversationId: options.conversation?.id ?? null,
    draftModel: options.conversation ? null : 'claude-default',
    executionCoordinator: {
      copyInputsForFork: jest.fn().mockResolvedValue(undefined),
      notifyMayCool: jest.fn(),
      prepare: jest.fn().mockResolvedValue(undefined),
      state: 'absent',
    },
    hydrationState: options.conversation ? 'idle' : 'ready',
    lifecycleState: options.lifecycleState ?? 'cold',
    providerId: options.conversation?.providerId ?? 'claude',
    session,
    captureReviewableSettlement: options.captureReviewableSettlement ?? null,
    state: {
      acknowledgeReview: jest.fn(),
      attention: null,
      currentConversationId: options.conversation?.id ?? null,
      hasPendingConversationSave: false,
      isRewinding: false,
      isStreaming: false,
      isSwitchingConversation: false,
      messages: [],
      markReviewRequired: jest.fn(),
      requiresAction: false,
    },
    controllers: {
      conversationController: {
        initializeWelcome: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
        switchTo: jest.fn().mockImplementation(async (conversationId: string) => {
          tab.conversationId = conversationId;
          tab.state.currentConversationId = conversationId;
        }),
      },
      inputController: {
        resumeQueuedTurnAfterIntentAdmission: jest.fn(),
      },
    },
    dom: {
      contentEl: createMockEl(),
      messagesEl: createMockEl(),
    },
    ui: {
      externalContextSelector: {
        getExternalContexts: jest.fn().mockReturnValue([]),
      },
    },
  };
  mockTabs.push(tab);
  return tab;
}

jest.mock('@/features/chat/tabs/TabLifecycle', () => ({
  activateTab: jest.fn(),
  deactivateTab: jest.fn(),
  drainTabForShutdownSnapshot: (...args: unknown[]) => mockDrainTabForShutdownSnapshot(...args),
  destroyTab: (...args: unknown[]) => mockDestroyTab(...args),
  getTabTitle: jest.fn().mockReturnValue('Tab'),
}));

jest.mock('@/features/chat/tabs/TabProviderState', () => ({
  onProviderAvailabilityChanged: jest.fn().mockReturnValue(false),
  refreshTabWorkspaceServices: jest.fn(),
}));

jest.mock('@/features/chat/tabs/TabRuntimeFactory', () => ({
  createTabRuntime: (options: Record<string, any>) => mockCreateTabRuntime(options),
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

function expectTabMetadataReleased(manager: TabManager, tabId: string): void {
  const internals = manager as any;
  expect(internals.providerRuntimeCommandWarmups.has(tabId)).toBe(false);
  expect(internals.providerRuntimeCommandCache.has(tabId)).toBe(false);
  expect(internals.providerCommandDiscoveryStores.has(tabId)).toBe(false);
  expect(internals.tabCommandContextRevisions.has(tabId)).toBe(false);
  expect(internals.tabActivationRevisions.has(tabId)).toBe(false);
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, reject, resolve };
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
    expect(options).not.toHaveProperty('defaultProviderId');
  });

  it('does not inherit the active tab provider when creating another blank tab', async () => {
    const { manager } = createManager();
    const active = await manager.createTab();
    active!.providerId = 'codex';

    await manager.createTab();

    expect(mockCreateTab.mock.calls[1]?.[0]).not.toHaveProperty('defaultProviderId');
  });

  it('acknowledges review attention when a tab becomes active', async () => {
    const { manager } = createManager();
    await manager.createTab();
    const target = await manager.createTab(null, undefined, { activate: false });

    await manager.switchToTab(target!.id);

    expect(target!.state.acknowledgeReview).toHaveBeenCalledTimes(1);
  });

  it('preserves the attention kind in tab bar items', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab();
    Object.defineProperty(tab!.state, 'attention', {
      configurable: true,
      value: { kind: 'review', since: 123 },
    });

    expect(manager.getTabBarItems()).toEqual([
      expect.objectContaining({
        attention: { kind: 'review', since: 123 },
        id: tab!.id,
      }),
    ]);
  });

  it('waits for prior tab switching to settle', async () => {
    const { manager } = createManager();
    const initial = await manager.createTab();
    const managerInternals = manager as any;
    managerInternals.isSwitchingTab = true;

    const switchingIdle = managerInternals.waitForTabSwitchIdle();
    await Promise.resolve();

    expect(manager.getActiveTabId()).toBe(initial!.id);

    managerInternals.isSwitchingTab = false;
    managerInternals.resolveTabSwitchIdleWaitersIfIdle();

    await expect(switchingIdle).resolves.toBeUndefined();
    expect(manager.getActiveTabId()).toBe(initial!.id);
  });

  it('settles queued tab switches when shutdown begins during hydration', async () => {
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const initial = await manager.createTab();
    const hydrating = await manager.createTab('hydrating-conversation', 'hydrating-tab', {
      activate: false,
    });
    const hydration = deferred<void>();
    hydrating!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise);

    const activeSwitch = manager.switchToTab(hydrating!.id);
    for (let attempt = 0;
      attempt < 10
        && (hydrating!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const queuedSwitch = manager.switchToTab(initial!.id);
    manager.beginShutdown();
    const drain = manager.drainForShutdownSnapshot();

    hydration.resolve(undefined);
    await expect(Promise.all([activeSwitch, queuedSwitch, drain])).resolves.toBeDefined();

    manager.sealShutdownSnapshot();
    await manager.destroy();
  });

  it('joins active and queued tab switches during direct destruction', async () => {
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const initial = await manager.createTab();
    const hydrating = await manager.createTab('hydrating-conversation', 'hydrating-tab', {
      activate: false,
    });
    const hydration = deferred<void>();
    hydrating!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise);

    const activeSwitch = manager.switchToTab(hydrating!.id);
    for (let attempt = 0;
      attempt < 10
        && (hydrating!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const queuedSwitch = manager.switchToTab(initial!.id);
    const destruction = manager.destroy();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }

    expect(mockDestroyTab).not.toHaveBeenCalled();

    hydration.resolve(undefined);
    await expect(Promise.all([activeSwitch, queuedSwitch, destruction])).resolves.toBeDefined();
    expect(mockDestroyTab).toHaveBeenCalledTimes(2);
  });

  it('marks only inactive tabs when a reviewable turn settles', async () => {
    const { manager } = createManager();
    const active = await manager.createTab();
    const background = await manager.createTab(null, undefined, { activate: false });
    const activeSettlement = mockCreateTab.mock.calls[0]?.[0].captureReviewableSettlement;
    const backgroundSettlement = mockCreateTab.mock.calls[1]?.[0].captureReviewableSettlement;

    activeSettlement()();
    backgroundSettlement()();

    expect(active!.state.markReviewRequired).not.toHaveBeenCalled();
    expect(background!.state.markReviewRequired).toHaveBeenCalledTimes(1);
  });

  it('uses activity at completion and invalidates review after activation', async () => {
    const { manager } = createManager();
    const active = await manager.createTab();
    const background = await manager.createTab(null, undefined, { activate: false });
    const activeSettlement = mockCreateTab.mock.calls[0]?.[0].captureReviewableSettlement;
    const backgroundSettlement = mockCreateTab.mock.calls[1]?.[0].captureReviewableSettlement;
    const reportActiveCompletion = activeSettlement();
    const reportBackgroundCompletion = backgroundSettlement();

    await manager.switchToTab(background!.id);
    await manager.switchToTab(active!.id);
    reportActiveCompletion();
    reportBackgroundCompletion();

    expect(active!.state.markReviewRequired).not.toHaveBeenCalled();
    expect(background!.state.markReviewRequired).not.toHaveBeenCalled();
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

  it('keeps the latest provisional selection during overlapping preview hydration', async () => {
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
    const firstHydration = deferred<void>();
    const switchedConversationIds: string[] = [];
    let isSwitching = false;
    const switchTo = preview.controllers.conversationController!.switchTo as jest.Mock;
    switchTo.mockImplementation(
      async (conversationId: string) => {
        if (isSwitching) return;
        isSwitching = true;
        switchedConversationIds.push(conversationId);
        try {
          if (conversationId === 'conversation-2') {
            await firstHydration.promise;
          }
        } finally {
          isSwitching = false;
        }
      },
    );

    const firstSelection = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0;
      attempt < 20 && switchedConversationIds.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(switchedConversationIds).toEqual(['conversation-2']);
    const supersededSelection = manager.openConversation('conversation-3', {
      preferNewTab: true,
      provisional: true,
    });
    const latestSelection = manager.openConversation('conversation-4', {
      preferNewTab: true,
      provisional: true,
    });

    firstHydration.resolve(undefined);
    await Promise.all([firstSelection, supersededSelection, latestSelection]);

    expect(switchedConversationIds).toEqual(['conversation-2', 'conversation-4']);
    expect(preview.lifecycleState).toBe('provisional');
  });

  it('does not demote a preview retained while its conversation switch is pending', async () => {
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
    const hydration = deferred<void>();
    const switchTo = preview.controllers.conversationController.switchTo as jest.Mock;
    switchTo.mockImplementationOnce(async (conversationId: string) => {
      await hydration.promise;
      preview.conversationId = conversationId;
    });

    const navigation = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0; attempt < 10 && switchTo.mock.calls.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    preview.session.claimUserOwnership();
    preview.lifecycleState = 'cold';
    hydration.resolve(undefined);
    await navigation;

    expect(preview.lifecycleState).toBe('cold');
  });

  it('keeps a stale provisional target that the user retained during initial hydration', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    await manager.createTab();
    const hydration = deferred<void>();
    mockCreateTabRuntime.mockImplementationOnce(async (options) => {
      const target = createMockTab(options);
      target.controllers.conversationController.switchTo = jest.fn(async () => {
        await hydration.promise;
      });
      return target;
    });

    const staleNavigation = manager.openConversation('conversation-1', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0; attempt < 20 && mockTabs.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    const retainedTarget = mockTabs[1];
    for (let attempt = 0;
      attempt < 20
        && retainedTarget.controllers.conversationController.switchTo.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const latestNavigation = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    retainedTarget.session.claimUserOwnership();
    retainedTarget.lifecycleState = 'cold';
    hydration.resolve(undefined);
    await Promise.all([staleNavigation, latestNavigation]);

    expect(manager.getAllTabs()).toContain(retainedTarget);
    expect(retainedTarget.lifecycleState).toBe('cold');
    expect(mockDestroyTab).not.toHaveBeenCalledWith(retainedTarget);
    expect(manager.getActiveTab()?.conversationId).toBe('conversation-2');
  });

  it('lets an immediate retained-tab selection supersede an in-flight preview', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const retained = await manager.createTab('retained-conversation');
    await manager.openConversation('conversation-1', {
      preferNewTab: true,
      provisional: true,
    });
    const preview = manager.getActiveTab()!;
    const firstHydration = deferred<void>();
    const switchTo = preview.controllers.conversationController!.switchTo as jest.Mock;
    switchTo.mockImplementation(async () => firstHydration.promise);
    switchTo.mockClear();

    const previewSelection = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0; attempt < 20 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(switchTo).toHaveBeenCalledWith('conversation-2');

    const retainedSelection = manager.openConversation('retained-conversation');
    firstHydration.resolve(undefined);
    await Promise.all([previewSelection, retainedSelection]);

    expect(manager.getActiveTab()).toBe(retained);
  });

  it('drains and invalidates preview navigation before provisional cleanup', async () => {
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
    const firstHydration = deferred<void>();
    const switchTo = preview.controllers.conversationController!.switchTo as jest.Mock;
    switchTo.mockImplementation(async () => firstHydration.promise);
    switchTo.mockClear();

    const previewSelection = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0; attempt < 20 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const cleanup = manager.discardProvisionalTabs();
    const ignoredLateSelection = manager.openConversation('conversation-3', {
      preferNewTab: true,
      provisional: true,
    });

    firstHydration.resolve(undefined);
    await Promise.all([previewSelection, ignoredLateSelection, cleanup]);

    expect(manager.getAllTabs().every(tab => tab.lifecycleState !== 'provisional'))
      .toBe(true);
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it('prevents queued preview navigation from creating tabs after destroy', async () => {
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
    const firstHydration = deferred<void>();
    const switchTo = preview.controllers.conversationController!.switchTo as jest.Mock;
    switchTo.mockImplementation(async () => firstHydration.promise);
    switchTo.mockClear();

    const firstSelection = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0; attempt < 20 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const queuedSelection = manager.openConversation('conversation-3', {
      preferNewTab: true,
      provisional: true,
    });
    const destruction = manager.destroy();

    firstHydration.resolve(undefined);
    await Promise.all([firstSelection, queuedSelection, destruction]);

    expect(manager.getAllTabs()).toHaveLength(0);
    expect(mockCreateTab).toHaveBeenCalledTimes(1);
  });

  it('rolls back a tab assembly that finishes after manager destruction', async () => {
    const assembly = deferred<any>();
    const onTabCreated = jest.fn();
    mockCreateTabRuntime.mockImplementationOnce(async () => assembly.promise);
    const { manager } = createManager(createPlugin(), { onTabCreated });

    const creation = manager.createTab(null, 'late-tab');
    await manager.destroy();
    const factoryOptions = mockCreateTabRuntime.mock.calls[0]?.[0];
    const lateTab = createMockTab(factoryOptions);
    assembly.resolve(lateTab);

    await expect(creation).resolves.toBeNull();
    expect(mockDestroyTab).toHaveBeenCalledWith(lateTab);
    expect(onTabCreated).not.toHaveBeenCalled();
    expect(manager.getAllTabs()).toEqual([]);
    expect(manager.canCreateTab()).toBe(false);
    expectTabMetadataReleased(manager, lateTab.id);

    mockCreateTabRuntime.mockClear();
    await expect(manager.createTab()).resolves.toBeNull();
    expect(mockCreateTabRuntime).not.toHaveBeenCalled();
  });

  it('rejects a duplicate explicit tab ID without disturbing its reserved runtime', async () => {
    const assembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => assembly.promise);
    const { manager } = createManager();

    const firstCreation = manager.createTab(null, 'restored-tab');
    await Promise.resolve();
    await expect(manager.createTab(null, 'restored-tab'))
      .rejects.toThrow('restored-tab');
    const firstOptions = mockCreateTabRuntime.mock.calls[0]?.[0];
    const firstRuntime = createMockTab(firstOptions);
    assembly.resolve(firstRuntime);
    await expect(firstCreation).resolves.toBe(firstRuntime);

    expect(manager.getAllTabs()).toEqual([firstRuntime]);
    expect(manager.getActiveTab()).toBe(firstRuntime);
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(1);
    expect(mockDestroyTab).not.toHaveBeenCalled();
  });

  it('rolls back an admitted tab when its creation callback fails', async () => {
    const callbackError = new Error('Failed to render created tab');
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), {
      onTabClosed,
      onTabCreated: jest.fn(() => {
        throw callbackError;
      }),
    });

    await expect(manager.createTab(null, 'failed-tab')).rejects.toBe(callbackError);

    expect(manager.getAllTabs()).toEqual([]);
    expect(manager.getActiveTab()).toBeNull();
    expect(mockDestroyTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'failed-tab' }));
    expect(onTabClosed).toHaveBeenCalledWith('failed-tab');
    expectTabMetadataReleased(manager, 'failed-tab');
  });

  it('restores the previous active tab when activation fails after admission', async () => {
    const callbackError = new Error('Failed to render active tab');
    let rejectActivation = false;
    const onActiveTabChanged = jest.fn((_previousId: string | null, nextId: string) => {
      if (rejectActivation && nextId === 'failed-tab') throw callbackError;
    });
    const { manager } = createManager(createPlugin(), { onActiveTabChanged });
    const retained = await manager.createTab();
    rejectActivation = true;

    await expect(manager.createTab(null, 'failed-tab')).rejects.toBe(callbackError);

    expect(manager.getAllTabs()).toEqual([retained]);
    expect(manager.getActiveTab()).toBe(retained);
    expect(mockDestroyTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'failed-tab' }));
    expectTabMetadataReleased(manager, 'failed-tab');
  });

  it('reactivates the previous tab when deactivation fails during admission', async () => {
    const deactivationError = new Error('Failed to deactivate previous tab');
    const { activateTab, deactivateTab } = jest.requireMock(
      '@/features/chat/tabs/TabLifecycle',
    ) as {
      activateTab: jest.Mock;
      deactivateTab: jest.Mock;
    };
    const { manager } = createManager();
    const initial = await manager.createTab(null, 'initial-tab');
    activateTab.mockClear();
    deactivateTab.mockImplementationOnce(() => {
      throw deactivationError;
    });

    await expect(manager.createTab(null, 'failed-tab')).rejects.toBe(deactivationError);

    expect(manager.getAllTabs()).toEqual([initial]);
    expect(manager.getActiveTab()).toBe(initial);
    expect(activateTab).toHaveBeenCalledWith(initial);
    expect(mockDestroyTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'failed-tab' }));
  });

  it('attributes queued activation failure to the tab admission that requested it', async () => {
    const activationError = new Error('Failed queued tab activation');
    const onActiveTabChanged = jest.fn((_previousId: string | null, nextId: string) => {
      if (nextId === 'failed-tab') throw activationError;
    });
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), { onActiveTabChanged });
    await manager.createTab(null, 'initial-tab');
    const blocking = await manager.createTab('blocking-conversation', 'blocking-tab', {
      activate: false,
    });
    const hydration = deferred<void>();
    blocking!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise);

    const blockingSwitch = manager.switchToTab(blocking!.id);
    for (let attempt = 0;
      attempt < 10
        && (blocking!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const failedCreation = manager.createTab(null, 'failed-tab');
    const laterSwitch = manager.switchToTab('initial-tab');
    hydration.resolve(undefined);

    await expect(blockingSwitch).resolves.toBeUndefined();
    await expect(failedCreation).rejects.toBe(activationError);
    await expect(laterSwitch).resolves.toBeUndefined();
    expect(manager.getTab('failed-tab')).toBeNull();
    expect(mockDestroyTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'failed-tab' }));
    expect(manager.getActiveTab()?.id).toBe('initial-tab');
  });

  it('restores the actual switch predecessor when a later admission activation fails', async () => {
    const activationError = new Error('Failed queued tab activation');
    const onActiveTabChanged = jest.fn((_previousId: string | null, nextId: string) => {
      if (nextId === 'failed-tab') throw activationError;
    });
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), { onActiveTabChanged });
    const initial = await manager.createTab(null, 'initial-tab');
    const blocking = await manager.createTab('blocking-conversation', 'blocking-tab', {
      activate: false,
    });
    const hydration = deferred<void>();
    blocking!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise);

    const blockingSwitch = manager.switchToTab(blocking!.id);
    for (let attempt = 0;
      attempt < 10
        && (blocking!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const userSwitch = manager.switchToTab(initial!.id);
    const failedCreation = manager.createTab(null, 'failed-tab');
    hydration.resolve(undefined);

    await expect(blockingSwitch).resolves.toBeUndefined();
    await expect(userSwitch).resolves.toBeUndefined();
    await expect(failedCreation).rejects.toBe(activationError);

    expect(manager.getTab('failed-tab')).toBeNull();
    expect(manager.getActiveTab()).toBe(initial);
  });

  it('republishes the predecessor when a tab switch rolls back', async () => {
    const switchError = new Error('Failed to publish completed switch');
    const onActiveTabChanged = jest.fn();
    const onTabSwitched = jest.fn((_previousId: string | null, nextId: string) => {
      if (nextId === 'target-tab') throw switchError;
    });
    const { manager } = createManager(createPlugin(), {
      onActiveTabChanged,
      onTabSwitched,
    });
    const predecessor = await manager.createTab(null, 'predecessor-tab');
    const target = await manager.createTab(null, 'target-tab', { activate: false });
    onActiveTabChanged.mockClear();
    onTabSwitched.mockClear();

    await expect(manager.switchToTab(target!.id)).rejects.toBe(switchError);

    expect(manager.getActiveTab()).toBe(predecessor);
    expect(onActiveTabChanged.mock.calls).toEqual([
      ['predecessor-tab', 'target-tab'],
      ['target-tab', 'predecessor-tab'],
    ]);
  });

  it('fences overlapping closes before repeating manager side effects', async () => {
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabClosed });
    const retained = await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);

    const firstClose = manager.closeTab(closing!.id);
    const overlappingClose = manager.closeTab(closing!.id);

    for (let attempt = 0;
      attempt < 10
        && (closing!.controllers.conversationController.save as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(closing!.controllers.conversationController.save).toHaveBeenCalledTimes(1);
    save.resolve(undefined);
    await expect(Promise.all([firstClose, overlappingClose])).resolves.toEqual([true, false]);
    expect(mockDestroyTab).toHaveBeenCalledTimes(1);
    expect(onTabClosed).toHaveBeenCalledTimes(1);
    expect(onTabClosed).toHaveBeenCalledWith(closing!.id);
    expect(manager.getAllTabs()).toEqual([retained]);
  });

  it('keeps the active source live when successor activation fails during close', async () => {
    const activationError = new Error('Failed to activate close successor');
    let rejectSuccessorActivation = false;
    const onActiveTabChanged = jest.fn((_previousId: string | null, nextId: string) => {
      if (rejectSuccessorActivation && nextId === 'successor-tab') throw activationError;
    });
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), {
      onActiveTabChanged,
      onTabClosed,
    });
    const closing = await manager.createTab(null, 'closing-tab');
    const successor = await manager.createTab(null, 'successor-tab', { activate: false });
    rejectSuccessorActivation = true;
    onActiveTabChanged.mockClear();

    await expect(manager.closeTab(closing!.id)).rejects.toBe(activationError);

    expect(manager.getAllTabs()).toEqual([closing, successor]);
    expect(manager.getActiveTab()).toBe(closing);
    expect(closing!.lifecycleState).toBe('cold');
    expect(closing!.session.acceptsIntents).toBe(true);
    expect(mockDestroyTab).not.toHaveBeenCalledWith(closing);
    expect(onTabClosed).not.toHaveBeenCalled();
    expect(onActiveTabChanged.mock.calls).toEqual([
      ['closing-tab', 'successor-tab'],
      ['successor-tab', 'closing-tab'],
    ]);
  });

  it('claims the final tab before awaiting replacement assembly', async () => {
    const { manager } = createManager();
    const closing = await manager.createTab();
    const replacementAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => replacementAssembly.promise);

    const firstClose = manager.discardTab(closing!.id);
    const overlappingClose = manager.discardTab(closing!.id);
    const replacementOptions = mockCreateTabRuntime.mock.calls[1]?.[0];
    const replacement = createMockTab(replacementOptions);
    replacementAssembly.resolve(replacement);

    await expect(Promise.all([firstClose, overlappingClose]))
      .resolves.toEqual([true, false]);
    expect(manager.getAllTabs()).toEqual([replacement]);
    expect(mockDestroyTab).toHaveBeenCalledTimes(1);
    expect(mockDestroyTab).toHaveBeenCalledWith(closing);
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(2);
  });

  it('installs one live replacement when different tabs close concurrently', async () => {
    const { manager } = createManager();
    const first = await manager.createTab();
    const second = await manager.createTab();
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    first!.controllers.conversationController.save = jest.fn(() => firstSave.promise);
    second!.controllers.conversationController.save = jest.fn(() => secondSave.promise);

    const firstClose = manager.closeTab(first!.id);
    const secondClose = manager.closeTab(second!.id);

    secondSave.resolve(undefined);
    await expect(secondClose).resolves.toBe(true);
    firstSave.resolve(undefined);
    await expect(firstClose).resolves.toBe(true);

    const liveTabs = manager.getAllTabs().filter(tab => tab.lifecycleState !== 'closing');
    expect(liveTabs).toHaveLength(1);
    expect(manager.getActiveTab()).toBe(liveTabs[0]);
    expect(liveTabs[0].conversationId).toBeNull();
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(3);
  });

  it('retains one original when concurrent-close replacement assembly fails', async () => {
    const replacementError = new Error('Replacement assembly failed');
    const { manager } = createManager();
    const first = await manager.createTab();
    const second = await manager.createTab();
    const firstSave = deferred<void>();
    first!.controllers.conversationController.save = jest.fn(() => firstSave.promise);
    mockCreateTabRuntime.mockRejectedValueOnce(replacementError);

    const firstClose = manager.closeTab(first!.id);
    const secondClose = manager.closeTab(second!.id);

    await expect(secondClose).rejects.toBe(replacementError);
    firstSave.resolve(undefined);
    await expect(firstClose).resolves.toBe(true);

    expect(manager.getAllTabs()).toEqual([second]);
    expect(manager.getActiveTab()).toBe(second);
    expect(second!.lifecycleState).toBe('cold');
    expect(mockDestroyTab).not.toHaveBeenCalledWith(second);
  });

  it('discards a compensating last blank tab and installs a fresh draft', async () => {
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabClosed });
    const staleDraft = await manager.createTab();

    await expect(manager.closeTab(staleDraft!.id, true)).resolves.toBe(false);
    await expect(manager.discardTab(staleDraft!.id)).resolves.toBe(true);

    const replacement = manager.getActiveTab();
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(staleDraft);
    expect(replacement?.conversationId).toBeNull();
    expect(mockDestroyTab).toHaveBeenCalledWith(staleDraft);
    expect(onTabClosed).toHaveBeenCalledWith(staleDraft!.id);
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(2);
  });

  it('keeps the final tab live when replacement assembly fails', async () => {
    const replacementError = new Error('Replacement assembly failed');
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabClosed });
    const retainedDraft = await manager.createTab();
    mockCreateTabRuntime.mockRejectedValueOnce(replacementError);

    await expect(manager.discardTab(retainedDraft!.id)).rejects.toBe(replacementError);

    expect(manager.getAllTabs()).toEqual([retainedDraft]);
    expect(manager.getActiveTab()).toBe(retainedDraft);
    expect(retainedDraft!.lifecycleState).toBe('cold');
    expect(mockDestroyTab).not.toHaveBeenCalled();
    expect(onTabClosed).not.toHaveBeenCalled();
  });

  it('keeps runtime state callbacks live until final-tab replacement is admitted', async () => {
    const replacementError = new Error('Replacement assembly failed');
    const replacementAssembly = deferred<any>();
    const onTabConversationChanged = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabConversationChanged });
    const retainedDraft = await manager.createTab();
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;
    const internals = manager as any;
    const initialCommandRevision = internals.tabCommandContextRevisions.get(retainedDraft!.id);
    internals.providerRuntimeCommandCache.set(retainedDraft!.id, { stale: true });
    mockCreateTabRuntime.mockImplementationOnce(() => replacementAssembly.promise);

    const close = manager.discardTab(retainedDraft!.id);
    expect(retainedDraft!.session.acceptsIntents).toBe(false);
    retainedDraft!.state.currentConversationId = 'conversation-created-during-close';
    conversationChanged(retainedDraft, 'conversation-created-during-close');
    replacementAssembly.reject(replacementError);

    await expect(close).rejects.toBe(replacementError);
    expect(retainedDraft!.conversationId).toBe('conversation-created-during-close');
    expect(onTabConversationChanged).toHaveBeenCalledWith(
      retainedDraft!.id,
      'conversation-created-during-close',
    );
    expect(internals.tabCommandContextRevisions.get(retainedDraft!.id))
      .toBe(initialCommandRevision + 1);
    expect(internals.providerRuntimeCommandCache.has(retainedDraft!.id)).toBe(false);
    expect(manager.getAllTabs()).toEqual([retainedDraft]);
    expect(retainedDraft!.session.acceptsIntents).toBe(true);
    expect(retainedDraft!.controllers.inputController.resumeQueuedTurnAfterIntentAdmission)
      .toHaveBeenCalledTimes(1);
  });

  it('does not emit close callbacks after manager destruction begins', async () => {
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabClosed });
    await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);

    const close = manager.closeTab(closing!.id);
    const destruction = manager.destroy();
    await Promise.resolve();
    save.resolve(undefined);
    await expect(Promise.all([close, destruction])).resolves.toEqual([true, undefined]);

    expect(onTabClosed).not.toHaveBeenCalled();
    expect(manager.getAllTabs()).toEqual([]);
  });

  it('releases membership and metadata when tab teardown fails during close', async () => {
    const teardownError = new Error('Failed to tear down tab');
    const onTabClosed = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabClosed });
    const retained = await manager.createTab();
    const closing = await manager.createTab();
    mockDestroyTab.mockRejectedValueOnce(teardownError);

    await expect(manager.closeTab(closing!.id)).rejects.toBe(teardownError);

    expect(manager.getAllTabs()).toEqual([retained]);
    expect(manager.getActiveTab()).toBe(retained);
    expect(onTabClosed).toHaveBeenCalledWith(closing!.id);
    expectTabMetadataReleased(manager, closing!.id);
  });

  it('does not recreate discovery metadata after tab closure begins', async () => {
    const { manager } = createManager();
    const retained = await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);
    const catalogResolver = mockCreateTabRuntime.mock.calls[1]?.[0]
      .getProviderCatalogConfig as (tab: any) => unknown;
    const commandContextChanged = mockCreateTabRuntime.mock.calls[1]?.[0]
      .onCommandContextChanged as (tab: any) => void;

    const close = manager.closeTab(closing!.id);

    for (let attempt = 0;
      attempt < 10 && closing!.lifecycleState !== 'closing';
      attempt += 1) {
      await Promise.resolve();
    }
    expect(closing!.lifecycleState).toBe('closing');
    commandContextChanged(closing);
    expect(catalogResolver(closing)).toBeNull();
    expectTabMetadataReleased(manager, closing!.id);

    save.resolve(undefined);
    await expect(close).resolves.toBe(true);
    expect(manager.getAllTabs()).toEqual([retained]);
    expectTabMetadataReleased(manager, closing!.id);
  });

  it('fences retained state callbacks after tab closure begins', async () => {
    const callbacks = {
      onTabAttentionChanged: jest.fn(),
      onTabConversationChanged: jest.fn(),
      onTabRewindingChanged: jest.fn(),
      onTabStreamingChanged: jest.fn(),
    };
    const { manager } = createManager(createPlugin(), callbacks);
    await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);
    (closing as any).session.executionCoordinator = closing!.executionCoordinator;
    const factoryOptions = mockCreateTabRuntime.mock.calls[1]?.[0];
    (closing!.executionCoordinator.notifyMayCool as jest.Mock).mockClear();

    const close = manager.closeTab(closing!.id);
    for (let attempt = 0;
      attempt < 10 && closing!.lifecycleState !== 'closing';
      attempt += 1) {
      await Promise.resolve();
    }
    factoryOptions.onStreamingChanged(closing, false);
    factoryOptions.onRewindingChanged(closing, false);
    factoryOptions.onAttentionChanged(closing, { kind: 'action-required' });
    factoryOptions.onConversationIdChanged(closing, 'late-conversation');

    expect(callbacks.onTabStreamingChanged).not.toHaveBeenCalled();
    expect(callbacks.onTabRewindingChanged).not.toHaveBeenCalled();
    expect(callbacks.onTabAttentionChanged).not.toHaveBeenCalled();
    expect(callbacks.onTabConversationChanged).not.toHaveBeenCalled();
    expect(closing!.executionCoordinator.notifyMayCool).not.toHaveBeenCalled();
    expect(closing!.conversationId).toBeNull();
    expectTabMetadataReleased(manager, closing!.id);

    save.resolve(undefined);
    await expect(close).resolves.toBe(true);
  });

  it('accepts a terminal conversation binding until the shutdown snapshot is sealed', async () => {
    const onTabConversationChanged = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabConversationChanged });
    const tab = await manager.createTab();
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;

    manager.beginShutdown();
    conversationChanged(tab, 'conversation-created-during-close');

    expect(tab!.conversationId).toBe('conversation-created-during-close');
    expect(onTabConversationChanged).toHaveBeenCalledWith(
      tab!.id,
      'conversation-created-during-close',
    );

    manager.sealShutdownSnapshot();
    conversationChanged(tab, 'too-late');

    expect(tab!.conversationId).toBe('conversation-created-during-close');
    expect(onTabConversationChanged).toHaveBeenCalledTimes(1);
    await manager.destroy();
  });

  it('drains every admitted runtime before the shutdown snapshot is sealed', async () => {
    const { manager } = createManager();
    const first = await manager.createTab();
    const second = await manager.createTab();

    manager.beginShutdown();
    expect(first!.session.acceptsIntents).toBe(false);
    expect(second!.session.acceptsIntents).toBe(false);
    await manager.drainForShutdownSnapshot();

    expect(mockDrainTabForShutdownSnapshot).toHaveBeenCalledTimes(2);
    expect(mockDrainTabForShutdownSnapshot).toHaveBeenCalledWith(first);
    expect(mockDrainTabForShutdownSnapshot).toHaveBeenCalledWith(second);
    expect(first!.lifecycleState).toBe('cold');
    expect(second!.lifecycleState).toBe('cold');
    await manager.destroy();
  });

  it('drains in-flight conversation navigation before sealing shutdown state', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab();
    const switchConversation = deferred<void>();
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;
    tab!.controllers.conversationController.switchTo = jest.fn(async (conversationId: string) => {
      await switchConversation.promise;
      tab!.state.currentConversationId = conversationId;
      conversationChanged(tab, conversationId);
    });

    const navigation = manager.openConversation('conversation-during-shutdown');
    for (let attempt = 0;
      attempt < 10
        && (tab!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    manager.beginShutdown();
    let drainSettled = false;
    const drain = manager.drainForShutdownSnapshot().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();

    expect(drainSettled).toBe(false);
    switchConversation.resolve(undefined);
    await Promise.all([navigation, drain]);

    expect(tab!.conversationId).toBe('conversation-during-shutdown');
    manager.sealShutdownSnapshot();
    await manager.destroy();
  });

  it('joins an admitted close before choosing the shutdown snapshot owner', async () => {
    const { manager } = createManager();
    const retained = await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);

    const close = manager.closeTab(closing!.id);
    manager.beginShutdown();
    let drainSettled = false;
    const drain = manager.drainForShutdownSnapshot().then(() => {
      drainSettled = true;
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }

    expect(drainSettled).toBe(false);
    expect(manager.getActiveTab()).toBe(retained);

    save.resolve(undefined);
    await Promise.all([close, drain]);

    expect(manager.getActiveTab()).toBe(retained);
    expect(manager.getAllTabs()).toEqual([retained]);
    manager.sealShutdownSnapshot();
    await manager.destroy();
  });

  it('does not recreate discovery metadata through callbacks retained after destroy', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab();
    const catalogResolver = mockCreateTabRuntime.mock.calls[0]?.[0]
      .getProviderCatalogConfig as (tab: any) => unknown;
    const commandContextChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onCommandContextChanged as (tab: any) => void;

    await manager.destroy();

    commandContextChanged(tab);
    expect(catalogResolver(tab)).toBeNull();
    expectTabMetadataReleased(manager, tab!.id);
  });

  it('does not start command discovery after its tab begins closing', async () => {
    const { manager } = createManager();
    await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);

    const discovery = manager.getSdkCommands(closing!.id);
    const close = manager.closeTab(closing!.id);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.resolve();
    }

    expect(commandLoader.loadCommands).not.toHaveBeenCalled();
    expectTabMetadataReleased(manager, closing!.id);

    save.resolve(undefined);
    await expect(discovery).resolves.toEqual([]);
    await expect(close).resolves.toBe(true);
    expectTabMetadataReleased(manager, closing!.id);
  });

  it('disposes every tab and releases manager state when one teardown fails', async () => {
    const teardownError = new Error('Failed to tear down first tab');
    const { manager } = createManager();
    const first = await manager.createTab();
    const second = await manager.createTab();
    mockDestroyTab.mockImplementation(async (tab) => {
      if (tab === first) throw teardownError;
    });

    const firstDestruction = manager.destroy();
    const overlappingDestruction = manager.destroy();
    const [firstError, overlappingError] = await Promise.all([
      firstDestruction.catch(error => error),
      overlappingDestruction.catch(error => error),
    ]);

    expect(firstError).toBe(teardownError);
    expect(overlappingError).toBe(teardownError);
    await expect(manager.destroy()).rejects.toBe(teardownError);

    expect(mockDestroyTab).toHaveBeenCalledWith(first);
    expect(mockDestroyTab).toHaveBeenCalledWith(second);
    expect(mockDestroyTab).toHaveBeenCalledTimes(2);
    expect(manager.getAllTabs()).toEqual([]);
    expect(manager.getActiveTab()).toBeNull();
    expectTabMetadataReleased(manager, first!.id);
    expectTabMetadataReleased(manager, second!.id);
  });

  it('finishes mandatory teardown when concurrent provisional cleanup fails', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const retained = await manager.createTab('retained-conversation');
    await manager.openConversation('preview-conversation', {
      preferNewTab: true,
      provisional: true,
    });
    const preview = manager.getActiveTab()!;
    const saveFailure = deferred<void>();
    preview.controllers.conversationController!.save = jest.fn(
      async () => saveFailure.promise,
    );

    const cleanupResult = manager.discardProvisionalTabs().then(
      () => null,
      error => error,
    );
    for (let attempt = 0;
      attempt < 20
        && (preview.controllers.conversationController!.save as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const destructionResult = manager.destroy().then(
      () => null,
      error => error,
    );

    saveFailure.reject(new Error('Failed to save preview'));
    const [cleanupError, destructionError] = await Promise.all([
      cleanupResult,
      destructionResult,
    ]);

    expect(cleanupError).toEqual(new Error('Failed to save preview'));
    expect(destructionError).toEqual(new Error('Failed to save preview'));
    expect(mockDestroyTab).toHaveBeenCalledWith(preview);
    expect(mockDestroyTab).toHaveBeenCalledWith(retained);
    expect(manager.getAllTabs()).toHaveLength(0);
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

  it('rejects command context loaded for a conversation rebound during lookup', async () => {
    const firstLookup = deferred<any>();
    const conversationB = {
      id: 'conversation-b',
      messages: [],
      providerId: 'claude',
    };
    const getConversationById = jest.fn()
      .mockImplementationOnce(() => firstLookup.promise)
      .mockResolvedValue(conversationB);
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
      getConversationById,
    }));
    const tab = await manager.createTab('conversation-a');
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;

    const staleDiscovery = manager.getSdkCommands(tab!.id);
    for (let attempt = 0;
      attempt < 10 && getConversationById.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    conversationChanged(tab, 'conversation-b');
    firstLookup.resolve({
      id: 'conversation-a',
      messages: [{ role: 'user', content: 'A' }],
      providerId: 'claude',
    });

    await expect(staleDiscovery).resolves.toEqual([]);
    expect(commandLoader.loadCommands).not.toHaveBeenCalled();

    await expect(manager.getSdkCommands(tab!.id)).resolves.toHaveLength(1);
    expect(commandLoader.loadCommands).toHaveBeenCalledWith(expect.objectContaining({
      conversation: conversationB,
    }));
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
    const tab = await manager.createTab();
    warmupPolicy.resolveMode.mockReturnValue('execution');

    manager.primeProviderExecution();
    await Promise.resolve();
    await Promise.resolve();

    expect(tab!.executionCoordinator.prepare).not.toHaveBeenCalled();
  });

  it('copies the accepted input ledger when forking', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn().mockReturnValue({
        id: 'source-conversation',
        providerId: 'claude',
      }),
    }));
    const source = await manager.createTab('source-conversation');

    await manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'source-conversation',
      sourceSessionId: 'native-session',
    });

    expect((source!.executionCoordinator!.copyInputsForFork as jest.Mock)).toHaveBeenCalledWith(
      'source-conversation',
      'forked',
      'assistant-checkpoint',
    );
    expect(plugin.updateConversation).toHaveBeenCalledWith(
      'forked',
      expect.objectContaining({ providerState: { fork: true } }),
    );
  });

  it('aborts a fork when its source runtime rebinds during provider-state creation', async () => {
    const forkState = deferred<Record<string, unknown>>();
    const buildForkProviderState = jest.fn(() => forkState.promise);
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({
      buildForkProviderState,
    });
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const source = await manager.createTab('conversation-a');
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;

    const fork = manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'conversation-a',
      sourceSessionId: 'native-session',
    }, source);
    for (let attempt = 0; attempt < 10 && buildForkProviderState.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    conversationChanged(source, 'conversation-b');
    forkState.resolve({ fork: true });

    await expect(fork).resolves.toBeNull();
    expect(source!.executionCoordinator.copyInputsForFork).not.toHaveBeenCalled();
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('revalidates the fork lease before starting target-side effects', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const source = await manager.createTab('conversation-a');
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;
    source!.executionCoordinator.copyInputsForFork = jest.fn().mockImplementationOnce(() => ({
      then: (resolve: (value?: void) => void) => {
        resolve();
        queueMicrotask(() => conversationChanged(source, 'conversation-b'));
      },
    }));

    await expect(manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'conversation-a',
      sourceSessionId: 'native-session',
    }, source)).resolves.toBeNull();

    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(1);
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('aborts a fork when its source rebinds while choosing the fork target', async () => {
    const target = deferred<'current-tab'>();
    mockChooseForkTarget.mockReturnValueOnce(target.promise);
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), {
      shouldForkToNewTab: () => false,
    });
    const source = await manager.createTab('conversation-a');
    (source!.controllers.conversationController.switchTo as jest.Mock).mockClear();
    const factoryOptions = mockCreateTabRuntime.mock.calls[0]?.[0];

    const fork = factoryOptions.forkRequestCallback({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'conversation-a',
      sourceSessionId: 'native-session',
    });
    for (let attempt = 0; attempt < 10 && mockChooseForkTarget.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    factoryOptions.onConversationIdChanged(source, 'conversation-b');
    target.resolve('current-tab');
    await fork;

    expect(plugin.createConversation).not.toHaveBeenCalled();
    expect(source!.executionCoordinator.copyInputsForFork).not.toHaveBeenCalled();
    expect(source!.controllers.conversationController.switchTo).not.toHaveBeenCalled();
  });

  it('forks into a new runtime tab without prompting in dual mode', async () => {
    const { manager } = createManager(createPlugin(), {
      shouldForkToNewTab: () => true,
    });
    await manager.createTab();
    const forkRequest = mockCreateTabRuntime.mock.calls[0]?.[0].forkRequestCallback;

    await forkRequest({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    });

    expect(mockChooseForkTarget).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(manager.getTabCount()).toBe(2);
  });

  it('deletes a fork conversation when post-admission setup rolls its tab back', async () => {
    const callbackError = new Error('Failed to render fork tab');
    let rejectForkTab = false;
    const onTabCreated = jest.fn(() => {
      if (rejectForkTab) throw callbackError;
    });
    const { manager, plugin } = createManager(createPlugin(), { onTabCreated });
    const source = await manager.createTab();
    rejectForkTab = true;

    await expect(manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    }, source)).rejects.toBe(callbackError);

    expect(manager.getAllTabs()).toEqual([source]);
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });

  it('ignores owner intents retained by a tab after it begins closing', async () => {
    const { manager, plugin } = createManager(createPlugin(), {
      shouldForkToNewTab: () => true,
    });
    await manager.createTab();
    const source = await manager.createTab();
    const save = deferred<void>();
    source!.controllers.conversationController.save = jest.fn(() => save.promise);
    (source!.controllers.conversationController.switchTo as jest.Mock).mockClear();
    const factoryOptions = mockCreateTabRuntime.mock.calls[1]?.[0];

    const close = manager.closeTab(source!.id);
    await factoryOptions.forkRequestCallback({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    });
    await factoryOptions.openConversation('stale-conversation');

    expect(plugin.createConversation).not.toHaveBeenCalled();
    expect(source!.controllers.conversationController.switchTo).not.toHaveBeenCalled();
    save.resolve(undefined);
    await expect(close).resolves.toBe(true);
  });

  it('keeps a queued open-conversation intent bound to its source runtime', async () => {
    const { manager } = createManager();
    const retained = await manager.createTab();
    const source = await manager.createTab();
    const firstSwitch = deferred<void>();
    (retained!.controllers.conversationController.switchTo as jest.Mock).mockClear();
    (source!.controllers.conversationController.switchTo as jest.Mock)
      .mockImplementationOnce(() => firstSwitch.promise);
    const openFromSource = mockCreateTabRuntime.mock.calls[1]?.[0]
      .openConversation as (conversationId: string) => Promise<void>;

    const blockingNavigation = manager.openConversation('blocking-conversation');
    for (let attempt = 0;
      attempt < 10
        && (source!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const queuedNavigation = openFromSource('stale-conversation');
    await manager.closeTab(source!.id);
    firstSwitch.resolve(undefined);
    await Promise.all([blockingNavigation, queuedNavigation]);

    expect(retained!.controllers.conversationController.switchTo).not.toHaveBeenCalled();
    expect(manager.getAllTabs()).toEqual([retained]);
  });

  it('ignores a matching local tab after that target begins closing', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const closingTarget = await manager.createTab('conversation-1');
    const source = await manager.createTab();
    const save = deferred<void>();
    closingTarget!.controllers.conversationController.save = jest.fn(() => save.promise);
    const close = manager.closeTab(closingTarget!.id);

    await manager.openConversation('conversation-1');

    expect(source!.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('conversation-1');
    save.resolve(undefined);
    await close;
  });

  it('falls back locally when a matching tab closes during its awaited switch', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const source = await manager.createTab();
    const target = await manager.createTab('conversation-1', undefined, { activate: false });
    const hydration = deferred<void>();
    target!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise);

    const navigation = manager.openConversation('conversation-1');
    for (let attempt = 0;
      attempt < 10
        && (target!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(target!.id);
    hydration.resolve(undefined);
    await navigation;

    expect(source!.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('conversation-1');
  });

  it('uses a live replacement when the active tab is already closing', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const closing = await manager.createTab('conversation-1');
    (closing!.controllers.conversationController.switchTo as jest.Mock).mockClear();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);

    const close = manager.closeTab(closing!.id);
    for (let attempt = 0;
      attempt < 10 && manager.getAllTabs().length < 2;
      attempt += 1) {
      await Promise.resolve();
    }
    const replacement = manager.getAllTabs().find(tab => tab !== closing)!;
    await manager.openConversation('conversation-2');

    expect(closing!.controllers.conversationController.switchTo).not.toHaveBeenCalled();
    expect(replacement.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('conversation-2');
    save.resolve(undefined);
    await close;
  });

  it('does not switch another view after a source-owned reveal loses its runtime', async () => {
    const reveal = deferred<void>();
    const revealLeaf = jest.fn(() => reveal.promise);
    const switchToTab = jest.fn().mockResolvedValue(undefined);
    const otherView = {
      leaf: {},
      getTabManager: jest.fn().mockReturnValue({ switchToTab }),
    };
    const { manager } = createManager(createPlugin({
      app: {
        vault: { adapter: { basePath: '/vault' } },
        workspace: { revealLeaf },
      },
      findConversationAcrossViews: jest.fn().mockReturnValue({
        tabId: 'other-tab',
        view: otherView,
      }),
    }));
    const retained = await manager.createTab();
    const source = await manager.createTab();
    const openFromSource = mockCreateTabRuntime.mock.calls[1]?.[0]
      .openConversation as (conversationId: string) => Promise<void>;

    const navigation = openFromSource('cross-view-conversation');
    for (let attempt = 0;
      attempt < 10 && revealLeaf.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(source!.id);
    reveal.resolve(undefined);
    await navigation;

    expect(switchToTab).not.toHaveBeenCalled();
    expect(manager.getAllTabs()).toEqual([retained]);
  });

  it('revalidates cross-view conversation ownership after revealing its target', async () => {
    const reveal = deferred<void>();
    const revealLeaf = jest.fn(() => reveal.promise);
    const switchToTab = jest.fn().mockResolvedValue(undefined);
    const targetTab = {
      conversationId: 'cross-view-conversation',
      lifecycleState: 'cold',
    };
    const otherManager = {
      canCreateTab: jest.fn().mockReturnValue(true),
      getTab: jest.fn().mockReturnValue(targetTab),
      switchToTab,
    };
    const otherView = {
      leaf: {},
      getTabManager: jest.fn().mockReturnValue(otherManager),
    };
    const { manager } = createManager(createPlugin({
      app: {
        vault: { adapter: { basePath: '/vault' } },
        workspace: { revealLeaf },
      },
      findConversationAcrossViews: jest.fn().mockReturnValue({
        tabId: 'other-tab',
        view: otherView,
      }),
    }));
    const source = await manager.createTab();
    const openFromSource = mockCreateTabRuntime.mock.calls[0]?.[0]
      .openConversation as (conversationId: string) => Promise<void>;

    const navigation = openFromSource('cross-view-conversation');
    for (let attempt = 0;
      attempt < 10 && revealLeaf.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    targetTab.lifecycleState = 'closing';
    reveal.resolve(undefined);
    await navigation;

    expect(switchToTab).not.toHaveBeenCalled();
    expect(source!.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('cross-view-conversation');
  });

  it('falls back locally when a cross-view target closes during its awaited switch', async () => {
    const targetSwitch = deferred<void>();
    const switchToTab = jest.fn(() => targetSwitch.promise);
    const targetTab = {
      conversationId: 'cross-view-conversation',
      lifecycleState: 'cold',
    };
    const otherManager = {
      canCreateTab: jest.fn().mockReturnValue(true),
      getTab: jest.fn().mockReturnValue(targetTab),
      switchToTab,
    };
    const otherView = {
      leaf: {},
      getTabManager: jest.fn().mockReturnValue(otherManager),
    };
    const { manager } = createManager(createPlugin({
      findConversationAcrossViews: jest.fn().mockReturnValue({
        tabId: 'other-tab',
        view: otherView,
      }),
    }));
    const source = await manager.createTab();

    const navigation = manager.openConversation('cross-view-conversation');
    for (let attempt = 0; attempt < 10 && switchToTab.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    targetTab.lifecycleState = 'closing';
    otherManager.getTab.mockReturnValue(null);
    targetSwitch.resolve(undefined);
    await navigation;

    expect(source!.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('cross-view-conversation');
  });

  it('creates a fresh provisional target when the reused preview closes during switching', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const source = await manager.createTab();
    const preview = await manager.createTab('conversation-1', undefined, {
      activate: false,
      lifecycleState: 'provisional',
    });
    const previewSwitch = deferred<void>();
    preview!.controllers.conversationController.switchTo = jest.fn(() => previewSwitch.promise);

    const navigation = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0;
      attempt < 10
        && (preview!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(preview!.id);
    previewSwitch.resolve(undefined);
    await navigation;

    expect(manager.getAllTabs()).toEqual(expect.arrayContaining([
      source,
      expect.objectContaining({
        conversationId: 'conversation-2',
        lifecycleState: 'provisional',
      }),
    ]));
  });

  it('deletes a fork conversation when manager destruction wins the race', async () => {
    const forkState = deferred<Record<string, unknown>>();
    const buildForkProviderState = jest.fn(() => forkState.promise);
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({
      buildForkProviderState,
    });
    const { manager, plugin } = createManager();
    await manager.createTab();

    const fork = manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    });
    for (let attempt = 0;
      attempt < 10 && buildForkProviderState.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(buildForkProviderState).toHaveBeenCalled();
    await manager.destroy();
    forkState.resolve({ fork: true });

    await expect(fork).resolves.toBeNull();
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([]);
  });

  it('removes a fork tab assembled after its source begins closing', async () => {
    const { manager, plugin } = createManager();
    const retained = await manager.createTab();
    const source = await manager.createTab();
    const forkAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => forkAssembly.promise);

    const fork = manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    }, source);
    for (let attempt = 0; attempt < 10 && mockCreateTabRuntime.mock.calls.length < 3; attempt += 1) {
      await Promise.resolve();
    }
    const forkOptions = mockCreateTabRuntime.mock.calls[2]?.[0];
    const forkTab = createMockTab(forkOptions);
    await manager.closeTab(source!.id);
    forkAssembly.resolve(forkTab);

    await expect(fork).resolves.toBeNull();
    expect(mockDestroyTab).toHaveBeenCalledWith(forkTab);
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([retained]);
  });

  it('keeps a fork tab retained by the user while its source closes', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const retained = await manager.createTab();
    const source = await manager.createTab('source-conversation');
    const forkAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => forkAssembly.promise);

    const fork = manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'source-conversation',
      sourceSessionId: 'native-session',
    }, source);
    for (let attempt = 0; attempt < 10 && mockCreateTabRuntime.mock.calls.length < 3; attempt += 1) {
      await Promise.resolve();
    }
    const forkOptions = mockCreateTabRuntime.mock.calls[2]?.[0];
    const forkTab = createMockTab(forkOptions);
    forkTab.session.claimUserOwnership();
    await manager.closeTab(source!.id);
    forkAssembly.resolve(forkTab);

    await expect(fork).resolves.toBe(forkTab);
    expect(manager.getAllTabs()).toEqual([retained, forkTab]);
    expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
    expect(mockDestroyTab).not.toHaveBeenCalledWith(forkTab);
  });

  it('keeps a fork conversation when failed compensation leaves its tab live', async () => {
    const replacementError = new Error('Replacement assembly failed');
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({
        id,
        providerId: 'claude',
      })),
    }));
    const source = await manager.createTab();
    const forkAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => forkAssembly.promise);

    const fork = manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    }, source);
    for (let attempt = 0;
      attempt < 10 && mockCreateTabRuntime.mock.calls.length < 2;
      attempt += 1) {
      await Promise.resolve();
    }
    const forkOptions = mockCreateTabRuntime.mock.calls[1]?.[0];
    const forkTab = createMockTab(forkOptions);
    (manager as any).tabs.delete(source!.id);
    (manager as any).activeTabId = null;
    mockCreateTabRuntime.mockRejectedValueOnce(replacementError);
    forkAssembly.resolve(forkTab);

    await expect(fork).rejects.toBe(replacementError);
    expect(manager.getAllTabs()).toEqual([forkTab]);
    expect(forkTab.conversationId).toBe('forked');
    expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
  });

  it('deletes a current-tab fork when its source closes during the switch', async () => {
    const { manager, plugin } = createManager();
    await manager.createTab();
    const source = await manager.createTab();
    const switchToFork = deferred<void>();
    (source!.controllers.conversationController.switchTo as jest.Mock)
      .mockImplementationOnce(() => switchToFork.promise);

    const fork = manager.forkInCurrentTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    }, source);
    for (let attempt = 0;
      attempt < 10
        && (source!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(source!.id);
    switchToFork.resolve(undefined);

    await expect(fork).resolves.toBe(false);
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });

  it('retains a current-tab fork when a reversible close reservation rolls back', async () => {
    const replacementError = new Error('Replacement assembly failed');
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const source = await manager.createTab('source-conversation');
    const switchFork = deferred<void>();
    const conversationChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;
    source!.controllers.conversationController.switchTo = jest.fn(async (conversationId: string) => {
      await switchFork.promise;
      source!.state.currentConversationId = conversationId;
      conversationChanged(source, conversationId);
    });

    const fork = manager.forkInCurrentTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'source-conversation',
      sourceSessionId: 'native-session',
    }, source);
    for (let attempt = 0;
      attempt < 10
        && (source!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const replacementAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(() => replacementAssembly.promise);
    const close = manager.discardTab(source!.id);

    switchFork.resolve(undefined);
    await expect(fork).resolves.toBe(true);
    replacementAssembly.reject(replacementError);
    await expect(close).rejects.toBe(replacementError);

    expect(source!.conversationId).toBe('forked');
    expect(source!.session.acceptsIntents).toBe(true);
    expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('keeps the fork target chooser and current-tab replacement in single mode', async () => {
    mockChooseForkTarget.mockResolvedValue('current-tab');
    const { manager, plugin } = createManager(createPlugin(), {
      shouldForkToNewTab: () => false,
    });
    const source = await manager.createTab();
    const forkRequest = mockCreateTabRuntime.mock.calls[0]?.[0].forkRequestCallback;

    await forkRequest({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    });

    expect(mockChooseForkTarget).toHaveBeenCalledWith(plugin.app);
    expect(source!.controllers.conversationController!.switchTo).toHaveBeenCalledWith('forked');
    expect(manager.getTabCount()).toBe(1);
    expect(Notice).toHaveBeenCalled();
  });

  it('deletes a partial fork if ledger copy fails', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn().mockReturnValue({
        id: 'source-conversation',
        providerId: 'claude',
      }),
    }));
    const source = await manager.createTab('source-conversation');
    (source!.executionCoordinator!.copyInputsForFork as jest.Mock).mockRejectedValueOnce(
      new Error('ledger copy failed'),
    );

    await expect(manager.forkToNewTab({
      messages: [],
      providerId: 'claude',
      resumeAt: 'assistant-checkpoint',
      sourceConversationId: 'source-conversation',
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
      sourceConversationId: null,
      sourceSessionId: 'native-session',
    })).rejects.toThrow('fork state failed');

    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });
});
