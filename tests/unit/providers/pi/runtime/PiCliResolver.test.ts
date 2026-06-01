import * as fs from 'fs';
import * as path from 'path';

import { PiCliResolver } from '@/providers/pi/runtime/PiCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('PiCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('resolves the current host path before the legacy Pi CLI path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/pi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new PiCliResolver();

    expect(resolver.resolve({
      'current-host': '/current/pi',
      'other-host': '/other/pi',
    }, '/legacy/pi')).toBe('/current/pi');
  });

  it('falls back to cliPath and returns null for invalid paths', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/pi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new PiCliResolver();
    expect(resolver.resolve({ 'other-host': '/other/pi' }, '/legacy/pi')).toBe('/legacy/pi');

    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(resolver.resolve({ 'other-host': '/other/pi' }, '/legacy/pi')).toBeNull();
  });

  it('falls back to PATH lookup when no Pi CLI path is configured', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'pi');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new PiCliResolver();

    expect(resolver.resolve({}, '', `PATH=${pathDir}`)).toBe(pathBinary);
  });

  it('invalidates cached resolutions when provider environment changes', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/pi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new PiCliResolver();
    const firstSettings = {
      providerConfigs: {
        pi: {
          cliPathsByHost: {
            'current-host': '/current/pi',
          },
          environmentVariables: 'PI_OFFLINE=0',
        },
      },
    };
    const secondSettings = {
      providerConfigs: {
        pi: {
          cliPathsByHost: {
            'current-host': '/current/pi',
          },
          environmentVariables: 'PI_OFFLINE=1',
        },
      },
    };

    expect(resolver.resolveFromSettings(firstSettings)).toBe('/current/pi');
    expect(resolver.resolveFromSettings(firstSettings)).toBe('/current/pi');
    expect(mockedStat).toHaveBeenCalledTimes(1);

    expect(resolver.resolveFromSettings(secondSettings)).toBe('/current/pi');
    expect(mockedStat).toHaveBeenCalledTimes(2);
  });
});
