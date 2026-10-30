import '@/providers';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import type { Mock } from 'vitest';

import type { ProviderCommandCatalog } from '@/core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderCommandLoader } from '@/core/providers/types';

async function createProviderHost() { return (await createProviderHostFixture()).host; }

async function flushAsyncWork(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('ProviderWorkspaceRegistry', () => {
  afterEach(async () => {
    await ProviderWorkspaceRegistry.disposeInitialized();
    ProviderWorkspaceRegistry.clear();
  });

  it('rejects a different workspace host until disposal', async () => {
    const initialize = vi.fn(async () => ({}));
    ProviderWorkspaceRegistry.register('claude', { initialize });
    const owner = await createProviderHost();
    const other = await createProviderHost();
    await ProviderWorkspaceRegistry.ensureInitialized(owner, 'claude', 'test');
    await expect(ProviderWorkspaceRegistry.ensureInitialized(other, 'claude', 'test'))
      .rejects.toThrow('workspace host');
    expect(initialize).toHaveBeenCalledTimes(1);
    await ProviderWorkspaceRegistry.disposeInitialized();
    await ProviderWorkspaceRegistry.ensureInitialized(other, 'claude', 'test');
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('returns the assigned catalog for a provider', () => {
    const mockCatalog: ProviderCommandCatalog = {
      listDropdownEntries: vi.fn(async () => []),
      getDropdownConfig: () => ({ providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' }),
      refresh: vi.fn(async () => {}),
    };

    ProviderWorkspaceRegistry.setServices('claude', {
      commandCatalog: mockCatalog,
    });

    expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(mockCatalog);
  });

  it('returns the command loader for a provider', () => {
    const commandLoader: ProviderCommandLoader = {
      getCacheFingerprint: vi.fn().mockReturnValue('enabled:bundled-cli'),
      isAvailable: vi.fn().mockReturnValue(true),
      loadCommands: vi.fn().mockResolvedValue({ status: 'empty' }),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      commandLoader,
    });

    expect(ProviderWorkspaceRegistry.getCommandLoader('opencode')).toBe(commandLoader);
  });

  it('deduplicates concurrent provider initialization', async () => {
    const initialize = vi.fn(async () => ({}));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = await createProviderHost();

    await Promise.all([
      ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first'),
      ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'second'),
    ]);

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('allows provider initialization to retry after failure', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({});
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = await createProviderHost();

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
    const dispose = vi.fn();
    const initialize = vi.fn(async () => ({ dispose }));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = await createProviderHost();

    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first');
    await ProviderWorkspaceRegistry.disposeInitialized();
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'second');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('reinitializes a provider after its assigned services are cleared', async () => {
    const initialize = vi.fn(async () => ({}));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = await createProviderHost();

    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'first');
    ProviderWorkspaceRegistry.setServices('codex', undefined);
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'second');

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(ProviderWorkspaceRegistry.getIfInitialized('codex')).not.toBeNull();
  });

  it.each(['throw', 'reject'])('disposes every initialized provider when one cleanup fails via %s', async failure => {
    const disposeClaude = vi.fn(() => {
      const error = new Error('cleanup failed');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    const disposeCodex = vi.fn().mockResolvedValue(undefined);
    ProviderWorkspaceRegistry.register('claude', { initialize: async () => ({ dispose: disposeClaude }) });
    ProviderWorkspaceRegistry.register('codex', { initialize: async () => ({ dispose: disposeCodex }) });
    const host = await createProviderHost();
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'claude', 'test');
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'test');

    await expect(ProviderWorkspaceRegistry.disposeInitialized()).resolves.toBeUndefined();

    expect(disposeClaude).toHaveBeenCalledTimes(1);
    expect(disposeCodex).toHaveBeenCalledTimes(1);
    expect(ProviderWorkspaceRegistry.getIfInitialized('claude')).toBeNull();
    expect(ProviderWorkspaceRegistry.getIfInitialized('codex')).toBeNull();
    await expect(ProviderWorkspaceRegistry.ensureInitialized(await createProviderHost(), 'codex', 'replacement'))
      .resolves.toBeUndefined();
  });

  it('disposes services that finish initializing after provider disposal', async () => {
    let finishInitialization!: (services: { dispose: Mock }) => void;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const initialize = vi.fn(() => new Promise<{ dispose: Mock }>((resolve) => {
      finishInitialization = resolve;
    }));
    ProviderWorkspaceRegistry.register('codex', { initialize });
    const host = await createProviderHost();

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

  it('runs cold provider initialization inside the execution lifecycle transition', async () => {
    const host = await createProviderHost();
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
      initialize: vi.fn(async () => {
        events.push('initialize');
        return {};
      }),
    });

    await ProviderWorkspaceRegistry.ensureInitialized(host, 'grok', 'cold-query');

    expect(events).toEqual(['before', 'initialize', 'after']);
    expect(host.executionLifecycleRegistry.getProviderGeneration('grok')).toBe(1);
  });

  it('rejects a nested transition started by async provider initialization', async () => {
    const host = await createProviderHost();
    const nestedMutation = vi.fn(async () => undefined);
    ProviderWorkspaceRegistry.register('grok', {
      initialize: vi.fn(async (context) => {
        await Promise.resolve();
        await context.plugin.runProviderExecutionTransition(
          ['grok'],
          nestedMutation,
          context.transitionScope,
        );
        return {};
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
