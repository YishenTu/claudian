const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  computeGrokEnvironmentHash,
  grokSettingsReconciler,
} from '@/providers/grok/env/GrokSettingsReconciler';
import type { GrokDiscoveredModel } from '@/providers/grok/models';
import {
  GrokModelCatalogCoordinator,
} from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import type {
  GrokModelCatalogDiscoveryResult,
  GrokModelCatalogServiceLike,
} from '@/providers/grok/runtime/GrokModelCatalogService';
import {
  clearCurrentGrokCatalog,
  DEFAULT_GROK_PROVIDER_SETTINGS,
  getCurrentGrokCatalog,
  getGrokProviderSettings,
} from '@/providers/grok/settings';

function makeModel(rawId: string, displayName = rawId): GrokDiscoveredModel {
  return {
    displayName,
    rawId,
    reasoningEfforts: [],
    supportsReasoning: false,
  };
}

function makeCatalog(overrides: Partial<NonNullable<ReturnType<typeof getCurrentGrokCatalog>>> = {}) {
  return {
    defaultModelId: 'kimi-coding',
    fingerprint: 'fingerprint-current',
    models: [makeModel('kimi-coding', 'Kimi')],
    refreshedAt: Date.now(),
    ...overrides,
  };
}

function makeHost(options: {
  catalog?: ReturnType<typeof makeCatalog> | null;
  enabled?: boolean;
  otherHostCatalog?: ReturnType<typeof makeCatalog>;
  visibleModels?: string[] | null;
} = {}): ProviderHost {
  const {
    catalog = null,
    enabled = true,
    otherHostCatalog = makeCatalog({ fingerprint: 'other', models: [makeModel('other-model')] }),
    visibleModels = null,
  } = options;
  const settings = {
    providerConfigs: {
      grok: {
        ...DEFAULT_GROK_PROVIDER_SETTINGS,
        catalogsByHost: {
          ...(catalog ? { 'device:current': catalog } : {}),
          'device:other': otherHostCatalog,
        },
        enabled,
        visibleModels,
      },
    },
  } as unknown as Record<string, unknown>;

  return {
    app: {},
    mutateSettingsConditionally: jest.fn(async (mutation) => {
      await mutation(settings as never);
    }),
    refreshModelSelectors: jest.fn(),
    settings,
  } as unknown as ProviderHost;
}

function makeService(
  result: GrokModelCatalogDiscoveryResult,
  currentFingerprint = 'fingerprint-current',
): GrokModelCatalogServiceLike {
  return {
    discoverCatalog: jest.fn(async () => result),
    getCatalogFingerprint: jest.fn(async () => currentFingerprint),
  };
}

