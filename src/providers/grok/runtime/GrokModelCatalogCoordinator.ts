import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
} from '../../../core/providers/types';
import { computeGrokEnvironmentHash } from '../env/GrokSettingsReconciler';
import {
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

export interface GrokCatalogResult {
  catalog: GrokCatalogSnapshot | null;
  changed: boolean;
  diagnostics?: string;
  kind: 'completed' | 'skipped';
  persistedSettingsChanged: boolean;
}

export class GrokModelCatalogCoordinator {
  private readonly activeMetadataOperations = new Set<Promise<unknown>>();
  private abortController: AbortController | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
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
  private transitionActive = false;
  private readonly transitionWaiters = new Set<() => void>();

  constructor(
    private readonly plugin: ProviderHost,
    private readonly service: GrokModelCatalogServiceLike,
  ) {}

  getCachedCatalog(): GrokCatalogSnapshot | null {
    return getCurrentGrokCatalog(this.plugin.settings);
  }

  refresh(context?: ProviderTransitionOwnerContext, signal?: AbortSignal): Promise<GrokCatalogResult> {
    if (this.disposed || signal?.aborted || !getGrokProviderSettings(this.plugin.settings).enabled) {
      return Promise.resolve(this.#skippedResult());
    }
    return this.runMetadataOperation(
      () => this.#refreshUnfenced(context, signal),
      context?.providerTransitionOwner === true,
      () => this.#skippedResult(),
    );
  }

  async #refreshUnfenced(
    context?: ProviderTransitionOwnerContext,
    signal?: AbortSignal,
  ): Promise<GrokCatalogResult> {
    if (signal?.aborted) return this.#skippedResult();
    if (
      this.transitionActive
      && context?.providerTransitionOwner !== true
    ) {
      return this.#skippedResult();
    }
    const contextKey = this.#getContextKey();
    const transitionOwner = context?.providerTransitionOwner === true;
    this.#prepareLiveContext(contextKey);
    if (
      this.inFlightRefresh?.contextKey === contextKey
      && (!transitionOwner || this.inFlightRefresh.transitionOwner)
    ) {
      return this.#waitForRefresh(this.inFlightRefresh, signal);
    }
    if (this.inFlightRefresh) this.abortController?.abort();

    const generation = ++this.refreshGeneration;
    const promise = this.#runRefresh(generation, contextKey, context);
    const flight = { contextKey, generation, promise, transitionOwner };
    this.inFlightRefresh = flight;
    try {
      return await this.#waitForRefresh(flight, signal);
    } finally {
      if (this.inFlightRefresh === flight) this.inFlightRefresh = null;
    }
  }

  mergeLiveModels(
    liveModels: GrokDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed) {
      return Promise.resolve({ changed: false });
    }
    return this.runMetadataOperation(
      () => this.#mergeLiveModelsUnfenced(
        liveModels,
        defaultModelId,
        sourceContextKey,
      ),
      false,
      () => ({ changed: false }),
    );
  }

  async #mergeLiveModelsUnfenced(
    liveModels: GrokDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const contextKey = this.#getContextKey();
    if (sourceContextKey && sourceContextKey !== contextKey) {
      return { changed: false };
    }
    this.#prepareLiveContext(contextKey);
    const normalizedLiveModels = normalizeGrokDiscoveredModels(liveModels);
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
      persisted = await this.#persistLiveModels(
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

  async #waitForRefresh(
    flight: { generation: number; promise: Promise<GrokCatalogResult> },
    signal?: AbortSignal,
  ): Promise<GrokCatalogResult> {
    const cancel = () => {
      if (flight.generation === this.refreshGeneration) this.cancel();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await flight.promise;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  cancel(): void {
    this.refreshGeneration += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.inFlightRefresh = null;
  }

  beginEnvironmentTransition(): void {
    if (!this.disposed) this.transitionActive = true;
  }

  endEnvironmentTransition(): void {
    if (this.disposed) return;
    this.transitionActive = false;
    this.#releaseTransitionWaiters();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.cancel();
    await Promise.allSettled(this.activeMetadataOperations);
    this.liveContextKey = null;
    this.liveDefaultModelId = null;
    this.liveDefaultRevision = 0;
    this.liveModelsById.clear();
    this.pendingLiveRevisions.clear();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.transitionActive = false;
    this.#releaseTransitionWaiters();
    this.cancel();
    this.disposePromise = Promise.allSettled(this.activeMetadataOperations).then(() => undefined);
    return this.disposePromise;
  }

  private runMetadataOperation<T>(
    operation: () => Promise<T>,
    transitionOwner: boolean,
    disposedResult: () => T,
  ): Promise<T> {
    if (this.disposed) return Promise.resolve(disposedResult());
    if (this.transitionActive && !transitionOwner) {
      return this.#waitForTransition().then(() =>
        this.runMetadataOperation(operation, transitionOwner, disposedResult));
    }

    const promise = operation();
    this.activeMetadataOperations.add(promise);
    void promise.then(
      () => this.activeMetadataOperations.delete(promise),
      () => this.activeMetadataOperations.delete(promise),
    );
    return promise;
  }

  #waitForTransition(): Promise<void> {
    if (this.disposed || !this.transitionActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.transitionWaiters.add(resolve);
    });
  }

  #releaseTransitionWaiters(): void {
    const waiters = [...this.transitionWaiters];
    this.transitionWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  async #runRefresh(
    generation: number,
    contextKey: string,
    context?: ProviderTransitionOwnerContext,
  ): Promise<GrokCatalogResult> {
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    const refreshStartRevision = this.liveRevision;
    const pendingLiveRevisionsAtStart = new Set(this.pendingLiveRevisions);

    try {
      const discovery = await this.service.discoverCatalog(
        abortController.signal,
        context,
      );
      if (!this.#isCurrentRefresh(generation)) {
        return this.#skippedResult();
      }
      if (contextKey !== this.#getContextKey()) {
        return this.#skippedResult();
      }
      if (discovery.kind === 'skipped') {
        return this.#skippedResult();
      }
      if (discovery.diagnostics) {
        return {
          ...this.#completedResult(),
          diagnostics: discovery.diagnostics ?? 'Grok models returned no available models',
        };
      }

      const persisted = await this.#persistDiscovery(
        discovery,
        refreshStartRevision,
        pendingLiveRevisionsAtStart,
        contextKey,
        generation,
      );
      if (!this.#isCurrentRefresh(generation)) {
        return this.#skippedResult();
      }
      if (persisted.changed) {
        this.plugin.notifyProviderChatOptionsChanged('grok');
      }
      return {
        catalog: this.getCachedCatalog(),
        kind: 'completed',
        ...persisted,
      };
    } catch {
      if (!this.#isCurrentRefresh(generation)) {
        return this.#skippedResult();
      }
      return {
        ...this.#completedResult(),
        diagnostics: 'Grok model catalog refresh failed',
      };
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  async #persistDiscovery(
    discovery: Extract<GrokModelCatalogDiscoveryResult, { kind: 'completed' }>,
    refreshStartRevision: number,
    pendingLiveRevisionsAtStart: ReadonlySet<number>,
    expectedContextKey: string,
    expectedGeneration: number,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    return this.#persistCatalog(expectedContextKey, (current) => {
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

  async #persistLiveModels(
    liveModels: GrokDiscoveredModel[],
    revision: number,
    expectedContextKey: string,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    return this.#persistCatalog(expectedContextKey, (current) => {
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

  async #persistCatalog(
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
          && !this.#isCurrentRefresh(expectedGeneration)
        )
        || computeGrokEnvironmentHash(settings) !== expectedContextKey
      ) {
        return false;
      }
      const current = getCurrentGrokCatalog(settings);
      const snapshot = buildSnapshot(current);
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

  #getContextKey(): string {
    return computeGrokEnvironmentHash(this.plugin.settings);
  }

  #isCurrentRefresh(generation: number): boolean {
    return !this.disposed && generation === this.refreshGeneration;
  }

  #prepareLiveContext(contextKey: string): void {
    if (this.liveContextKey === contextKey) return;
    this.liveContextKey = contextKey;
    this.liveDefaultModelId = null;
    this.liveDefaultRevision = 0;
    this.liveModelsById.clear();
    this.pendingLiveRevisions.clear();
  }

  #completedResult(): GrokCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'completed',
      persistedSettingsChanged: false,
    };
  }

  #skippedResult(): GrokCatalogResult {
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
