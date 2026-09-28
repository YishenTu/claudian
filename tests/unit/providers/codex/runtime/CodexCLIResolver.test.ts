import * as fs from 'fs';
import * as path from 'path';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import { CodexCLIResolver } from '@/providers/codex/runtime/CodexCLIResolver';

jest.mock('fs');
const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;
const mockedDeviceKey = getHostnameKey as jest.Mock;

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: jest.fn(() => 'current-host'),
}));

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

  it.each(['host-native', 'native-windows'])(
    'preserves the cache policy for %s installations',
    (method) => {
      const files = new Set(['/current/codex', '/legacy/codex']);
      mockedStat.mockImplementation((filePath: string) => ({ isFile: () => files.has(filePath) }));
      const resolver = new CodexCLIResolver();
      const settings = {
        providerConfigs: { codex: { cliPathsByHost: { 'current-host': '/current/codex' }, cliPath: '/legacy/codex' } },
      };
      const context = { executionTarget: { method, platformFamily: 'windows', platformOs: 'windows' } };

      expect(resolver.resolveFromSettings(settings, context)).toBe('/current/codex');
      files.delete('/current/codex');
      expect(resolver.resolveFromSettings(settings, context))
        .toBe(method === 'native-windows' ? '/legacy/codex' : '/current/codex');
      resolver.reset();
      expect(resolver.resolveFromSettings(settings, context)).toBe('/legacy/codex');
    },
  );

  it('retries missing installations without a settings change', () => {
    mockedStat.mockReturnValue({ isFile: () => false });
    const resolver = new CodexCLIResolver();
    const settings = { providerConfigs: { codex: { cliPathsByHost: { 'current-host': '/installed/codex' } } } };
    const context = { executionTarget: { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' } };

    expect(resolver.resolveFromSettings(settings, context)).toBeNull();
    mockedStat.mockImplementation((filePath: string) => ({ isFile: () => filePath === '/installed/codex' }));
    expect(resolver.resolveFromSettings(settings, context)).toBe('/installed/codex');
  });

  it('invalidates a cached native path when switching to WSL', () => {
    const cliPath = 'C:\\tools\\codex.exe';
    mockedStat.mockImplementation((filePath: string) => ({ isFile: () => filePath === cliPath }));
    const resolver = new CodexCLIResolver();
    const settings = { providerConfigs: { codex: { cliPathsByHost: { 'current-host': cliPath } } } };

    expect(resolver.resolveFromSettings(settings, {
      executionTarget: { method: 'host-native', platformFamily: 'windows', platformOs: 'windows' },
    })).toBe(cliPath);
    expect(resolver.resolveFromSettings(settings, {
      executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
    })).toBe('codex');
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
