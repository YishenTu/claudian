import * as fs from 'node:fs';

import { PiCliResolver } from '@/providers/pi/runtime/PiCliResolver';

jest.mock('node:fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;

describe('PiCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the current host path before the legacy Pi CLI path', () => {
    mockedExists.mockImplementation((filePath: string) => filePath === '/current/pi');
    mockedStat.mockReturnValue({ isFile: () => true });

    const resolver = new PiCliResolver();

    expect(resolver.resolve({
      'current-host': '/current/pi',
      'other-host': '/other/pi',
    }, '/legacy/pi')).toBe('/current/pi');
  });

  it('falls back to cliPath and returns null for invalid paths', () => {
    mockedExists.mockImplementation((filePath: string) => filePath === '/legacy/pi');
    mockedStat.mockReturnValue({ isFile: () => true });

    const resolver = new PiCliResolver();
    expect(resolver.resolve({ 'other-host': '/other/pi' }, '/legacy/pi')).toBe('/legacy/pi');

    mockedExists.mockReturnValue(false);
    expect(resolver.resolve({ 'other-host': '/other/pi' }, '/legacy/pi')).toBeNull();
  });

  it('invalidates cached resolutions when provider environment changes', () => {
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });

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
