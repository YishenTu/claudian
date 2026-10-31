import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { grokEnvironmentHash, readGrokCatalog } from '@test/helpers/providers/grokSettings';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { DEFAULT_GROK_PROVIDER_SETTINGS } from '@/providers/grok/config';
import { grokSettingsReconciler } from '@/providers/grok/env/GrokSettingsReconciler';
import type { GrokDiscoveredModel } from '@/providers/grok/models';
import {
  GrokModelCatalogCoordinator,
} from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import type {
  GrokModelCatalogDiscoveryResult,
  GrokModelDiscoveryServiceLike,
} from '@/providers/grok/runtime/GrokModelDiscoveryService';
import {
  getGrokProviderSettings,
  updateGrokProviderSettings,
} from '@/providers/grok/settings';

function makeModel(rawId: string, displayName = rawId): GrokDiscoveredModel {
  return {
    displayName,
    rawId,
    reasoningEfforts: [],
    supportsReasoning: false,
  };
}

function makeCatalog(overrides: Partial<NonNullable<ReturnType<typeof readGrokCatalog>>> = {}) {
  return {
    defaultModelId: 'kimi-coding',
    fingerprint: 'fingerprint-current',
    models: [makeModel('kimi-coding', 'Kimi')],
    refreshedAt: Date.now(),
    ...overrides,
  };
}

async function makeHost(options: {
  catalog?: ReturnType<typeof makeCatalog> | null;
  enabled?: boolean;
  otherHostCatalog?: ReturnType<typeof makeCatalog>;
  visibleModels?: string[] | null;
} = {}): Promise<ProviderHost> {
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
          ...(catalog ? { [getInstallationKey()]: catalog } : {}),
          'device:other': otherHostCatalog,
        },
        enabled,
        visibleModels,
      },
    },
  };

  const { host } = await createProviderHostFixture({ settings, overrides: { notifyProviderChatOptionsChanged: vi.fn() } });
  const runtime = host.getRuntimeHost('grok');
  const update = runtime.updateConfig;
  vi.spyOn(runtime, 'updateConfig').mockImplementation(update);
  vi.spyOn(host, 'getRuntimeHost').mockReturnValue(runtime);
  return host;
}

function runtimeHost(host: ProviderHost): ProviderRuntimeHost {
  return host.getRuntimeHost('grok');
}

function makeService(
  result: GrokModelCatalogDiscoveryResult,
): GrokModelDiscoveryServiceLike {
  return {
    discoverCatalog: vi.fn(async () => result),
  };
}

