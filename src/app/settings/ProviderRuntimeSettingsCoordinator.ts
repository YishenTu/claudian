import type { SettingsReconciliationResult } from '../../core/providers/ProviderSettingsCoordinator';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '../../core/providers/types';
import type { ClaudianSettings } from '../../core/types';
import type { ConversationRepository } from '../conversations/ConversationRepository';
import type { SessionInvalidationCoordinator } from '../conversations/SessionInvalidationCoordinator';
import {
  type SettingsCommit,
  type SettingsMutation,
  SettingsPostCommitError,
} from './SettingsCoordinator';

export interface ProviderRuntimeSettingsCoordinatorOptions {
  repository: ConversationRepository;
  sessionInvalidation: SessionInvalidationCoordinator;
  mutateSettings: (
    mutation: SettingsMutation<ClaudianSettings>,
    onCommitted?: SettingsCommit<ClaudianSettings>,
  ) => Promise<void>;
  reconcileModelWithEnvironment: (
    providerIds: ProviderId[],
    invalidateConversations: boolean,
  ) => SettingsReconciliationResult;
  isSessionMetadataLoaded: () => boolean;
  isUnloading: () => boolean;
}

export interface ProviderRuntimeSettingsCommitOptions {
  failureMessage: string;
  onInvalidationsPersisted?: (
    reconciliation: SettingsReconciliationResult,
  ) => void | Promise<void>;
  onSettingsCommitted?: (
    reconciliation: SettingsReconciliationResult,
  ) => void | Promise<void>;
}

export class ProviderRuntimeSettingsCoordinator {
  private readonly repository: ConversationRepository;
  private readonly sessionInvalidation: SessionInvalidationCoordinator;
  private readonly mutateSettings: ProviderRuntimeSettingsCoordinatorOptions['mutateSettings'];
  private readonly reconcileModelWithEnvironment: ProviderRuntimeSettingsCoordinatorOptions[
    'reconcileModelWithEnvironment'
  ];
  private readonly isSessionMetadataLoaded: () => boolean;
  private readonly isUnloading: () => boolean;

  constructor(options: ProviderRuntimeSettingsCoordinatorOptions) {
    this.repository = options.repository;
    this.sessionInvalidation = options.sessionInvalidation;
    this.mutateSettings = options.mutateSettings;
    this.reconcileModelWithEnvironment = options.reconcileModelWithEnvironment;
    this.isSessionMetadataLoaded = options.isSessionMetadataLoaded;
    this.isUnloading = options.isUnloading;
  }

  async commit(
    providerIds: ProviderId[],
    mutation: SettingsMutation<ClaudianSettings>,
    options: ProviderRuntimeSettingsCommitOptions,
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
      await this.mutateSettings(async (settings) => {
        await mutation(settings);
        reconciliation = this.reconcileModelWithEnvironment(providerIds, false);
        invalidationGenerations = this.sessionInvalidation.stage(
          settings,
          reconciliation.sessionInvalidationProviderIds,
        );
      }, () => {
        this.sessionInvalidation.commit(invalidationGenerations);
        this.sessionInvalidation.block(invalidationGenerations);
        ProviderSettingsCoordinator.invalidateConversationSessions(
          this.repository.getAll(),
          reconciliation.sessionInvalidationProviderIds,
        );
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
        const invalidatedProviderIds = new Set(invalidationGenerations.keys());
        const conversationsToPersist = this.repository.getAll().filter(
          conversation => invalidatedProviderIds.has(conversation.providerId),
        );
        await this.repository.persistConversations(
          conversationsToPersist.filter(
            conversation => this.repository.getCachedConversation(conversation.id) === conversation,
          ),
        );
        invalidationMetadataPersisted = true;
      } catch (error) {
        errors.push(error);
      }
      if (invalidationMetadataPersisted) {
        this.sessionInvalidation.release(invalidationGenerations);
        if (this.isSessionMetadataLoaded() && !this.isUnloading()) {
          try {
            await this.sessionInvalidation.complete(invalidationGenerations);
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

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, options.failureMessage);
    }
    return reconciliation;
  }
}
