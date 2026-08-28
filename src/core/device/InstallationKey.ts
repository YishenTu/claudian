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
