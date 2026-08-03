import type { ProviderExecutionTransitionScope } from '../../core/execution';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import type { ProviderCliResolutionContext, ProviderId } from '../../core/providers/types';
import type { EnvironmentScope } from '../../core/types/settings';
import type ClaudianPlugin from '../../main';

/** Delegates provider-facing capabilities to the application composition root. */
export class ClaudianProviderHost implements ProviderHost {
  constructor(private readonly plugin: ClaudianPlugin) {}

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

  saveSettings(): Promise<void> {
    return this.plugin.saveSettings();
  }

  mutateSettings(
    mutation: (settings: typeof this.plugin.settings) => void | Promise<void>,
  ): Promise<void> {
    return this.plugin.mutateSettings(mutation);
  }

  mutateSettingsConditionally(
    mutation: (settings: typeof this.plugin.settings) => boolean | Promise<boolean>,
  ): Promise<void> {
    return this.plugin.mutateSettingsConditionally(mutation);
  }

  loadData(): Promise<unknown> {
    return this.plugin.loadData();
  }

  saveData(data: unknown): Promise<void> {
    return this.plugin.saveData(data);
  }

  normalizeModelVariantSettings(): boolean {
    return this.plugin.normalizeModelVariantSettings();
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
    mutation: (settings: typeof this.plugin.settings) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ): Promise<void> {
    return this.plugin.applyProviderRuntimeSettings(providerIds, mutation, onApplied);
  }

  async getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCliResolutionContext,
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
    for (const view of this.plugin.getAllViews()) {
      view.refreshModelSelector(providerId);
    }
  }
}
