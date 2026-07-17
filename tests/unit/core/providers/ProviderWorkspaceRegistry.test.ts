import '@/providers';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

function createProviderHost(): ProviderHost {
  return {
    app: {},
    settings: {},
    storage: {
      getAdapter: jest.fn().mockReturnValue({}),
    },
  } as unknown as ProviderHost;
}

describe('ProviderWorkspaceRegistry', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
  });

  it('returns agent mention providers through the workspace registry', () => {
    const claudeProvider = { searchAgents: jest.fn().mockReturnValue([]) };
    const codexProvider = { searchAgents: jest.fn().mockReturnValue([]) };

    ProviderWorkspaceRegistry.setServices('claude', {
      agentMentionProvider: claudeProvider as any,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      agentMentionProvider: codexProvider as any,
    });

    expect(ProviderWorkspaceRegistry.getAgentMentionProvider('claude')).toBe(claudeProvider);
    expect(ProviderWorkspaceRegistry.getAgentMentionProvider('codex')).toBe(codexProvider);
  });

  it('refreshes agent mention state through the workspace registry', async () => {
    const refreshClaude = jest.fn().mockResolvedValue(undefined);
    const refreshCodex = jest.fn().mockResolvedValue(undefined);

    ProviderWorkspaceRegistry.setServices('claude', {
      refreshAgentMentions: refreshClaude,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      refreshAgentMentions: refreshCodex,
    });

    await ProviderWorkspaceRegistry.refreshAgentMentions('codex');

    expect(refreshClaude).not.toHaveBeenCalled();
    expect(refreshCodex).toHaveBeenCalled();
  });

  it('returns the assigned catalog for a provider', () => {
    const mockCatalog = {
      listDropdownEntries: jest.fn(),
      listVaultEntries: jest.fn(),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      setRuntimeCommands: jest.fn(),
      getDropdownConfig: jest.fn(),
      refresh: jest.fn(),
    };

    ProviderWorkspaceRegistry.setServices('claude', {
      commandCatalog: mockCatalog as any,
    });

    expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(mockCatalog);
  });

  it('returns the runtime command loader for a provider', () => {
    const runtimeCommandLoader = {
      isAvailable: jest.fn().mockReturnValue(true),
      loadCommands: jest.fn().mockResolvedValue([]),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      runtimeCommandLoader: runtimeCommandLoader as any,
    });

    expect(ProviderWorkspaceRegistry.getRuntimeCommandLoader('opencode')).toBe(runtimeCommandLoader);
  });

  it('returns the tab warmup policy for a provider', () => {
    const tabWarmupPolicy = {
      resolveMode: jest.fn().mockReturnValue('commands'),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      tabWarmupPolicy: tabWarmupPolicy as any,
    });

    expect(ProviderWorkspaceRegistry.getTabWarmupPolicy('opencode')).toBe(tabWarmupPolicy);
  });

  it('deduplicates concurrent provider initialization', async () => {
    const initialize = jest.fn(async () => ({ commandCatalog: {} as any }));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = createProviderHost();

    await Promise.all([
      ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first'),
      ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'second'),
    ]);

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('allows provider initialization to retry after failure', async () => {
    const initialize = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ commandCatalog: {} as any });
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = createProviderHost();

    await expect(
      ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first'),
    ).rejects.toThrow('temporary failure');
    await expect(
      ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'retry'),
    ).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(ProviderWorkspaceRegistry.getIfInitialized('codex')).not.toBeNull();
  });

  it('keeps registrations available after disposing initialized services', async () => {
    const dispose = jest.fn();
    const initialize = jest.fn(async () => ({ dispose }));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = createProviderHost();

    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first');
    await ProviderWorkspaceRegistry.disposeInitialized();
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'second');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('reinitializes a provider after its assigned services are cleared', async () => {
    const initialize = jest.fn(async () => ({ commandCatalog: {} as any }));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = createProviderHost();

    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first');
    ProviderWorkspaceRegistry.setServices('codex', undefined);
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'second');

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(ProviderWorkspaceRegistry.getIfInitialized('codex')).not.toBeNull();
  });

  it('disposes every initialized provider even when one cleanup fails', async () => {
    const disposeClaude = jest.fn().mockRejectedValue(new Error('cleanup failed'));
    const disposeCodex = jest.fn().mockResolvedValue(undefined);
    ProviderWorkspaceRegistry.setServices('claude', { dispose: disposeClaude });
    ProviderWorkspaceRegistry.setServices('codex', { dispose: disposeCodex });

    await expect(ProviderWorkspaceRegistry.disposeInitialized()).resolves.toBeUndefined();

    expect(disposeClaude).toHaveBeenCalledTimes(1);
    expect(disposeCodex).toHaveBeenCalledTimes(1);
    expect(ProviderWorkspaceRegistry.getIfInitialized('claude')).toBeNull();
    expect(ProviderWorkspaceRegistry.getIfInitialized('codex')).toBeNull();
  });

  it('disposes services that finish initializing after provider disposal', async () => {
    let finishInitialization!: (services: { dispose: jest.Mock }) => void;
    const dispose = jest.fn().mockResolvedValue(undefined);
    const initialize = jest.fn(() => new Promise<{ dispose: jest.Mock }>((resolve) => {
      finishInitialization = resolve;
    }));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = createProviderHost();

    const initialization = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'codex',
      'cold-start',
    );
    await Promise.resolve();
    await ProviderWorkspaceRegistry.disposeInitialized();
    finishInitialization({ dispose });
    await initialization;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(ProviderWorkspaceRegistry.getIfInitialized('codex')).toBeNull();
  });

  it('prepares provider settings through initialized workspace services', async () => {
    const prepareSettings = jest.fn().mockResolvedValue(undefined);
    ProviderWorkspaceRegistry.setServices('codex', { prepareSettings });

    await ProviderWorkspaceRegistry.prepareSettings('codex');

    expect(prepareSettings).toHaveBeenCalledTimes(1);
  });
});
