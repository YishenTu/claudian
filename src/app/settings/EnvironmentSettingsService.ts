import { Notice } from 'obsidian';

import type { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import {
  getEnvironmentVariablesForScope,
  getRuntimeEnvironmentText,
  setEnvironmentVariablesForScope,
} from '@/core/providers/providerEnvironment';
import type { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import type { EnvironmentScope } from '@/core/types/settings';

import type { RuntimeSettingsCoordinator } from './RuntimeSettingsCoordinator';
import type { SettingsMutation } from './SettingsCoordinator';

export interface EnvironmentUpdate {
  scope: EnvironmentScope;
  envText: string;
}

export interface EnvironmentSettingsServiceDeps {
  getSettings(): Readonly<ClaudianSettings>;
  readonly runtimeSettings: Pick<RuntimeSettingsCoordinator, 'commit'>;
  readonly executionLifecycle: Pick<ProviderExecutionLifecycleRegistry, 'runTransition'>;
  readonly providers: Pick<typeof ProviderRegistry, 'getRegisteredProviderIds' | 'resolveSettingsProviderId'>;
  readonly providerSettings: Pick<typeof ProviderSettingsCoordinator, 'handleEnvironmentChange'>;
  /** Publishes applied environment changes to provider command caches and chat options. */
  onEnvironmentApplied(providerIds: ProviderId[]): Promise<void>;
}

/**
 * Applies environment and provider runtime settings. Each change quiesces the
 * affected providers, commits settings with their session invalidations, and
 * only then publishes the change; updates are serialized in submission order.
 */
export class EnvironmentSettingsService {
  private updateTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EnvironmentSettingsServiceDeps) {}

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(
    providerId: ProviderId = this.deps.providers.resolveSettingsProviderId(this.deps.getSettings()),
  ): string {
    return getRuntimeEnvironmentText(this.deps.getSettings(), providerId);
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return getEnvironmentVariablesForScope(this.deps.getSettings(), scope);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void> {
    return this.applyEnvironmentVariablesBatch([{ scope, envText }]);
  }

  async applyEnvironmentVariablesBatch(updates: readonly EnvironmentUpdate[]): Promise<void> {
    const queuedUpdates = updates.map(update => ({ ...update }));
    const apply = this.updateTail.then(
      () => this.#applyEnvironmentVariablesBatchNow(queuedUpdates),
    );
    this.updateTail = apply.catch(() => undefined);
    await apply;
  }

  async applyProviderRuntimeSettings(
    providerIds: ProviderId[],
    mutation: SettingsMutation<ClaudianSettings>,
    onApplied?: () => void | Promise<void>,
  ): Promise<void> {
    const uniqueProviderIds = Array.from(new Set(providerIds));
    await this.deps.executionLifecycle.runTransition(uniqueProviderIds, async () => {
      await this.deps.runtimeSettings.commit(
        uniqueProviderIds,
        mutation,
        {
          failureMessage: 'Provider runtime settings change recovery failed.',
          onSettingsCommitted: onApplied,
        },
      );
    });
  }

  async #applyEnvironmentVariablesBatchNow(updates: readonly EnvironmentUpdate[]): Promise<void> {
    const nextEnvironmentByScope = new Map<EnvironmentScope, string>();
    for (const update of updates) {
      nextEnvironmentByScope.set(update.scope, update.envText);
    }

    const providersToQuiesce = this.#getAffectedProviders(
      this.#getChangedScopes(this.deps.getSettings(), nextEnvironmentByScope),
    );
    await this.deps.executionLifecycle.runTransition(providersToQuiesce, async () => {
      let affectedProviderIds: ProviderId[] = [];
      await this.deps.runtimeSettings.commit(
        providersToQuiesce,
        (settings) => {
          const changedScopes = this.#getChangedScopes(settings, nextEnvironmentByScope);
          for (const [scope, envText] of nextEnvironmentByScope) {
            setEnvironmentVariablesForScope(settings, scope, envText);
          }
          affectedProviderIds = this.#getAffectedProviders(changedScopes);
          this.deps.providerSettings.handleEnvironmentChange(settings, affectedProviderIds);
        },
        {
          failureMessage: 'Environment change recovery failed.',
          onInvalidationsPersisted: async (reconciliation) => {
            if (affectedProviderIds.length === 0) {
              return;
            }
            await this.deps.onEnvironmentApplied(affectedProviderIds);

            const noticeText = reconciliation.sessionInvalidationProviderIds.length > 0
              ? 'Environment variables applied. Sessions will be rebuilt on next message.'
              : 'Environment variables applied.';
            new Notice(noticeText);
          },
        },
      );
    });
  }

  #getChangedScopes(
    settings: Readonly<ClaudianSettings>,
    nextEnvironmentByScope: ReadonlyMap<EnvironmentScope, string>,
  ): EnvironmentScope[] {
    return [...nextEnvironmentByScope].flatMap(([scope, envText]) => (
      getEnvironmentVariablesForScope(settings, scope) === envText ? [] : [scope]
    ));
  }

  #getAffectedProviders(scopes: EnvironmentScope[]): ProviderId[] {
    const registeredProviderIds = new Set(this.deps.providers.getRegisteredProviderIds());
    const affectedProviderIds = new Set<ProviderId>();

    for (const scope of scopes) {
      if (scope === 'shared') {
        for (const providerId of registeredProviderIds) {
          affectedProviderIds.add(providerId);
        }
        continue;
      }

      const providerId = scope.slice('provider:'.length);
      if (registeredProviderIds.has(providerId)) {
        affectedProviderIds.add(providerId);
      }
    }

    return Array.from(affectedProviderIds);
  }
}
