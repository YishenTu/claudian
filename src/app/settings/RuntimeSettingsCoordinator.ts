import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator, type SettingsReconciliationResult } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';

import type { ConversationRepository } from '../conversations/ConversationRepository';
import { type SettingsCoordinator, type SettingsMutation, SettingsPostCommitError } from './SettingsCoordinator';

interface RuntimeSettingsCoordinatorOptions {
  readonly settings: SettingsCoordinator<ClaudianSettings>;
  readonly conversations: Pick<ConversationRepository, 'invalidateProviderSessions' | 'persistProviderSessionInvalidations'>;
  readonly getSettings: () => ClaudianSettings;
  readonly canCompleteInvalidations: () => boolean;
}

function readPendingProviderSessionInvalidations(
  settings: Record<string, unknown>,
): Map<ProviderId, number> {
  const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
  const value = settings.pendingProviderSessionInvalidations;
  const pending = new Map<ProviderId, number>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return pending;
  }

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length === pending.size
    && entries.every(([providerId, generation]) => pending.get(providerId) === generation);
}

export class RuntimeSettingsCoordinator {
  private pendingEnvironmentInvalidationGenerations = new Map<ProviderId, number>();
  private blockedEnvironmentInvalidationGenerations = new Map<ProviderId, number>();

  constructor(private readonly options: RuntimeSettingsCoordinatorOptions) {}

  getPendingGenerations(): ReadonlyMap<ProviderId, number> {
    return new Map(this.pendingEnvironmentInvalidationGenerations);
  }

  getPendingProviderIds(): ProviderId[] {
    return [...this.pendingEnvironmentInvalidationGenerations.keys()];
  }

  reconcile(
    providerIds: ProviderId[] = ProviderRegistry.getRegisteredProviderIds(),
    invalidateConversations = true,
  ): SettingsReconciliationResult {
    const result = ProviderSettingsCoordinator.reconcileProviders(
      this.options.getSettings(), [], providerIds, { invalidateConversations: false },
    );
    if (invalidateConversations) {
      result.invalidatedConversations = this.options.conversations.invalidateProviderSessions(
        result.sessionInvalidationProviderIds,
      );
    }
    return result;
  }

  syncPendingSessionInvalidations(): boolean {
    const pending = readPendingProviderSessionInvalidations(this.options.getSettings());
    const changed = !hasSamePendingProviderSessionInvalidations(
      this.options.getSettings().pendingProviderSessionInvalidations,
      pending,
    );
    this.options.getSettings().pendingProviderSessionInvalidations =
      serializePendingProviderSessionInvalidations(pending);
    this.pendingEnvironmentInvalidationGenerations = pending;
    return changed;
  }

  markPendingSessionInvalidations(
    settings: ClaudianSettings,
    providerIds: ProviderId[],
  ): Map<ProviderId, number> {
    const marked = this.stagePendingSessionInvalidations(settings, providerIds);
    this.commitPendingSessionInvalidations(marked);
    return marked;
  }

  private stagePendingSessionInvalidations(
    settings: ClaudianSettings,
    providerIds: ProviderId[],
  ): Map<ProviderId, number> {
    const pending = readPendingProviderSessionInvalidations(settings);
    const marked = new Map<ProviderId, number>();
    for (const providerId of new Set(providerIds)) {
      const previousGeneration = Math.max(
        pending.get(providerId) ?? 0,
        this.pendingEnvironmentInvalidationGenerations.get(providerId) ?? 0,
      );
      const generation = Math.max(Date.now(), previousGeneration + 1);
      pending.set(providerId, generation);
      marked.set(providerId, generation);
    }
    settings.pendingProviderSessionInvalidations =
      serializePendingProviderSessionInvalidations(pending);
    return marked;
  }

  private commitPendingSessionInvalidations(
    generations: ReadonlyMap<ProviderId, number>,
  ): void {
    for (const [providerId, generation] of generations) {
      this.pendingEnvironmentInvalidationGenerations.set(providerId, generation);
    }
  }

  private blockEnvironmentInvalidationCompletion(
    generations: ReadonlyMap<ProviderId, number>,
  ): void {
    for (const [providerId, generation] of generations) {
      this.blockedEnvironmentInvalidationGenerations.set(providerId, generation);
    }
  }

  private releaseEnvironmentInvalidationCompletion(
    generations: ReadonlyMap<ProviderId, number>,
  ): void {
    for (const [providerId, generation] of generations) {
      if (this.blockedEnvironmentInvalidationGenerations.get(providerId) === generation) {
        this.blockedEnvironmentInvalidationGenerations.delete(providerId);
      }
    }
  }

