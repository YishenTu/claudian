import type { App } from 'obsidian';

import type { EnvironmentSettingsService, EnvironmentUpdate } from '@/app/settings/EnvironmentSettingsService';
import type { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderHostStorage } from '@/core/bootstrap/storage';
import type {
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionTransitionScope,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCLIResolutionContext,
  ProviderId,
  ProviderSessionArchive,
} from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import type { EnvironmentScope } from '@/core/types/settings';

export interface ClaudianProviderHostDeps {
  readonly app: App;
  readonly manifest?: { version?: string };
  readonly executionLifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly storage: ProviderHostStorage;
  readonly settings: Pick<
    SettingsCoordinator<ClaudianSettings>,
    'getCommittedSettings' | 'mutate' | 'mutateConditionally'
  >;
  readonly environment: Pick<
    EnvironmentSettingsService,
    | 'applyEnvironmentVariables'
    | 'applyEnvironmentVariablesBatch'
    | 'applyProviderRuntimeSettings'
    | 'getActiveEnvironmentVariables'
    | 'getEnvironmentVariablesForScope'
  >;
  notifyProviderChatOptionsChanged(providerId: ProviderId): Promise<void>;
}

/**
 * Provider-facing capabilities assembled from application domains. Providers see
 * only this narrow host, never plugin lifecycle, views, or conversation ownership.
 */
export class ClaudianProviderHost implements ProviderHost {
  readonly app: App;
  readonly manifest?: { version?: string };
  readonly executionLifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly storage: ProviderHostStorage;

  constructor(private readonly deps: ClaudianProviderHostDeps) {
    this.app = deps.app;
    this.manifest = deps.manifest;
    this.executionLifecycleRegistry = deps.executionLifecycleRegistry;
    this.storage = deps.storage;
  }

  get settings(): Readonly<ClaudianSettings> {
    return this.deps.settings.getCommittedSettings();
  }

  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void> {
    return this.deps.settings.mutate(mutation);
  }

  mutateSettingsConditionally(
    mutation: (settings: ClaudianSettings) => boolean | Promise<boolean>,
  ): Promise<void> {
    return this.deps.settings.mutateConditionally(mutation);
  }

  getActiveEnvironmentVariables(providerId: ProviderId): string {
    return this.deps.environment.getActiveEnvironmentVariables(providerId);
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return this.deps.environment.getEnvironmentVariablesForScope(scope);
  }

  applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void> {
    return this.deps.environment.applyEnvironmentVariables(scope, envText);
  }

  applyEnvironmentVariablesBatch(updates: EnvironmentUpdate[]): Promise<void> {
    return this.deps.environment.applyEnvironmentVariablesBatch(updates);
  }

  applyProviderRuntimeSettings(
    providerIds: ProviderId[],
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ): Promise<void> {
    return this.deps.environment.applyProviderRuntimeSettings(providerIds, mutation, onApplied);
  }

  async getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCLIResolutionContext,
  ): Promise<string | null> {
    if (context?.providerTransitionOwner !== true) {
      await ProviderWorkspaceRegistry.ensureInitialized(this, providerId, 'cli-resolution');
    }
    const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
    if (!cliResolver) {
      if (context?.providerTransitionOwner === true) {
        throw new Error(
          `Provider transition owner requires initialized workspace services for "${providerId}".`,
        );
      }
      return null;
    }

    return cliResolver.resolveFromSettings(this.settings, context);
  }

  /** Null when the provider has no native archive; initializes only archive providers. */
  async getSessionArchive(providerId: ProviderId): Promise<ProviderSessionArchive | null> {
    if (!ProviderWorkspaceRegistry.providesSessionArchive(providerId)) return null;
    await ProviderWorkspaceRegistry.ensureInitialized(this, providerId, 'session-archive');
    return ProviderWorkspaceRegistry.getIfInitialized(providerId)?.sessionArchive ?? null;
  }

  runProviderExecutionTransition<T>(
    providerIds: ProviderId[],
    mutation: (scope: ProviderExecutionTransitionScope) => Promise<T>,
    parentScope?: ProviderExecutionTransitionScope,
  ): Promise<T> {
    if (!parentScope) {
      return this.executionLifecycleRegistry.runTransition(providerIds, mutation);
    }
    return this.executionLifecycleRegistry.runTransition(providerIds, mutation, parentScope);
  }

  notifyProviderChatOptionsChanged(providerId: ProviderId): void {
    void this.deps.notifyProviderChatOptionsChanged(providerId);
  }
}
