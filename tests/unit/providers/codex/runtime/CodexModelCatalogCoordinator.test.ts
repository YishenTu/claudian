import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { CodexDiscoveredModel } from '@/providers/codex/models';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import { buildCodexCatalogFingerprint } from '@/providers/codex/runtime/CodexModelCatalogFingerprint';
import type {
  CodexModelDiscoveryResult,
  CodexModelDiscoveryServiceLike,
} from '@/providers/codex/runtime/CodexModelDiscoveryService';
import {
  DEFAULT_CODEX_PROVIDER_SETTINGS,
  getCodexProviderSettings,
} from '@/providers/codex/settings';

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    normalizeAllModelVariants: jest.fn(() => false),
  },
}));

function makeModel(model: string, displayName = model): CodexDiscoveredModel {
  return {
    model,
    displayName,
    description: `${model} description`,
    supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'],
    isDefault: false,
  };
}

const PLATFORM_OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const FAKE_FINGERPRINT = buildCodexCatalogFingerprint({
  resolvedCliCommand: '/usr/bin/codex',
  executionTargetKey: `host-native:unix:${PLATFORM_OS}:`,
  envHash: 'OPENAI_API_KEY=secret',
});

function createFakeHost(overrides: {
  enabled?: boolean;
  discoveredModels?: CodexDiscoveredModel[];
  catalogFingerprint?: string;
  catalogTimestamp?: number;
  resolvedCliPath?: string | null;
  envText?: string;
} = {}): ProviderHost {
  const {
    enabled = true,
    discoveredModels = [],
    catalogFingerprint = discoveredModels.length > 0 ? FAKE_FINGERPRINT : '',
    catalogTimestamp = discoveredModels.length > 0 ? Date.now() : 0,
    resolvedCliPath = '/usr/bin/codex',
    envText = 'OPENAI_API_KEY=secret',
  } = overrides;

  return {
    app: {
      vault: {
        adapter: {
          basePath: '/vault',
        },
      },
      workspace: {
        onLayoutReady: jest.fn(),
      },
    },
    settings: {
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled,
          discoveredModels,
          visibleModels: null,
          catalogFingerprint,
          catalogTimestamp,
          environmentVariables: envText,
        },
      },
      environmentVariables: {},
    },
    getResolvedProviderCliPath: jest.fn(() => resolvedCliPath),
    getActiveEnvironmentVariables: jest.fn(() => envText),
    notifyProviderChatOptionsChanged: jest.fn(),
    mutateSettingsConditionally: jest.fn(async (mutation) => {
      return mutation({
        ...DEFAULT_CODEX_PROVIDER_SETTINGS,
        providerConfigs: {
          codex: {
            ...DEFAULT_CODEX_PROVIDER_SETTINGS,
            enabled,
            discoveredModels,
            visibleModels: null,
            catalogFingerprint,
            catalogTimestamp,
            environmentVariables: envText,
          },
        },
        environmentVariables: {},
      } as unknown as Record<string, unknown>);
    }),
  } as unknown as ProviderHost;
}

