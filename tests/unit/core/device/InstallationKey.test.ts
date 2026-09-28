import type * as InstallationIdentity from '@/core/device/InstallationKey';
import {
  getInstallationKey,
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

describe('getInstallationKey', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storedValues = new Map<string, string>();

  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storedValues.get(key) ?? null,
          setItem: (key: string, value: string) => storedValues.set(key, value),
        },
      },
    });
  });

  afterAll(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('returns an opaque device key instead of the system hostname', () => {
    const key = getInstallationKey();
    expect(key).toMatch(/^device-[a-f0-9]{64}$/);
    expect(key).not.toContain(':');
  });

  it('returns consistent value on repeated calls', () => {
    const first = getInstallationKey();
    const second = getInstallationKey();
    expect(first).toBe(second);
  });

  it('fails closed instead of caching a volatile key when localStorage rejects the seed', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis.window, 'localStorage');
    const values = new Map<string, string>();
    const setItem = jest.fn()
      .mockImplementationOnce(() => {
        throw new Error('storage unavailable');
      })
      .mockImplementation((key: string, value: string) => {
        values.set(key, value);
      });
    Object.defineProperty(globalThis.window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
      },
    });

    try {
      jest.resetModules();
      // Dynamic require re-evaluates the module-level device-key cache.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolatedIdentity = require('@/core/device/InstallationKey') as typeof InstallationIdentity;

      expect(() => isolatedIdentity.getInstallationKey()).toThrow('persist');
      const durableKey = isolatedIdentity.getInstallationKey();

      expect(durableKey).toMatch(/^device-[a-f0-9]{64}$/);
      expect(values.get('claudian.deviceSettingsKey')).toBeTruthy();
    } finally {
      if (originalStorage) {
        Object.defineProperty(globalThis.window, 'localStorage', originalStorage);
      }
      jest.resetModules();
    }
  });

});
