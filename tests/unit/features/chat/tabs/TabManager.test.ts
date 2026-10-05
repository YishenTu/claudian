import {
  commandCatalog,
  commandLoader,
  createManager,
  createMockTab,
  createPlugin,
  deferred,
  expectTabMetadataReleased,
  mockCreateTab,
  mockCreateTabRuntime,
  mockDestroyTab,
  mockDrainTabForShutdownSnapshot,
  mockTabs,
} from '@test/helpers/features/chat/TabManagerTestHarness';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { TabManager } from '@/features/chat/tabs/TabManager';

jest.mock('@/features/chat/tabs/TabLifecycle', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').tabLifecycleModuleMock()
));
jest.mock('@/features/chat/tabs/tabProviderUI', () => ({ refreshTabWorkspaceServices: jest.fn() }));
jest.mock('@/features/chat/tabs/tabProviderLifecycle', () => ({ onProviderAvailabilityChanged: jest.fn().mockReturnValue(false) }));
jest.mock('@/features/chat/tabs/TabRuntimeFactory', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').tabRuntimeFactoryModuleMock()
));
jest.mock('@/features/chat/tabs/forking/ForkTargetModal', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').forkTargetModalModuleMock()
));
jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').providerWorkspaceRegistryModuleMock()
));
jest.mock('@/core/providers/ProviderRegistry', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').providerRegistryModuleMock()
));

