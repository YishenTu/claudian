import type { App } from 'obsidian';

import type { EnvironmentSettingsService, EnvironmentUpdate } from '@/app/settings/EnvironmentSettingsService';
import type { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderHostStorage } from '@/core/bootstrap/storage';
import type {
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionTransitionScope,
} from '@/core/execution';
import { resolveLoginShellPath } from '@/core/process/loginShellPath';
import {
  getProviderConfig,
  getProviderSavedSelection,
  getProviderSelectionDefaults,
  getProviderSelectionInputs,
  setProviderConfig,
} from '@/core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCLIResolutionContext,
  ProviderId,
  ProviderSessionArchive,
} from '@/core/providers/types';
import type { SessionToolEndpoint } from '@/core/session-tools/SessionToolEndpoint';
import type { ClaudianSettings } from '@/core/types';
import type { EnvironmentScope } from '@/core/types/settings';
import { getVaultPath } from '@/utils/path';

export interface ClaudianProviderHostDeps {
  readonly app: App;
  readonly manifest?: { version?: string };
  readonly executionLifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly storage: ProviderHostStorage;
  readonly sessionToolEndpoint: SessionToolEndpoint;
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
  readonly sessionToolEndpoint: SessionToolEndpoint;
  readonly #runtimeHosts = new Map<ProviderId, ProviderRuntimeHost>();

  constructor(private readonly deps: ClaudianProviderHostDeps) {
    this.app = deps.app;
    this.manifest = deps.manifest;
    this.executionLifecycleRegistry = deps.executionLifecycleRegistry;
    this.storage = deps.storage;
    this.sessionToolEndpoint = deps.sessionToolEndpoint;
  }

  get workingDirectory(): string | null {
    return getVaultPath(this.app);
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
    // Provider launches resolve their CLI here first, so the login-shell PATH is ready for them.
    await resolveLoginShellPath();
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

  getRuntimeHost(providerId: ProviderId): ProviderRuntimeHost {
    let runtimeHost = this.#runtimeHosts.get(providerId);
    if (!runtimeHost) {
      runtimeHost = createProviderRuntimeHost(this, this.deps.settings, providerId);
      this.#runtimeHosts.set(providerId, runtimeHost);
    }
    return runtimeHost;
  }
}

/** The settings document a runtime host projects, through its owning coordinator. */
interface RuntimeSettingsSource {
  getCommittedSettings(): Readonly<Record<string, unknown>>;
  mutateConditionally(mutation: (draft: Record<string, unknown>) => boolean | Promise<boolean>): Promise<void>;
}

/** A live provider-scoped projection of the application host; it holds no state of its own. */
export function createProviderRuntimeHost(
  host: Pick<
    ProviderHost,
    | 'manifest' | 'workingDirectory' | 'storage' | 'sessionToolEndpoint'
    | 'getResolvedProviderCliPath' | 'notifyProviderChatOptionsChanged'
  >,
  settings: RuntimeSettingsSource,
  providerId: ProviderId,
): ProviderRuntimeHost {
  const committed = (): Readonly<Record<string, unknown>> => settings.getCommittedSettings();
  return {
    get config() { return getProviderConfig(committed(), providerId); },
    get selection() { return getProviderSelectionInputs(committed(), providerId); },
    get providerSelection() {
      return getProviderSelectionDefaults(ProviderSettingsCoordinator.getProviderSettingsSnapshot(committed(), providerId));
    },
    get savedSelection() { return getProviderSavedSelection(committed(), providerId); },
    get environmentText() { return getRuntimeEnvironmentText(committed(), providerId); },
    get locale() { const { locale } = committed(); return typeof locale === 'string' ? locale : ''; },
    get clientVersion() { return host.manifest?.version; },
    get workingDirectory() { return host.workingDirectory; },
    storage: host.storage,
    sessionToolEndpoint: host.sessionToolEndpoint,
    resolveCliPath: context => host.getResolvedProviderCliPath(providerId, context),
    notifyChatOptionsChanged: () => host.notifyProviderChatOptionsChanged(providerId),
    async updateConfig(mutation) {
      let written = false;
      await settings.mutateConditionally(async draft => {
        // The draft publishes even when unwritten, so the mutation edits a private copy.
        const config = structuredClone(getProviderConfig(draft, providerId));
        if (!await mutation(config, getProviderSelectionInputs(draft, providerId))) return false;
        setProviderConfig(draft, providerId, config);
        written = true;
        return true;
      });
      return written;
    },
  };
}
