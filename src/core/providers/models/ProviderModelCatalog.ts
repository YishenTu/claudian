import { ProviderTransitionFence } from '../metadata/ProviderTransitionFence';
import type { ProviderRuntimeHost, ProviderSelectionInputs } from '../ProviderRuntimeHost';
import type { ProviderModelCatalogRefreshResult } from '../types';

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

export type ProviderModelSelectionChange =
  | { type: 'set'; modelId: string; selected: boolean }
  | { type: 'move'; modelId: string; target: string | -1 | 1 }
  | { type: 'clear' };

export interface ProviderModelCatalog {
  getSnapshot(): ProviderModelCatalogSnapshot;
  refresh(options?: { force?: boolean }): Promise<ProviderModelCatalogRefreshResult>;
  markStale(): void;
  changeSelection(change: ProviderModelSelectionChange): Promise<void>;
  setAlias(modelId: string, alias: string): Promise<void>;
  observe(observer: () => void): () => void;
  dispose(): Promise<void>;
}

export interface ProviderModelCatalogState extends ProviderModelSelection {
  enabled: boolean;
}

export interface ProviderModelCatalogPatch {
  visibleModels?: string[];
  modelAliases?: Record<string, string>;
}

/** Where a provider keeps its selected models and aliases; persistence stays provider-owned. */
export interface ProviderModelCatalogStore {
  read(): ProviderModelCatalogState;
  /** Persists the patch computed from the current state in one transaction. */
  write(change: (current: ProviderModelCatalogState) => ProviderModelCatalogPatch): Promise<void>;
  notifyChatOptionsChanged(): void;
}

export interface ProviderModelCatalogOptions {
  providerName: string;
  store: ProviderModelCatalogStore;
  discover(signal: AbortSignal): Promise<ProviderModelCatalogRefreshResult>;
  afterSelect?(addedIds: string[]): Promise<void>;
}

/** A catalog store over the provider's own configuration, decoded and updated by its configuration module. */
export function createConfigCatalogStore(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection' | 'updateConfig' | 'notifyChatOptionsChanged'>,
  codec: {
    read(config: Readonly<Record<string, unknown>>, selection: ProviderSelectionInputs): ProviderModelCatalogState;
    update(config: Record<string, unknown>, selection: ProviderSelectionInputs, patch: ProviderModelCatalogPatch): void;
  },
): ProviderModelCatalogStore {
  return {
    read: () => codec.read(host.config, host.selection),
    async write(change) {
      await host.updateConfig((config, selection) => {
        codec.update(config, selection, change(codec.read(config, selection)));
        return true;
      });
    },
    notifyChatOptionsChanged: () => host.notifyChatOptionsChanged(),
  };
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
    const state = this.options.store.read();
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
    if (this.disposed || !this.options.store.read().enabled) {
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

  async changeSelection(change: ProviderModelSelectionChange): Promise<void> {
    let addedIds: string[] = [];
    await this.options.store.write(current => {
      const previousIds = normalizeSelectedModelIds(current.selectedIds);
      let selectedIds = [...previousIds];
      switch (change.type) {
        case 'clear':
          selectedIds = [];
          break;
        case 'set': {
          const modelId = change.modelId.trim();
          selectedIds = change.selected
            ? normalizeSelectedModelIds([...selectedIds, modelId])
            : selectedIds.filter(id => id !== modelId);
          break;
        }
        case 'move': {
          const index = selectedIds.indexOf(change.modelId);
          const target = typeof change.target === 'string'
            ? selectedIds.indexOf(change.target)
            : index + change.target;
          if (index >= 0 && target >= 0 && target < selectedIds.length) {
            selectedIds.splice(index, 1);
            selectedIds.splice(target, 0, change.modelId);
          }
          break;
        }
      }
      addedIds = selectedIds.filter(id => !previousIds.includes(id));
      return { visibleModels: selectedIds };
    });
    await this.options.afterSelect?.(addedIds);
    this.options.store.notifyChatOptionsChanged();
    this.publish();
  }

  async setAlias(modelId: string, alias: string): Promise<void> {
    await this.options.store.write(current => {
      const aliases = { ...current.aliases };
      if (alias.trim()) {
        Object.defineProperty(aliases, modelId, { value: alias.trim(), enumerable: true, configurable: true, writable: true });
      }
      else delete aliases[modelId];
      return { modelAliases: aliases };
    });
    this.options.store.notifyChatOptionsChanged();
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
