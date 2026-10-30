import { conversationRecord } from '@test/helpers/features/chat/TabManagerTestHarness';
/** @vitest-environment jsdom */
const actualModule0 = await vi.importActual<any>('@/core/providers/ProviderInitializationBoundary');
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
import type { Mock } from 'vitest';

import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
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

function createRuntimeCatalog(): RuntimeCommandCatalog {
  const catalog = new RuntimeCommandCatalog({
    dropdownConfig: { providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' },
    projectEntry: command => ({
      ...command, providerId: 'claude', kind: 'command', scope: 'runtime', source: 'sdk',
      isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
    }),
  });
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
    vi.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(catalog);
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

  it('validates cached workspace ownership during command lookup', async () => {
    const { ProviderInitializationBoundary } = actualModule0;
    const boundary = new ProviderInitializationBoundary();
    const hostA = {
      storage: { getAdapter: () => ({}) },
      runProviderExecutionTransition: async (_ids: unknown, run: any) => run({}),
    };
    const commandsA = {
      ...commandLoader,
      loadCommands: vi.fn().mockResolvedValue({
        status: 'ready', items: [{ name: 'from-vault-a', description: 'Vault A only' }],
      }),
    };
    const { manager } = await createManager(await createPlugin());
    const tab = await manager.createTab();
    boundary.register('claude', {
      initialize: async () => ({ commandCatalog: catalog, commandLoader: commandsA }),
    });
    await boundary.ensureInitialized(hostA, 'claude', 'host-a');
    vi.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(id => boundary.getIfInitialized(id));
    vi.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation((host, id, reason) => boundary.ensureInitialized(host, id, reason));
    vi.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockImplementation(id => boundary.getIfInitialized(id)?.commandLoader ?? null);

    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({ status: 'error' });
    expect(commandsA.loadCommands).not.toHaveBeenCalled();
    await manager.destroy();
  });

  it('uses each tab live command snapshot instead of unrelated discovery state', async () => {
    vi.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(null);
    const { manager } = await createManager();
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
    const { manager } = await createManager();
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
    const conversation = conversationRecord('background-conversation', { providerId: 'claude' });
    const { manager } = await createManager(await createPlugin({
      getCachedConversation: vi.fn().mockReturnValue(conversation),
      getConversationSync: vi.fn().mockReturnValue(conversation),
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

  it('does not admit command observation after the requesting tab becomes inactive during initialization', async () => {
    const { manager } = await createManager();
    const first = await manager.createTab();
    const second = await manager.createTab(null, 'second', { activate: false });
    const initialized = deferred<void>();
    const watchCommands = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue({ ...commandLoader, watchCommands });
    vi.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockReturnValueOnce(initialized.promise);
    const controller = new AbortController();
    discoveryFor(0, first).watch(controller.signal);
    await manager.switchToTab(second!.id);
    initialized.resolve();
    // Drain the initialization continuation, lookup and observer admission.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(watchCommands).not.toHaveBeenCalled();
    controller.abort();
    await manager.destroy();
  });

  it('lets provider-owned command discovery outlive the shared deadline', async () => {
    vi.useFakeTimers();
    const commandResult = deferred<any>();
    commandLoader.loadCommands.mockReturnValueOnce(commandResult.promise);
    vi.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    commandCatalog.listDropdownEntries.mockResolvedValueOnce([{
      id: 'opencode:review',
      name: 'review',
    }]);
    (ProviderRegistry.getCapabilities as Mock).mockReturnValue({
      providerId: 'opencode',
      supportsProviderCommands: true,
    });
    commandCatalog.getDropdownConfig.mockReturnValue({
      discoveryTimeoutMs: 'provider-owned',
    });
    const { manager } = await createManager();

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
      await vi.advanceTimersByTimeAsync(8_000);

      expect(discovery.getSnapshot()).toEqual({ status: 'loading' });
      commandResult.resolve({
        status: 'ready',
        items: [{ description: 'Review changes', name: 'review' }],
      });
      await expect(load).resolves.toMatchObject({ status: 'ready' });
    } finally {
      vi.useRealTimers();
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
    const getConversationById = vi.fn()
      .mockImplementationOnce(() => firstLookup.promise)
      .mockResolvedValue(conversationB);
    const { manager } = await createManager(await createPlugin({
      getCachedConversation: vi.fn((id: string) => (conversationRecord(id, { providerId: 'claude' }))),
      getConversationById,
    }));
    const tab = await manager.createTab('conversation-a');

    const staleDiscovery = reloadDiscovery(0, tab);
    for (let attempt = 0;
      attempt < 10 && getConversationById.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.openConversation('conversation-b');
    firstLookup.resolve({
      id: 'conversation-a',
      messages: [{ role: 'user', content: 'A' }],
      providerId: 'claude',
    });

    // The rebind invalidates the picker's source, aborting its in-flight stale load.
    await expect(staleDiscovery).resolves.toMatchObject({ status: 'error', retryable: true });
    expect(commandLoader.loadCommands).not.toHaveBeenCalled();

    await expect(reloadDiscovery(1, manager.getActiveTab())).resolves.toMatchObject({
      status: 'ready', items: [{ name: 'review' }],
    });
    expect(commandLoader.loadCommands).toHaveBeenCalledWith(expect.objectContaining({
      conversation: conversationB,
    }));
  });

  it('reloads cached commands after the provider lifecycle generation advances', async () => {
    const plugin = await createPlugin();
    const executionLifecycleRegistry = plugin.providerHost.executionLifecycleRegistry;
    const { manager } = await createManager(plugin);
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
    const plugin = await createPlugin();
    const executionLifecycleRegistry = plugin.providerHost.executionLifecycleRegistry;
    const oldDiscovery = deferred<{
      status: 'ready';
      items: [{ description: string; name: string }];
    }>();
    commandLoader.loadCommands.mockReturnValueOnce(oldDiscovery.promise);
    const { manager } = await createManager(plugin);
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

    commandLoader.loadCommands.mockResolvedValueOnce({
      status: 'ready',
      items: [{ description: 'Fresh command', name: 'fresh' }],
    });
    await expect(reloadDiscovery(0, tab)).resolves.toMatchObject({
      status: 'ready', items: [{ description: 'Fresh command', name: 'fresh' }],
    });
    expect(commandLoader.loadCommands).toHaveBeenCalledTimes(2);
    await executionLifecycleRegistry.dispose();
  });

  it('does not start command discovery after its tab begins closing', async () => {
    const { manager } = await createManager();
    await manager.createTab();
    const closing = await manager.createTab();
    const save = deferred<void>();
    closing!.controllers.conversationController.save = vi.fn(() => save.promise);

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
