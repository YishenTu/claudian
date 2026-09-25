import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import { findClaudeModelOption, getClaudeModelCatalog, getClaudeVisibleModelIds } from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { probeClaudeModels } from './probeClaudeModels';

export const CLAUDE_MODEL_DISCOVERY_ERROR = 'Couldn’t load Claude models. Check your configuration and refresh the model list.';

/** SDK discovery shared by settings and startup metadata migration. */
export class ClaudeModelCatalog {
  private controller: AbortController | null = null;
  private flight: Promise<ProviderModelCatalogRefreshResult> | null = null;
  private disposed = false;
  private generation = 0;
  private readonly pending = new Set<Promise<ProviderModelCatalogRefreshResult>>();

  constructor(private readonly host: ProviderHost, private readonly probe = probeClaudeModels) {}

  async refresh(signal?: AbortSignal): Promise<ProviderModelCatalogRefreshResult> {
    if (signal?.aborted || this.disposed || !getClaudeProviderSettings(this.host.settings).enabled) return { changed: false };
    if (this.flight) return this.waitForRefresh(this.flight, this.generation, signal);
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const flight = this.discover(controller, generation).finally(() => {
      this.pending.delete(flight);
      if (this.flight === flight) {
        this.flight = null;
        this.controller = null;
      }
    });
    this.flight = flight;
    this.pending.add(flight);
    return this.waitForRefresh(flight, generation, signal);
  }

  private async discover(
    controller: AbortController,
    generation: number,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const current = () => !controller.signal.aborted && !this.disposed && generation === this.generation
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
      this.host.notifyProviderChatOptionsChanged('claude');
      return { changed: true, persistedSettingsChanged: true };
    } catch {
      if (!current()) return { changed: false };
      return { changed: false, diagnostics: CLAUDE_MODEL_DISCOVERY_ERROR };
    }
  }

  private async waitForRefresh(
    flight: Promise<ProviderModelCatalogRefreshResult>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const cancel = () => {
      if (generation === this.generation) this.cancelCurrent();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await flight;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  private cancelCurrent(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.flight = null;
  }

  async cancel(): Promise<void> {
    this.cancelCurrent();
    await Promise.allSettled(this.pending);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
  }
}
