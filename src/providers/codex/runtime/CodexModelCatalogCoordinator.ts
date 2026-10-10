/** Provider-owned discovery and generation-fenced catalog publication. */

import { StartupProfiler } from '../../../core/performance/StartupProfiler';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderTransitionOwnerContext
} from '../../../core/providers/types';
import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import type { CodexDiscoveredModel } from '../models';
import {
  getCodexProviderSettings,
  normalizeCodexVisibleModels,
  updateCodexProviderSettings,
} from '../settings';
import {
  computeCodexCatalogFingerprint,
} from './CodexModelCatalogFingerprint';
import type {
  CodexModelDiscoveryServiceLike,
} from './CodexModelDiscoveryService';

export interface CodexCatalogResult {
  kind: 'completed' | 'skipped';
  models: CodexDiscoveredModel[];
  refreshed: boolean;
  retryable?: boolean;
  diagnostics?: string;
}

function sameCatalog(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CodexModelCatalogCoordinator {
  private inFlightRefresh: {
    generation: number;
    promise: Promise<CodexCatalogResult>;
    transitionOwner: boolean;
  } | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private refreshGeneration = 0;
  private readonly pendingRefreshes = new Set<Promise<CodexCatalogResult>>();

  constructor(
    private readonly plugin: ProviderHost,
    private readonly discovery: CodexModelDiscoveryServiceLike,
    private readonly transitionGate = new CodexMetadataTransitionGate(),
  ) {}

  getCachedCatalog(): CodexDiscoveredModel[] {
    return getCodexProviderSettings(this.plugin.settings).discoveredModels;
  }

  async refresh(context?: ProviderTransitionOwnerContext, signal?: AbortSignal): Promise<CodexCatalogResult> {
    if (
      context?.providerTransitionOwner !== true
      && this.transitionGate.isUnavailable()
      && !await this.transitionGate.waitUntilAvailable(signal)
    ) {
      return { kind: 'skipped', models: this.getCachedCatalog(), refreshed: false };
    }
    if (this.disposed || signal?.aborted || !getCodexProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', models: this.getCachedCatalog(), refreshed: false };
    }
    const transitionOwner = context?.providerTransitionOwner === true;
    if (this.inFlightRefresh && (!transitionOwner || this.inFlightRefresh.transitionOwner)) {
      return this.#waitForRefresh(this.inFlightRefresh, signal);
    }

    if (this.inFlightRefresh) {
      this.abortController?.abort();
    }
    const generation = ++this.refreshGeneration;
    const flight = {
      generation,
      promise: this.#runRefresh(generation, context),
      transitionOwner,
    };
    this.inFlightRefresh = flight;
    this.pendingRefreshes.add(flight.promise);
    try {
      return await this.#waitForRefresh(flight, signal);
    } finally {
      this.pendingRefreshes.delete(flight.promise);
      if (this.inFlightRefresh === flight) {
        this.inFlightRefresh = null;
      }
    }
  }

  async #waitForRefresh(
    flight: { generation: number; promise: Promise<CodexCatalogResult> },
    signal?: AbortSignal,
  ): Promise<CodexCatalogResult> {
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
    this.transitionGate.beginTransition();
  }

  endEnvironmentTransition(): void {
    this.transitionGate.endTransition();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.cancel();
    await Promise.allSettled(this.pendingRefreshes);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.transitionGate.dispose();
    this.disposePromise = this.quiesceForEnvironmentChange();
    return this.disposePromise;
  }

  async #runRefresh(
    generation: number,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CodexCatalogResult> {
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;

    const span = StartupProfiler.start('codex-model-discovery');
    try {
      let catalogFingerprint: string | null = null;
      let catalogFingerprintError: unknown;
      try {
        catalogFingerprint = await computeCodexCatalogFingerprint(this.plugin, context);
      } catch (error) {
        catalogFingerprintError = error;
      }
      if (!this.#isCurrentRefresh(generation)) {
        return this.#supersededResult();
      }

      const discoveryResult = await this.discovery.discoverModels(
        abortController.signal,
        context,
      );

      if (!this.#isCurrentRefresh(generation)) {
        return this.#supersededResult();
      }

      if (discoveryResult.kind === 'skipped') {
        const cached = this.getCachedCatalog();
        return { kind: 'skipped', models: cached, refreshed: false };
      }

      if (discoveryResult.diagnostics) {
        return {
          kind: 'completed',
          models: this.getCachedCatalog(),
          refreshed: false,
          diagnostics: discoveryResult.diagnostics ?? 'Codex app-server returned no visible models',
        };
      }

      if (!catalogFingerprint) {
        throw catalogFingerprintError instanceof Error
          ? catalogFingerprintError
          : new Error('Codex catalog fingerprint resolution failed');
      }
      const persistedResult = await this.#persistCatalog(
        discoveryResult.models,
        catalogFingerprint,
        generation,
        context,
      );
      if (!this.#isCurrentRefresh(generation)) return this.#supersededResult();
      if (!persistedResult.accepted) {
        if (!this.#isCurrentRefresh(generation)) {
          return this.#supersededResult();
        }
        return {
          kind: 'completed',
          models: discoveryResult.models,
          refreshed: false,
          retryable: true,
        };
      }
      if (persistedResult.changed) {
        this.plugin.notifyProviderChatOptionsChanged('codex');
      }
      return {
        kind: 'completed',
        models: discoveryResult.models,
        refreshed: persistedResult.changed,
      };
    } catch (error) {
      if (!this.#isCurrentRefresh(generation)) {
        return this.#supersededResult();
      }
      const message = error instanceof Error ? error.message : 'Codex model discovery failed';
      return {
        kind: 'completed',
        models: this.getCachedCatalog(),
        refreshed: false,
        diagnostics: message,
      };
    } finally {
      StartupProfiler.finish(span);
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  async #persistCatalog(
    models: CodexDiscoveredModel[],
    fingerprint: string,
    generation: number,
    context?: ProviderTransitionOwnerContext,
  ): Promise<{
    accepted: boolean;
    changed: boolean;
    persistedSettingsChanged: boolean;
  }> {
    const timestamp = Date.now();

    let refreshResult = {
      accepted: false,
      changed: false,
      persistedSettingsChanged: false,
    };
    await this.plugin.mutateSettingsConditionally(async (settings) => {
      if (!this.#isCurrentRefresh(generation)) {
        return false;
      }
      let currentFingerprint: string;
      try {
        currentFingerprint = await computeCodexCatalogFingerprint(this.plugin, context);
      } catch {
        return false;
      }
      if (
        !this.#isCurrentRefresh(generation)
        || currentFingerprint !== fingerprint
      ) {
        return false;
      }
      const currentSettings = getCodexProviderSettings(settings);
      const currentModels = currentSettings.discoveredModels;
      const visibleModels = normalizeCodexVisibleModels(
        currentSettings.visibleModels,
        models,
      );
      const catalogChanged = !sameCatalog(currentModels, models);
      const visibilityChanged = !sameCatalog(currentSettings.visibleModels, visibleModels);
      const fingerprintChanged = currentSettings.catalogFingerprint !== fingerprint;
      const timestampChanged = currentSettings.catalogTimestamp !== timestamp;

      if (catalogChanged || visibilityChanged || fingerprintChanged || timestampChanged) {
        updateCodexProviderSettings(settings, {
          discoveredModels: models,
          visibleModels,
          catalogFingerprint: fingerprint,
          catalogTimestamp: timestamp,
        });
      }

      const selectionChanged = ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
      const selectorStateChanged = visibilityChanged || selectionChanged;
      const shouldPersist = catalogChanged
        || selectorStateChanged
        || fingerprintChanged
        || timestampChanged;
      refreshResult = {
        accepted: true,
        changed: catalogChanged || selectorStateChanged,
        persistedSettingsChanged: shouldPersist,
      };
      return shouldPersist;
    });

    return refreshResult;
  }

  #isCurrentRefresh(generation: number): boolean {
    return !this.disposed && generation === this.refreshGeneration;
  }

  #supersededResult(): CodexCatalogResult {
    return {
      kind: 'skipped',
      models: this.getCachedCatalog(),
      refreshed: false,
    };
  }
}
