import type { ProviderHost } from '../../core/providers/ProviderHost';
import type { ProviderCliResolutionContext, ProviderId } from '../../core/providers/types';
import type { ChatRuntime } from '../../core/runtime/ChatRuntime';
import type { EnvironmentScope } from '../../core/types/settings';
import type ClaudianPlugin from '../../main';

/** Delegates provider-facing capabilities to the application composition root. */
export class ClaudianProviderHost implements ProviderHost {
  constructor(private readonly plugin: ClaudianPlugin) {}

  get app() {
    return this.plugin.app;
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

  getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCliResolutionContext,
  ): string | null {
    return this.plugin.getResolvedProviderCliPath(providerId, context);
  }

  refreshModelSelectors(): void {
    for (const view of this.plugin.getAllViews()) {
      view.refreshModelSelector();
    }
  }

  async broadcastToActiveViewRuntimes(
    action: (runtime: ChatRuntime) => Promise<void> | void,
  ): Promise<void> {
    await this.plugin.getView()?.getTabManager()?.broadcastToAllTabs(
      (runtime) => Promise.resolve(action(runtime)),
    );
  }

  async broadcastToAllViewRuntimes(
    action: (runtime: ChatRuntime) => Promise<void> | void,
  ): Promise<void> {
    for (const view of this.plugin.getAllViews()) {
      await view.getTabManager()?.broadcastToAllTabs(
        (runtime) => Promise.resolve(action(runtime)),
      );
    }
  }

  async recycleProviderRuntimes(providerId: ProviderId): Promise<void> {
    for (const view of this.plugin.getAllViews()) {
      const tabManager = view.getTabManager();
      await tabManager?.recycleProviderRuntimes(providerId);
      view.invalidateProviderCommandCaches?.([providerId]);
      view.refreshModelSelector?.();
    }
  }
}
