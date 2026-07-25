import * as fs from 'fs';
import * as path from 'path';

import {
  findKimiCliBinary,
  KimiCliResolver,
} from '@/providers/kimi/runtime/KimiCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
  getLegacyHostnameKey: () => 'legacy-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('KimiCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('prefers the current host path over other hosts and the legacy path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/kimi' || filePath === '/legacy/kimi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new KimiCliResolver().resolve({
      'current-host': '/current/kimi',
      'other-host': '/other/kimi',
    }, '/legacy/kimi', '')).toBe('/current/kimi');
  });

  it('falls back through the legacy path and the PATH binary named kimi', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/kimi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new KimiCliResolver().resolve({}, '/legacy/kimi', '')).toBe('/legacy/kimi');

    const kimiBinary = path.join('/provider/bin', 'kimi');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === kimiBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new KimiCliResolver().resolve({}, '', 'PATH=/provider/bin')).toBe(kimiBinary);
  });

  it('returns null when no configured path or PATH binary exists', () => {
    mockedStat.mockImplementation((filePath: string) => {
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new KimiCliResolver().resolve({}, '', '')).toBeNull();
    expect(findKimiCliBinary('/missing/bin')).toBeNull();
  });

  it('uses merged provider settings, caches the result, and can be reset', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/configured/kimi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const settings = {
      providerConfigs: {
        kimi: {
          cliPathsByHost: { 'current-host': '/configured/kimi' },
        },
      },
    };
    const resolver = new KimiCliResolver();

    expect(resolver.resolveFromSettings(settings)).toBe('/configured/kimi');
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/kimi');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/kimi'))
      .toHaveLength(1);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/kimi');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/kimi'))
      .toHaveLength(2);
  });

  it('re-resolves when the host path or environment changes', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/configured/kimi' || filePath === path.join('/env/bin', 'kimi')) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const settings = {
      providerConfigs: {
        kimi: {
          cliPathsByHost: { 'current-host': '/configured/kimi' },
        },
      },
    };
    const resolver = new KimiCliResolver();

    expect(resolver.resolveFromSettings(settings)).toBe('/configured/kimi');

    (settings.providerConfigs.kimi as Record<string, unknown>).cliPathsByHost = {};
    (settings.providerConfigs.kimi as Record<string, unknown>).environmentVariables =
      'PATH=/env/bin';
    expect(resolver.resolveFromSettings(settings)).toBe(path.join('/env/bin', 'kimi'));
  });
});
