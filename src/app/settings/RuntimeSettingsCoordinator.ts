import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator, type SettingsReconciliationResult } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';

import { type SettingsCoordinator, type SettingsMutation, SettingsPostCommitError } from './SettingsCoordinator';

interface RuntimeSettingsCoordinatorOptions {
  readonly settings: SettingsCoordinator<ClaudianSettings>;
  readonly getSettings: () => ClaudianSettings;
  readonly getVaultPath?: () => string | null;
}

/**
 * Commits provider runtime settings with their reconciled runtime fingerprints. A changed
 * fingerprint restarts the provider runtime; conversation bindings are never touched.
 */
export class RuntimeSettingsCoordinator {
  constructor(private readonly options: RuntimeSettingsCoordinatorOptions) {}

  reconcile(
    providerIds: ProviderId[] = ProviderRegistry.getRegisteredProviderIds(),
    settings = this.options.getSettings(),
  ): SettingsReconciliationResult {
    return ProviderSettingsCoordinator.reconcileProviders(settings, providerIds, { vaultPath: this.options.getVaultPath?.() });
  }

  async commit(
    providerIds: ProviderId[],
    mutation: SettingsMutation<ClaudianSettings>,
    options: {
      failureMessage: string;
      onSettingsCommitted?: (
        reconciliation: SettingsReconciliationResult,
      ) => void | Promise<void>;
    },
  ): Promise<SettingsReconciliationResult> {
    let reconciliation: SettingsReconciliationResult = {
      changed: false,
      environmentChangedProviderIds: [],
    };
    let settingsCommitted = false;
    const errors: unknown[] = [];

    try {
      await this.options.settings.mutate(async (settings) => {
        await mutation(settings);
        reconciliation = this.reconcile(providerIds, settings);
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

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, options.failureMessage);
    }
    return reconciliation;
  }
}
