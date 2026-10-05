import {
  commandCatalog,
  commandLoader,
  createManager,
  createMockTab,
  createPlugin,
  deferred,
  mockCreateTab,
  mockCreateTabRuntime,
  mockDestroyTab,
  mockTabs,
} from '@test/helpers/features/chat/TabManagerTestHarness';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

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

describe('TabConversationNavigation', () => {
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

  it('reuses the provisional preview while browsing unopened sessions', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));

    await manager.openConversation('conversation-1', {
      activate: true,
      preferNewTab: true,
      provisional: true,
    });
    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
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
      preview.session.setConversationId(conversationId);
    });

    const navigation = manager.openConversation('conversation-2', {
      preferNewTab: true,
      provisional: true,
    });
    for (let attempt = 0; attempt < 10 && switchTo.mock.calls.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    preview.session.claimUserOwnership();
    preview.session.commitAdmission();
    hydration.resolve(undefined);
    await navigation;

    expect(preview.lifecycleState).toBe('open');
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
    retainedTarget.session.commitAdmission();
    hydration.resolve(undefined);
    await Promise.all([staleNavigation, latestNavigation]);

    expect(manager.getAllTabs()).toContain(retainedTarget);
    expect(retainedTarget.lifecycleState).toBe('open');
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

  it('discards provisional previews without removing open runtime tabs', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const first = await manager.createTab('conversation-1');
    const second = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.openConversation('conversation-3', {
      activate: false,
      preferNewTab: true,
      provisional: true,
    });

    await manager.discardProvisionalTabs();

    expect(manager.getAllTabs()).toEqual([first, second]);
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
    expect(current?.lifecycleState).toBe('open');
    expect(mockDestroyTab).toHaveBeenCalledWith(first);
  });

  it('reuses an inactive conversation locally and closes another shell without assembling it', async () => {
    const { manager } = createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
    await manager.restoreState({ openTabs: ['one', 'two', 'three'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    await manager.closeTab('three');
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(1);
    expect(mockDestroyTab).not.toHaveBeenCalled();
    await manager.openConversation('two');
    expect(manager.getTabCount()).toBe(2);
    expect(manager.getActiveTabId()).toBe('two');
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(2);
  });

  it('reuses an unassembled conversation in another view without creating a local duplicate', async () => {
    const lookup = (id: string) => ({ id, providerId: 'claude' });
    const other = createManager(createPlugin({ getCachedConversation: lookup }));
    await other.manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    const otherView = { leaf: {}, getTabManager: () => other.manager };
    const { manager } = createManager(createPlugin({
      getCachedConversation: lookup,
      findConversationAcrossViews: (id: string) => id === 'two' ? { tabId: 'two', view: otherView } : null,
    }));
    await manager.createTab(null, 'local');
    await manager.openConversation('two');
    expect(other.manager.getActiveTabId()).toBe('two');
    expect(other.manager.getTabCount()).toBe(2);
    expect(manager.getTabCount()).toBe(1);
    expect(manager.getTab('local')?.conversationId).toBeNull();
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

  it('accepts the awaited local target while a close it does not own is only beginning', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const source = await manager.createTab();
    const target = await manager.createTab('conversation-1', undefined, { activate: false });
    const hydration = deferred<void>();
    target!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise);
    (source!.controllers.conversationController.switchTo as jest.Mock).mockClear();

    const navigation = manager.openConversation('conversation-1');
    for (let attempt = 0;
      attempt < 10
        && (target!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    // The manager has not claimed this close yet, so the target still owns the conversation.
    target!.session.beginClose();
    hydration.resolve(undefined);
    await navigation;

    expect(source!.controllers.conversationController.switchTo).not.toHaveBeenCalled();
    expect(manager.getTabCount()).toBe(2);
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
      id: 'other-tab',
      conversationId: 'cross-view-conversation',
      lifecycleState: 'open',
    };
    const otherManager = {
      canCreateTab: jest.fn().mockReturnValue(true),
      getTab: jest.fn().mockReturnValue(targetTab),
      getTabIdentities: () => [targetTab],
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
      id: 'other-tab',
      conversationId: 'cross-view-conversation',
      lifecycleState: 'open',
    };
    const otherManager = {
      canCreateTab: jest.fn().mockReturnValue(true),
      getTab: jest.fn().mockReturnValue(targetTab),
      getTabIdentities: () => [targetTab],
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
});
