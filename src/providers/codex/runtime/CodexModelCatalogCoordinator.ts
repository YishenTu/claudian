/**
 * Stale-while-revalidate coordinator for the Codex model catalog.
 *
 * The coordinator owns Codex model discovery lifecycle:
 *   - Load cached models immediately.
 *   - Complete plugin activation without launching Codex.
 *   - Schedule a background refresh after layout-ready.
 *   - Ensure freshness when the model picker opens.
 *   - Preserve cached models if refresh fails.
 */

import { StartupProfiler } from '../../../core/performance/StartupProfiler';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
} from '../../../core/providers/types';
import {
  getCodexProviderSettings,
  normalizeCodexVisibleModels,
  updateCodexProviderSettings,
} from '../settings';
import type { CodexDiscoveredModel } from './../models';
import {
  computeCodexCatalogFingerprint,
} from './CodexModelCatalogFingerprint';
import type {
  CodexModelDiscoveryServiceLike,
} from './CodexModelDiscoveryService';

export type CodexCatalogState = 'idle' | 'refreshing' | 'ready' | 'failed';

export interface CodexCatalogResult {
  kind: 'completed' | 'skipped';
  models: CodexDiscoveredModel[];
  refreshed: boolean;
  retryable?: boolean;
  diagnostics?: string;
}

export interface CodexCatalogEnsureResult extends CodexCatalogResult {
  backgroundRefresh?: Promise<CodexCatalogResult>;
}

const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes

