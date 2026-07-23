import * as fs from 'fs';
import * as path from 'path';

import { QoderCliResolver } from '@/providers/qoder/runtime/QoderCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
  getLegacyHostnameKey: () => 'legacy-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('QoderCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('prefers the current host path over synced paths and the legacy path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/qodercli' || filePath === '/legacy/qodercli') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new QoderCliResolver().resolve({
      'current-host': '/current/qodercli',
      'other-host': '/other/qodercli',
    }, '/legacy/qodercli', '')).toBe('/current/qodercli');
  });

  it('falls back through the legacy path and a PATH binary named qodercli', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/qodercli') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new QoderCliResolver().resolve({}, '/legacy/qodercli', '')).toBe('/legacy/qodercli');

    const pathBinary = path.join('/provider/bin', 'qodercli');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new QoderCliResolver().resolve({}, '', 'PATH=/provider/bin')).toBe(pathBinary);
  });

  it('uses merged provider settings, caches the result, and can be reset', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/configured/qodercli') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const settings = {
      providerConfigs: {
        qoder: {
          cliPathsByHost: { 'current-host': '/configured/qodercli' },
        },
      },
    };
    const resolver = new QoderCliResolver();

    expect(resolver.resolveFromSettings(settings)).toBe('/configured/qodercli');
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/qodercli');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/qodercli'))
      .toHaveLength(1);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/qodercli');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/qodercli'))
      .toHaveLength(2);
  });
});
