import { createHash } from 'node:crypto';

declare const installationKeyBrand: unique symbol;

export type InstallationKey = string & {
  readonly [installationKeyBrand]: true;
};

const INSTALLATION_KEY_PATTERN = /^device-[a-f0-9]{64}$/;

export function isInstallationKey(value: unknown): value is InstallationKey {
  return typeof value === 'string' && INSTALLATION_KEY_PATTERN.test(value);
}

export function parseInstallationKey(value: unknown): InstallationKey {
  if (!isInstallationKey(value)) {
    throw new TypeError('A valid installation key is required');
  }
  return value;
}

const DEVICE_SETTINGS_STORAGE_KEY = 'claudian.deviceSettingsKey';
let cachedDeviceSettingsSeed: string | null = null;
let cachedDeviceSettingsKey: string | null = null;

function getDeviceSettingsStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function createOpaqueDeviceSettingsSeed(): string {
  const cryptoApi = typeof window === 'undefined' ? null : window.crypto;
  const randomUUID = cryptoApi?.randomUUID?.();
  if (randomUUID) {
    return randomUUID;
  }

  if (cryptoApi?.getRandomValues) {
    const randomBytes = new Uint8Array(16);
    cryptoApi.getRandomValues(randomBytes);
    const entropy = Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${Date.now().toString(36)}-${entropy}`;
  }

  const entropy = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${entropy}`;
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

  const candidate = createOpaqueDeviceSettingsSeed();
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
    return parseInstallationKey(cachedDeviceSettingsKey);
  }

  const digest = createHash('sha256')
    .update(getDeviceSettingsSeed(), 'utf8')
    .digest('hex');
  cachedDeviceSettingsKey = `device-${digest}`;
  return parseInstallationKey(cachedDeviceSettingsKey);
}

export function getLegacyDeviceSettingsKey(): string | null {
  const seed = getDeviceSettingsSeed();
  return seed.startsWith('device:') ? seed : null;
}