function sameCatalog(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CodexModelCatalogCoordinator {
  private state: CodexCatalogState = 'idle';
  private inFlightRefresh: {
    generation: number;
    promise: Promise<CodexCatalogResult>;
    transitionOwner: boolean;
  } | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private refreshGeneration = 0;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly discovery: CodexModelDiscoveryServiceLike,
  ) {}

  getCachedCatalog(): CodexDiscoveredModel[] {
    return getCodexProviderSettings(this.plugin.settings).discoveredModels;
  }

  getState(): CodexCatalogState {
    return this.state;
  }

  async getStatus(
    context?: ProviderTransitionOwnerContext,
  ): Promise<'missing' | 'stale' | 'fresh'> {
    const settings = getCodexProviderSettings(this.plugin.settings);
    if (settings.discoveredModels.length === 0 || !settings.catalogFingerprint) {
      return 'missing';
    }

    const currentFingerprint = await computeCodexCatalogFingerprint(this.plugin, context);
    if (currentFingerprint !== settings.catalogFingerprint) {
      return 'stale';
    }

    const ageMs = Date.now() - settings.catalogTimestamp;
    if (ageMs > CATALOG_TTL_MS) {
      return 'stale';
    }

    return 'fresh';
  }

  async ensureFresh(
    _reason: string,
    options: { force?: boolean } = {},
  ): Promise<CodexCatalogEnsureResult> {
    if (this.disposed) {
      return { kind: 'skipped', models: this.getCachedCatalog(), refreshed: false };
    }
    const settings = getCodexProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      return { kind: 'skipped', models: this.getCachedCatalog(), refreshed: false };
    }

    if (options.force) {
      const result = await this.refresh();
      return { ...result, backgroundRefresh: undefined };
    }

    let status: 'missing' | 'stale' | 'fresh';
    try {
      status = await this.getStatus();
    } catch {
      status = this.getCachedCatalog().length > 0 ? 'stale' : 'missing';
    }
    if (status === 'fresh') {
      return { kind: 'completed', models: this.getCachedCatalog(), refreshed: false };
    }

    if (status === 'missing') {
      const result = await this.refresh();
      return { ...result, backgroundRefresh: undefined };
    }

    // Stale: return cached immediately and refresh in the background.
    const backgroundRefresh = this.refresh();
    return {
      kind: 'completed',
      models: this.getCachedCatalog(),
      refreshed: false,
      backgroundRefresh,
    };
  }

  async refresh(context?: ProviderTransitionOwnerContext): Promise<CodexCatalogResult> {
    if (this.disposed) {
      return { kind: 'skipped', models: this.getCachedCatalog(), refreshed: false };
    }
    const transitionOwner = context?.providerTransitionOwner === true;
    if (this.inFlightRefresh && (!transitionOwner || this.inFlightRefresh.transitionOwner)) {
      return this.inFlightRefresh.promise;
    }

    if (this.inFlightRefresh) {
      this.abortController?.abort();
    }
    const generation = ++this.refreshGeneration;
    const flight = {
      generation,
      promise: this.runRefresh(generation, context),
      transitionOwner,
    };
    this.inFlightRefresh = flight;
    try {
      return await flight.promise;
    } finally {
      if (this.inFlightRefresh === flight) {
        this.inFlightRefresh = null;
      }
    }
  }

  async refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult> {
    let result = await this.refresh(context);
    let changed = result.kind === 'completed' && result.refreshed;
    if (result.retryable && !this.disposed) {
      result = await this.refresh(context);
      changed = changed || (result.kind === 'completed' && result.refreshed);
    }
    if (
      result.kind === 'completed'
      && !result.diagnostics
      && result.models.length > 0
      && !this.disposed
    ) {
      let status: 'missing' | 'stale' | 'fresh' = 'fresh';
      try {
        status = await this.getStatus(context);
      } catch {
        // Keep the completed refresh result when fingerprint verification is unavailable.
      }
      if (status !== 'fresh') {
        result = await this.refresh(context);
        changed = changed || (result.kind === 'completed' && result.refreshed);
      }
    }
    if (result.kind === 'skipped') {
      return { changed };
    }
    if (result.diagnostics) {
      return { changed: false, diagnostics: result.diagnostics };
    }
    if (result.models.length === 0) {
      return { changed: false, diagnostics: 'Codex app-server returned no visible models' };
    }
    return { changed };
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
    context?: ProviderTransitionOwnerContext,
  ): Promise<CodexCatalogResult> {
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.state = 'refreshing';

    const span = StartupProfiler.start('codex-model-discovery');
    try {
      let catalogFingerprint: string | null = null;
      let catalogFingerprintError: unknown;
      try {
        catalogFingerprint = await computeCodexCatalogFingerprint(this.plugin, context);
      } catch (error) {
        catalogFingerprintError = error;
      }
      if (!this.isCurrentRefresh(generation)) {
        return this.supersededResult();
      }

      const discoveryResult = await this.discovery.discoverModels(
        abortController.signal,
        context,
      );

      if (!this.isCurrentRefresh(generation)) {
        return this.supersededResult();
      }

      if (discoveryResult.kind === 'skipped') {
        const cached = this.getCachedCatalog();
        this.state = cached.length > 0 ? 'ready' : 'idle';
        return { kind: 'skipped', models: cached, refreshed: false };
      }

      if (discoveryResult.diagnostics || discoveryResult.models.length === 0) {
        this.state = 'failed';
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
      const persistedResult = await this.persistCatalog(
        discoveryResult.models,
        catalogFingerprint,
        generation,
        context,
      );
      if (!persistedResult.accepted) {
        if (!this.isCurrentRefresh(generation)) {
          return this.supersededResult();
        }
        this.state = this.getCachedCatalog().length > 0 ? 'ready' : 'idle';
        return {
          kind: 'completed',
          models: discoveryResult.models,
          refreshed: false,
          retryable: true,
        };
      }
      this.state = 'ready';
      if (persistedResult.changed) {
        this.plugin.notifyProviderChatOptionsChanged('codex');
      }
      return {
        kind: 'completed',
        models: discoveryResult.models,
        refreshed: persistedResult.changed,
      };
    } catch (error) {
      if (!this.isCurrentRefresh(generation)) {
        return this.supersededResult();
      }
      const message = error instanceof Error ? error.message : 'Codex model discovery failed';
      this.state = 'failed';
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

  private async persistCatalog(
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
      if (!this.isCurrentRefresh(generation)) {
        return false;
      }
      let currentFingerprint: string;
      try {
        currentFingerprint = await computeCodexCatalogFingerprint(this.plugin, context);
      } catch {
        return false;
      }
      if (
        !this.isCurrentRefresh(generation)
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

  private isCurrentRefresh(generation: number): boolean {
    return !this.disposed && generation === this.refreshGeneration;
  }

  private supersededResult(): CodexCatalogResult {
    if (this.disposed) {
      this.state = 'idle';
    }
    return {
      kind: 'skipped',
      models: this.getCachedCatalog(),
      refreshed: false,
    };
  }
}
