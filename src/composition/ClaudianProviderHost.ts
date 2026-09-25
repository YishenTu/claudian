import type { ProviderExecutionTransitionScope } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCLIResolutionContext, ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import type { EnvironmentScope } from '@/core/types/settings';

/**
 * Delegates provider-facing capabilities to the composition root, which structurally
 * provides them. Providers see only this narrow host, never plugin lifecycle APIs.
 */
export class ClaudianProviderHost implements ProviderHost {
  constructor(private readonly plugin: ProviderHost) {}

  get app() {
    return this.plugin.app;
  }

  get executionLifecycleRegistry() {
    return this.plugin.executionLifecycleRegistry;
  }

  get settings() {
    return this.plugin.settings;
  }

  get storage() {
    return this.plugin.storage;
  }

  get manifest() {
    return this.plugin.manifest;
  }

  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void> {
    return this.plugin.mutateSettings(mutation);
  }

  mutateSettingsConditionally(
    mutation: (settings: ClaudianSettings) => boolean | Promise<boolean>,
  ): Promise<void> {
    return this.plugin.mutateSettingsConditionally(mutation);
  }

  getActiveEnvironmentVariables(providerId: ProviderId): string {
    return this.plugin.getActiveEnvironmentVariables(providerId);
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return this.plugin.getEnvironmentVariablesForScope(scope);
  }

  applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void> {
    return this.plugin.applyEnvironmentVariables(scope, envText);
  }

  applyEnvironmentVariablesBatch(
    updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void> {
    return this.plugin.applyEnvironmentVariablesBatch(updates);
  }

  applyProviderRuntimeSettings(
    providerIds: ProviderId[],
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ): Promise<void> {
    return this.plugin.applyProviderRuntimeSettings(providerIds, mutation, onApplied);
  }

  async getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCLIResolutionContext,
  ): Promise<string | null> {
    return this.plugin.getResolvedProviderCliPath(providerId, context);
  }

  runProviderExecutionTransition<T>(
    providerIds: ProviderId[],
    mutation: (scope: ProviderExecutionTransitionScope) => Promise<T>,
    parentScope?: ProviderExecutionTransitionScope,
  ): Promise<T> {
    if (!parentScope) {
      return this.plugin.runProviderExecutionTransition(providerIds, mutation);
    }
    return this.plugin.runProviderExecutionTransition(
      providerIds,
      mutation,
      parentScope,
    );
  }

  notifyProviderChatOptionsChanged(providerId: ProviderId): void {
    void this.plugin.notifyProviderChatOptionsChanged(providerId);
  }
}