describe('TabManager provider execution orchestration', () => {
  beforeEach(() => {
    jest.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    jest.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(commandLoader);
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockResolvedValue(undefined);
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockReturnValue({});
    mockTabs.length = 0;
    jest.clearAllMocks();
    (ProviderRegistry.getCapabilities as jest.Mock).mockReturnValue({
      providerId: 'claude',
      supportsProviderCommands: true,
    });
    commandLoader.loadCommands.mockResolvedValue({
      status: 'ready',
      items: [{ description: 'Review changes', name: 'review' }],
    });
  });

  it('validates cached workspace ownership during admission', async () => {
    const { ProviderInitializationBoundary } = jest.requireActual('@/core/providers/ProviderInitializationBoundary');
    const boundary = new ProviderInitializationBoundary();
    const hostA = {
      storage: { getAdapter: () => ({}) },
      runProviderExecutionTransition: async (_ids: unknown, run: any) => run({}),
    };
    const commandsA = {
      ...commandLoader,
      loadCommands: jest.fn().mockResolvedValue({
        status: 'ready', items: [{ name: 'from-vault-a', description: 'Vault A only' }],
      }),
    };
    const { manager } = createManager(createPlugin());
    boundary.register('claude', {
      initialize: async () => ({ commandCatalog, commandLoader: commandsA }),
    });
    await boundary.ensureInitialized(hostA, 'claude', 'host-a');
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(id => boundary.getIfInitialized(id));
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation((host, id, reason) => boundary.ensureInitialized(host, id, reason));
    jest.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockImplementation(id => boundary.getIfInitialized(id)?.commandLoader ?? null);

    const tab = await manager.createTab();
    expect(tab?.hydrationState).toBe('failed');
    expect(commandsA.loadCommands).not.toHaveBeenCalled();
    await manager.destroy();
  });

  it('creates tabs without installing runtime callbacks', async () => {
    const { manager } = createManager();

    const tab = await manager.createTab();

    expect(tab).not.toBeNull();
    expect(tab?.lifecycleState).toBe('open');
    const options = mockCreateTab.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('onRuntimeInstalled');
    expect(options).not.toHaveProperty('defaultProviderId');
  });

  it('does not inherit the active tab provider when creating another blank tab', async () => {
    const { manager } = createManager();
    const active = await manager.createTab();
    active!.session.selectDraft('codex', active!.draftModel);
    active!.session.selectDraft(active!.providerId, 'codex:gpt-5');

    await manager.createTab();

    const options = mockCreateTabRuntime.mock.calls[1]?.[0];
    expect(options).not.toHaveProperty('providerId');
    expect(options).not.toHaveProperty('draftModel');
    expect(options).not.toHaveProperty('defaultProviderId');
  });

  it('acknowledges review attention when a tab becomes active', async () => {
    const { manager } = createManager();
    await manager.createTab();
    const target = await manager.createTab(null, undefined, { activate: false });

    await manager.switchToTab(target!.id);

    expect(target!.state.acknowledgeReview).toHaveBeenCalledTimes(1);
  });

  it('leaves the first tab inactive when activation is explicitly disabled', async () => {
    const { manager } = createManager();

    const tab = await manager.createTab(null, 'inactive-tab', { activate: false });

    expect(manager.getAllTabs()).toEqual([tab]);
    expect(manager.getActiveTab()).toBeNull();
    expect(manager.getPersistedState()).toEqual({
      activeTabId: null,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: 'inactive-tab',
      }],
    });
  });

  it('keeps the committed active tab visible while another tab is hydrating', async () => {
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }));
    const initial = await manager.createTab(null, 'initial-tab');
    const target = await manager.createTab('conversation-1', 'target-tab', {
      activate: false,
    });
    const hydration = deferred<void>();
    const hydrationStarted = deferred<void>();
    target!.controllers.conversationController.switchTo = jest.fn(() => {
      hydrationStarted.resolve(undefined);
      return hydration.promise;
    });

    const switching = manager.switchToTab(target!.id);
    await hydrationStarted.promise;

    expect(target!.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('conversation-1');
    const switchingIdle = manager.waitForTabSwitchIdle();
    let idleSettled = false;
    void switchingIdle.then(() => { idleSettled = true; });
    await Promise.resolve();

    expect(idleSettled).toBe(false);
    expect(manager.getActiveTab()).toBe(target);
    expect(manager.getPersistedState()).toEqual({
      activeTabId: initial!.id,
      openTabs: [
        { conversationId: null, draftModel: 'claude-default', providerId: 'claude', tabId: initial!.id },
        { conversationId: 'conversation-1', tabId: target!.id },
      ],
    });

    hydration.resolve(undefined);
    await switching;
    await expect(switchingIdle).resolves.toBeUndefined();

    expect(manager.getActiveTab()).toBe(target);
    expect(manager.getPersistedState().activeTabId).toBe(target!.id);
  });

  it.each([
    ['a foreground turn', (tab: any) => { void tab.session.turns.run(() => Promise.resolve()); }],
    ['provider background work', (tab: any) => { tab.executionCoordinator.hasBackgroundWork = true; }],
  ])('projects %s as working in tab bar items', async (_source, makeWorking) => {
    const { manager } = createManager();
    const tab = await manager.createTab();

    makeWorking(tab);

    expect(manager.getTabBarItems()).toEqual([
      expect.objectContaining({ id: tab!.id, isWorking: true }),
    ]);
  });

  it('keeps branch navigation admitted without showing a session work spinner', async () => {
    const { manager } = createManager();
    const tab = (await manager.createTab())!;
    const navigation = deferred<void>();
    const pending = tab.session.runConversationNavigation(() => navigation.promise);
    expect(tab.session.turns.isActive).toBe(true);
    expect(tab.session.canNavigateConversation).toBe(false);
    expect(manager.isTabWorking(tab.id)).toBe(false);
    expect(manager.getTabBarItems()).toEqual([
      expect.objectContaining({ id: tab.id, isWorking: false }),
    ]);
    navigation.resolve();
    await pending;
    expect(tab.session.turns.isActive).toBe(false);
    expect(manager.isTabWorking(tab.id)).toBe(false);
  });

  it('keeps an unread result while projecting later work as active', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab();
    Object.defineProperty(tab!.state, 'attention', {
      configurable: true,
      value: { kind: 'review', outcome: 'completed', since: 123 },
    });
    expect(manager.getTabBarItems()).toEqual([
      expect.objectContaining({
        attention: { kind: 'review', outcome: 'completed', since: 123 },
        id: tab!.id,
      }),
    ]);

    Object.defineProperty(tab!.executionCoordinator, 'hasBackgroundWork', {
      configurable: true,
      value: true,
    });

    expect(manager.getTabBarItems()).toEqual([
      expect.objectContaining({
        attention: { kind: 'review', outcome: 'completed', since: 123 },
        id: tab!.id,
        isWorking: true,
      }),
    ]);
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

    activeSettlement('completed')();
    backgroundSettlement('error')();

    expect(active!.state.markReviewRequired).not.toHaveBeenCalled();
    expect(background!.state.markReviewRequired).toHaveBeenCalledWith('error');
  });

  it('uses activity at completion and invalidates review after activation', async () => {
    const { manager } = createManager();
    const active = await manager.createTab();
    const background = await manager.createTab(null, undefined, { activate: false });
    const activeSettlement = mockCreateTab.mock.calls[0]?.[0].captureReviewableSettlement;
    const backgroundSettlement = mockCreateTab.mock.calls[1]?.[0].captureReviewableSettlement;
    const reportActiveCompletion = activeSettlement('completed');
    const reportBackgroundCompletion = backgroundSettlement('completed');

    await manager.switchToTab(background!.id);
    await manager.switchToTab(active!.id);
    reportActiveCompletion();
    reportBackgroundCompletion();

    expect(active!.state.markReviewRequired).not.toHaveBeenCalled();
    expect(background!.state.markReviewRequired).not.toHaveBeenCalled();
  });

  it('allows unlimited runtime tabs', async () => {
    const { manager } = createManager();

    const tabs = await Promise.all(
      Array.from({ length: 12 }, () => manager.createTab()),
    );

    expect(tabs.every(Boolean)).toBe(true);
    expect(manager.getTabCount()).toBe(12);
    expect(manager.canCreateTab()).toBe(true);
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

  it('does not roll back committed admission when its observer throws', async () => {
    const callbackError = new Error('Failed to render created tab');
    const onTabClosed = jest.fn();
    const onTabCreated = jest.fn(() => {
      throw callbackError;
    });
    const { manager } = createManager(createPlugin(), {
      onTabClosed,
      onTabCreated,
    });

    await expect(manager.createTab(null, 'committed-tab')).resolves.toEqual(
      expect.objectContaining({ id: 'committed-tab' }),
    );

    expect(onTabCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'committed-tab' }));
    expect(manager.getAllTabs()).toEqual([
      expect.objectContaining({ id: 'committed-tab' }),
    ]);
    expect(mockDestroyTab).not.toHaveBeenCalled();
    expect(onTabClosed).not.toHaveBeenCalled();
  });

  it('restores the previous active tab when activation fails after admission', async () => {
    const callbackError = new Error('Failed to render active tab');
    let rejectActivation = false;
    let persistedDuringActivation: ReturnType<TabManager['getPersistedState']> | null = null;
    const onTabCreated = jest.fn();
    const onActiveTabChanged = jest.fn((_previousId: string | null, nextId: string) => {
      if (rejectActivation && nextId === 'failed-tab') {
        persistedDuringActivation = manager.getPersistedState();
        throw callbackError;
      }
    });
    const { manager } = createManager(createPlugin(), {
      onActiveTabChanged,
      onTabCreated,
    });
    const retained = await manager.createTab();
    onTabCreated.mockClear();
    rejectActivation = true;

    await expect(manager.createTab(null, 'failed-tab')).rejects.toBe(callbackError);

    expect(manager.getAllTabs()).toEqual([retained]);
    expect(manager.getActiveTab()).toBe(retained);
    expect(persistedDuringActivation).toEqual({
      activeTabId: retained!.id,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: retained!.id,
      }],
    });
    expect(onTabCreated).not.toHaveBeenCalled();
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

  it('does not roll back a committed switch when its completion observer throws', async () => {
    const switchError = new Error('Failed to publish completed switch');
    const onActiveTabChanged = jest.fn();
    const onTabSwitched = jest.fn((_previousId: string | null, nextId: string) => {
      if (nextId === 'target-tab') throw switchError;
    });
    const { manager } = createManager(createPlugin(), {
      onActiveTabChanged,
      onTabSwitched,
    });
    await manager.createTab(null, 'predecessor-tab');
    const target = await manager.createTab(null, 'target-tab', { activate: false });
    onActiveTabChanged.mockClear();
    onTabSwitched.mockClear();

    await expect(manager.switchToTab(target!.id)).resolves.toBeUndefined();

    expect(manager.getActiveTab()).toBe(target);
    expect(onActiveTabChanged.mock.calls).toEqual([
      ['predecessor-tab', 'target-tab'],
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
    expect(closing!.lifecycleState).toBe('open');
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
    expect(second!.lifecycleState).toBe('open');
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
    expect(retainedDraft!.lifecycleState).toBe('open');
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
    const discovery = (manager as any).commandDiscovery;
    const initialCommandRevision = discovery.tabCommandContextRevisions.get(retainedDraft!.id);
    discovery.providerRuntimeCommandCache.set(retainedDraft!.id, { stale: true });
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
    expect(discovery.tabCommandContextRevisions.get(retainedDraft!.id))
      .toBe(initialCommandRevision + 1);
    expect(discovery.providerRuntimeCommandCache.has(retainedDraft!.id)).toBe(false);
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

  it('fences external observers while allowing a terminal identity during close', async () => {
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
    const factoryOptions = mockCreateTabRuntime.mock.calls[1]?.[0];

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
    expect(closing!.conversationId).toBe('late-conversation');
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
    expect(first!.lifecycleState).toBe('open');
    expect(second!.lifecycleState).toBe('open');
    await manager.destroy();
  });

  it('aborts each admitted turn and supersedes its presentation as soon as shutdown begins', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab();
    const release = deferred<void>();
    let turnSignal: AbortSignal | null = null;
    const turn = tab!.session.turns.run(async signal => {
      turnSignal = signal;
      await release.promise;
    });
    const generation = tab!.session.turns.streamGeneration;

    manager.beginShutdown();

    expect(turnSignal!.aborted).toBe(true);
    expect(tab!.session.turns.cancelRequested).toBe(true);
    expect(tab!.session.turns.streamGeneration).toBeGreaterThan(generation);
    release.resolve();
    await turn;
    await manager.destroy();
  });

  it('does not invent a snapshot owner for intentionally inactive restored shells', async () => {
    const { manager } = createManager();
    const first = await manager.createTab(null, 'restored-1', { activate: false });
    const second = await manager.createTab(null, 'restored-2', { activate: false });

    manager.beginShutdown();
    await manager.drainForShutdownSnapshot();

    expect(manager.getActiveTab()).toBeNull();
    expect(manager.getPersistedState()).toEqual({
      activeTabId: null,
      openTabs: [
        { conversationId: null, draftModel: 'claude-default', providerId: 'claude', tabId: first!.id },
        { conversationId: null, draftModel: 'claude-default', providerId: 'claude', tabId: second!.id },
      ],
    });
    manager.sealShutdownSnapshot();
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

  it('retains only live runtime tabs and commits their provisional previews', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const open = await manager.createTab('open-conversation');
    const preview = await manager.createTab('preview-conversation', undefined, {
      lifecycleState: 'provisional',
    });
    const closingPreview = await manager.createTab('closing-conversation', undefined, {
      activate: false,
      lifecycleState: 'provisional',
    });
    const untouchedPreview = await manager.createTab('untouched-conversation', undefined, {
      activate: false,
      lifecycleState: 'provisional',
    });
    await manager.restoreState({
      openTabs: [{ tabId: 'cold-shell', conversationId: 'cold-conversation' }],
      activeTabId: preview!.id,
    });
    const save = deferred<void>();
    closingPreview!.controllers.conversationController.save = jest.fn(() => save.promise);
    const close = manager.closeTab(closingPreview!.id);
    for (let attempt = 0;
      attempt < 10 && closingPreview!.lifecycleState !== 'closing';
      attempt += 1) {
      await Promise.resolve();
    }
    expect(closingPreview!.lifecycleState).toBe('closing');

    manager.retainTabs([
      open!.id,
      preview!.id,
      closingPreview!.id,
      'cold-shell',
      'unknown-tab',
    ]);

    expect(open!.lifecycleState).toBe('open');
    expect(open!.session.userOwnershipRevision).toBe(1);
    expect(preview!.lifecycleState).toBe('open');
    expect(preview!.session.userOwnershipRevision).toBe(1);
    expect(closingPreview!.session.userOwnershipRevision).toBe(0);
    expect(untouchedPreview!.lifecycleState).toBe('provisional');
    expect(untouchedPreview!.session.userOwnershipRevision).toBe(0);
    expect(manager.getTab('cold-shell')).toBeNull();

    save.resolve(undefined);
    await expect(close).resolves.toBe(true);
    await manager.discardProvisionalTabs();
    expect(manager.getAllTabs()).toEqual([open, preview]);
  });

  it('captures every open tab and the actual active tab regardless of lifecycle', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const retained = await manager.createTab('conversation-1');
    const blank = await manager.createTab(null, undefined, { activate: false });
    blank!.session.selectDraft(blank!.providerId, 'codex:gpt-5');
    blank!.session.selectDraft('codex', blank!.draftModel);
    const preview = await manager.createTab('conversation-2', undefined, {
      lifecycleState: 'provisional',
    });

    expect(manager.getPersistedState()).toEqual({
      openTabs: [
        { tabId: retained!.id, conversationId: 'conversation-1' },
        { tabId: blank!.id, conversationId: null, draftModel: 'codex:gpt-5', providerId: 'codex' },
        { tabId: preview!.id, conversationId: 'conversation-2' },
      ],
      activeTabId: preview!.id,
    });
  });

  it('keeps provisional lifecycle changes out of its persisted shell', async () => {
    const { manager } = createManager();
    const preview = await manager.createTab(null, undefined, {
      lifecycleState: 'provisional',
    });

    expect(manager.getPersistedState()).toEqual({
      activeTabId: preview!.id,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: preview!.id,
      }],
    });

    preview!.session.claimUserOwnership();
    preview!.session.commitAdmission();

    expect(preview!.lifecycleState).toBe('open');
    expect(manager.getPersistedState()).toEqual({
      activeTabId: preview!.id,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: preview!.id,
      }],
    });
  });

  it('does not treat teardown lifecycle as a committed membership removal', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab(null, 'tearing-down-tab');

    tab!.session.beginClose();

    expect(manager.getPersistedState()).toEqual({
      activeTabId: tab!.id,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: tab!.id,
      }],
    });
  });

  it('publishes every successful inactive admission after the transaction', async () => {
    const onTabCreated = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabCreated });
    await manager.createTab();
    onTabCreated.mockClear();

    const background = await manager.createTab(null, 'background-tab', {
      activate: false,
    });
    const preview = await manager.createTab(null, 'preview-tab', {
      activate: false,
      lifecycleState: 'provisional',
    });

    expect(background?.id).toBe('background-tab');
    expect(preview?.id).toBe('preview-tab');
    expect(onTabCreated.mock.calls).toEqual([
      [background],
      [preview],
    ]);
  });

  it('publishes active selection only after switching an admitted tab', async () => {
    const onActiveTabCommitted = jest.fn();
    const { manager } = createManager(
      createPlugin(),
      { onActiveTabCommitted } as any,
    );
    const initial = await manager.createTab(null, 'initial-tab');
    const background = await manager.createTab(null, 'background-tab', {
      activate: false,
    });
    onActiveTabCommitted.mockClear();

    await manager.switchToTab(background!.id);

    expect(manager.getActiveTab()).toBe(background);
    expect(onActiveTabCommitted).toHaveBeenCalledWith(initial!.id, background!.id);
  });

  it('publishes persisted blank-tab model changes', async () => {
    const onTabDraftChanged = jest.fn();
    const { manager } = createManager(createPlugin(), { onTabDraftChanged });
    const tab = await manager.createTab();
    const onDraftModelChanged = mockCreateTabRuntime.mock.calls[0]?.[0]
      .onDraftModelChanged as (runtime: any, model: string | null) => void;

    tab!.session.selectDraft(tab!.providerId, 'claude-alternate');
    onDraftModelChanged(tab, tab!.draftModel);

    expect(onTabDraftChanged).toHaveBeenCalledWith(tab!.id, 'claude-alternate');
  });

  it('restores open tab shells cold in order and activates once at the end', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const onActiveTabChanged = jest.fn();
    const { manager } = createManager(
      createPlugin({ getCachedConversation }),
      { onActiveTabChanged },
    );

    await manager.restoreState({
      openTabs: [
        { tabId: 'restored-1', conversationId: 'conversation-1' },
        { tabId: 'restored-2', conversationId: null, draftModel: 'codex:gpt-5' },
      ],
      activeTabId: 'restored-2',
    });

    expect(manager.getTabIdentities().map(tab => ({
      id: tab.id,
      lifecycleState: tab.lifecycleState,
    }))).toEqual([
      { id: 'restored-1', lifecycleState: 'open' },
      { id: 'restored-2', lifecycleState: 'open' },
    ]);
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(1);
    expect(manager.getTab('restored-1')).toBeNull();
    expect(manager.getTabCount()).toBe(2);
    expect(manager.getActiveTabId()).toBe('restored-2');
    expect(onActiveTabChanged).toHaveBeenCalledTimes(1);
    expect(mockCreateTabRuntime.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      draftModel: 'codex:gpt-5',
      lifecycleState: 'open',
      tabId: 'restored-2',
    }));
    await Promise.all([manager.switchToTab('restored-1'), manager.switchToTab('restored-1')]);
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(2);
    expect(manager.getActiveTabId()).toBe('restored-1');
    expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(['restored-1', 'restored-2']);
  });

  it('restores a usable tab when the selected saved runtime cannot be assembled', async () => {
    const { manager } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    mockCreateTabRuntime.mockRejectedValueOnce(new Error('Unavailable selected tab'));
    await expect(manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' })).resolves.toBeUndefined();
    expect(manager.getActiveTabId()).toBe('two');
    expect(manager.getTab('one')).toBeNull();
    expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(['one', 'two']);
    await manager.switchToTab('one');
    expect(manager.getActiveTabId()).toBe('one');
  });

  it('keeps the active source reversible when an inactive successor fails assembly', async () => {
    const { manager } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    await manager.restoreState({ openTabs: [
      { tabId: 'active', conversationId: 'one' }, { tabId: 'open', conversationId: 'two' },
    ], activeTabId: 'active' });
    const source = manager.getActiveTab()!;
    const before = manager.getPersistedState();
    mockCreateTabRuntime.mockRejectedValueOnce(new Error('Assembly failed'));
    await expect(manager.closeTab('active')).rejects.toThrow('Assembly failed');
    expect(manager.getActiveTab()).toBe(source);
    expect(source.session.acceptsIntents).toBe(true);
    expect(source.controllers.conversationController.save).not.toHaveBeenCalled();
    expect(manager.getPersistedState()).toEqual(before);
    await expect(manager.closeTab('active')).resolves.toBe(true);
    expect(manager.getActiveTabId()).toBe('open');
  });

  it('resets a deleted conversation during reversible close preflight even if successor assembly fails', async () => {
    const { manager } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    const source = manager.getActiveTab()!;
    source.controllers.inputController.cancelStreaming = jest.fn();
    source.controllers.conversationController.createNew = jest.fn(async () => { source.session.setConversationId(null); });
    const pending = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(() => pending.promise);
    const closing = manager.closeTab('one');
    await manager.resetConversationTabs('one');
    pending.reject(new Error('Successor unavailable'));
    await expect(closing).rejects.toThrow('Successor unavailable');
    expect(manager.getActiveTab()).toBe(source);
    expect(source.conversationId).toBeNull();
    expect(source.session.acceptsIntents).toBe(true);
    expect(source.controllers.inputController.cancelStreaming).toHaveBeenCalledTimes(1);
  });

  it('joins a late restored assembly during shutdown without losing its shell snapshot', async () => {
    const { manager } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    const pending = deferred<any>();
    let options: any;
    mockCreateTabRuntime.mockImplementationOnce(input => { options = input; return pending.promise; });
    const switching = manager.switchToTab('two');
    const shutdown = manager.drainForShutdownSnapshot();
    const late = createMockTab(options);
    pending.resolve(late);
    await Promise.all([switching, shutdown]);
    expect(mockDestroyTab).toHaveBeenCalledWith(late);
    expect(manager.getTab('two')).toBeNull();
    expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(['one', 'two']);
    expect(manager.getPersistedState().activeTabId).toBe('one');
  });

  it.each([false, true])('resets deleted shells and retries failed runtime resets (multiple failures: %s)', async multipleFailures => {
    const { manager, plugin } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    await manager.restoreState({ openTabs: ['one', 'two', 'three'].map(tabId => ({ tabId, conversationId: 'deleted' })), activeTabId: 'one' });
    await manager.switchToTab('three');
    const other = manager.getTab('three')!;
    other.controllers.inputController.cancelStreaming = jest.fn();
    other.controllers.conversationController.createNew = jest.fn(async () => { other.session.setConversationId(null); });
    if (multipleFailures) jest.mocked(other.controllers.conversationController.createNew).mockRejectedValueOnce(new Error('Other reset failed'));
    plugin.settings.lastSelectedChatModel = { providerId: 'claude', model: 'claude-default' };
    const active = manager.getTab('one')!;
    active.controllers.inputController.cancelStreaming = jest.fn();
    active.controllers.conversationController.createNew = jest.fn().mockRejectedValueOnce(new Error('Reset failed'))
      .mockImplementation(async () => { active.session.setConversationId(null); });
    await expect(manager.resetConversationTabs('deleted')).rejects.toThrow('Reset failed');
    expect(manager.getTabIdentities().find(tab => tab.id === 'two')?.conversationId).toBeNull();
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(2);
    await manager.resetConversationTabs('deleted');
    expect(active.controllers.conversationController.createNew).toHaveBeenCalledTimes(2);
    expect(other.controllers.conversationController.createNew).toHaveBeenCalledTimes(multipleFailures ? 2 : 1);
    expect(manager.getTabIdentities().every(tab => tab.conversationId === null)).toBe(true);
  });

  it.each(['close', 'delete'] as const)('discards late assembly when %s invalidates its restored shell', async operation => {
    const { manager } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    const pending = deferred<any>();
    let options: any;
    mockCreateTabRuntime.mockImplementationOnce(input => { options = input; return pending.promise; });
    const switching = manager.switchToTab('two');
    if (operation === 'close') await manager.closeTab('two');
    else await manager.resetConversationTabs('two');
    const late = createMockTab(options);
    pending.resolve(late);
    await switching;
    expect(mockDestroyTab).toHaveBeenCalledWith(late);
    expect(manager.getTab('two')).toBeNull();
    expect(manager.getActiveTabId()).toBe('one');
    expect(manager.getTabIdentities().find(tab => tab.id === 'two')?.conversationId).toBe(operation === 'close' ? undefined : null);
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

});
