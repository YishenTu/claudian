import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
} from '../../../core/providers/types';
import { computeGrokEnvironmentHash } from '../env/GrokSettingsReconciler';
import {
  clearGrokReasoningMetadata,
  type GrokDiscoveredModel,
  mergeGrokDiscoveredModels,
  normalizeGrokDiscoveredModels,
} from '../models';
import {
  getCurrentGrokCatalog,
  getGrokProviderSettings,
  type GrokCatalogSnapshot,
  updateCurrentGrokCatalog,
} from '../settings';
import type {
  GrokModelCatalogDiscoveryResult,
  GrokModelCatalogServiceLike,
} from './GrokModelCatalogService';

const CATALOG_TTL_MS = 5 * 60 * 1000;

export type GrokCatalogState = 'failed' | 'idle' | 'ready' | 'refreshing';

export interface GrokCatalogResult {
  catalog: GrokCatalogSnapshot | null;
  changed: boolean;
  diagnostics?: string;
  kind: 'completed' | 'skipped';
  persistedSettingsChanged: boolean;
}

export interface GrokCatalogEnsureResult extends GrokCatalogResult {
  backgroundRefresh?: Promise<GrokCatalogResult>;
}

export class GrokModelCatalogCoordinator {
  private abortController: AbortController | null = null;
  private disposed = false;
  private inFlightRefresh: {
    contextKey: string;
    generation: number;
    promise: Promise<GrokCatalogResult>;
    transitionOwner: boolean;
  } | null = null;
  private liveContextKey: string | null = null;
  private liveDefaultModelId: string | null = null;
  private liveDefaultRevision = 0;
  private readonly liveModelsById = new Map<
    string,
    { model: GrokDiscoveredModel; revision: number }
  >();
  private liveRevision = 0;
  private readonly pendingLiveRevisions = new Set<number>();
  private refreshGeneration = 0;
  private state: GrokCatalogState = 'idle';

  constructor(
    private readonly plugin: ProviderHost,
    private readonly service: GrokModelCatalogServiceLike,
  ) {}

  getCachedCatalog(): GrokCatalogSnapshot | null {
    return getCurrentGrokCatalog(this.plugin.settings);
  }

  getState(): GrokCatalogState {
    return this.state;
  }

  async getStatus(
    context?: ProviderTransitionOwnerContext,
  ): Promise<'fresh' | 'missing' | 'stale'> {
    const catalog = this.getCachedCatalog();
    if (!catalog || catalog.models.length === 0 || !catalog.fingerprint) {
      return 'missing';
    }
    const fingerprint = await this.service.getCatalogFingerprint(undefined, context);
    if (fingerprint !== catalog.fingerprint) {
      return 'stale';
    }
    return Date.now() - catalog.refreshedAt > CATALOG_TTL_MS ? 'stale' : 'fresh';
  }

  async ensureFresh(
    _reason: string,
    options: { force?: boolean } = {},
  ): Promise<GrokCatalogEnsureResult> {
    if (this.disposed || !getGrokProviderSettings(this.plugin.settings).enabled) {
      return this.skippedResult();
    }
    if (options.force) {
      return this.refresh();
    }

    let status: 'fresh' | 'missing' | 'stale';
    try {
      status = await this.getStatus();
    } catch {
      status = this.getCachedCatalog() ? 'stale' : 'missing';
    }
    if (status === 'fresh') {
      return this.completedResult();
    }
    if (status === 'missing') {
      return this.refresh();
    }

    return {
      ...this.completedResult(),
      backgroundRefresh: this.refresh(),
    };
  }

  async refresh(context?: ProviderTransitionOwnerContext): Promise<GrokCatalogResult> {
    if (this.disposed || !getGrokProviderSettings(this.plugin.settings).enabled) {
      return this.skippedResult();
    }
    const contextKey = this.getContextKey();
    const transitionOwner = context?.providerTransitionOwner === true;
    this.prepareLiveContext(contextKey);
    if (
      this.inFlightRefresh?.contextKey === contextKey
      && (!transitionOwner || this.inFlightRefresh.transitionOwner)
    ) {
      return this.inFlightRefresh.promise;
    }
    if (this.inFlightRefresh) this.abortController?.abort();

    const generation = ++this.refreshGeneration;
    const promise = this.runRefresh(generation, contextKey, context);
    const flight = { contextKey, generation, promise, transitionOwner };
    this.inFlightRefresh = flight;
    try {
      return await promise;
    } finally {
      if (this.inFlightRefresh === flight) this.inFlightRefresh = null;
    }
  }

