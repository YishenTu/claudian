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
