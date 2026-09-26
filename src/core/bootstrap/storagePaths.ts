import { type InstallationKey, isInstallationKey } from '@/core/device/InstallationKey';

export const CLAUDIAN_STORAGE_PATH = '.claudian';

export const CLAUDIAN_SETTINGS_PATH = `${CLAUDIAN_STORAGE_PATH}/claudian-settings.json`;

export const LEGACY_SESSIONS_PATH = '.claude/sessions';
export const SESSIONS_PATH = `${CLAUDIAN_STORAGE_PATH}/sessions`;
export const DEVICE_SESSIONS_PATH = `${SESSIONS_PATH}/devices`;

export function isDeviceSettingsKey(value: unknown): value is InstallationKey {
  return isInstallationKey(value);
}

export function getDeviceSessionsPath(deviceKey: string): string {
  if (!isDeviceSettingsKey(deviceKey)) {
    throw new Error('A filesystem-safe device settings key is required for session metadata storage');
  }
  return `${DEVICE_SESSIONS_PATH}/${deviceKey}`;
}
