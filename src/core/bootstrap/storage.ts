import type { InstallationKey } from '../device/InstallationKey';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';

/**
 * Storage identity visible to providers: the durable installation key that
 * scopes host-specific provider settings. Application persistence (settings,
 * session metadata, legacy tab state) stays behind app-owned storage.
 */
export interface ProviderHostStorage {
  readonly installationKey: InstallationKey;
}

/** Storage capabilities available to user-facing features. */
export interface SharedAppStorage extends ProviderHostStorage {
  getAdapter(): VaultFileAdapter;
}
