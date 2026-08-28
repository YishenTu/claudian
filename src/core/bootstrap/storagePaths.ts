import { type InstallationKey, isInstallationKey } from '@/core/device/InstallationKey';

export const CLAUDIAN_STORAGE_PATH = '.claudian';

export const LEGACY_CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';
export const CLAUDIAN_SETTINGS_PATH = `${CLAUDIAN_STORAGE_PATH}/claudian-settings.json`;

export const LEGACY_SESSIONS_PATH = '.claude/sessions';
export const SESSIONS_PATH = `${CLAUDIAN_STORAGE_PATH}/sessions`;
export const DEVICE_SESSIONS_PATH = `${SESSIONS_PATH}/devices`;
export const INPUT_LEDGER_SUFFIX = '.inputs.json';
export const DELETION_MARKER_SUFFIX = '.deleted.json';
export const ASSIGNMENT_MARKER_SUFFIX = '.assigned.json';

export function isDeviceSettingsKey(value: unknown): value is InstallationKey {
  return isInstallationKey(value);
}

export function getDeviceSessionsPath(deviceKey: string): string {
  if (!isDeviceSettingsKey(deviceKey)) {
    throw new Error('A filesystem-safe device settings key is required for session metadata storage');
  }
  return `${DEVICE_SESSIONS_PATH}/${deviceKey}`;
}