  getCompletablePendingSessionInvalidations(): Map<ProviderId, number> {
    return new Map(Array.from(
      this.pendingEnvironmentInvalidationGenerations,
      ([providerId, generation]) => [providerId, generation] as const,
    ).filter(([providerId, generation]) => (
      this.blockedEnvironmentInvalidationGenerations.get(providerId) !== generation
    )));
  }

  async completePendingSessionInvalidations(
    completedGenerations: ReadonlyMap<ProviderId, number>,
  ): Promise<void> {
    if (completedGenerations.size === 0) {
      return;
    }

    const removed = new Map<ProviderId, number>();
    try {
      await this.options.settings.mutateConditionally((settings) => {
        const pending = readPendingProviderSessionInvalidations(settings);
        for (const [providerId, generation] of completedGenerations) {
          if (pending.get(providerId) === generation) {
            pending.delete(providerId);
            removed.set(providerId, generation);
          }
        }
        if (removed.size === 0) {
          return false;
        }
        settings.pendingProviderSessionInvalidations =
          serializePendingProviderSessionInvalidations(pending);
        return true;
      });
    } catch (error) {
      const pending = readPendingProviderSessionInvalidations(this.options.getSettings());
      for (const [providerId, generation] of removed) {
        if (this.pendingEnvironmentInvalidationGenerations.get(providerId) === generation) {
          pending.set(providerId, generation);
        }
      }
      this.options.getSettings().pendingProviderSessionInvalidations =
        serializePendingProviderSessionInvalidations(pending);
      throw error;
    }

    for (const [providerId, generation] of removed) {
      if (this.pendingEnvironmentInvalidationGenerations.get(providerId) === generation) {
        this.pendingEnvironmentInvalidationGenerations.delete(providerId);
      }
    }
  }

  async commit(
    providerIds: ProviderId[],
    mutation: SettingsMutation<ClaudianSettings>,
    options: {
      failureMessage: string;
      onInvalidationsPersisted?: (
        reconciliation: SettingsReconciliationResult,
      ) => void | Promise<void>;
      onSettingsCommitted?: (
        reconciliation: SettingsReconciliationResult,
      ) => void | Promise<void>;
    },
  ): Promise<SettingsReconciliationResult> {
    let reconciliation: SettingsReconciliationResult = {
      changed: false,
      environmentChangedProviderIds: [],
      invalidatedConversations: [],
      sessionInvalidationProviderIds: [],
    };
    let invalidationGenerations = new Map<ProviderId, number>();
    let invalidationPublished = false;
    let settingsCommitted = false;
    const errors: unknown[] = [];

    try {
      await this.options.settings.mutate(async (settings) => {
        await mutation(settings);
        reconciliation = this.reconcile(providerIds, false);
        invalidationGenerations = this.stagePendingSessionInvalidations(
          settings,
          reconciliation.sessionInvalidationProviderIds,
        );
      }, () => {
        this.commitPendingSessionInvalidations(invalidationGenerations);
        this.blockEnvironmentInvalidationCompletion(invalidationGenerations);
        this.options.conversations.invalidateProviderSessions(reconciliation.sessionInvalidationProviderIds);
        invalidationPublished = true;
      });
      settingsCommitted = true;
    } catch (error) {
      if (error instanceof SettingsPostCommitError) {
        settingsCommitted = true;
        errors.push(error.cause);
      } else {
        errors.push(error);
      }
    }

    if (settingsCommitted) {
      try {
        await options.onSettingsCommitted?.(reconciliation);
      } catch (error) {
        errors.push(error);
      }
    }

    if (invalidationPublished && invalidationGenerations.size > 0) {
      let invalidationMetadataPersisted = false;
      try {
        await this.options.conversations.persistProviderSessionInvalidations(
          [...invalidationGenerations.keys()],
        );
        invalidationMetadataPersisted = true;
      } catch (error) {
        errors.push(error);
      }
      if (invalidationMetadataPersisted) {
        this.releaseEnvironmentInvalidationCompletion(invalidationGenerations);
        if (this.options.canCompleteInvalidations()) {
          try {
            await this.completePendingSessionInvalidations(invalidationGenerations);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }

    if (settingsCommitted) {
      try {
        await options.onInvalidationsPersisted?.(reconciliation);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, options.failureMessage);
    }
    return reconciliation;
  }

}