function deferNextConditionalMutation(host: ProviderHost): {
  execute(): Promise<void>;
  queued: Promise<void>;
} {
  let executeMutation: (() => Promise<void>) | null = null;
  let resolveQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  (host.mutateSettingsConditionally as jest.Mock).mockImplementationOnce((mutation) =>
    new Promise<void>((resolve, reject) => {
      executeMutation = async () => {
        try {
          await mutation(host.settings);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      resolveQueued();
    }));
  return {
    async execute() {
      if (!executeMutation) {
        throw new Error('Conditional mutation has not been queued');
      }
      await executeMutation();
    },
    queued,
  };
}

function deferConditionalMutations(host: ProviderHost, count: number): {
  execute(index: number): Promise<void>;
  queued: Promise<void>;
} {
  const executions: Array<() => Promise<void>> = [];
  let resolveQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  (host.mutateSettingsConditionally as jest.Mock).mockImplementation((mutation) =>
    new Promise<void>((resolve, reject) => {
      let executed = false;
      executions.push(async () => {
        if (executed) return;
        executed = true;
        try {
          await mutation(host.settings);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      if (executions.length === count) resolveQueued();
    }));
  return {
    async execute(index) {
      const execution = executions[index];
      if (!execution) throw new Error(`Conditional mutation ${index} has not been queued`);
      await execution();
    },
    queued,
  };
}

function reconcileNewEnvironment(host: ProviderHost): void {
  (host.settings as any).providerConfigs.grok.environmentVariables = 'GROK_PROFILE=new-context';
  grokSettingsReconciler.reconcileModelWithEnvironment(host.settings, []);
}

function completedResult(overrides: Partial<Extract<GrokModelCatalogDiscoveryResult, { kind: 'completed' }>> = {}): Extract<GrokModelCatalogDiscoveryResult, { kind: 'completed' }> {
  return {
    defaultModelId: 'kimi-coding',
    fingerprint: 'fingerprint-current',
    kind: 'completed',
    models: [makeModel('kimi-coding', 'Kimi')],
    ...overrides,
  };
}

describe('GrokModelCatalogCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('returns the current-host cached catalog immediately when fresh', async () => {
    const cached = makeCatalog();
    const host = makeHost({ catalog: cached });
    const service = makeService(completedResult());
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    await expect(coordinator.ensureFresh('layout-ready')).resolves.toMatchObject({
      catalog: cached,
      changed: false,
      kind: 'completed',
      persistedSettingsChanged: false,
    });
    expect(service.discoverCatalog).not.toHaveBeenCalled();
  });

  it('returns stale cache and starts a background refresh', async () => {
    const cached = makeCatalog({ refreshedAt: 1 });
    const host = makeHost({ catalog: cached });
    const service = makeService(completedResult({
      models: [makeModel('glm-coding', 'GLM')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    const result = await coordinator.ensureFresh('layout-ready');

    expect(result).toMatchObject({ catalog: cached, changed: false });
    expect(result.backgroundRefresh).toBeDefined();
    await result.backgroundRefresh;
    expect(service.discoverCatalog).toHaveBeenCalledTimes(1);
  });

  it('runs a blocking refresh for a missing catalog and a forced refresh for a fresh one', async () => {
    const discovered = completedResult();
    const missingHost = makeHost();
    const missingService = makeService(discovered);
    const missingCoordinator = new GrokModelCatalogCoordinator(missingHost, missingService);

    await expect(missingCoordinator.ensureFresh('settings')).resolves.toMatchObject({
      changed: true,
      kind: 'completed',
      persistedSettingsChanged: true,
    });

    const freshHost = makeHost({ catalog: makeCatalog() });
    const freshService = makeService(discovered);
    const freshCoordinator = new GrokModelCatalogCoordinator(freshHost, freshService);
    const forced = await freshCoordinator.ensureFresh('settings', { force: true });

    expect(forced.backgroundRefresh).toBeUndefined();
    expect(freshService.discoverCatalog).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent refreshes', async () => {
    let resolveDiscovery!: (result: GrokModelCatalogDiscoveryResult) => void;
    const pending = new Promise<GrokModelCatalogDiscoveryResult>((resolve) => {
      resolveDiscovery = resolve;
    });
    const service: GrokModelCatalogServiceLike = {
      discoverCatalog: jest.fn(async () => pending),
      getCatalogFingerprint: jest.fn(async () => 'fingerprint-current'),
    };
    const coordinator = new GrokModelCatalogCoordinator(makeHost(), service);

    const first = coordinator.refresh();
    const second = coordinator.refresh();
    resolveDiscovery(completedResult());

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(service.discoverCatalog).toHaveBeenCalledTimes(1);
  });

  it('ignores an abort-insensitive non-owner discovery completing after its owner replacement', async () => {
    let resolveOld!: (result: GrokModelCatalogDiscoveryResult) => void;
    let resolveOwner!: (result: GrokModelCatalogDiscoveryResult) => void;
    const oldDiscovery = new Promise<GrokModelCatalogDiscoveryResult>(resolve => {
      resolveOld = resolve;
    });
    const ownerDiscovery = new Promise<GrokModelCatalogDiscoveryResult>(resolve => {
      resolveOwner = resolve;
    });
    const service: GrokModelCatalogServiceLike = {
      discoverCatalog: jest.fn()
        .mockImplementationOnce(() => oldDiscovery)
        .mockImplementationOnce(() => ownerDiscovery),
      getCatalogFingerprint: jest.fn(async () => 'fingerprint-current'),
    };
    const host = makeHost();
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    const oldRefresh = coordinator.refresh();
    await Promise.resolve();
    const ownerRefresh = coordinator.refresh({ providerTransitionOwner: true });
    resolveOwner(completedResult({
      defaultModelId: 'owner-model',
      fingerprint: 'owner-fingerprint',
      models: [makeModel('owner-model')],
    }));
    await ownerRefresh;
    resolveOld(completedResult({
      defaultModelId: 'old-model',
      fingerprint: 'old-fingerprint',
      models: [makeModel('old-model')],
    }));
    await oldRefresh;

    expect(host.mutateSettingsConditionally).toHaveBeenCalledTimes(1);
    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'owner-model',
      fingerprint: 'owner-fingerprint',
      models: [expect.objectContaining({ rawId: 'owner-model' })],
    });
    expect(coordinator.getState()).toBe('ready');
  });

  it('rejects an already queued non-owner write after the owner refresh persists', async () => {
    let resolveOld!: (result: GrokModelCatalogDiscoveryResult) => void;
    let resolveOwner!: (result: GrokModelCatalogDiscoveryResult) => void;
    const oldDiscovery = new Promise<GrokModelCatalogDiscoveryResult>(resolve => {
      resolveOld = resolve;
    });
    const ownerDiscovery = new Promise<GrokModelCatalogDiscoveryResult>(resolve => {
      resolveOwner = resolve;
    });
    const service: GrokModelCatalogServiceLike = {
      discoverCatalog: jest.fn()
        .mockImplementationOnce(() => oldDiscovery)
        .mockImplementationOnce(() => ownerDiscovery),
      getCatalogFingerprint: jest.fn(async () => 'fingerprint-current'),
    };
    const host = makeHost();
    const mutations = deferConditionalMutations(host, 2);
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    const oldRefresh = coordinator.refresh();
    resolveOld(completedResult({
      defaultModelId: 'old-model',
      fingerprint: 'old-fingerprint',
      models: [makeModel('old-model')],
    }));
    await new Promise(resolve => setImmediate(resolve));
    const ownerRefresh = coordinator.refresh({ providerTransitionOwner: true });
    resolveOwner(completedResult({
      defaultModelId: 'owner-model',
      fingerprint: 'owner-fingerprint',
      models: [makeModel('owner-model')],
    }));
    await mutations.queued;

    await mutations.execute(1);
    await ownerRefresh;
    await mutations.execute(0);
    await oldRefresh;

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'owner-model',
      fingerprint: 'owner-fingerprint',
      models: [expect.objectContaining({ rawId: 'owner-model' })],
    });
    expect(host.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });

  it('merges richer live ACP metadata by raw id and preserves CLI-only models', async () => {
    const host = makeHost({
      catalog: makeCatalog({
        models: [makeModel('kimi-coding', 'kimi-coding'), makeModel('glm-coding', 'GLM')],
      }),
    });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult()));

    await expect(coordinator.mergeLiveModels([{
      agentType: 'coding',
      contextWindow: 262_144,
      description: 'Rich live metadata',
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }])).resolves.toEqual({
      changed: true,
      persistedSettingsChanged: true,
    });

    expect(getCurrentGrokCatalog(host.settings)?.models).toEqual([
      expect.objectContaining({
        agentType: 'coding',
        contextWindow: 262_144,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
      }),
      expect.objectContaining({ rawId: 'glm-coding' }),
    ]);
  });

  it('persists live ACP reasoning metadata only for enabled models', async () => {
    const host = makeHost({
      catalog: makeCatalog({
        models: [makeModel('kimi-coding', 'Kimi'), {
          displayName: 'GLM',
          rawId: 'glm-coding',
          reasoningEfforts: [{ label: 'High', value: 'high' }],
          reasoningMetadataResolved: true,
          supportsReasoning: true,
        }],
      }),
      visibleModels: ['kimi-coding'],
    });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult()));

    await coordinator.mergeLiveModels([{
      displayName: 'Kimi',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }, {
      displayName: 'GLM',
      rawId: 'glm-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }]);

    expect(getCurrentGrokCatalog(host.settings)?.models).toEqual([
      expect.objectContaining({
        rawId: 'kimi-coding',
        reasoningMetadataResolved: true,
      }),
      expect.objectContaining({
        rawId: 'glm-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }),
    ]);
  });

  it('composes concurrent disjoint live-model deltas in serialized persistence', async () => {
    const host = makeHost({ catalog: makeCatalog({ models: [] }) });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult()));
    const deferred = deferConditionalMutations(host, 2);

    const first = coordinator.mergeLiveModels([makeModel('model-a')]);
    const second = coordinator.mergeLiveModels([makeModel('model-b')]);
    await deferred.queued;
    await deferred.execute(0);
    await deferred.execute(1);
    await Promise.all([first, second]);

    expect(getCurrentGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  it('composes richer metadata from concurrent live merges of the same model', async () => {
    const host = makeHost({ catalog: makeCatalog({ models: [] }) });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult()));
    const deferred = deferConditionalMutations(host, 2);

    const first = coordinator.mergeLiveModels([{
      contextWindow: 262_144,
      description: 'Live context metadata',
      displayName: 'Shared Coding',
      rawId: 'shared',
      reasoningEfforts: [],
      supportsReasoning: false,
    }]);
    const second = coordinator.mergeLiveModels([{
      displayName: 'shared',
      rawId: 'shared',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }]);
    await deferred.queued;
    await deferred.execute(0);
    await deferred.execute(1);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { changed: true, persistedSettingsChanged: true },
      { changed: false, persistedSettingsChanged: false },
    ]);

    expect(getCurrentGrokCatalog(host.settings)?.models).toEqual([
      expect.objectContaining({
        contextWindow: 262_144,
        description: 'Live context metadata',
        displayName: 'Shared Coding',
        rawId: 'shared',
        reasoningEfforts: [{ label: 'High', value: 'high' }],
        supportsReasoning: true,
      }),
    ]);
  });

  it('keeps the newest live default revision when concurrent mutations settle out of order', async () => {
    const host = makeHost({ catalog: makeCatalog({ defaultModelId: 'old-default', models: [] }) });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult()));
    const deferred = deferConditionalMutations(host, 2);

    const first = coordinator.mergeLiveModels([makeModel('model-a')], 'model-a');
    const second = coordinator.mergeLiveModels([makeModel('model-b')], 'model-b');
    await deferred.queued;
    await deferred.execute(1);
    await deferred.execute(0);
    await Promise.all([first, second]);

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'model-b',
      models: expect.arrayContaining([
        expect.objectContaining({ rawId: 'model-a' }),
        expect.objectContaining({ rawId: 'model-b' }),
      ]),
    });
  });

  it('keeps live models and the live native default authoritative across an in-flight refresh', async () => {
    let resolveDiscovery!: (result: GrokModelCatalogDiscoveryResult) => void;
    const discovery = new Promise<GrokModelCatalogDiscoveryResult>((resolve) => {
      resolveDiscovery = resolve;
    });
    const service: GrokModelCatalogServiceLike = {
      discoverCatalog: jest.fn(async () => discovery),
      getCatalogFingerprint: jest.fn(async () => 'fingerprint-next'),
    };
    const host = makeHost({
      catalog: makeCatalog({ defaultModelId: 'old-default', models: [makeModel('shared')] }),
    });
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    const refresh = coordinator.refresh();
    await coordinator.mergeLiveModels([{
      contextWindow: 262_144,
      displayName: 'Shared Live',
      rawId: 'shared',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }, makeModel('live-only', 'Live only')], 'live-default');
    resolveDiscovery(completedResult({
      defaultModelId: 'cli-default',
      fingerprint: 'fingerprint-next',
      models: [makeModel('shared', 'Shared CLI'), makeModel('cli-only', 'CLI only')],
    }));
    await refresh;

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'live-default',
      models: expect.arrayContaining([
        expect.objectContaining({ contextWindow: 262_144, rawId: 'shared' }),
        expect.objectContaining({ rawId: 'live-only' }),
        expect.objectContaining({ rawId: 'cli-only' }),
      ]),
    });
  });

  it('preserves a queued live merge when a later CLI refresh persists behind it', async () => {
    const host = makeHost({
      catalog: makeCatalog({
        defaultModelId: 'old-default',
        models: [makeModel('shared')],
      }),
    });
    const service = makeService(completedResult({
      defaultModelId: 'cli-default',
      fingerprint: 'fingerprint-next',
      models: [makeModel('shared', 'Shared CLI'), makeModel('cli-only', 'CLI only')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);
    const deferred = deferConditionalMutations(host, 2);

    const liveMerge = coordinator.mergeLiveModels([{
      contextWindow: 262_144,
      description: 'Rich live metadata',
      displayName: 'Shared Live',
      rawId: 'shared',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }, makeModel('live-only', 'Live only')], 'live-default');
    const refresh = coordinator.refresh();
    await deferred.queued;

    await deferred.execute(0);
    await deferred.execute(1);
    await Promise.all([liveMerge, refresh]);

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'live-default',
      fingerprint: 'fingerprint-next',
      models: [
        expect.objectContaining({
          contextWindow: 262_144,
          description: 'Rich live metadata',
          displayName: 'Shared Live',
          rawId: 'shared',
          reasoningEfforts: [{ label: 'High', value: 'high' }],
          supportsReasoning: true,
        }),
        expect.objectContaining({ rawId: 'cli-only' }),
        expect.objectContaining({ rawId: 'live-only' }),
      ],
    });
    expect(getCurrentGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual([
      'shared',
      'cli-only',
      'live-only',
    ]);
  });

  it('lets a later sequential CLI refresh drop live-only ids and replace the live default', async () => {
    const host = makeHost({
      catalog: makeCatalog({ defaultModelId: 'old-default', models: [makeModel('shared')] }),
    });
    const service = makeService(completedResult({
      defaultModelId: 'cli-default',
      fingerprint: 'fingerprint-next',
      models: [makeModel('cli-only'), makeModel('shared')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    await coordinator.mergeLiveModels([{
      contextWindow: 262_144,
      displayName: 'Shared Live',
      rawId: 'shared',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }, makeModel('live-only', 'Live only')], 'live-default');
    await coordinator.refresh();

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'cli-default',
      models: [
        expect.objectContaining({ rawId: 'cli-only' }),
        expect.objectContaining({
          contextWindow: 262_144,
          displayName: 'Shared Live',
          rawId: 'shared',
        }),
      ],
    });
    expect(getCurrentGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual([
      'cli-only',
      'shared',
    ]);
  });

  it('does not carry live models or defaults into a changed runtime context', async () => {
    const host = makeHost({ catalog: makeCatalog() });
    const service = makeService(completedResult({
      defaultModelId: 'new-default',
      fingerprint: 'new-context-fingerprint',
      models: [makeModel('new-default')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);
    const oldContextKey = computeGrokEnvironmentHash(host.settings);

    await coordinator.mergeLiveModels(
      [makeModel('old-live-only')],
      'old-live-default',
      oldContextKey,
    );
    const config = (host.settings as any).providerConfigs.grok;
    config.environmentVariables = 'GROK_PROFILE=new-context';
    clearCurrentGrokCatalog(host.settings);

    await expect(coordinator.mergeLiveModels(
      [makeModel('late-old-live')],
      'late-old-default',
      oldContextKey,
    )).resolves.toEqual({ changed: false });
    await coordinator.refresh();

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'new-default',
      models: [expect.objectContaining({ rawId: 'new-default' })],
    });
  });

  it('does not persist a live merge after a queued environment reconciliation clears it', async () => {
    const host = makeHost({ catalog: makeCatalog() });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult()));
    const deferred = deferNextConditionalMutation(host);

    const merge = coordinator.mergeLiveModels([makeModel('stale-live')], 'stale-default');
    await deferred.queued;
    reconcileNewEnvironment(host);
    expect(getCurrentGrokCatalog(host.settings)).toBeNull();

    await deferred.execute();

    await expect(merge).resolves.toEqual({ changed: false, persistedSettingsChanged: false });
    expect(getCurrentGrokCatalog(host.settings)).toBeNull();
  });

  it('does not persist a completed CLI refresh after a queued environment reconciliation clears it', async () => {
    const host = makeHost({ catalog: makeCatalog() });
    const coordinator = new GrokModelCatalogCoordinator(host, makeService(completedResult({
      defaultModelId: 'stale-cli',
      fingerprint: 'stale-fingerprint',
      models: [makeModel('stale-cli')],
    })));
    const deferred = deferNextConditionalMutation(host);

    const refresh = coordinator.refresh();
    await deferred.queued;
    reconcileNewEnvironment(host);
    expect(getCurrentGrokCatalog(host.settings)).toBeNull();

    await deferred.execute();

    await expect(refresh).resolves.toMatchObject({
      changed: false,
      persistedSettingsChanged: false,
    });
    expect(getCurrentGrokCatalog(host.settings)).toBeNull();
  });

  it('retains live ACP metadata for surviving ids across a later CLI refresh', async () => {
    const host = makeHost({
      catalog: makeCatalog({
        defaultModelId: 'model-a',
        models: [makeModel('model-a'), makeModel('removed-model')],
      }),
    });
    const service = makeService(completedResult({
      defaultModelId: 'new-model',
      fingerprint: 'fingerprint-next',
      models: [makeModel('new-model'), makeModel('model-a')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    await coordinator.mergeLiveModels([{
      agentType: 'coding',
      contextWindow: 262_144,
      defaultReasoningEffort: 'high',
      description: 'Enriched by live ACP',
      displayName: 'Model A Coding',
      rawId: 'model-a',
      reasoningEfforts: [{ description: 'Deep reasoning', label: 'High', value: 'high' }],
      supportsReasoning: true,
    }]);
    await coordinator.refresh();

    expect(getCurrentGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'new-model',
      fingerprint: 'fingerprint-next',
      models: [
        expect.objectContaining({
          displayName: 'new-model',
          rawId: 'new-model',
          reasoningEfforts: [],
          supportsReasoning: false,
        }),
        expect.objectContaining({
          agentType: 'coding',
          contextWindow: 262_144,
          defaultReasoningEffort: 'high',
          description: 'Enriched by live ACP',
          displayName: 'Model A Coding',
          rawId: 'model-a',
          reasoningEfforts: [{
            description: 'Deep reasoning',
            label: 'High',
            value: 'high',
          }],
          supportsReasoning: true,
        }),
      ],
    });
    expect(getCurrentGrokCatalog(host.settings)?.models.map(model => model.rawId)).not
      .toContain('removed-model');
  });

  it('retains the prior snapshot and other-host catalog when refresh fails', async () => {
    const cached = makeCatalog();
    const other = makeCatalog({ fingerprint: 'other-host-fingerprint' });
    const host = makeHost({ catalog: cached, otherHostCatalog: other });
    const service = makeService(completedResult({
      diagnostics: 'Grok models timed out',
      models: [],
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    await expect(coordinator.refresh()).resolves.toMatchObject({
      catalog: cached,
      changed: false,
      diagnostics: 'Grok models timed out',
      persistedSettingsChanged: false,
    });
    expect(getCurrentGrokCatalog(host.settings)).toEqual(cached);
    expect(getGrokProviderSettings(host.settings).catalogsByHost['device:other']).toEqual(other);
    expect(host.mutateSettingsConditionally).not.toHaveBeenCalled();
  });

  it('reports persisted timestamp/fingerprint changes separately from catalog changes', async () => {
    const cached = makeCatalog();
    const host = makeHost({ catalog: cached });
    const service = makeService(completedResult({
      fingerprint: 'new-fingerprint',
    }));
    const coordinator = new GrokModelCatalogCoordinator(host, service);

    await expect(coordinator.refreshModelCatalog()).resolves.toEqual({
      changed: false,
      persistedSettingsChanged: true,
    });
  });

  it('skips refresh when disabled and stops refresh after disposal', async () => {
    const disabledHost = makeHost({ enabled: false });
    const disabledService = makeService(completedResult());
    const disabled = new GrokModelCatalogCoordinator(disabledHost, disabledService);
    await expect(disabled.ensureFresh('layout-ready')).resolves.toMatchObject({
      changed: false,
      kind: 'skipped',
    });
    expect(disabledService.discoverCatalog).not.toHaveBeenCalled();

    const service = makeService(completedResult());
    const disposed = new GrokModelCatalogCoordinator(makeHost(), service);
    disposed.dispose();
    await expect(disposed.refresh()).resolves.toMatchObject({
      changed: false,
      kind: 'skipped',
    });
    expect(service.discoverCatalog).not.toHaveBeenCalled();
  });
});
