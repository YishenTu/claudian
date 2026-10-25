import { createHash, randomUUID } from 'node:crypto';

declare const installationKeyBrand: unique symbol;

export type InstallationKey = string & {
  readonly [installationKeyBrand]: true;
};

const INSTALLATION_KEY_PATTERN = /^device-[a-f0-9]{64}$/;

export function isInstallationKey(value: unknown): value is InstallationKey {
  return typeof value === 'string' && INSTALLATION_KEY_PATTERN.test(value);
}

const DEVICE_SETTINGS_STORAGE_KEY = 'claudian.deviceSettingsKey';
let cachedDeviceSettingsSeed: string | null = null;
let cachedDeviceSettingsKey: InstallationKey | null = null;

function getDeviceSettingsStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function getDeviceSettingsSeed(): string {
  if (cachedDeviceSettingsSeed) {
    return cachedDeviceSettingsSeed;
  }

  const storage = getDeviceSettingsStorage();
  if (!storage) {
    throw new Error('Cannot persist the device settings key: localStorage is unavailable');
  }

  let stored: string | null;
  try {
    stored = storage.getItem(DEVICE_SETTINGS_STORAGE_KEY)?.trim() || null;
  } catch (error) {
    throw new Error('Cannot read the persisted device settings key', { cause: error });
  }
  if (stored) {
    cachedDeviceSettingsSeed = stored;
    return cachedDeviceSettingsSeed;
  }

  const candidate = randomUUID();
  try {
    storage.setItem(DEVICE_SETTINGS_STORAGE_KEY, candidate);
    if (storage.getItem(DEVICE_SETTINGS_STORAGE_KEY)?.trim() !== candidate) {
      throw new Error('localStorage did not retain the device settings key');
    }
  } catch (error) {
    throw new Error('Cannot persist the device settings key', { cause: error });
  }

  cachedDeviceSettingsSeed = candidate;
  return cachedDeviceSettingsSeed;
}

export function getInstallationKey(): InstallationKey {
  if (cachedDeviceSettingsKey) {
    return cachedDeviceSettingsKey;
  }

  const digest = createHash('sha256')
    .update(getDeviceSettingsSeed(), 'utf8')
    .digest('hex');
  cachedDeviceSettingsKey = `device-${digest}` as InstallationKey;
  return cachedDeviceSettingsKey;
}

export function getLegacyDeviceSettingsKey(): string | null {
  const seed = getDeviceSettingsSeed();
  return seed.startsWith('device:') ? seed : null;
}
