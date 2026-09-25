import * as fs from 'fs';
import * as path from 'path';

import { CodexCLIResolver } from '@/providers/codex/runtime/CodexCLIResolver';
import { getHostnameKey } from '@/utils/env';

jest.mock('fs');
jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: jest.fn(() => 'current-host'),
  };
});

const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;
const mockedDeviceKey = getHostnameKey as jest.Mock;

describe('CodexCLIResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDeviceKey.mockReturnValue('current-host');
  });

  it('uses the current host path instead of another synced host path', async () => {
    mockedExists.mockImplementation((filePath: string) => filePath === '/current/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const resolver = new CodexCLIResolver();
    const resolved = await resolver.resolveFromSettings({
      providerConfigs: {
        codex: {
          cliPathsByHost: {
            'other-host': '/other/codex',
            'current-host': '/current/codex',
          },
          cliPath: '/legacy/codex',
        },
      },
    });

    expect(resolved).toBe('/current/codex');
  });

  it('falls back to the legacy path when the current host has no custom path', async () => {
    mockedExists.mockImplementation((filePath: string) => filePath === '/legacy/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const resolver = new CodexCLIResolver();
    const resolved = await resolver.resolveFromSettings({
      providerConfigs: {
        codex: {
          cliPathsByHost: { 'other-host': '/other/codex' },
          cliPath: '/legacy/codex',
        },
      },
    });

    expect(resolved).toBe('/legacy/codex');
  });

  it('auto-detects from the runtime PATH when no configured path is valid', async () => {
    const cliPath = path.join('/custom/bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    mockedExists.mockImplementation((filePath: string) => filePath === cliPath);
    mockedStat.mockImplementation((filePath: string) => ({
      isFile: () => filePath === cliPath,
    }));

    const resolver = new CodexCLIResolver();
    const resolved = await resolver.resolveFromSettings({
      sharedEnvironmentVariables: 'PATH=/custom/bin',
      providerConfigs: {
        codex: { cliPathsByHost: { 'other-host': '/other/codex' } },
      },
    });

    expect(resolved).toBe(cliPath);
  });

  it('returns a Linux-side command in WSL mode without host filesystem validation', () => {
    mockedExists.mockReturnValue(false);

    const resolver = new CodexCLIResolver();
    const resolved = resolver.resolveFromSettings(
      {
        providerConfigs: { codex: { cliPathsByHost: { 'current-host': 'codex' } } },
      },
      { executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux' } },
    );

    expect(resolved).toBe('codex');
  });

  it('falls back to the Linux command when a Windows-native CLI path is configured in WSL mode', () => {
    mockedExists.mockReturnValue(false);

    const resolver = new CodexCLIResolver();
    const resolved = resolver.resolveFromSettings(
      {
        providerConfigs: {
          codex: {
            cliPathsByHost: {
              'current-host': 'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe',
            },
          },
        },
      },
      { executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux' } },
    );

    expect(resolved).toBe('codex');
  });

  it('uses the supplied execution target when resolving from settings', () => {
    mockedExists.mockReturnValue(false);

    const resolver = new CodexCLIResolver();
    const resolved = resolver.resolveFromSettings(
      {
        providerConfigs: {
          codex: {
            installationMethodsByHost: {
              'current-host': 'native-windows',
            },
            cliPathsByHost: {
              'current-host': 'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe',
            },
          },
        },
      },
      {
        executionTarget: {
          method: 'wsl',
          platformFamily: 'unix',
          platformOs: 'linux',
          distroName: 'Ubuntu',
        },
      },
    );

    expect(resolved).toBe('codex');
  });
});
