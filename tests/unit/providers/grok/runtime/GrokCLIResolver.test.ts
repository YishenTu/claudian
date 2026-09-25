import * as fs from 'fs';
import * as path from 'path';

import { GrokCLIResolver } from '@/providers/grok/runtime/GrokCLIResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('GrokCLIResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('prefers the current host path over synced paths and the legacy path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/grok' || filePath === '/legacy/grok') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new GrokCLIResolver().resolveFromSettings({
      providerConfigs: { grok: {
        cliPathsByHost: {
          'current-host': '/current/grok',
          'other-host': '/other/grok',
        },
        cliPath: '/legacy/grok',
      } },
    })).toBe('/current/grok');
  });

  it('falls back through the legacy path and PATH binary named grok', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/grok') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new GrokCLIResolver().resolveFromSettings({
      providerConfigs: { grok: { cliPath: '/legacy/grok' } },
    })).toBe('/legacy/grok');

    const pathBinary = path.join('/provider/bin', 'grok');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new GrokCLIResolver().resolveFromSettings({
      providerConfigs: { grok: { environmentVariables: 'PATH=/provider/bin' } },
    })).toBe(pathBinary);
  });

  it('uses merged provider settings, caches the result, and can be reset', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/configured/grok') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const settings = {
      providerConfigs: {
        grok: {
          cliPathsByHost: { 'current-host': '/configured/grok' },
        },
      },
    };
    const resolver = new GrokCLIResolver();

    expect(resolver.resolveFromSettings(settings)).toBe('/configured/grok');
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/grok');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/grok'))
      .toHaveLength(1);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/grok');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/grok'))
      .toHaveLength(2);
  });

  it('caches null settings resolutions until reset', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const resolver = new GrokCLIResolver();
    const settings = { providerConfigs: { grok: {} } };

    expect(resolver.resolveFromSettings(settings)).toBeNull();
    const firstCallCount = mockedStat.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    expect(resolver.resolveFromSettings(settings)).toBeNull();
    expect(mockedStat).toHaveBeenCalledTimes(firstCallCount);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBeNull();
    expect(mockedStat.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});
