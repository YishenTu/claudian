import { getInstallationKey } from '@/core/device/InstallationKey';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import type { AntigravityMetadata } from '../app/AntigravityMetadataProbe';
import {
  type AntigravityCatalogSnapshot,
  decodeAntigravityConfig,
  updateAntigravityConfig,
} from '../config';
import type { AntigravityModel } from '../models';
import { computeAntigravityRuntimeInputHash } from './AntigravityRuntimeEnvironment';

/**
 * Sole writer of the discovered catalog. Each session's config options are authoritative, so a
 * newer report replaces the catalog instead of merging into it. Live sessions are preferred: the
 * prompt-less discovery probe leaves a native session directory behind, so it runs only while no
 * live session has reported models for the current CLI and environment.
 */
export class AntigravityModelCatalog {
  private disposed = false;
  /** Runtime-input fingerprint under which a live session last reported models. */
  private liveContextKey: string | null = null;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly discover: (signal: AbortSignal) => Promise<AntigravityMetadata>,
  ) {}

  async refresh(signal: AbortSignal): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || !decodeAntigravityConfig(this.host.config, this.host.selection).enabled) {
      return { changed: false };
    }
    const contextKey = this.#getContextKey();
    if (this.liveContextKey === contextKey) return { changed: false };
    const metadata = await this.discover(signal);
    if (metadata.models.length === 0) {
      return { changed: false, diagnostics: 'Antigravity reported no available models.' };
    }
    return this.#persist(metadata.models, metadata.currentModelId, contextKey);
  }

  mergeLiveModels(models: AntigravityModel[], defaultModelId: string | null): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || models.length === 0) return Promise.resolve({ changed: false });
    const contextKey = this.#getContextKey();
    this.liveContextKey = contextKey;
    return this.#persist(models, defaultModelId, contextKey);
  }

  dispose(): void {
    this.disposed = true;
  }

  async #persist(
    models: AntigravityModel[],
    defaultModelId: string | null,
    contextKey: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    let result: ProviderModelCatalogRefreshResult = { changed: false };
    await this.host.updateConfig((config, selection) => {
      const current = decodeAntigravityConfig(config, selection);
      // Reports from a superseded CLI or environment must not overwrite the current catalog.
      if (this.disposed || computeAntigravityRuntimeInputHash(current, this.host.environmentText) !== contextKey) {
        return false;
      }
      const previous = current.currentCatalog;
      const next: AntigravityCatalogSnapshot = {
        defaultModelId: defaultModelId ?? previous?.defaultModelId ?? null,
        models,
        refreshedAt: Date.now(),
      };
      const changed = JSON.stringify([previous?.defaultModelId, previous?.models]) !== JSON.stringify([next.defaultModelId, next.models]);
      if (!changed) return false;
      updateAntigravityConfig(config, selection, {
        catalogsByHost: { ...current.catalogsByHost, [getInstallationKey()]: next },
      });
      result = { changed: true, persistedSettingsChanged: true };
      return true;
    });
    if (result.changed) this.host.notifyChatOptionsChanged();
    return result;
  }

  #getContextKey(): string {
    return computeAntigravityRuntimeInputHash(
      decodeAntigravityConfig(this.host.config, this.host.selection),
      this.host.environmentText,
    );
  }
}
