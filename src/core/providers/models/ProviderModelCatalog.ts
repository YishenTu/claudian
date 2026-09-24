import { ProviderTransitionFence } from '../metadata/ProviderTransitionFence';
import type { ProviderHost } from '../ProviderHost';
import type { ProviderId, ProviderModelCatalogRefreshResult } from '../types';

export interface ProviderCatalogModel {
  id: string;
  name: string;
  description?: string;
  providerKey?: string;
  providerLabel?: string;
  isAvailable?: boolean;
  unavailableMessage?: string;
}

export interface ProviderModelSelection {
  models: ProviderCatalogModel[];
  selectedIds: string[];
  aliases: Record<string, string>;
}

export interface ProviderModelCatalogSnapshot extends ProviderModelSelection {
  defaultModelId: string | null;
  discoveredCount: number;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  stale: boolean;
  error?: string;
}

export interface ProviderModelCatalog {
  getSnapshot(): ProviderModelCatalogSnapshot;
  refresh(options?: { force?: boolean }): Promise<ProviderModelCatalogRefreshResult>;
  markStale(): void;
  select(ids: string[]): Promise<void>;
  setAliases(aliases: Record<string, string>): Promise<void>;
  observe(observer: () => void): () => void;
  dispose(): Promise<void>;
}

export interface ProviderModelCatalogOptions {
  providerId: ProviderId;
  providerName: string;
  host: Pick<ProviderHost, 'mutateSettings' | 'notifyProviderChatOptionsChanged'>;
  read(): ProviderModelSelection & { enabled: boolean };
  discover(signal: AbortSignal): Promise<ProviderModelCatalogRefreshResult>;
  update(settings: Record<string, unknown>, patch: {
    visibleModels?: string[];
    modelAliases?: Record<string, string>;
  }): void;
  afterSelect?(addedIds: string[]): Promise<void>;
}

export function normalizeSelectedModelIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))];
}

/** Common settings policy. Providers retain discovery, native metadata and persistence authority. */
export class ProviderModelCatalogController implements ProviderModelCatalog {
  private readonly transitionFence = new ProviderTransitionFence();
  private attempted = false;
  private stale = false;
  private status: ProviderModelCatalogSnapshot['status'] = 'idle';
  private error: string | undefined;
  private controller: AbortController | null = null;
  private flight: Promise<ProviderModelCatalogRefreshResult> | null = null;
  private readonly pending = new Set<Promise<ProviderModelCatalogRefreshResult>>();
  private readonly observers = new Set<() => void>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: ProviderModelCatalogOptions) {}

  getSnapshot(): ProviderModelCatalogSnapshot {
    const state = this.options.read();
    const selectedIds = normalizeSelectedModelIds(state.selectedIds);
    const models = [...state.models];
    const known = new Map(models.map(model => [model.id, model]));
    for (const id of selectedIds) {
      if (!known.has(id)) {
        models.push({
          id,
          name: id,
          isAvailable: false,
          unavailableMessage: `Not currently reported by ${this.options.providerName}`,
        });
      }
    }
    return {
      aliases: state.aliases,
      models,
      selectedIds,
      stale: this.stale,
      status: this.status,
      error: this.error,
      discoveredCount: state.models.length,
      defaultModelId: selectedIds.find(id => known.has(id) && known.get(id)?.isAvailable !== false) ?? null,
    };
  }

  refresh(options: { force?: boolean } = {}): Promise<ProviderModelCatalogRefreshResult> {
    if (this.transitionFence.isUnavailable()) {
      return this.transitionFence.waitUntilAvailable().then(available => available ? this.refresh(options) : { changed: false });
    }
    if (this.disposed || !this.options.read().enabled) {
      return Promise.resolve({ changed: false });
    }
    if (this.flight) return this.flight;
    if (this.attempted && !options.force) return Promise.resolve({ changed: false });
    this.attempted = true;
    const controller = new AbortController();
    const generation = ++this.generation;
    this.controller = controller;
    this.status = 'loading';
    this.error = undefined;
    const flight = this.discover(controller, generation).finally(() => {
      this.pending.delete(flight);
      if (this.flight === flight) {
        this.flight = null;
        this.controller = null;
      }
    });
    this.flight = flight;
    this.pending.add(flight);
    this.publish();
    return flight;
  }

  private async discover(controller: AbortController, generation: number): Promise<ProviderModelCatalogRefreshResult> {
    try {
      const result = await this.options.discover(controller.signal);
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return { changed: false };
      if (result.diagnostics) throw new Error(result.diagnostics);
      this.stale = false;
      this.status = 'ready';
      this.publish();
      return result;
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return { changed: false };
      this.status = 'failed';
      this.error = error instanceof Error ? error.message : 'Model discovery failed.';
      this.publish();
      return { changed: false, diagnostics: this.error };
    }
  }

  beginTransition(): void {
    this.transitionFence.beginTransition();
    this.markStale();
  }

  async quiesce(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  endTransition(): void { this.transitionFence.endTransition(); }

  markStale(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.flight = null;
    this.stale = true;
    this.status = 'idle';
    this.error = undefined;
    this.publish();
  }

  async select(ids: string[]): Promise<void> {
    const selectedIds = normalizeSelectedModelIds(ids);
    const previousIds = this.options.read().selectedIds;
    await this.options.host.mutateSettings(settings => {
      this.options.update(settings, { visibleModels: selectedIds });
    });
    await this.options.afterSelect?.(selectedIds.filter(id => !previousIds.includes(id)));
    this.options.host.notifyProviderChatOptionsChanged(this.options.providerId);
    this.publish();
  }

  async setAliases(aliases: Record<string, string>): Promise<void> {
    await this.options.host.mutateSettings(settings => {
      this.options.update(settings, { modelAliases: aliases });
    });
    this.options.host.notifyProviderChatOptionsChanged(this.options.providerId);
    this.publish();
  }

  observe(observer: () => void): () => void {
    if (this.disposed) return () => {};
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  private publish(): void {
    if (this.disposed) return;
    for (const observer of this.observers) observer();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.transitionFence.dispose();
    this.observers.clear();
    this.generation += 1;
    this.controller?.abort();
    await this.quiesce();
  }
}
