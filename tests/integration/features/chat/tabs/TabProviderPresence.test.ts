import { conversationRecord } from '@test/helpers/features/chat/TabManagerTestHarness';
/** @vitest-environment jsdom */
import {
  commandCatalog,
  commandLoader,
  createManager,
  createPlugin,
  mockCreateTabRuntime,
  mockTabs,
} from '@test/helpers/features/chat/TabManagerTestHarness';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { OPENCODE_PROVIDER_CAPABILITIES } from '@/providers/opencode/capabilities';



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

describe('TabProviderPresence', () => {
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

  it.each(['codex', 'opencode'].flatMap(providerId => [
    { provider: providerId, restored: { conversationId: `${providerId}-history` } },
    { provider: providerId, restored: { conversationId: null, providerId, draftModel: `${providerId}:model` } },
  ]))('starts a shared runtime for an inactive restored provider tab without preparing execution: %o', async ({ provider, restored }) => {
    const startRuntime = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ProviderRegistry.getCapabilities).mockImplementation(providerId => (providerId === 'opencode' ? OPENCODE_PROVIDER_CAPABILITIES : {
      providerId, supportsProviderCommands: true, startsSharedRuntimeOnTabPresence: providerId === provider,
    } as any));
    vi.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(providerId => providerId === provider ? { startRuntime } : {});
    const { manager } = await createManager(await createPlugin({
      getCachedConversation: (id: string) => (conversationRecord(id, { providerId: id === `${provider}-history` ? provider : 'claude' })),
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
    const startRuntime = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ProviderRegistry.getCapabilities).mockImplementation(providerId => (providerId === 'opencode' ? OPENCODE_PROVIDER_CAPABILITIES : {
      providerId, supportsProviderCommands: true, startsSharedRuntimeOnTabPresence: providerId === provider,
    } as any));
    vi.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(providerId => providerId === provider ? { startRuntime } : {});
    const { manager } = await createManager();
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
    const startRuntime = vi.fn().mockRejectedValue(new Error('Codex missing'));
    vi.mocked(ProviderRegistry.getCapabilities).mockImplementation(providerId => ({
      providerId, supportsProviderCommands: true, startsSharedRuntimeOnTabPresence: providerId === 'codex',
    } as any));
    vi.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockImplementation(providerId => providerId === 'codex' ? { startRuntime } : {});
    const { manager } = await createManager();
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
