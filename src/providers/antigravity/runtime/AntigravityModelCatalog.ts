import { getInstallationKey } from '@/core/device/InstallationKey';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import { runProcessProbe, WSL_PROCESS_PROBE_TIMEOUT_MS } from '@/core/process/ProcessProbe';
import { t } from '@/i18n/i18n';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import {
  type AntigravityCatalogSnapshot,
  type AntigravityProviderSettings,
  decodeAntigravityConfig,
  updateAntigravityConfig,
} from '../config';
import { type AntigravityModel, readAntigravityModelList } from '../models';
import { resolveAntigravityLaunchSpec } from './AntigravityExecutionContext';
import { computeAntigravityRuntimeInputHash } from './AntigravityRuntimeEnvironment';

/** Live session reports supply canonical model metadata and take precedence over standalone discovery. */
export class AntigravityModelCatalog {
  private disposed = false;
  /** Latest live report, retained so an unsuccessful settings write can be retried without probing. */
  private liveReport: { contextKey: string; models: AntigravityModel[]; defaultModelId: string | null } | null = null;

  constructor(private readonly host: ProviderRuntimeHost) {}

  async refresh(signal: AbortSignal): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || signal.aborted || !decodeAntigravityConfig(this.host.config, this.host.selection).enabled) {
      return { changed: false };
    }
    const contextKey = this.#getContextKey();
    let output: string | null = null;
    if (this.liveReport?.contextKey !== contextKey) {
      const launch = await resolveAntigravityLaunchSpec(this.host, ['models']);
      output = await runProcessProbe(
        { ...launch, cwd: launch.spawnCwd, signal },
        launch.target.method === 'wsl' ? WSL_PROCESS_PROBE_TIMEOUT_MS : undefined,
      );
    }
    if (signal.aborted) return { changed: false };
    // A session may have supplied a complete catalog while the standalone command was running.
    const live = this.liveReport;
    if (live?.contextKey === contextKey) return this.#persist(live.models, live.defaultModelId, contextKey, 'live', signal);
    if (output === null) return { changed: false, diagnostics: t('settings.antigravity.listModelsFailed') };
    const models = readAntigravityModelList(output);
    if (models.length === 0) {
      return { changed: false, diagnostics: 'Antigravity reported no available models.' };
    }
    return this.#persist(models, null, contextKey, 'probe', signal);
  }

  mergeLiveModels(models: AntigravityModel[], defaultModelId: string | null): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || models.length === 0) return Promise.resolve({ changed: false });
    const contextKey = this.#getContextKey();
    this.liveReport = { contextKey, models, defaultModelId };
    return this.#persist(models, defaultModelId, contextKey, 'live');
  }

  dispose(): void {
    this.disposed = true;
  }

  async #persist(
    models: AntigravityModel[],
    defaultModelId: string | null,
    contextKey: string,
    source: 'live' | 'probe',
    signal?: AbortSignal,
  ): Promise<ProviderModelCatalogRefreshResult> {
    let result: ProviderModelCatalogRefreshResult = { changed: false };
    await this.host.updateConfig((config, selection) => {
      const current = decodeAntigravityConfig(config, selection);
      // Reports from a superseded CLI or environment must not overwrite the current catalog.
      if (this.disposed || signal?.aborted || this.#contextKeyOf(current) !== contextKey) {
        return false;
      }
      // A probe started before a live report must not replace it when it finishes later.
      if (source === 'probe' && this.liveReport?.contextKey === contextKey) return false;
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
    return this.#contextKeyOf(decodeAntigravityConfig(this.host.config, this.host.selection));
  }

  /** The launch inputs, including the distro agy runs in, which a WSL vault path can select. */
  #contextKeyOf(settings: AntigravityProviderSettings): string {
    return computeAntigravityRuntimeInputHash(
      settings,
      this.host.environmentText,
      resolveExecutionTarget({ settings, hostVaultPath: this.host.workingDirectory }),
    );
  }
}
