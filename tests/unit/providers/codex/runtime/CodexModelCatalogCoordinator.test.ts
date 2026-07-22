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

function createHangingDiscovery(): {
  discovery: CodexModelDiscoveryServiceLike;
} {
  const discovery: CodexModelDiscoveryServiceLike = {
    discoverModels: jest.fn(async (signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (signal?.aborted) {
            reject(new Error('Cancelled'));
            return;
          }
          setTimeout(check, 5);
        };
        check();
        signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
      return { kind: 'completed', models: [] } as CodexModelDiscoveryResult;
    }),
  };
  return { discovery };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
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
    expect(FAKE_FINGERPRINT).toMatch(/^1:[a-f0-9]{64}$/);
  });

  it('returns cached models immediately when cache is fresh', async () => {
    const host = createFakeHost({
      discoveredModels: [makeModel('gpt-4o')],
    });
    const discovery = createDiscovery({ kind: 'completed', models: [] });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('test');

    expect(result.refreshed).toBe(false);
    expect(result.models).toEqual([makeModel('gpt-4o')]);
    expect(discovery.discoverModels).not.toHaveBeenCalled();
  });

  it('runs blocking refresh when cache is missing', async () => {
    const host = createFakeHost();
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('gpt-4o')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('test');

    expect(result.refreshed).toBe(true);
    expect(result.models).toEqual([makeModel('gpt-4o')]);
    expect(discovery.discoverModels).toHaveBeenCalledTimes(1);
  });

  it('waits for an explicitly forced refresh even when cache is fresh', async () => {
    const host = createFakeHost({
      discoveredModels: [makeModel('gpt-4o')],
    });
    const discovery = createDiscovery({
      kind: 'completed',
      diagnostics: 'interactive failure',
      models: [],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('model-picker', { force: true });

    expect(result.backgroundRefresh).toBeUndefined();
    expect(result.diagnostics).toBe('interactive failure');
    expect(discovery.discoverModels).toHaveBeenCalledTimes(1);
  });

  it('returns cached models and refreshes in the background when cache is stale', async () => {
    const host = createFakeHost({
      discoveredModels: [makeModel('gpt-4o')],
      catalogTimestamp: 1, // ancient, will be stale
    });
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('gpt-4o-mini')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('test');

    expect(result.refreshed).toBe(false);
    expect(result.models).toEqual([makeModel('gpt-4o')]);
    expect(result.backgroundRefresh).toBeDefined();
    await result.backgroundRefresh;
    expect(discovery.discoverModels).toHaveBeenCalledTimes(1);
  });

  it('preserves cached models when cache fingerprint resolution fails', async () => {
    const cachedModel = makeModel('gpt-4o');
    const host = createFakeHost({ discoveredModels: [cachedModel] });
    (host.getResolvedProviderCliPath as jest.Mock).mockRejectedValue(new Error('CLI lookup failed'));
    const discovery = createDiscovery({
      kind: 'completed',
      diagnostics: 'app-server unavailable',
      models: [],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('layout-ready');

    expect(result.models).toEqual([cachedModel]);
    expect(result.backgroundRefresh).toBeDefined();
    await expect(result.backgroundRefresh).resolves.toMatchObject({
      diagnostics: 'app-server unavailable',
      models: [cachedModel],
    });
  });

  it('skips refresh when provider is disabled', async () => {
    const host = createFakeHost({ enabled: false });
    const discovery = createDiscovery({ kind: 'completed', models: [] });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('test');

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
    expect(coordinator.getState()).toBe('failed');
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

  it('retries an explicit refresh when its discovery inputs change in flight', async () => {
    const host = createFakeHost();
    let signalFirstDiscoveryStarted!: () => void;
    let resolveFirstDiscovery!: (result: CodexModelDiscoveryResult) => void;
    const firstDiscoveryStarted = new Promise<void>((resolve) => {
      signalFirstDiscoveryStarted = resolve;
    });
    const firstDiscoveryResult = new Promise<CodexModelDiscoveryResult>((resolve) => {
      resolveFirstDiscovery = resolve;
    });
    const refreshedModel = makeModel('gpt-4o-mini');
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn()
        .mockImplementationOnce(async () => {
          signalFirstDiscoveryStarted();
          return firstDiscoveryResult;
        })
        .mockResolvedValueOnce({ kind: 'completed', models: [refreshedModel] }),
    };
    (host.mutateSettingsConditionally as jest.Mock).mockImplementation(async (mutation) => {
      await mutation(host.settings);
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const refresh = coordinator.refreshModelCatalog();
    await firstDiscoveryStarted;
    const codexConfig = (host.settings.providerConfigs as Record<string, Record<string, unknown>>).codex;
    codexConfig.environmentVariables = 'OPENAI_API_KEY=rotated';
    resolveFirstDiscovery({ kind: 'completed', models: [makeModel('gpt-4o')] });

    await expect(refresh).resolves.toEqual({ changed: true });
    expect(discovery.discoverModels).toHaveBeenCalledTimes(2);
    expect(getCodexProviderSettings(host.settings).discoveredModels).toEqual([refreshedModel]);
    await expect(coordinator.getStatus()).resolves.toBe('fresh');
  });

  it('invalidates cache when resolved CLI path changes', async () => {
    const host = createFakeHost({
      discoveredModels: [makeModel('gpt-4o')],
      resolvedCliPath: '/other/codex',
    });
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('gpt-4o')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const result = await coordinator.ensureFresh('test');

    expect(result.refreshed).toBe(false);
    expect(result.backgroundRefresh).toBeDefined();
    await result.backgroundRefresh;
    expect(discovery.discoverModels).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-progress refresh', async () => {
    const host = createFakeHost();
    const { discovery } = createHangingDiscovery();
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const refreshPromise = coordinator.refresh();
    coordinator.cancel();

    const result = await refreshPromise;
    expect(result.diagnostics).toMatch(/cancelled/i);
  });

  it('does not refresh after disposal', async () => {
    const host = createFakeHost();
    const discovery = createDiscovery({
      kind: 'completed',
      models: [makeModel('gpt-4o')],
    });
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    coordinator.dispose();
    const result = await coordinator.ensureFresh('layout-ready');

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

  it('startup resolves before discovery resolves', async () => {
    const host = createFakeHost();
    let resolved = false;
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn(async () => {
        await new Promise((res) => setTimeout(res, 10));
        resolved = true;
        return { kind: 'completed', models: [makeModel('gpt-4o')] } as CodexModelDiscoveryResult;
      }),
    };
    const coordinator = new CodexModelCatalogCoordinator(host, discovery);

    const refreshPromise = coordinator.refresh();
    expect(resolved).toBe(false);

    await refreshPromise;
    expect(resolved).toBe(true);
  });
});
