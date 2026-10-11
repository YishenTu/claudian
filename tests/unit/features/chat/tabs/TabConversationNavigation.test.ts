import {
  commandCatalog,
  commandLoader,
  createManager,
  createPlugin,
  deferred,
  mockCreateTabRuntime,
  mockDestroyTab,
  mockTabs,
  runtimeOptions,
} from '@test/helpers/features/chat/TabManagerTestHarness';
import { Notice } from 'obsidian';

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

  const conversationPlugin = () => createPlugin({
    getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
  });
  it('opens the session in a new tab when the current tab refuses to switch', async () => {
    const { manager } = createManager(conversationPlugin());
    const current = await manager.createTab('conversation-1') as any;
    current.controllers.conversationController.switchTo.mockResolvedValue(false);

    await manager.openConversation('conversation-2');

    expect(current.conversationId).toBe('conversation-1');
    const opened = manager.getActiveTab()!;
    expect(opened).not.toBe(current);
    expect(opened.conversationId).toBe('conversation-2');
    expect(opened.lifecycleState).toBe('open');
  });

  it('keeps the current tab and reports when a refused switch has no room for a new tab', async () => {
    const { manager } = createManager(conversationPlugin());
    const current = await manager.createTab('conversation-1') as any;
    current.controllers.conversationController.switchTo.mockResolvedValue(false);
    jest.spyOn(manager, 'canCreateTab').mockReturnValue(false);

    await manager.openConversation('conversation-2');

    expect(manager.getAllTabs()).toEqual([current]);
    expect(current.conversationId).toBe('conversation-1');
    expect(Notice).toHaveBeenCalledTimes(1);
  });

  it('lets the layout open a session a tab command picked before rebinding that tab', async () => {
    const openPicked = jest.fn().mockResolvedValue(true);
    const { manager } = createManager(conversationPlugin(), {}, {}, { openPicked });
    const source = await manager.createTab('conversation-1') as any;

    await runtimeOptions(0).openConversation('conversation-2');

    expect(openPicked).toHaveBeenCalledWith('conversation-2', source);
    expect(source.controllers.conversationController.switchTo).not.toHaveBeenCalledWith('conversation-2');
    expect(source.conversationId).toBe('conversation-1');
  });

  it('reuses an inactive conversation locally and closes another restored tab without assembling it', async () => {
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
    target!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise.then(() => true));

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
    target!.controllers.conversationController.switchTo = jest.fn(() => hydration.promise.then(() => true));
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
      isTabLive: jest.fn(() => targetTab.lifecycleState !== 'closing'),
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
      isTabLive: jest.fn(() => targetTab.lifecycleState !== 'closing'),
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
    targetSwitch.resolve(undefined);
    await navigation;

    expect(source!.controllers.conversationController.switchTo)
      .toHaveBeenCalledWith('cross-view-conversation');
  });

  it('does not treat a close-claimed tab in another view as the conversation owner', async () => {
    const lookup = (id: string) => ({ id, providerId: 'claude' });
    const other = createManager(createPlugin({ getCachedConversation: lookup }));
    const successor = await other.manager.createTab('one', undefined, { activate: false });
    const closing = await other.manager.createTab('two');
    const successorHydration = deferred<boolean>();
    successor!.controllers.conversationController.switchTo = jest.fn(() => successorHydration.promise);
    const close = other.manager.closeTab(closing!.id);
    for (let attempt = 0;
      attempt < 20
        && (successor!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const otherView = { leaf: {}, getTabManager: () => other.manager };
    const { manager } = createManager(createPlugin({
      getCachedConversation: lookup,
      findConversationAcrossViews: (id: string) => id === 'two' ? { tabId: closing!.id, view: otherView } : null,
    }));
    const local = await manager.createTab();

    await manager.openConversation('two');

    expect(local!.controllers.conversationController.switchTo).toHaveBeenCalledWith('two');
    successorHydration.resolve(true);
    await close;
  });

});
