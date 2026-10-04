import { type InstallationKey, isInstallationKey } from '@/core/device/InstallationKey';

export const CLAUDIAN_STORAGE_PATH = '.claudian';

export const CLAUDIAN_SETTINGS_PATH = `${CLAUDIAN_STORAGE_PATH}/claudian-settings.json`;

export const LEGACY_SESSIONS_PATH = '.claude/sessions';
export const SESSIONS_PATH = `${CLAUDIAN_STORAGE_PATH}/sessions`;
export const DEVICE_SESSIONS_PATH = `${SESSIONS_PATH}/devices`;

const SAFE_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Session ids name metadata files, so they must stay a single safe path segment. */
export function isValidSessionMetadataId(id: string): boolean {
  return SAFE_METADATA_ID_PATTERN.test(id)
    && id !== '.'
    && id !== '..'
    && !/%(?:2f|5c)/i.test(id);
}

export function assertValidSessionMetadataId(id: string): void {
  if (!isValidSessionMetadataId(id)) {
    throw new Error(`Invalid session metadata id: ${JSON.stringify(id)}`);
  }
}

export function isDeviceSettingsKey(value: unknown): value is InstallationKey {
  return isInstallationKey(value);
}

export function getDeviceSessionsPath(deviceKey: string): string {
  if (!isDeviceSettingsKey(deviceKey)) {
    throw new Error('A filesystem-safe device settings key is required for session metadata storage');
  }
  return `${DEVICE_SESSIONS_PATH}/${deviceKey}`;
}
