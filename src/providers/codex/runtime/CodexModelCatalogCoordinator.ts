/** Provider-owned discovery and generation-fenced catalog publication. */

import { StartupProfiler } from '../../../core/performance/StartupProfiler';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type {
  ProviderTransitionOwnerContext
} from '../../../core/providers/types';
import { decodeCodexConfig, updateCodexConfig } from '../config';
import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import type { CodexDiscoveredModel } from '../models';
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

/**
 * Codex's part of a catalog commit. It edits a private copy of the stored Codex
 * configuration and resolves to whether it changed it, or to null to reject the
 * commit, in which case nothing is written.
 */
export type CodexCatalogConfigUpdate = (config: Record<string, unknown>) => Promise<boolean | null>;

/**
 * Commits a Codex catalog update together with the application's normalization of
 * every provider's model selections, in one settings transaction. Resolves to null
 * when the update rejected the commit, else to whether normalization changed a selection.
 */
export type CodexModelCatalogCommit = (
  update: CodexCatalogConfigUpdate,
) => Promise<{ selectionChanged: boolean } | null>;

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
    private readonly host: ProviderRuntimeHost,
    private readonly discovery: CodexModelDiscoveryServiceLike,
    private readonly commitCatalog: CodexModelCatalogCommit,
    private readonly transitionGate = new CodexMetadataTransitionGate(),
  ) {}

  getCachedCatalog(): CodexDiscoveredModel[] {
    return decodeCodexConfig(this.host.config).discoveredModels;
  }

  async refresh(context?: ProviderTransitionOwnerContext, signal?: AbortSignal): Promise<CodexCatalogResult> {
    if (
      context?.providerTransitionOwner !== true
      && this.transitionGate.isUnavailable()
      && !await this.transitionGate.waitUntilAvailable(signal)
    ) {
      return { kind: 'skipped', models: this.getCachedCatalog(), refreshed: false };
    }
    if (this.disposed || signal?.aborted || !decodeCodexConfig(this.host.config).enabled) {
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
        catalogFingerprint = await computeCodexCatalogFingerprint(this.host, context);
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
        this.host.notifyChatOptionsChanged();
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

    let catalogChanged = false;
    let configChanged = false;
    const committed = await this.commitCatalog(async (config) => {
      if (!this.#isCurrentRefresh(generation)) {
        return null;
      }
      let currentFingerprint: string;
      try {
        currentFingerprint = await computeCodexCatalogFingerprint(this.host, context);
      } catch {
        return null;
      }
      if (
        !this.#isCurrentRefresh(generation)
        || currentFingerprint !== fingerprint
      ) {
        return null;
      }
      const currentSettings = decodeCodexConfig(config);
      const currentModels = currentSettings.discoveredModels;
      catalogChanged = !sameCatalog(currentModels, models);
      const fingerprintChanged = currentSettings.catalogFingerprint !== fingerprint;
      const timestampChanged = currentSettings.catalogTimestamp !== timestamp;
      configChanged = catalogChanged || fingerprintChanged || timestampChanged;

      if (configChanged) {
        updateCodexConfig(config, {
          discoveredModels: models,
          visibleModels: currentSettings.visibleModels,
          catalogFingerprint: fingerprint,
          catalogTimestamp: timestamp,
        });
      }
      return configChanged;
    });
    if (!committed) {
      return { accepted: false, changed: false, persistedSettingsChanged: false };
    }
    return {
      accepted: true,
      changed: catalogChanged || committed.selectionChanged,
      persistedSettingsChanged: configChanged || committed.selectionChanged,
    };
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