  async refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const result = await this.refresh(context);
    return {
      changed: result.changed,
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      ...(result.persistedSettingsChanged
        ? { persistedSettingsChanged: true }
        : {}),
    };
  }

  async mergeLiveModels(
    liveModels: GrokDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed) {
      return { changed: false };
    }
    const contextKey = this.getContextKey();
    if (sourceContextKey && sourceContextKey !== contextKey) {
      return { changed: false };
    }
    this.prepareLiveContext(contextKey);
    const settings = getGrokProviderSettings(this.plugin.settings);
    const enabledModelIds = new Set(settings.visibleModels ?? []);
    const normalizedLiveModels = normalizeGrokDiscoveredModels(liveModels)
      .map(model => (
        settings.visibleModels === null || enabledModelIds.has(model.rawId)
          ? model
          : clearGrokReasoningMetadata(model)
      ));
    if (normalizedLiveModels.length === 0) {
      return { changed: false };
    }
    const revision = ++this.liveRevision;
    for (const model of normalizedLiveModels) {
      const currentLive = this.liveModelsById.get(model.rawId);
      this.liveModelsById.set(
        model.rawId,
        {
          model: currentLive
            ? mergeGrokDiscoveredModels([currentLive.model], [model])[0]
            : model,
          revision,
        },
      );
    }
    const normalizedDefaultModelId = defaultModelId?.trim() || null;
    if (normalizedDefaultModelId) {
      this.liveDefaultModelId = normalizedDefaultModelId;
      this.liveDefaultRevision = revision;
    }

    this.pendingLiveRevisions.add(revision);
    let persisted: ProviderModelCatalogRefreshResult;
    try {
      persisted = await this.persistLiveModels(
        normalizedLiveModels,
        revision,
        contextKey,
      );
    } finally {
      this.pendingLiveRevisions.delete(revision);
    }
    if (persisted.changed) {
      this.plugin.notifyProviderChatOptionsChanged('grok');
    }
    return persisted;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private async runRefresh(
    generation: number,
    contextKey: string,
    context?: ProviderTransitionOwnerContext,
  ): Promise<GrokCatalogResult> {
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.state = 'refreshing';
    const refreshStartRevision = this.liveRevision;
    const pendingLiveRevisionsAtStart = new Set(this.pendingLiveRevisions);

    try {
      const discovery = await this.service.discoverCatalog(
        abortController.signal,
        context,
      );
      if (!this.isCurrentRefresh(generation)) {
        if (this.disposed) this.state = 'idle';
        return this.skippedResult();
      }
      if (contextKey !== this.getContextKey()) {
        if (this.abortController === abortController) this.state = 'idle';
        return this.skippedResult();
      }
      if (discovery.kind === 'skipped') {
        this.state = this.getCachedCatalog() ? 'ready' : 'idle';
        return this.skippedResult();
      }
      if (discovery.diagnostics || discovery.models.length === 0) {
        this.state = 'failed';
        return {
          ...this.completedResult(),
          diagnostics: discovery.diagnostics ?? 'Grok models returned no available models',
        };
      }

      const persisted = await this.persistDiscovery(
        discovery,
        refreshStartRevision,
        pendingLiveRevisionsAtStart,
        contextKey,
        generation,
      );
      if (!this.isCurrentRefresh(generation)) {
        if (this.disposed) this.state = 'idle';
        return this.skippedResult();
      }
      this.state = 'ready';
      if (persisted.changed) {
        this.plugin.notifyProviderChatOptionsChanged('grok');
      }
      return {
        catalog: this.getCachedCatalog(),
        kind: 'completed',
        ...persisted,
      };
    } catch {
      if (!this.isCurrentRefresh(generation)) {
        if (this.disposed) this.state = 'idle';
        return this.skippedResult();
      }
      this.state = 'failed';
      return {
        ...this.completedResult(),
        diagnostics: 'Grok model catalog refresh failed',
      };
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  private async persistDiscovery(
    discovery: Extract<GrokModelCatalogDiscoveryResult, { kind: 'completed' }>,
    refreshStartRevision: number,
    pendingLiveRevisionsAtStart: ReadonlySet<number>,
    expectedContextKey: string,
    expectedGeneration: number,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    return this.persistCatalog(expectedContextKey, (current) => {
      const isApplicableLiveRevision = (revision: number): boolean => (
        revision > refreshStartRevision
        || pendingLiveRevisionsAtStart.has(revision)
      );
      const liveModels = this.liveContextKey === expectedContextKey
        ? Array.from(this.liveModelsById.values())
          .filter(entry => isApplicableLiveRevision(entry.revision))
          .map(entry => entry.model)
        : [];
      const liveDefaultModelId = this.liveContextKey === expectedContextKey
        && isApplicableLiveRevision(this.liveDefaultRevision)
        ? this.liveDefaultModelId
        : null;
      return snapshotFromDiscovery(
        discovery,
        current,
        liveModels,
        liveDefaultModelId,
      );
    }, expectedGeneration);
  }

  private async persistLiveModels(
    liveModels: GrokDiscoveredModel[],
    revision: number,
    expectedContextKey: string,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    return this.persistCatalog(expectedContextKey, (current) => {
      const latestModels = liveModels.map((model) => {
        const latest = this.liveContextKey === expectedContextKey
          ? this.liveModelsById.get(model.rawId)
          : null;
        return latest && latest.revision >= revision ? latest.model : model;
      });
      const latestDefaultModelId = this.liveContextKey === expectedContextKey
        && this.liveDefaultRevision >= revision
        ? this.liveDefaultModelId
        : null;
      return {
        defaultModelId: latestDefaultModelId ?? current?.defaultModelId ?? null,
        fingerprint: current?.fingerprint ?? '',
        models: mergeGrokDiscoveredModels(current?.models ?? [], latestModels),
        refreshedAt: current?.refreshedAt ?? 0,
      };
    });
  }

  private async persistCatalog(
    expectedContextKey: string,
    buildSnapshot: (current: GrokCatalogSnapshot | null) => GrokCatalogSnapshot,
    expectedGeneration?: number,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    let result = { changed: false, persistedSettingsChanged: false };
    await this.plugin.mutateSettingsConditionally((settings) => {
      if (
        this.disposed
        || (
          expectedGeneration !== undefined
          && !this.isCurrentRefresh(expectedGeneration)
        )
        || computeGrokEnvironmentHash(settings) !== expectedContextKey
      ) {
        return false;
      }
      const current = getCurrentGrokCatalog(settings);
      const builtSnapshot = buildSnapshot(current);
      const visibleModels = getGrokProviderSettings(settings).visibleModels;
      const enabledModelIds = new Set(visibleModels ?? []);
      const snapshot = visibleModels === null
        ? builtSnapshot
        : {
          ...builtSnapshot,
          models: builtSnapshot.models.map(model => (
            enabledModelIds.has(model.rawId)
              ? model
              : clearGrokReasoningMetadata(model)
          )),
        };
      const changed = !sameCatalogContent(current, snapshot);
      const persistedSettingsChanged = !sameValue(current, snapshot);
      if (persistedSettingsChanged) {
        updateCurrentGrokCatalog(settings, snapshot);
      }
      result = { changed, persistedSettingsChanged };
      return persistedSettingsChanged;
    });
    return result;
  }

  private getContextKey(): string {
    return computeGrokEnvironmentHash(this.plugin.settings);
  }

  private isCurrentRefresh(generation: number): boolean {
    return !this.disposed && generation === this.refreshGeneration;
  }

  private prepareLiveContext(contextKey: string): void {
    if (this.liveContextKey === contextKey) return;
    this.liveContextKey = contextKey;
    this.liveDefaultModelId = null;
    this.liveDefaultRevision = 0;
    this.liveModelsById.clear();
    this.pendingLiveRevisions.clear();
  }

  private completedResult(): GrokCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'completed',
      persistedSettingsChanged: false,
    };
  }

  private skippedResult(): GrokCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'skipped',
      persistedSettingsChanged: false,
    };
  }
}

function snapshotFromDiscovery(
  discovery: Extract<GrokModelCatalogDiscoveryResult, { kind: 'completed' }>,
  current: GrokCatalogSnapshot | null,
  liveModels: GrokDiscoveredModel[],
  liveDefaultModelId: string | null,
): GrokCatalogSnapshot {
  const currentModelsById = new Map(
    (current?.models ?? []).map(model => [model.rawId, model] as const),
  );
  return {
    defaultModelId: liveDefaultModelId ?? discovery.defaultModelId,
    fingerprint: discovery.fingerprint,
    models: mergeGrokDiscoveredModels(discovery.models.map((discoveredModel) => {
      const currentModel = currentModelsById.get(discoveredModel.rawId);
      return currentModel
        ? mergeGrokDiscoveredModels([currentModel], [discoveredModel])[0]
        : discoveredModel;
    }), liveModels),
    refreshedAt: Date.now(),
  };
}

function sameCatalogContent(
  current: GrokCatalogSnapshot | null,
  next: GrokCatalogSnapshot,
): boolean {
  return current !== null && sameValue(
    { defaultModelId: current.defaultModelId, models: current.models },
    { defaultModelId: next.defaultModelId, models: next.models },
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
