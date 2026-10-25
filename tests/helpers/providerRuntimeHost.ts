import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { createProviderRuntimeHost } from '@/composition/ClaudianProviderHost';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { ProviderCLIResolutionContext, ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';

type RuntimeCapabilities = Parameters<typeof createProviderRuntimeHost>[0];

/**
 * A provider runtime host over a settings document, through the production projection.
 * Reads stay live: direct edits to `settings` and committed writes are both visible.
 */
export function createTestRuntimeHost(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  capabilities: Partial<RuntimeCapabilities> = {},
  persist: (settings: ClaudianSettings) => Promise<void> = async () => undefined,
): ProviderRuntimeHost {
  const coordinator = new SettingsCoordinator(settings as unknown as ClaudianSettings, persist);
  return createProviderRuntimeHost({
    workingDirectory: null,
    storage: {} as ProviderHost['storage'],
    sessionToolEndpoint: {} as ProviderHost['sessionToolEndpoint'],
    executionLifecycleRegistry: {} as ProviderHost['executionLifecycleRegistry'],
    getResolvedProviderCliPath: async () => null,
    runProviderExecutionTransition: (_ids, mutation) => mutation({} as never),
    notifyProviderChatOptionsChanged: () => undefined,
    ...capabilities,
  }, coordinator, providerId);
}

interface AppHostFixture {
  settings: Record<string, unknown>;
  workingDirectory?: string | null;
  manifest?: { version?: string };
  storage?: unknown;
  sessionToolEndpoint?: unknown;
  executionLifecycleRegistry?: unknown;
  getResolvedProviderCliPath?: (providerId: ProviderId, context?: ProviderCLIResolutionContext) => Promise<string | null> | string | null;
  notifyProviderChatOptionsChanged?: (providerId: ProviderId) => void;
  runProviderExecutionTransition?: (...args: never[]) => Promise<unknown>;
}

/**
 * The provider runtime host an application host fixture would hand out. Capabilities
 * delegate lazily, so later edits to the fixture (settings, mocks) stay visible.
 */
export function runtimeHostFor(host: AppHostFixture, providerId: ProviderId): ProviderRuntimeHost {
  return createTestRuntimeHost(host.settings, providerId, {
    get workingDirectory() { return host.workingDirectory ?? null; },
    get manifest() { return host.manifest; },
    get storage() { return host.storage as ProviderHost['storage']; },
    get sessionToolEndpoint() { return host.sessionToolEndpoint as ProviderHost['sessionToolEndpoint']; },
    get executionLifecycleRegistry() { return host.executionLifecycleRegistry as ProviderHost['executionLifecycleRegistry']; },
    getResolvedProviderCliPath: async (id, context) => await host.getResolvedProviderCliPath?.(id, context) ?? null,
    notifyProviderChatOptionsChanged: id => host.notifyProviderChatOptionsChanged?.(id),
    runProviderExecutionTransition: ((ids, mutation, parent) => host.runProviderExecutionTransition
      ? (host.runProviderExecutionTransition as ProviderHost['runProviderExecutionTransition'])(ids, mutation, parent)
      : mutation({} as never)) as ProviderHost['runProviderExecutionTransition'],
  });
}

/** Adds `getRuntimeHost` to an application host fixture. */
export function withRuntimeHosts<T extends AppHostFixture>(host: T): T & Pick<ProviderHost, 'getRuntimeHost'> {
  return Object.assign(host, { getRuntimeHost: (providerId: ProviderId) => runtimeHostFor(host, providerId) });
}
