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
import type { Mock } from 'vitest';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

vi.mock('@/features/chat/tabs/TabLifecycle', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).tabLifecycleModuleMock()
));
vi.mock('@/features/chat/tabs/tabProviderUI', () => ({ refreshTabWorkspaceServices: vi.fn() }));
vi.mock('@/features/chat/tabs/tabProviderLifecycle', () => ({ onProviderAvailabilityChanged: vi.fn().mockReturnValue(false) }));
vi.mock('@/features/chat/tabs/TabRuntimeFactory', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).tabRuntimeFactoryModuleMock()
));
vi.mock('@/features/chat/tabs/forking/ForkTargetModal', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).forkTargetModalModuleMock()
));
vi.mock('@/core/providers/ProviderWorkspaceRegistry', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).providerWorkspaceRegistryModuleMock()
));
vi.mock('@/core/providers/ProviderRegistry', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).providerRegistryModuleMock()
));

describe('TabConversationNavigation', () => {
  beforeEach(() => {
    vi.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    vi.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(commandLoader);
    vi.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockResolvedValue(undefined);
    vi.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockReturnValue({});
    mockTabs.length = 0;
    vi.clearAllMocks();
    (ProviderRegistry.getCapabilities as Mock).mockReturnValue({
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

  it('lets the layout open a session a tab command picked before rebinding that tab', async () => {
    const openPicked = vi.fn().mockResolvedValue(true);
    const { manager } = await createManager(conversationPlugin(), {}, {}, { openPicked });
    const source = await manager.createTab('conversation-1') as any;

    await runtimeOptions(0).openConversation('conversation-2');

    expect(openPicked).toHaveBeenCalledWith('conversation-2', source);
    expect(source.session.runtime.model.hydrate).not.toHaveBeenCalledWith('conversation-2');
    expect(source.conversationId).toBe('conversation-1');
  });

  it('reuses an inactive conversation locally and closes another restored tab without assembling it', async () => {
    const { manager } = await createManager(createPlugin({ getCachedConversation: (id: string) => ({ id, providerId: 'claude' }) }));
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
    const other = await createManager(createPlugin({ getCachedConversation: lookup }));
    await other.manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    const otherView = { leaf: {}, getTabManager: () => other.manager };
    const { manager } = await createManager(createPlugin({
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

  it('shows a session in a wide view through its viewer instead of reloading its narrow tab', async () => {
    const lookup = (id: string) => ({ id, providerId: 'claude' });
    const other = await createManager(createPlugin({ getCachedConversation: lookup }), {}, {}, { showsPreviews: () => true });
    await other.manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
    const otherView = { leaf: {}, getTabManager: () => other.manager };
    const { manager } = await createManager(createPlugin({
      getCachedConversation: lookup,
      findConversationAcrossViews: (id: string) => id === 'two' ? { tabId: 'two', view: otherView } : null,
    }));
    await manager.createTab(null, 'local');

    await manager.openConversation('two');

    expect(other.manager.getTab('two')).toBeNull();
    const shown = other.manager.getActiveTab()!;
    expect([shown.conversationId, shown.lifecycleState]).toEqual(['two', 'provisional']);
    expect(manager.getTabCount()).toBe(1);
  });

  it('keeps a queued open-conversation intent bound to its source runtime', async () => {
    const { manager } = await createManager();
    const retained = await manager.createTab();
    const source = await manager.createTab();
    const firstSwitch = deferred<void>();
    (retained!.session.runtime.model.hydrate as Mock).mockClear();
    (source!.session.runtime.model.hydrate as Mock)
      .mockImplementationOnce(() => firstSwitch.promise);
    const openFromSource = mockCreateTabRuntime.mock.calls[1]?.[0]
      .openConversation as (conversationId: string) => Promise<void>;

    const blockingNavigation = manager.openConversation('blocking-conversation');
    for (let attempt = 0;
      attempt < 10
        && (source!.session.runtime.model.hydrate as Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const queuedNavigation = openFromSource('stale-conversation');
    await manager.closeTab(source!.id);
    firstSwitch.resolve(undefined);
    await Promise.all([blockingNavigation, queuedNavigation]);

    expect(retained!.session.runtime.model.hydrate).not.toHaveBeenCalled();
    expect(manager.getAllTabs()).toEqual([retained]);
  });

  it('ignores a matching local tab after that target begins closing', async () => {
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
    const closingTarget = await manager.createTab('conversation-1');
    const source = await manager.createTab();
    const save = deferred<void>();
    closingTarget!.controllers.conversationController.save = vi.fn(() => save.promise);
    const close = manager.closeTab(closingTarget!.id);

    await manager.openConversation('conversation-1');

    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source!.id, conversationId: 'conversation-1' }));
    save.resolve(undefined);
    await close;
  });

  it('falls back locally when a matching tab closes during its awaited switch', async () => {
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
    const source = await manager.createTab();
    const target = await manager.createTab('conversation-1', undefined, { activate: false });
    const hydration = deferred<void>();
    target!.session.runtime.model.hydrate = vi.fn(() => hydration.promise);

    const navigation = manager.openConversation('conversation-1');
    for (let attempt = 0;
      attempt < 10
        && (target!.session.runtime.model.hydrate as Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(target!.id);
    hydration.resolve(undefined);
    await navigation;

    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source!.id, conversationId: 'conversation-1' }));
  });

  it('accepts the awaited local target while a close it does not own is only beginning', async () => {
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
    const source = await manager.createTab();
    const target = await manager.createTab('conversation-1', undefined, { activate: false });
    const hydration = deferred<void>();
    target!.session.runtime.model.hydrate = vi.fn(() => hydration.promise);
    (source!.session.runtime.model.hydrate as Mock).mockClear();

    const navigation = manager.openConversation('conversation-1');
    for (let attempt = 0;
      attempt < 10
        && (target!.session.runtime.model.hydrate as Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    // The manager has not claimed this close yet, so the target still owns the conversation.
    target!.session.beginClose();
    hydration.resolve(undefined);
    await navigation;

    expect(source!.session.runtime.model.hydrate).not.toHaveBeenCalled();
    expect(manager.getTabCount()).toBe(2);
  });

  it('uses a live replacement when the active tab is already closing', async () => {
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
    const closing = await manager.createTab('conversation-1');
    (closing!.session.runtime.model.hydrate as Mock).mockClear();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = vi.fn(() => save.promise);

    const close = manager.closeTab(closing!.id);
    for (let attempt = 0;
      attempt < 10 && manager.getAllTabs().length < 2;
      attempt += 1) {
      await Promise.resolve();
    }
    const replacement = manager.getAllTabs().find(tab => tab !== closing)!;
    await manager.openConversation('conversation-2');

    expect(closing!.session.runtime.model.hydrate).not.toHaveBeenCalled();
    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: replacement.id, conversationId: 'conversation-2' }));
    save.resolve(undefined);
    await close;
  });

  it('does not switch another view after a source-owned reveal loses its runtime', async () => {
    const reveal = deferred<void>();
    const revealLeaf = vi.fn(() => reveal.promise);
    const switchToTab = vi.fn().mockResolvedValue(undefined);
    const otherView = {
      leaf: {},
      getTabManager: vi.fn().mockReturnValue({ focusTab: switchToTab }),
    };
    const { manager } = await createManager(createPlugin({
      getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
      app: {
        vault: { adapter: { basePath: '/vault' } },
        workspace: { getActiveFile: () => null, revealLeaf },
      },
      findConversationAcrossViews: vi.fn().mockReturnValue({
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
    const revealLeaf = vi.fn(() => reveal.promise);
    const switchToTab = vi.fn().mockResolvedValue(undefined);
    const targetTab = {
      id: 'other-tab',
      conversationId: 'cross-view-conversation',
      lifecycleState: 'open',
    };
    const otherManager = {
      isTabLive: vi.fn(() => targetTab.lifecycleState !== 'closing'),
      getTabIdentities: () => [targetTab],
      focusTab: switchToTab,
    };
    const otherView = {
      leaf: {},
      getTabManager: vi.fn().mockReturnValue(otherManager),
    };
    const { manager } = await createManager(createPlugin({
      getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
      app: {
        vault: { adapter: { basePath: '/vault' } },
        workspace: { getActiveFile: () => null, revealLeaf },
      },
      findConversationAcrossViews: vi.fn().mockReturnValue({
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
    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source!.id, conversationId: 'cross-view-conversation' }));
  });

  it('falls back locally when a cross-view target closes during its awaited switch', async () => {
    const targetSwitch = deferred<void>();
    const switchToTab = vi.fn(() => targetSwitch.promise);
    const targetTab = {
      id: 'other-tab',
      conversationId: 'cross-view-conversation',
      lifecycleState: 'open',
    };
    const otherManager = {
      isTabLive: vi.fn(() => targetTab.lifecycleState !== 'closing'),
      getTabIdentities: () => [targetTab],
      focusTab: switchToTab,
    };
    const otherView = {
      leaf: {},
      getTabManager: vi.fn().mockReturnValue(otherManager),
    };
    const { manager } = await createManager(createPlugin({
      getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
      findConversationAcrossViews: vi.fn().mockReturnValue({
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

    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source!.id, conversationId: 'cross-view-conversation' }));
  });

  it('does not treat a close-claimed tab in another view as the conversation owner', async () => {
    const lookup = (id: string) => ({ id, providerId: 'claude' });
    const other = await createManager(createPlugin({ getCachedConversation: lookup }));
    const successor = await other.manager.createTab('one', undefined, { activate: false });
    const closing = await other.manager.createTab('two');
    const successorHydration = deferred<void>();
    successor!.session.runtime.model.hydrate = vi.fn(() => successorHydration.promise);
    const close = other.manager.closeTab(closing!.id);
    for (let attempt = 0;
      attempt < 20
        && (successor!.session.runtime.model.hydrate as Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const otherView = { leaf: {}, getTabManager: () => other.manager };
    const { manager } = await createManager(createPlugin({
      getCachedConversation: lookup,
      findConversationAcrossViews: (id: string) => id === 'two' ? { tabId: closing!.id, view: otherView } : null,
    }));
    const local = await manager.createTab();

    await manager.openConversation('two');

    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: local!.id, conversationId: 'two' }));
    successorHydration.resolve();
    await close;
  });

});
