import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';

export type InstallationMethod = 'native-windows' | 'wsl';
export interface InstallationSettings {
  installationMethod: InstallationMethod;
  wslDistroOverride: string;
}
export const DEFAULT_INSTALLATION_SETTINGS: Readonly<InstallationSettings> = Object.freeze({ installationMethod: 'native-windows', wslDistroOverride: '' });

export interface StoredInstallationSettings {
  installationMethodsByHost: Record<string, InstallationMethod>;
  wslDistroOverridesByHost: Record<string, string>;
}

export function normalizeInstallationMethod(value: unknown): InstallationMethod {
  return value === 'wsl' ? 'wsl' : 'native-windows';
}

export function decodeInstallationSettings(config: Readonly<Record<string, unknown>>): StoredInstallationSettings {
  return {
    installationMethodsByHost: Object.fromEntries(Object.entries(normalizeHostnameStringMap(config.installationMethodsByHost))
      .map(([key, value]) => [key, normalizeInstallationMethod(value)])),
    wslDistroOverridesByHost: normalizeHostnameStringMap(config.wslDistroOverridesByHost),
  };
}

export function selectInstallationSettings(stored: StoredInstallationSettings, installationKey: string): InstallationSettings {
  return {
    installationMethod: stored.installationMethodsByHost[installationKey] ?? DEFAULT_INSTALLATION_SETTINGS.installationMethod,
    wslDistroOverride: stored.wslDistroOverridesByHost[installationKey] ?? DEFAULT_INSTALLATION_SETTINGS.wslDistroOverride,
  };
}

export function updateInstallationSettings(
  current: StoredInstallationSettings,
  updates: Partial<StoredInstallationSettings & InstallationSettings>,
  installationKey: string,
  platform: NodeJS.Platform = process.platform,
): StoredInstallationSettings & InstallationSettings {
  const stored = decodeInstallationSettings({ ...current, ...updates });
  if (platform !== 'win32') {
    delete stored.installationMethodsByHost[installationKey];
    delete stored.wslDistroOverridesByHost[installationKey];
  } else {
    if ('installationMethod' in updates) {
      Object.defineProperty(stored.installationMethodsByHost, installationKey, {
        value: normalizeInstallationMethod(updates.installationMethod), enumerable: true, writable: true, configurable: true,
      });
    }
    if ('wslDistroOverride' in updates) {
      const value = typeof updates.wslDistroOverride === 'string' ? updates.wslDistroOverride.trim() : '';
      if (value) {
        Object.defineProperty(stored.wslDistroOverridesByHost, installationKey, { value, enumerable: true, writable: true, configurable: true });
      } else {
        delete stored.wslDistroOverridesByHost[installationKey];
      }
    }
  }
  return { ...stored, ...selectInstallationSettings(stored, installationKey) };
}
