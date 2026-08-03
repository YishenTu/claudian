import '@/providers';

import {
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionTransitionScope,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';

function createProviderHost(): ProviderHost {
  const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  return {
    app: {},
    executionLifecycleRegistry,
    runProviderExecutionTransition: <T>(
      providerIds: ProviderId[],
      mutation: (scope: ProviderExecutionTransitionScope) => Promise<T>,
      parentScope?: ProviderExecutionTransitionScope,
    ) => (
      executionLifecycleRegistry.runTransition(
        providerIds,
        mutation,
        parentScope,
      )
    ),
    settings: {},
    storage: {
      getAdapter: jest.fn().mockReturnValue({}),
    },
  } as unknown as ProviderHost;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
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
      setCommandSnapshot: jest.fn(),
      getDropdownConfig: jest.fn(),
      refresh: jest.fn(),
    };

    ProviderWorkspaceRegistry.setServices('claude', {
      commandCatalog: mockCatalog as any,
    });

    expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(mockCatalog);
  });

  it('returns the command loader for a provider', () => {
    const commandLoader = {
      getCacheFingerprint: jest.fn().mockReturnValue('enabled:bundled-cli'),
      isAvailable: jest.fn().mockReturnValue(true),
      loadCommands: jest.fn().mockResolvedValue({ status: 'empty' }),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      commandLoader: commandLoader as any,
    });

    expect(ProviderWorkspaceRegistry.getCommandLoader('opencode')).toBe(commandLoader);
  });

  it('keeps editable vault repositories separate from runtime command catalogs', () => {
    const commandCatalog = {
      listDropdownEntries: jest.fn(),
      setCommandSnapshot: jest.fn(),
      getDropdownConfig: jest.fn(),
      refresh: jest.fn(),
    };
    const vaultCommandRepository = {
      listVaultEntries: jest.fn(),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
    };

    ProviderWorkspaceRegistry.setServices('claude', {
      commandCatalog,
      vaultCommandRepository,
    });

    const services = ProviderWorkspaceRegistry.getServices('claude');
    expect(services?.commandCatalog).toBe(commandCatalog);
    expect(services?.vaultCommandRepository).toBe(vaultCommandRepository);
    expect(commandCatalog).not.toHaveProperty('saveVaultEntry');
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
    await flushAsyncWork();
    expect(initialize).toHaveBeenCalledTimes(1);
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

  it('runs cold provider initialization inside the execution lifecycle transition', async () => {
    const host = createProviderHost();
    const events: string[] = [];
    host.executionLifecycleRegistry.registerTransitionHook('grok', {
      beforeTransition: () => {
        events.push('before');
      },
      afterTransition: () => {
        events.push('after');
      },
    });
    ProviderWorkspaceRegistry.register('grok', {
      initialize: jest.fn(async () => {
        events.push('initialize');
        return { commandCatalog: {} as any };
      }),
    });

    await ProviderWorkspaceRegistry.ensureInitialized(host, 'grok', 'cold-query');

    expect(events).toEqual(['before', 'initialize', 'after']);
    expect(host.executionLifecycleRegistry.getProviderGeneration('grok')).toBe(1);
  });

  it('rejects a nested transition started by async provider initialization', async () => {
    const host = createProviderHost();
    const nestedMutation = jest.fn(async () => undefined);
    ProviderWorkspaceRegistry.register('grok', {
      initialize: jest.fn(async (context) => {
        await Promise.resolve();
        await context.plugin.runProviderExecutionTransition(
          ['grok'],
          nestedMutation,
          context.transitionScope,
        );
        return { commandCatalog: {} as any };
      }),
    });

    const initialization = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'grok',
      'nested-transition',
    );
    const outcome = await Promise.race([
      initialization.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: {
        providerId: 'grok',
        retryable: true,
      },
    });
    expect(nestedMutation).not.toHaveBeenCalled();
  });
});
