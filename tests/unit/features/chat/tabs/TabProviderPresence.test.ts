import {
  commandCatalog,
  commandLoader,
  createManager,
  createPlugin,
  mockCreateTabRuntime,
  mockTabs,
} from '@test/helpers/features/chat/TabManagerTestHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { OPENCODE_PROVIDER_CAPABILITIES } from '@/providers/opencode/capabilities';

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

describe('TabProviderPresence', () => {
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

  it.each(['codex', 'opencode'].flatMap(providerId => [
    { provider: providerId, restored: { conversationId: `${providerId}-history` } },
    { provider: providerId, restored: { conversationId: null, providerId, draftModel: `${providerId}:model` } },
  ]))('starts a shared runtime for an inactive restored provider tab without preparing execution: %o', async ({ provider, restored }) => {
    const startRuntime = jest.fn().mockResolvedValue(undefined);
    jest.mocked(ProviderRegistry.getCapabilities).mockImplementation(providerId => (providerId === 'opencode' ? OPENCODE_PROVIDER_CAPABILITIES : {
      providerId, supportsProviderCommands: true, startsSharedRuntimeOnTabPresence: providerId === provider,
    } as any));
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(providerId => providerId === provider ? { startRuntime } : {});
    const { manager } = createManager(createPlugin({
      getCachedConversation: (id: string) => ({ id, providerId: id === `${provider}-history` ? provider : 'claude' }),
    }));
    await manager.restoreState({
      openTabs: [
        { tabId: 'visible', conversationId: 'claude-history' },
        { tabId: 'hidden', ...restored },
      ],
      activeTabId: 'visible',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(startRuntime).toHaveBeenCalledTimes(1);
    expect(manager.getTab('hidden')).toBeNull();
    expect(mockTabs.every(tab => tab.executionCoordinator.prepare.mock.calls.length === 0)).toBe(true);
    await manager.destroy();
  });

  it.each(['codex', 'opencode'])('starts a shared runtime when a blank tab selects %s without preparing execution', async provider => {
    const startRuntime = jest.fn().mockResolvedValue(undefined);
    jest.mocked(ProviderRegistry.getCapabilities).mockImplementation(providerId => (providerId === 'opencode' ? OPENCODE_PROVIDER_CAPABILITIES : {
      providerId, supportsProviderCommands: true, startsSharedRuntimeOnTabPresence: providerId === provider,
    } as any));
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(providerId => providerId === provider ? { startRuntime } : {});
    const { manager } = createManager();
    const tab = await manager.createTab();
    expect(startRuntime).not.toHaveBeenCalled();
    tab!.session.selectDraft(provider, `${provider}:model`);
    mockCreateTabRuntime.mock.calls[0][0].onDraftModelChanged(tab, tab!.draftModel);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(startRuntime).toHaveBeenCalledTimes(1);
    expect(tab!.executionCoordinator.prepare).not.toHaveBeenCalled();
    await manager.destroy();
  });

  it('keeps repeated passive runtime startup failures silent', async () => {
    const startRuntime = jest.fn().mockRejectedValue(new Error('Codex CLI missing'));
    jest.mocked(ProviderRegistry.getCapabilities).mockImplementation(providerId => ({
      providerId, supportsProviderCommands: true, startsSharedRuntimeOnTabPresence: providerId === 'codex',
    } as any));
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(providerId => providerId === 'codex' ? { startRuntime } : {});
    const { manager } = createManager();
    const tab = await manager.createTab();
    tab!.session.selectDraft('codex', 'codex:gpt-5');
    const changed = mockCreateTabRuntime.mock.calls[0][0].onDraftModelChanged;
    changed(tab, tab!.draftModel);
    await new Promise(resolve => setTimeout(resolve, 0));
    changed(tab, tab!.draftModel);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(startRuntime).toHaveBeenCalledTimes(2);
    expect(Notice).not.toHaveBeenCalled();
    await manager.destroy();
  });
});
