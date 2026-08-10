import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../core/providers/types';
import type { ClaudianSettings } from '../../core/types';
import type { ConditionalSettingsMutation } from '../settings/SettingsCoordinator';

export interface SessionInvalidationCoordinatorOptions {
  getSettings: () => ClaudianSettings;
  mutateSettingsConditionally: (
    mutation: ConditionalSettingsMutation<ClaudianSettings>,
  ) => Promise<void>;
}

export interface ProviderSessionInvalidationStatus {
  pendingGeneration: number | undefined;
  blockedGeneration: number | undefined;
}

export class SessionInvalidationCoordinator {
  private readonly getSettings: () => ClaudianSettings;
  private readonly mutateSettingsConditionally: (
    mutation: ConditionalSettingsMutation<ClaudianSettings>,
  ) => Promise<void>;
  private pendingGenerations = new Map<ProviderId, number>();
  private blockedGenerations = new Map<ProviderId, number>();

  constructor(options: SessionInvalidationCoordinatorOptions) {
    this.getSettings = options.getSettings;
    this.mutateSettingsConditionally = options.mutateSettingsConditionally;
  }

  sync(settings: ClaudianSettings): boolean {
    const pending = readPendingProviderSessionInvalidations(settings);
    const changed = !hasSamePendingProviderSessionInvalidations(
      settings.pendingProviderSessionInvalidations,
      pending,
    );
    settings.pendingProviderSessionInvalidations = serializePendingProviderSessionInvalidations(pending);
    this.pendingGenerations = pending;
    return changed;
  }

  getPendingProviderIds(): ProviderId[] {
    return [...this.pendingGenerations.keys()];
  }

  getPendingGenerations(): Map<ProviderId, number> {
    return new Map(this.pendingGenerations);
  }

  getStatus(providerId: ProviderId): ProviderSessionInvalidationStatus {
    return {
      pendingGeneration: this.pendingGenerations.get(providerId),
      blockedGeneration: this.blockedGenerations.get(providerId),
    };
  }

  stage(settings: ClaudianSettings, providerIds: ProviderId[]): Map<ProviderId, number> {
    const pending = readPendingProviderSessionInvalidations(settings);
    const marked = new Map<ProviderId, number>();
    for (const providerId of new Set(providerIds)) {
      const previousGeneration = Math.max(
        pending.get(providerId) ?? 0,
        this.pendingGenerations.get(providerId) ?? 0,
      );
      const generation = Math.max(Date.now(), previousGeneration + 1);
      pending.set(providerId, generation);
      marked.set(providerId, generation);
    }
    settings.pendingProviderSessionInvalidations = serializePendingProviderSessionInvalidations(pending);
    return marked;
  }

  commit(generations: ReadonlyMap<ProviderId, number>): void {
    for (const [providerId, generation] of generations) {
      this.pendingGenerations.set(providerId, generation);
    }
  }

  block(generations: ReadonlyMap<ProviderId, number>): void {
    for (const [providerId, generation] of generations) {
      this.blockedGenerations.set(providerId, generation);
    }
  }

  release(generations: ReadonlyMap<ProviderId, number>): void {
    for (const [providerId, generation] of generations) {
      if (this.blockedGenerations.get(providerId) === generation) {
        this.blockedGenerations.delete(providerId);
      }
    }
  }

  getCompletable(): Map<ProviderId, number> {
    return new Map(Array.from(
      this.pendingGenerations,
      ([providerId, generation]) => [providerId, generation] as const,
    ).filter(([providerId, generation]) => (
      this.blockedGenerations.get(providerId) !== generation
    )));
  }

  async complete(generations: ReadonlyMap<ProviderId, number>): Promise<void> {
    if (generations.size === 0) return;

    const removed = new Map<ProviderId, number>();
    try {
      await this.mutateSettingsConditionally((settings) => {
        const pending = readPendingProviderSessionInvalidations(settings);
        for (const [providerId, generation] of generations) {
          if (pending.get(providerId) === generation) {
            pending.delete(providerId);
            removed.set(providerId, generation);
          }
        }
        if (removed.size === 0) return false;
        settings.pendingProviderSessionInvalidations = serializePendingProviderSessionInvalidations(pending);
        return true;
      });
    } catch (error) {
      const pending = readPendingProviderSessionInvalidations(this.getSettings());
      for (const [providerId, generation] of removed) {
        if (this.pendingGenerations.get(providerId) === generation) {
          pending.set(providerId, generation);
        }
      }
      this.getSettings().pendingProviderSessionInvalidations = serializePendingProviderSessionInvalidations(pending);
      throw error;
    }

    for (const [providerId, generation] of removed) {
      if (this.pendingGenerations.get(providerId) === generation) {
        this.pendingGenerations.delete(providerId);
      }
    }
  }
}

function readPendingProviderSessionInvalidations(
  settings: Record<string, unknown>,
): Map<ProviderId, number> {
  const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
  const value = settings.pendingProviderSessionInvalidations;
  const pending = new Map<ProviderId, number>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return pending;
  for (const [providerId, generation] of Object.entries(value)) {
    if (
      registeredProviderIds.has(providerId)
      && typeof generation === 'number'
      && Number.isSafeInteger(generation)
      && generation > 0
    ) {
      pending.set(providerId, generation);
    }
  }
  return pending;
}

function serializePendingProviderSessionInvalidations(
  pending: ReadonlyMap<ProviderId, number>,
): Partial<Record<string, number>> {
  return Object.fromEntries(
    Array.from(pending.entries()).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function hasSamePendingProviderSessionInvalidations(
  value: unknown,
  pending: ReadonlyMap<ProviderId, number>,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === pending.size
    && entries.every(([providerId, generation]) => pending.get(providerId) === generation);
}
