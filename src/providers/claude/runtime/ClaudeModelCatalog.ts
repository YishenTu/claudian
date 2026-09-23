import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import { findClaudeModelOption,getClaudeModelCatalog, getClaudeVisibleModelIds } from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { probeClaudeModels } from './probeClaudeModels';

export const CLAUDE_MODEL_DISCOVERY_ERROR = 'Couldn’t load Claude models. Check your configuration and refresh the model list.';

/** SDK discovery requested by the settings panel. No background refresh or retries. */
export class ClaudeModelCatalog {
  private controller: AbortController | null = null;
  private flight: Promise<ProviderModelCatalogRefreshResult> | null = null;
  private disposed = false;
  // The settings tab has one active renderer. Replace its observer on each render.
  onChange: (() => void) | null = null;

  constructor(private readonly host: ProviderHost, private readonly probe = probeClaudeModels) {}

  async refresh(): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || !getClaudeProviderSettings(this.host.settings).enabled) return { changed: false };
    if (this.flight) return this.flight;
    const controller = new AbortController();
    this.controller = controller;
    const flight = this.discover(controller).finally(() => {
      if (this.flight === flight) {
        this.flight = null;
        this.controller = null;
      }
    });
    this.flight = flight;
    return flight;
  }

  private async discover(
    controller: AbortController,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const current = () => !controller.signal.aborted && !this.disposed
      && getClaudeProviderSettings(this.host.settings).enabled;
    try {
      const models = await this.probe(this.host, controller.signal);
      await this.host.mutateSettingsConditionally(settings => {
        if (!current()) return false;
        const migrateLegacySelection = getClaudeProviderSettings(settings).visibleModels === null;
        const selected = getClaudeVisibleModelIds(settings);
        updateClaudeProviderSettings(settings, { discoveredModels: models });
        if (migrateLegacySelection) {
          const catalog = getClaudeModelCatalog(settings);
          updateClaudeProviderSettings(settings, {
            visibleModels: [...new Set(selected.map(id => {
              const option = findClaudeModelOption(catalog, id);
              return option ? toClaudeRuntimeModelId(option.value) : id;
            }))],
          });
        }
        return true;
      });
      if (!current()) return { changed: false };
      this.publish();
      return { changed: true, persistedSettingsChanged: true };
    } catch {
      if (!current()) return { changed: false };
      return { changed: false, diagnostics: CLAUDE_MODEL_DISCOVERY_ERROR };
    }
  }

  private publish(): void {
    this.onChange?.();
    this.host.notifyProviderChatOptionsChanged('claude');
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.flight;
  }

  async invalidate(): Promise<ProviderModelCatalogRefreshResult> {
    await this.cancel();
    if (this.disposed) return { changed: false };
    await this.host.mutateSettingsConditionally(settings => {
      updateClaudeProviderSettings(settings, { discoveredModels: [] });
      return true;
    });
    this.publish();
    return { changed: true, persistedSettingsChanged: true };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.onChange = null;
    await this.cancel();
  }
}