function createDiscovery(result: CodexModelDiscoveryResult): CodexModelDiscoveryServiceLike {
  return {
    discoverModels: jest.fn(async () => result),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

function deferConditionalMutations(host: ProviderHost, count: number): {
  execute(index: number): Promise<boolean | void>;
  queued: Promise<void>;
} {
  const executions: Array<() => Promise<boolean | void>> = [];
  let resolveQueued!: () => void;
  const queued = new Promise<void>(resolve => { resolveQueued = resolve; });
  (host.mutateSettingsConditionally as jest.Mock).mockImplementation((mutation) => (
    new Promise<boolean | void>((resolve, reject) => {
      executions.push(async () => {
        try {
          const result = await mutation(host.settings);
          resolve(result);
          return result;
        } catch (error) {
          reject(error);
        }
      });
      if (executions.length === count) resolveQueued();
    })
  ));
  return {
    async execute(index) {
      const execution = executions[index];
      if (!execution) throw new Error(`Conditional mutation ${index} was not queued`);
      return execution();
    },
    queued,
  };
}

describe('CodexModelCatalogCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not expose environment secrets in the catalog fingerprint', () => {
    expect(FAKE_FINGERPRINT).not.toContain('secret');
    expect(FAKE_FINGERPRINT).toMatch(/^2:[a-f0-9]{64}$/);
  });

  it('skips refresh when provider is disabled', async () => {
    const host = createFakeHost({ enabled: false });
    const discovery = createDiscovery({ kind: 'completed', models: [] });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.refresh();

    expect(result.kind).toBe('skipped');
    expect(discovery.discoverModels).not.toHaveBeenCalled();
  });

  it('preserves cached models when refresh fails', async () => {
    const host = createFakeHost({
      discoveredModels: [makeModel('gpt-4o')],
      catalogFingerprint: 'stale-fingerprint',
    });
    const discovery = createDiscovery({
      kind: 'completed',
      diagnostics: 'app-server unreachable',
      models: [],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.refresh();

    expect(result.models).toEqual([makeModel('gpt-4o')]);
    expect(result.diagnostics).toBe('app-server unreachable');
  });

  it('deduplicates concurrent refresh requests', async () => {
    const host = createFakeHost();
    let calls = 0;
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn(async () => {
        calls += 1;
        return { kind: 'completed', models: [makeModel('gpt-4o')] } as CodexModelDiscoveryResult;
      }),
    };
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const [first, second] = await Promise.all([
      coordinator.refresh(),
      coordinator.refresh(),
    ]);

    expect(calls).toBe(1);
    expect(first.models).toEqual(second.models);
  });

  it('rejects the fingerprint captured before discovery when its context changes', async () => {
    const host = createFakeHost();
    let signalDiscoveryStarted!: () => void;
    let resolveDiscovery!: (result: CodexModelDiscoveryResult) => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      signalDiscoveryStarted = resolve;
    });
    const discoveryResult = new Promise<CodexModelDiscoveryResult>((resolve) => {
      resolveDiscovery = resolve;
    });
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn(async () => {
        signalDiscoveryStarted();
        return discoveryResult;
      }),
    };
    (host.mutateSettingsConditionally as jest.Mock).mockImplementation(async (mutation) => {
      await mutation(host.settings);
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const refresh = coordinator.refresh();
    await discoveryStarted;
    const codexConfig = (host.settings.providerConfigs as Record<string, Record<string, unknown>>).codex;
    codexConfig.environmentVariables = 'OPENAI_API_KEY=rotated';
    resolveDiscovery({ kind: 'completed', models: [makeModel('gpt-4o')] });
    await refresh;

    expect(getCodexProviderSettings(host.settings).catalogFingerprint).toBe('');
    expect(getCodexProviderSettings(host.settings).discoveredModels).toEqual([]);
  });

  it('rejects a superseded late catalog write after the owner refresh persists', async () => {
    const host = createFakeHost();
    const firstDiscovery = deferred<CodexModelDiscoveryResult>();
    const secondDiscovery = deferred<CodexModelDiscoveryResult>();
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn()
        .mockImplementationOnce(() => firstDiscovery.promise)
        .mockImplementationOnce(() => secondDiscovery.promise),
    };
    const mutations = deferConditionalMutations(host, 2);
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const oldRefresh = coordinator.refresh();
    while ((discovery.discoverModels as jest.Mock).mock.calls.length < 1) {
      await Promise.resolve();
    }
    firstDiscovery.resolve({ kind: 'completed', models: [makeModel('old-model')] });
    await new Promise(resolve => setImmediate(resolve));
    const ownerRefresh = coordinator.refresh({ providerTransitionOwner: true });
    while ((discovery.discoverModels as jest.Mock).mock.calls.length < 2) {
      await Promise.resolve();
    }
    secondDiscovery.resolve({ kind: 'completed', models: [makeModel('new-model')] });
    await mutations.queued;
    await mutations.execute(1);
    await ownerRefresh;

    await expect(mutations.execute(0)).resolves.toBe(false);
    await oldRefresh;

    expect(getCodexProviderSettings(host.settings).discoveredModels).toEqual([
      makeModel('new-model'),
    ]);
    expect(ProviderSettingsCoordinator.normalizeAllModelVariants).toHaveBeenCalledTimes(1);
  });

  it('rejects a queued catalog write after disposal', async () => {
    const host = createFakeHost();
    const mutations = deferConditionalMutations(host, 1);
    const coordinator = new CodexModelCatalogCoordinator(host, createDiscovery({
      kind: 'completed',
      models: [makeModel('disposed-model')],
    }));

    const refresh = coordinator.refresh();
    await mutations.queued;
    coordinator.dispose();
    await expect(mutations.execute(0)).resolves.toBe(false);
    await refresh;

    expect(getCodexProviderSettings(host.settings).discoveredModels).toEqual([]);
    expect(ProviderSettingsCoordinator.normalizeAllModelVariants).not.toHaveBeenCalled();
  });

  it('rejects a queued catalog write when its fingerprint context changes', async () => {
    const host = createFakeHost();
    const mutations = deferConditionalMutations(host, 1);
    const coordinator = new CodexModelCatalogCoordinator(host, createDiscovery({
      kind: 'completed',
      models: [makeModel('stale-context-model')],
    }));

    const refresh = coordinator.refresh();
    await mutations.queued;
    const codexConfig = (host.settings.providerConfigs as Record<string, Record<string, unknown>>)
      .codex;
    codexConfig.environmentVariables = 'OPENAI_API_KEY=rotated';
    await expect(mutations.execute(0)).resolves.toBe(false);
    await refresh;

    expect(getCodexProviderSettings(host.settings).discoveredModels).toEqual([]);
    expect(ProviderSettingsCoordinator.normalizeAllModelVariants).not.toHaveBeenCalled();
  });

  it('skips discovery when canceled before launch context resolves', async () => {
    const host = createFakeHost();
    const discovery = createDiscovery({ kind: 'completed', models: [] });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const refreshPromise = coordinator.refresh();
    coordinator.cancel();

    const result = await refreshPromise;
    expect(result).toMatchObject({ kind: 'skipped', refreshed: false });
    expect(discovery.discoverModels).not.toHaveBeenCalled();
  });

  it('aborts and awaits a held refresh while invalidating its environment cache', async () => {
    const cachedModel = makeModel('cached-model');
    const oldDiscovery = deferred<CodexModelDiscoveryResult>();
    let discoverySignal: AbortSignal | undefined;
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn((signal?: AbortSignal) => {
        discoverySignal = signal;
        return oldDiscovery.promise;
      }),
    };
    const host = createFakeHost({ discoveredModels: [cachedModel] });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);
    const refresh = coordinator.refresh();
    await waitForCondition(() => discoverySignal !== undefined);

    const quiesce = coordinator.quiesceForEnvironmentChange();
    let quiesceSettled = false;
    void quiesce.then(() => { quiesceSettled = true; });
    await Promise.resolve();

    expect(discoverySignal).toBeDefined();
    expect(discoverySignal!.aborted).toBe(true);
    expect(quiesceSettled).toBe(false);

    oldDiscovery.resolve({
      kind: 'completed',
      models: [makeModel('old-environment-model')],
    });
    await quiesce;
    await refresh;

    expect(getCodexProviderSettings(host.settings).discoveredModels).toEqual([cachedModel]);
    expect(host.mutateSettingsConditionally).not.toHaveBeenCalled();
  });

  it('blocks model discovery during an environment transition and uses the new state after it', async () => {
    const host = createFakeHost();
    const observedEnvironments: string[] = [];
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn(async () => {
        observedEnvironments.push(host.getActiveEnvironmentVariables('codex'));
        return {
          kind: 'completed' as const,
          models: [makeModel('new-environment-model')],
        };
      }),
    };
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);
    coordinator.beginEnvironmentTransition();
    await coordinator.quiesceForEnvironmentChange();

    const refresh = coordinator.refresh();
    try {
      await Promise.resolve();
      expect(discovery.discoverModels).not.toHaveBeenCalled();

      (host.getActiveEnvironmentVariables as jest.Mock).mockReturnValue('NEW_API_KEY=updated');
      coordinator.endEnvironmentTransition();
      await expect(refresh).resolves.toMatchObject({ kind: 'completed' });
    } finally {
      coordinator.endEnvironmentTransition();
      await Promise.allSettled([refresh]);
      await coordinator.dispose();
    }

    expect(observedEnvironments).toEqual(['NEW_API_KEY=updated']);
  });

  it('releases transition-blocked model requests as skipped on disposal', async () => {
    const host = createFakeHost();
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('should-not-start')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);
    coordinator.beginEnvironmentTransition();

    const refresh = coordinator.refresh();
    await coordinator.dispose();

    await expect(refresh).resolves.toMatchObject({ kind: 'skipped' });
    expect(discovery.discoverModels).not.toHaveBeenCalled();
  });

  it('does not refresh after disposal', async () => {
    const host = createFakeHost();
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('gpt-4o')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    coordinator.dispose();
    const result = await coordinator.refresh();

    expect(result.kind).toBe('skipped');
    expect(discovery.discoverModels).not.toHaveBeenCalled();
    expect(host.mutateSettingsConditionally).not.toHaveBeenCalled();
  });

  it('persists catalog after successful refresh', async () => {
    const host = createFakeHost();
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('gpt-4o')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    await coordinator.refresh();

    expect(host.mutateSettingsConditionally).toHaveBeenCalled();
    await expect(
      (host.mutateSettingsConditionally as jest.Mock).mock.results[0].value,
    ).resolves.toBe(true);
  });
});

