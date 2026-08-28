import {
  isInstallationKey,
  parseInstallationKey,
} from '@/core/device/InstallationKey';

describe('InstallationKey', () => {
  const valid = `device-${'a'.repeat(64)}`;

  it('accepts only the existing opaque per-installation key shape', () => {
    expect(isInstallationKey(valid)).toBe(true);
    for (const candidate of [
      undefined,
      null,
      '',
      `device-${'A'.repeat(64)}`,
      `device-${'a'.repeat(63)}`,
      `device-${'a'.repeat(65)}`,
      `../device-${'a'.repeat(64)}`,
      `device-${'g'.repeat(64)}`,
    ]) {
      expect(isInstallationKey(candidate)).toBe(false);
    }
  });

  it('fails closed before an invalid key can enter a filesystem path', () => {
    expect(parseInstallationKey(valid)).toBe(valid);
    expect(() => parseInstallationKey('device-invalid')).toThrow(
      'A valid installation key is required',
    );
  });
});
