import {
  commandCatalog,
  commandLoader,
  createManager,
  createPlugin,
  deferred,
  expectTabMetadataReleased,
  mockTabs,
  runtimeOptions,
} from '@test/helpers/features/chat/TabManagerTestHarness';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
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

function createRuntimeCatalog(): RuntimeCommandCatalog {
  const catalog = new RuntimeCommandCatalog({
    dropdownConfig: { providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' },
    projectEntry: command => ({
      ...command, providerId: 'claude', kind: 'command', scope: 'runtime', source: 'sdk',
      isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
    }),
  });
  jest.spyOn(catalog, 'setCommandSnapshot');
  return catalog;
}

/** The command-picker discovery source the manager handed the `index`-th runtime. */
function discoveryFor(index: number, tab: unknown) {
  return runtimeOptions(index).getProviderCatalogConfig(tab).discovery;
}

/** Opens the picker again: forgets the picker's snapshot and loads through the manager. */
function reloadDiscovery(index: number, tab: unknown) {
  const discovery = discoveryFor(index, tab);
  discovery.invalidate();
  return discovery.load();
}

describe('TabCommandDiscovery', () => {
  let catalog: RuntimeCommandCatalog;

  beforeEach(() => {
    catalog = createRuntimeCatalog();
    jest.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(catalog);
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

  it('validates cached workspace ownership during command lookup', async () => {
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
    const tab = await manager.createTab();
    boundary.register('claude', {
      initialize: async () => ({ commandCatalog: catalog, commandLoader: commandsA }),
    });
    await boundary.ensureInitialized(hostA, 'claude', 'host-a');
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(id => boundary.getIfInitialized(id));
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation((host, id, reason) => boundary.ensureInitialized(host, id, reason));
    jest.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockImplementation(id => boundary.getIfInitialized(id)?.commandLoader ?? null);

    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({ status: 'error' });
    expect(commandsA.loadCommands).not.toHaveBeenCalled();
    await manager.destroy();
  });

  it('uses each tab live command snapshot instead of unrelated discovery state', async () => {
    jest.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(null);
    const { manager } = createManager();
    const first = await manager.createTab();
    const second = await manager.createTab(null, 'second', { activate: false });
    const command = (name: string) => ({ id: name, name, description: name, content: '', source: 'sdk' as const });
    (first!.executionCoordinator as any).getCommandSnapshot = () => [command('first-live')];
    (second!.executionCoordinator as any).getCommandSnapshot = () => [command('second-live')];
    expect(await reloadDiscovery(0, first)).toMatchObject({
      status: 'ready', items: [{ name: 'first-live' }],
    });
    expect(await reloadDiscovery(1, second)).toMatchObject({
      status: 'ready', items: [{ name: 'second-live' }],
    });
    (first!.executionCoordinator as any).getCommandSnapshot = () => [];
    expect(await reloadDiscovery(0, first)).toEqual({ status: 'empty' });
  });

  it('runs on-demand command discovery without a runtime or provider session', async () => {
    const { manager } = createManager();
    const tab = await manager.createTab();

    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({
      status: 'ready',
      items: [{ description: 'Review changes', name: 'review' }],
    });

    expect(commandLoader.loadCommands).toHaveBeenCalledWith(expect.objectContaining({
      allowIsolatedMetadataCreation: true,
      conversation: null,
    }));
    expect(commandLoader.loadCommands.mock.calls[0][0]).not.toHaveProperty('runtime');
  });

  it('does not start isolated command metadata for a background tab', async () => {
    const conversation = { id: 'background-conversation', providerId: 'claude' };
    const { manager } = createManager(createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(conversation),
      getConversationSync: jest.fn().mockReturnValue(conversation),
    }));
    await manager.createTab();
    const background = await manager.createTab('background-conversation', 'background', { activate: false });
    expect(background!.conversationId).toBe('background-conversation');

    await reloadDiscovery(1, background);

    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(1);
    expect(commandLoader.loadCommands).toHaveBeenCalledWith(expect.objectContaining({
      allowIsolatedMetadataCreation: false,
    }));
  });

  it('lets provider-owned command discovery outlive the shared deadline', async () => {
    jest.useFakeTimers();
    const commandResult = deferred<any>();
    commandLoader.loadCommands.mockReturnValueOnce(commandResult.promise);
    jest.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    commandCatalog.listDropdownEntries.mockResolvedValueOnce([{
      id: 'opencode:review',
      name: 'review',
    }]);
    (ProviderRegistry.getCapabilities as jest.Mock).mockReturnValue({
      providerId: 'opencode',
      supportsProviderCommands: true,
    });
    commandCatalog.getDropdownConfig.mockReturnValue({
      discoveryTimeoutMs: 'provider-owned',
    });
    const { manager } = createManager();

    try {
      const tab = await manager.createTab();
      tab!.session.selectDraft('opencode', tab!.draftModel);
      const discovery = discoveryFor(0, tab);

      const load = discovery.load();
      for (let attempt = 0;
        attempt < 10 && commandLoader.loadCommands.mock.calls.length === 0;
        attempt += 1) {
        await Promise.resolve();
      }
      await jest.advanceTimersByTimeAsync(8_000);

      expect(discovery.getSnapshot()).toEqual({ status: 'loading' });
      commandResult.resolve({
        status: 'ready',
        items: [{ description: 'Review changes', name: 'review' }],
      });
      await expect(load).resolves.toMatchObject({ status: 'ready' });
    } finally {
      jest.useRealTimers();
      commandCatalog.getDropdownConfig.mockReturnValue({});
      await manager.destroy();
    }
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
    const conversationChanged = runtimeOptions(0)
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;

    const staleDiscovery = reloadDiscovery(0, tab);
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

    // The rebind invalidates the picker's source, aborting its in-flight stale load.
    await expect(staleDiscovery).resolves.toMatchObject({ status: 'error', retryable: true });
    expect(commandLoader.loadCommands).not.toHaveBeenCalled();

    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({
      status: 'ready', items: [{ name: 'review' }],
    });
    expect(commandLoader.loadCommands).toHaveBeenCalledWith(expect.objectContaining({
      conversation: conversationB,
    }));
  });

  it('reloads cached commands after the provider lifecycle generation advances', async () => {
    const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
    const { manager } = createManager(createPlugin({
      providerHost: { executionLifecycleRegistry },
    }));
    const tab = await manager.createTab();

    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({
      status: 'ready', items: [{ description: 'Review changes', name: 'review' }],
    });
    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({ status: 'ready' });
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(1);

    await executionLifecycleRegistry.runTransition(['claude'], async () => undefined);

    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({ status: 'ready' });
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
    const tab = await manager.createTab();

    const oldLoad = reloadDiscovery(0, tab);
    for (let attempt = 0; attempt < 10 && commandLoader.loadCommands.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(1);

    await executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
    oldDiscovery.resolve({
      status: 'ready',
      items: [{ description: 'Old command', name: 'old' }],
    });
    await expect(oldLoad).resolves.toMatchObject({
      status: 'ready', items: [{ description: 'Old command', name: 'old' }],
    });
    expect(catalog.setCommandSnapshot).not.toHaveBeenCalled();

    commandLoader.loadCommands.mockResolvedValueOnce({
      status: 'ready',
      items: [{ description: 'Fresh command', name: 'fresh' }],
    });
    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({
      status: 'ready', items: [{ description: 'Fresh command', name: 'fresh' }],
    });
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(2);
    expect(catalog.setCommandSnapshot).toHaveBeenCalledWith([
      { description: 'Fresh command', name: 'fresh' },
    ]);
    await executionLifecycleRegistry.dispose();
  });

  it('does not start command discovery after its tab begins closing', async () => {
    const { manager } = createManager();
    await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = jest.fn(() => save.promise);

    const discovery = reloadDiscovery(1, closing);
    const close = manager.closeTab(closing!.id);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.resolve();
    }

    expect(commandLoader.loadCommands).not.toHaveBeenCalled();
    expectTabMetadataReleased(manager, closing!.id);

    save.resolve(undefined);
    await expect(discovery).resolves.toEqual({ status: 'empty' });
    await expect(close).resolves.toBe(true);
    expect(commandLoader.loadCommands).not.toHaveBeenCalled();
    expectTabMetadataReleased(manager, closing!.id);
  });
});