it('does not join canceled discovery from a new native caller or publish its delayed result', async () => {
  const host = createFakeHost();
  jest.mocked(host.mutateSettingsConditionally).mockImplementation(async mutation => { await mutation(host.settings); });
  const oldResult = deferred<CodexModelDiscoveryResult>();
  const discoverModels = jest.fn()
    .mockImplementationOnce(() => oldResult.promise)
    .mockResolvedValueOnce({ kind: 'completed', models: [makeModel('fresh-model')] });
  const catalog = new CodexModelCatalogCoordinator(host, { discoverModels });
  const old = catalog.refresh();
  await waitForCondition(() => discoverModels.mock.calls.length === 1);
  catalog.cancel();
  const replacement = catalog.refresh();
  await waitForCondition(() => discoverModels.mock.calls.length === 2);
  await replacement;
  expect(getCodexProviderSettings(host.settings).discoveredModels.map(model => model.model)).toEqual(['fresh-model']);
  let disposed = false;
  const disposal = catalog.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  oldResult.resolve({ kind: 'completed', models: [makeModel('obsolete-model')] });
  await Promise.all([old, disposal]);
  expect(getCodexProviderSettings(host.settings).discoveredModels.map(model => model.model)).toEqual(['fresh-model']);
  expect(host.notifyProviderChatOptionsChanged).toHaveBeenCalledTimes(1);
});