function deferNextConditionalMutation(host: ProviderHost): {
  execute(): Promise<void>;
  queued: Promise<void>;
} {
  const update = vi.mocked(runtimeHost(host).updateConfig).getMockImplementation()!;
  let executeMutation: (() => Promise<void>) | null = null;
  let resolveQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  vi.mocked(runtimeHost(host).updateConfig).mockImplementationOnce((mutation) =>
    new Promise<boolean>((resolve, reject) => {
      executeMutation = async () => {
        try {
          resolve(await update(mutation));
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
  const update = vi.mocked(runtimeHost(host).updateConfig).getMockImplementation()!;
  const executions: Array<() => Promise<void>> = [];
  let resolveQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  vi.mocked(runtimeHost(host).updateConfig).mockImplementation((mutation) =>
    new Promise<boolean>((resolve, reject) => {
      let executed = false;
      executions.push(async () => {
        if (executed) return;
        executed = true;
        try {
          resolve(await update(mutation));
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
  host.settings.providerConfigs!.grok!.environmentVariables = 'GROK_PROFILE=new-context';
  grokSettingsReconciler.reconcileModelWithEnvironment(host.settings);
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
    vi.clearAllMocks();
  });

  it('aborts and drains an in-flight refresh before clearing transition state', async () => {
    let resolveDiscovery!: (result: GrokModelCatalogDiscoveryResult) => void;
    let discoverySignal: AbortSignal | undefined;
    const pending = new Promise<GrokModelCatalogDiscoveryResult>((resolve) => {
      resolveDiscovery = resolve;
    });
    const service: GrokModelDiscoveryServiceLike = {
      discoverCatalog: vi.fn(async (signal) => {
        discoverySignal = signal;
        return pending;
      }),
    };
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost((await makeHost())), service);
    const refresh = coordinator.refresh();
    while (!discoverySignal) await Promise.resolve();
    let quiesced = false;

    const transition = coordinator.quiesceForEnvironmentChange().then(() => {
      quiesced = true;
    });
    await Promise.resolve();

    expect(discoverySignal.aborted).toBe(true);
    expect(quiesced).toBe(false);
    resolveDiscovery(completedResult());
    await Promise.all([refresh, transition]);
    expect(quiesced).toBe(true);
  });

  it('admits only transition-owner refreshes while fenced and releases waiters on disposal', async () => {
    const service = makeService(completedResult());
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost((await makeHost())), service);
    coordinator.beginEnvironmentTransition();

    const ordinaryRefresh = coordinator.refresh();
    await Promise.resolve();
    expect(service.discoverCatalog).not.toHaveBeenCalled();

    await expect(coordinator.refresh({ providerTransitionOwner: true })).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(service.discoverCatalog).toHaveBeenCalledTimes(1);

    coordinator.endEnvironmentTransition();
    await ordinaryRefresh;
    expect(service.discoverCatalog).toHaveBeenCalledTimes(2);

    coordinator.beginEnvironmentTransition();
    const fencedMerge = coordinator.mergeLiveModels([makeModel('never-persisted')]);
    coordinator.dispose();
    await expect(fencedMerge).resolves.toEqual({ changed: false });
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
    const service: GrokModelDiscoveryServiceLike = {
      discoverCatalog: vi.fn()
        .mockImplementationOnce(() => oldDiscovery)
        .mockImplementationOnce(() => ownerDiscovery),
    };
    const host = (await makeHost());
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);

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

    expect(runtimeHost(host).updateConfig).toHaveBeenCalledTimes(1);
    expect(readGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'owner-model',
      fingerprint: 'owner-fingerprint',
      models: [expect.objectContaining({ rawId: 'owner-model' })],
    });
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
    const service: GrokModelDiscoveryServiceLike = {
      discoverCatalog: vi.fn()
        .mockImplementationOnce(() => oldDiscovery)
        .mockImplementationOnce(() => ownerDiscovery),
    };
    const host = (await makeHost());
    const mutations = deferConditionalMutations(host, 2);
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);

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

    expect(readGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'owner-model',
      fingerprint: 'owner-fingerprint',
      models: [expect.objectContaining({ rawId: 'owner-model' })],
    });
    expect(host.notifyProviderChatOptionsChanged).toHaveBeenCalledWith('grok');
  });

  it('composes concurrent disjoint live-model deltas in serialized persistence', async () => {
    const host = (await makeHost({ catalog: makeCatalog({ models: [] }) }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), makeService(completedResult()));
    const deferred = deferConditionalMutations(host, 2);

    const first = coordinator.mergeLiveModels([makeModel('model-a')]);
    const second = coordinator.mergeLiveModels([makeModel('model-b')]);
    await deferred.queued;
    await deferred.execute(0);
    await deferred.execute(1);
    await Promise.all([first, second]);

    expect(readGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  it('composes richer metadata from concurrent live merges of the same model', async () => {
    const host = (await makeHost({ catalog: makeCatalog({ models: [] }) }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), makeService(completedResult()));
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

    expect(readGrokCatalog(host.settings)?.models).toEqual([
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
    const host = (await makeHost({ catalog: makeCatalog({ defaultModelId: 'old-default', models: [] }) }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), makeService(completedResult()));
    const deferred = deferConditionalMutations(host, 2);

    const first = coordinator.mergeLiveModels([makeModel('model-a')], 'model-a');
    const second = coordinator.mergeLiveModels([makeModel('model-b')], 'model-b');
    await deferred.queued;
    await deferred.execute(1);
    await deferred.execute(0);
    await Promise.all([first, second]);

    expect(readGrokCatalog(host.settings)).toMatchObject({
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
    const service: GrokModelDiscoveryServiceLike = {
      discoverCatalog: vi.fn(async () => discovery),
    };
    const host = (await makeHost({
      catalog: makeCatalog({ defaultModelId: 'old-default', models: [makeModel('shared')] }),
    }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);

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

    expect(readGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'live-default',
      models: expect.arrayContaining([
        expect.objectContaining({ contextWindow: 262_144, rawId: 'shared' }),
        expect.objectContaining({ rawId: 'live-only' }),
        expect.objectContaining({ rawId: 'cli-only' }),
      ]),
    });
  });

  it('preserves a queued live merge when a later CLI refresh persists behind it', async () => {
    const host = (await makeHost({
      catalog: makeCatalog({
        defaultModelId: 'old-default',
        models: [makeModel('shared')],
      }),
    }));
    const service = makeService(completedResult({
      defaultModelId: 'cli-default',
      fingerprint: 'fingerprint-next',
      models: [makeModel('shared', 'Shared CLI'), makeModel('cli-only', 'CLI only')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);
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

    expect(readGrokCatalog(host.settings)).toMatchObject({
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
    expect(readGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual([
      'shared',
      'cli-only',
      'live-only',
    ]);
  });

  it('does not carry live models or defaults into a changed runtime context', async () => {
    const host = (await makeHost({ catalog: makeCatalog() }));
    const service = makeService(completedResult({
      defaultModelId: 'new-default',
      fingerprint: 'new-context-fingerprint',
      models: [makeModel('new-default')],
    }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);
    const oldContextKey = grokEnvironmentHash(host.settings);

    await coordinator.mergeLiveModels(
      [makeModel('old-live-only')],
      'old-live-default',
      oldContextKey,
    );
    const config = host.settings.providerConfigs!.grok!;
    config.environmentVariables = 'GROK_PROFILE=new-context';
    const catalogsByHost = { ...getGrokProviderSettings(host.settings).catalogsByHost };
    delete catalogsByHost[getInstallationKey()];
    updateGrokProviderSettings(host.settings, { catalogsByHost });

    await expect(coordinator.mergeLiveModels(
      [makeModel('late-old-live')],
      'late-old-default',
      oldContextKey,
    )).resolves.toEqual({ changed: false });
    await coordinator.refresh();

    expect(readGrokCatalog(host.settings)).toMatchObject({
      defaultModelId: 'new-default',
      models: [expect.objectContaining({ rawId: 'new-default' })],
    });
  });

  it('does not persist a live merge after a queued environment reconciliation supersedes it', async () => {
    const host = (await makeHost({ catalog: makeCatalog() }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), makeService(completedResult()));
    const deferred = deferNextConditionalMutation(host);

    const merge = coordinator.mergeLiveModels([makeModel('stale-live')], 'stale-default');
    await deferred.queued;
    reconcileNewEnvironment(host);
    expect(readGrokCatalog(host.settings)?.models[0].rawId).toBe('kimi-coding');

    await deferred.execute();

    await expect(merge).resolves.toEqual({ changed: false, persistedSettingsChanged: false });
    expect(readGrokCatalog(host.settings)?.models[0].rawId).toBe('kimi-coding');
  });

  it('does not persist a completed CLI refresh after a queued environment reconciliation clears it', async () => {
    const host = (await makeHost({ catalog: makeCatalog() }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), makeService(completedResult({
      defaultModelId: 'stale-cli',
      fingerprint: 'stale-fingerprint',
      models: [makeModel('stale-cli')],
    })));
    const deferred = deferNextConditionalMutation(host);

    const refresh = coordinator.refresh();
    await deferred.queued;
    reconcileNewEnvironment(host);
    expect(readGrokCatalog(host.settings)?.models[0].rawId).toBe('kimi-coding');

    await deferred.execute();

    await expect(refresh).resolves.toMatchObject({
      changed: false,
      persistedSettingsChanged: false,
    });
    expect(readGrokCatalog(host.settings)?.models[0].rawId).toBe('kimi-coding');
  });

  it('retains the prior snapshot and other-host catalog when refresh fails', async () => {
    const cached = makeCatalog();
    const other = makeCatalog({ fingerprint: 'other-host-fingerprint' });
    const host = (await makeHost({ catalog: cached, otherHostCatalog: other }));
    const service = makeService(completedResult({
      diagnostics: 'Grok Build models command timed out',
      models: [],
    }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);

    await expect(coordinator.refresh()).resolves.toMatchObject({
      catalog: cached,
      changed: false,
      diagnostics: 'Grok Build models command timed out',
      persistedSettingsChanged: false,
    });
    expect(readGrokCatalog(host.settings)).toEqual(cached);
    expect(getGrokProviderSettings(host.settings).catalogsByHost['device:other']).toEqual(other);
    expect(runtimeHost(host).updateConfig).not.toHaveBeenCalled();
  });

  it('reports persisted timestamp/fingerprint changes separately from catalog changes', async () => {
    const cached = makeCatalog();
    const host = (await makeHost({ catalog: cached }));
    const service = makeService(completedResult({
      fingerprint: 'new-fingerprint',
    }));
    const coordinator = new GrokModelCatalogCoordinator(runtimeHost(host), service);

    await expect(coordinator.refresh()).resolves.toMatchObject({
      changed: false,
      persistedSettingsChanged: true,
    });
  });

  it('skips refresh when disabled and stops refresh after disposal', async () => {
    const disabledHost = (await makeHost({ enabled: false }));
    const disabledService = makeService(completedResult());
    const disabled = new GrokModelCatalogCoordinator(runtimeHost(disabledHost), disabledService);
    await expect(disabled.refresh()).resolves.toMatchObject({
      changed: false,
      kind: 'skipped',
    });
    expect(disabledService.discoverCatalog).not.toHaveBeenCalled();

    const service = makeService(completedResult());
    const disposed = new GrokModelCatalogCoordinator(runtimeHost((await makeHost())), service);
    disposed.dispose();
    await expect(disposed.refresh()).resolves.toMatchObject({
      changed: false,
      kind: 'skipped',
    });
    expect(service.discoverCatalog).not.toHaveBeenCalled();
  });
});

it('does not reuse canceled discovery for a transition owner or publish its delayed result', async () => {
  const host = (await makeHost());
  let finishOld!: (result: GrokModelCatalogDiscoveryResult) => void;
  const fresh = { kind: 'completed' as const, models: [makeModel('fresh-model')], defaultModelId: null, fingerprint: 'fingerprint-current' };
  const service = makeService(fresh);
  vi.mocked(service.discoverCatalog).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const catalog = new GrokModelCatalogCoordinator(runtimeHost(host), service);
  const owner = { providerTransitionOwner: true as const };
  const old = catalog.refresh(owner);
  catalog.cancel();
  const replacement = catalog.refresh(owner);
  expect(service.discoverCatalog).toHaveBeenCalledTimes(2);
  await replacement;
  expect(readGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual(['fresh-model']);
  let drained = false;
  catalog.dispose();
  const cleanup = catalog.quiesceForEnvironmentChange().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  finishOld({ ...fresh, models: [makeModel('obsolete-model')] });
  await Promise.all([old, cleanup]);
  expect(readGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual(['fresh-model']);
  expect(host.notifyProviderChatOptionsChanged).toHaveBeenCalledTimes(1);
});
