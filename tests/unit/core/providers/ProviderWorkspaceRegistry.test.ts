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

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, reject, resolve };
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
      getCacheFingerprint: jest.fn().mockReturnValue('enabled:bundled-cli'),
      isAvailable: jest.fn().mockReturnValue(true),
      loadCommands: jest.fn().mockResolvedValue({ status: 'empty' }),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      runtimeCommandLoader: runtimeCommandLoader as any,
    });

    expect(ProviderWorkspaceRegistry.getRuntimeCommandLoader('opencode')).toBe(runtimeCommandLoader);
  });

  it('keeps editable vault repositories separate from runtime command catalogs', () => {
    const commandCatalog = {
      listDropdownEntries: jest.fn(),
      setRuntimeCommands: jest.fn(),
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

  it('gates a pending successful initialization and acquires its provider transition', async () => {
    const pendingServices = deferred<any>();
    const releaseProvider = jest.fn().mockResolvedValue(undefined);
    const beginProvider = jest.fn().mockResolvedValue({ release: releaseProvider });
    ProviderWorkspaceRegistry.register('grok', {
      initialize: jest.fn(() => pendingServices.promise),
    });
    const initialization = ProviderWorkspaceRegistry.ensureInitialized(
      createProviderHost(),
      'grok',
      'cold-query',
    );
    let initialized = false;
    void initialization.then(() => { initialized = true; });

    const transitionPromise = ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);
    const sharedInitialization = ProviderWorkspaceRegistry.ensureInitialized(
      createProviderHost(),
      'grok',
      'second-cold-query',
    );
    let sharedInitialized = false;
    void sharedInitialization.then(() => { sharedInitialized = true; });
    let transitionAcquired = false;
    void transitionPromise.then(() => { transitionAcquired = true; });
    await flushAsyncWork();
    expect(transitionAcquired).toBe(false);

    pendingServices.resolve({
      beginAuxiliaryServicesEnvironmentChange: beginProvider,
    });
    const transition = await transitionPromise;

    expect(beginProvider).toHaveBeenCalledTimes(1);
    expect(initialized).toBe(false);
    expect(sharedInitialized).toBe(false);
    await transition.release();
    await Promise.all([initialization, sharedInitialization]);
    expect(initialized).toBe(true);
    expect(sharedInitialized).toBe(true);
    expect(releaseProvider).toHaveBeenCalledTimes(1);
  });

  it('does not initialize an idle cold provider solely to hold a transition', async () => {
    const initialize = jest.fn(async () => ({ commandCatalog: {} as any }));
    ProviderWorkspaceRegistry.register('grok', { initialize });

    const transition = await ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);

    expect(initialize).not.toHaveBeenCalled();
    const initialization = ProviderWorkspaceRegistry.ensureInitialized(
      createProviderHost(),
      'grok',
      'query-during-transition',
    );
    let initialized = false;
    void initialization.then(() => { initialized = true; });
    await flushAsyncWork();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialized).toBe(false);

    await transition.release();
    await initialization;
    expect(initialized).toBe(true);
  });

  it('keeps a retry gated after a pending initialization fails', async () => {
    const firstInitialization = deferred<any>();
    const initialize = jest.fn()
      .mockImplementationOnce(() => firstInitialization.promise)
      .mockResolvedValueOnce({ commandCatalog: {} as any });
    ProviderWorkspaceRegistry.register('grok', { initialize });
    const host = createProviderHost();
    const failedInitialization = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'grok',
      'first-query',
    );
    const transitionPromise = ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);

    firstInitialization.reject(new Error('initialization failed'));
    await expect(failedInitialization).rejects.toThrow('initialization failed');
    const transition = await transitionPromise;

    const retry = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'grok',
      'retry-during-transition',
    );
    let retried = false;
    void retry.then(() => { retried = true; });
    await flushAsyncWork();
    expect(retried).toBe(false);

    await transition.release();
    await retry;
    expect(retried).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('keeps initialization gated until every concurrent transition releases', async () => {
    const firstRelease = jest.fn().mockResolvedValue(undefined);
    const secondRelease = jest.fn().mockResolvedValue(undefined);
    const beginProvider = jest.fn()
      .mockResolvedValueOnce({ release: firstRelease })
      .mockResolvedValueOnce({ release: secondRelease });
    ProviderWorkspaceRegistry.setServices('grok', {
      beginAuxiliaryServicesEnvironmentChange: beginProvider,
    });

    const first = await ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);
    const second = await ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);
    const initialization = ProviderWorkspaceRegistry.ensureInitialized(
      createProviderHost(),
      'grok',
      'query-during-transitions',
    );
    let initialized = false;
    void initialization.then(() => { initialized = true; });

    await first.release();
    await flushAsyncWork();
    expect(initialized).toBe(false);
    await second.release();
    await initialization;
    expect(initialized).toBe(true);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it('gates reinitialization after disposal until the active transition releases', async () => {
    const releaseProvider = jest.fn().mockResolvedValue(undefined);
    const dispose = jest.fn().mockResolvedValue(undefined);
    const initialize = jest.fn()
      .mockResolvedValueOnce({
        beginAuxiliaryServicesEnvironmentChange: jest.fn().mockResolvedValue({
          release: releaseProvider,
        }),
        dispose,
      })
      .mockResolvedValueOnce({ commandCatalog: {} as any });
    ProviderWorkspaceRegistry.register('grok', { initialize });
    const host = createProviderHost();
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'grok', 'first');
    const transition = await ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);

    await ProviderWorkspaceRegistry.disposeInitialized();
    const reinitialization = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'grok',
      'after-dispose',
    );
    let reinitialized = false;
    void reinitialization.then(() => { reinitialized = true; });
    await flushAsyncWork();
    expect(reinitialized).toBe(false);

    await transition.release();
    await reinitialization;
    expect(reinitialized).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('stops waiting for initialization superseded by disposal and gates reinitialization', async () => {
    const supersededServices = deferred<any>();
    const initialize = jest.fn()
      .mockImplementationOnce(() => supersededServices.promise)
      .mockResolvedValueOnce({ commandCatalog: {} as any });
    ProviderWorkspaceRegistry.register('grok', { initialize });
    const host = createProviderHost();
    const supersededInitialization = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'grok',
      'superseded',
    );
    const transitionPromise = ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);

    await ProviderWorkspaceRegistry.disposeInitialized();
    const reinitialization = ProviderWorkspaceRegistry.ensureInitialized(
      host,
      'grok',
      'replacement',
    );
    const transition = await transitionPromise;
    let reinitialized = false;
    void reinitialization.then(() => { reinitialized = true; });
    await flushAsyncWork();
    expect(reinitialized).toBe(false);

    await transition.release();
    await reinitialization;
    expect(reinitialized).toBe(true);

    const disposeSuperseded = jest.fn().mockResolvedValue(undefined);
    supersededServices.resolve({ dispose: disposeSuperseded });
    await supersededInitialization;
    expect(disposeSuperseded).toHaveBeenCalledTimes(1);
    expect(ProviderWorkspaceRegistry.getIfInitialized('grok')).not.toBeNull();
  });

  it('holds auxiliary environment transitions only for affected providers until release', async () => {
    const releaseGrok = jest.fn().mockResolvedValue(undefined);
    const releaseCodex = jest.fn().mockResolvedValue(undefined);
    const beginGrok = jest.fn().mockResolvedValue({ release: releaseGrok });
    const beginCodex = jest.fn().mockResolvedValue({ release: releaseCodex });
    ProviderWorkspaceRegistry.setServices('grok', {
      beginAuxiliaryServicesEnvironmentChange: beginGrok,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      beginAuxiliaryServicesEnvironmentChange: beginCodex,
    });

    const transition = await ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);

    expect(beginGrok).toHaveBeenCalledTimes(1);
    expect(beginCodex).not.toHaveBeenCalled();
    expect(releaseGrok).not.toHaveBeenCalled();
    await transition.release();
    expect(releaseGrok).toHaveBeenCalledTimes(1);
  });

  it('releases acquired provider transitions when a later provider fails to begin', async () => {
    const releaseClaude = jest.fn().mockResolvedValue(undefined);
    ProviderWorkspaceRegistry.setServices('claude', {
      beginAuxiliaryServicesEnvironmentChange: jest.fn().mockResolvedValue({
        release: releaseClaude,
      }),
    });
    ProviderWorkspaceRegistry.setServices('grok', {
      beginAuxiliaryServicesEnvironmentChange: jest.fn()
        .mockRejectedValue(new Error('quiesce failed')),
    });

    await expect(ProviderWorkspaceRegistry.beginAuxiliaryServicesEnvironmentChange([
      'grok',
      'claude',
    ])).rejects.toThrow('quiesce failed');

    expect(releaseClaude).toHaveBeenCalledTimes(1);
    let admittedAfterRollback = false;
    void ProviderWorkspaceRegistry.ensureInitialized(
      createProviderHost(),
      'claude',
      'after-transition-rollback',
    ).then(() => { admittedAfterRollback = true; });
    await flushAsyncWork();
    expect(admittedAfterRollback).toBe(true);
  });
});
