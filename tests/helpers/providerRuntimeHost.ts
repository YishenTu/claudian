import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { createProviderRuntimeHost } from '@/composition/ClaudianProviderHost';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { ProviderCLIResolutionContext, ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';

/** The application-host capabilities a provider runtime host reads; everything but `settings` is optional. */
export interface RuntimeHostFixture {
  settings: object;
  workingDirectory?: string | null;
  manifest?: { version?: string };
  storage?: unknown;
  sessionToolEndpoint?: unknown;
  getResolvedProviderCliPath?: (providerId: ProviderId, context?: ProviderCLIResolutionContext) => Promise<string | null> | string | null;
  notifyProviderChatOptionsChanged?: (providerId: ProviderId) => void;
}

interface RuntimeHostOptions {
  /** Receives each committed settings document; rejecting rolls the write back. */
  persist?: (settings: ClaudianSettings) => Promise<void>;
}

/**
 * A provider runtime host over a fixture, through the production projection. Reads stay
 * live: later edits to the fixture (settings, mocks) and committed writes are both visible.
 */
export function runtimeHostFor(
  host: RuntimeHostFixture,
  providerId: ProviderId,
  { persist = async () => undefined }: RuntimeHostOptions = {},
): ProviderRuntimeHost {
  const coordinator = new SettingsCoordinator(host.settings as ClaudianSettings, persist);
  return createProviderRuntimeHost({
    get workingDirectory() { return host.workingDirectory ?? null; },
    get manifest() { return host.manifest; },
    get storage() { return host.storage as ProviderHost['storage']; },
    get sessionToolEndpoint() { return host.sessionToolEndpoint as ProviderHost['sessionToolEndpoint']; },
    getResolvedProviderCliPath: async (id, context) => await host.getResolvedProviderCliPath?.(id, context) ?? null,
    notifyProviderChatOptionsChanged: id => host.notifyProviderChatOptionsChanged?.(id),
  }, coordinator, providerId);
}

/**
 * Adds `getRuntimeHost` to an application host fixture and types it as the `ProviderHost`
 * it stands in for; members the fixture omits stay absent at runtime.
 */
export function withRuntimeHosts<T extends RuntimeHostFixture>(host: T): T & ProviderHost {
  return Object.assign(host, {
    getRuntimeHost: (providerId: ProviderId) => runtimeHostFor(host, providerId),
  }) as unknown as T & ProviderHost;
}

export interface ProviderHostFixtureOptions {
  /** Overrides application defaults; the fixture owns the resulting mutable document. */
  settings?: Partial<ClaudianSettings>;
  /** Reuse a caller-owned vault; only a vault created by this fixture is removed by dispose. */
  vault?: import('@test/helpers/core/DesktopVault').DesktopVault;
  app?: import('obsidian').App;
  /** A fault/observation hook before the real settings write. */
  beforePersist?: (settings: ClaudianSettings) => void | Promise<void>;
  /** Replace a host capability for a test-specific external response or fault. */
  overrides?: Partial<ProviderHost>;
}

/**
 * Complete provider host over the real settings, environment, lifecycle and storage owners.
 * Native CLI lookup defaults to unavailable; inject that external result through overrides.
 * The endpoint binds only when used. dispose is idempotent and also runs at test completion.
 */
export async function createProviderHostFixture(options: ProviderHostFixtureOptions = {}) {
  // Keep the existing lightweight runtime projections cheap for their many unit consumers.
  const [
    { DesktopVault }, { DEFAULT_CLAUDIAN_SETTINGS }, { ClaudianSettingsStorage },
    { ClaudianProviderHost }, { ProviderExecutionLifecycleRegistry }, { LoopbackSessionToolServer },
    { getInstallationKey }, { EnvironmentSettingsService }, { RuntimeSettingsCoordinator },
    { ConversationRepository }, { ConversationPersistenceStore }, { ProviderRegistry }, { ProviderSettingsCoordinator },
  ] = await Promise.all([
    import('@test/helpers/core/DesktopVault'), import('@test/helpers/defaultSettings'),
    import('@/app/settings/ClaudianSettingsStorage'), import('@/composition/ClaudianProviderHost'),
    import('@/core/execution'), import('@/core/session-tools/LoopbackSessionToolServer'),
    import('@/core/device/InstallationKey'), import('@/app/settings/EnvironmentSettingsService'),
    import('@/app/settings/RuntimeSettingsCoordinator'), import('@/app/conversations/ConversationRepository'),
    import('@/app/storage/ConversationPersistenceStore'), import('@/core/providers/ProviderRegistry'),
    import('@/core/providers/ProviderSettingsCoordinator'),
  ]);
  const vault = options.vault ?? await DesktopVault.create();
  const settings = Object.assign(structuredClone(DEFAULT_CLAUDIAN_SETTINGS), options.settings);
  const settingsStorage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
  const coordinator = new SettingsCoordinator(settings, async draft => {
    await options.beforePersist?.(draft);
    await settingsStorage.save(draft);
  });
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const endpoint = new LoopbackSessionToolServer();
  const storage = { installationKey: getInstallationKey(), getAdapter: () => vault.files };
  const notifications: ProviderId[] = [];
  let environmentService: InstanceType<typeof EnvironmentSettingsService> | undefined;
  function environment() {
    if (environmentService) return environmentService;
    const conversations = new ConversationRepository({
      providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
      getSettings: () => settings, getVaultPath: () => vault.root,
      persistence: new ConversationPersistenceStore(vault.files, storage.installationKey),
      onConversationDeleted: async () => undefined,
    });
    const runtimeSettings = new RuntimeSettingsCoordinator({
      settings: coordinator, conversations, executionLifecycle: lifecycle,
      getSettings: () => settings, canCompleteInvalidations: () => true,
    });
    environmentService = new EnvironmentSettingsService({
      getSettings: () => settings, runtimeSettings, executionLifecycle: lifecycle,
      providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
      onEnvironmentApplied: async ids => { notifications.push(...ids); },
    });
    return environmentService;
  }
  const host: ProviderHost = new ClaudianProviderHost({
    app: options.app ?? vault.app, settings: coordinator, executionLifecycleRegistry: lifecycle,
    storage, sessionToolEndpoint: endpoint,
    environment: {
      getActiveEnvironmentVariables: id => environment().getActiveEnvironmentVariables(id),
      getEnvironmentVariablesForScope: scope => environment().getEnvironmentVariablesForScope(scope),
      applyEnvironmentVariables: (scope, value) => environment().applyEnvironmentVariables(scope, value),
      applyEnvironmentVariablesBatch: updates => environment().applyEnvironmentVariablesBatch(updates),
      applyProviderRuntimeSettings: (ids, mutation, applied) => environment().applyProviderRuntimeSettings(ids, mutation, applied),
    },
    notifyProviderChatOptionsChanged: async id => { notifications.push(id); },
  });
  Object.defineProperties(host, Object.getOwnPropertyDescriptors({
    getResolvedProviderCliPath: async () => null,
    ...options.overrides,
  } satisfies Partial<ProviderHost>));
  let disposal: Promise<void> | undefined;
  function dispose(): Promise<void> {
    disposal ??= (async () => {
      try { await lifecycle.dispose(); }
      finally {
        await coordinator.mutateConditionally(() => false);
        try { await endpoint.close(); }
        finally { if (!options.vault) await vault.dispose(); }
      }
    })();
    return disposal;
  }
  onTestFinished(dispose);
  return { host, settings, coordinator, lifecycle, vault, settingsStorage, storage, notifications, dispose };
}
