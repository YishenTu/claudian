import { readWSLExec } from '@test/helpers/WSLLaunch';
const actualModule0 = await import('child_process');
import type { MockInstance } from 'vitest';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import { buildCodexLaunchSpec } from '@/providers/codex/runtime/CodexLaunchSpecBuilder';
import { getCodexProviderSettings } from '@/providers/codex/settings';


const childProcess = actualModule0;

describe('buildCodexLaunchSpec', () => {
  let execFileSyncSpy: MockInstance;

  beforeEach(() => {
    execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('spawnSync wsl.exe ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    execFileSyncSpy.mockRestore();
  });

  it.each(['default', 'low', 'medium', 'high'])('applies %s verbosity only to app-server launches', (responseVerbosity) => {
    const options = {
      codexSettings: getCodexProviderSettings({ providerConfigs: { codex: { responseVerbosity } } }),
      resolvedCliCommand: 'codex',
      hostVaultPath: '/vault',
      env: {},
      hostPlatform: 'darwin' as const,
    };
    expect(buildCodexLaunchSpec(options).args).toEqual([
      'app-server', '--listen', 'stdio://',
      ...(responseVerbosity === 'default' ? [] : ['-c', `model_verbosity="${responseVerbosity}"`]),
    ]);
    expect(buildCodexLaunchSpec({ ...options, cliArgs: ['--version'] }).args).toEqual(['--version']);
  });

  it('forwards Codex and configured environment through WSLENV without forwarding host HOME or PATH', () => {
    const spec = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({ providerConfigs: { codex: { environmentVariables: 'CUSTOM_TOKEN=secret' } } }),
      resolvedCliCommand: 'codex', hostVaultPath: 'C:\\repo',
      env: { CUSTOM_TOKEN: 'secret', OPENAI_API_KEY: 'key', CODEX_HOME: 'C:\\codex home', HOME: 'C:\\Users\\me', PATH: 'C:\\Windows', WSLENV: 'EXISTING/u' },
      executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
    });
    expect(spec.env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['EXISTING/u', 'CUSTOM_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME/p']));
    expect(spec.env.WSLENV?.split(':')).not.toContain('HOME');
    expect(spec.env.WSLENV?.split(':')).not.toContain('PATH');
  });

  it('builds a native Windows launch spec with a direct codex executable', () => {
    const spec = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'native-windows' },
          },
        },
      }),
      resolvedCliCommand: 'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
    });

    expect(spec.command).toBe('C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe');
    expect(spec.args).toEqual(['app-server', '--listen', 'stdio://']);
    expect(spec.spawnCwd).toBe('C:\\repo');
    expect(spec.targetCwd).toBe('C:\\repo');
    expect(spec.target).toMatchObject({
      method: 'native-windows',
      platformFamily: 'windows',
      platformOs: 'windows',
    });
  });

  it('uses the same WSL interpreter and working directory for an auxiliary CLI command', () => {
    const spec = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({}),
      resolvedCliCommand: 'codex',
      cliArgs: ['--version'],
      hostVaultPath: 'C:\\repo',
      env: {},
      executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
    });
    expect(spec.command).toMatch(/(?:^|\\)wsl\.exe$/u);
    expect(readWSLExec(spec).args.slice(3)).toEqual([ 'codex', '--version']);
  });

  it('builds a WSL launch spec with translated cwd and distro targeting', () => {
    const spec = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
            wslDistroOverridesByHost: { [getHostnameKey()]: 'Ubuntu' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
    });

    expect(spec.command).toMatch(/(?:^|\\)wsl\.exe$/u);
    expect(readWSLExec(spec).args.slice(3)).toEqual([
      'codex',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(spec.spawnCwd).toBe('C:\\repo');
    expect(spec.targetCwd).toBe('/mnt/c/repo');
    expect(spec.target).toMatchObject({
      method: 'wsl',
      distroName: 'Ubuntu',
      platformOs: 'linux',
    });
  });

  it.each(['wsl$', 'wsl.localhost'])('launches vaults in the %s namespace using their own distro', (server) => {
    const vault = `\\\\${server}\\Ubuntu\\home\\user\\vault`;
    const options = {
      codexSettings: getCodexProviderSettings({ providerConfigs: { codex: { installationMethodsByHost: { [getHostnameKey()]: 'wsl' } } } }),
      resolvedCliCommand: 'codex', hostVaultPath: vault, env: {}, hostPlatform: 'win32' as const,
      resolveDefaultWSLDistro: () => 'Debian',
    };
    const spec = buildCodexLaunchSpec(options);
    expect(readWSLExec(spec).args.slice(3)).toEqual([ 'codex', 'app-server', '--listen', 'stdio://']);
    expect(spec.pathMapper.toTargetPath(`${vault}\\note.md`)).toBe('/home/user/vault/note.md');
    expect(() => buildCodexLaunchSpec({ ...options, executionTarget: {
      method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Debian',
    } })).toThrow('does not match workspace distro');
  });

  it('uses the default WSL distro when no override is configured', () => {
    const spec = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
      resolveDefaultWSLDistro: () => 'Ubuntu',
    });

    expect(readWSLExec(spec).args.slice(3)).toEqual([
      'codex',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(spec.target.distroName).toBe('Ubuntu');
    expect(spec.pathMapper.toHostPath('/home/user/.codex/sessions')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
    );
  });

  it('uses the native WSL default when the injected resolver returns no distro', () => {
    execFileSyncSpy.mockReturnValue(Buffer.from(
      '  NAME              STATE           VERSION\r\n'
      + '* Ubuntu-24.04      Running         2\r\n'
      + '  Debian            Stopped         2\r\n',
      'utf16le',
    ));

    const spec = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveDefaultWSLDistro: () => undefined,
    });

    expect(spec.command).toMatch(/(?:^|\\)wsl\.exe$/u);
    expect(readWSLExec(spec).args.slice(3)).toEqual([
      'codex',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(spec.target.distroName).toBe('Ubuntu-24.04');
    expect(spec.pathMapper.toHostPath('/home/user/.codex/sessions')).toBe(
      '\\\\wsl$\\Ubuntu-24.04\\home\\user\\.codex\\sessions',
    );
  });

  it('fails fast when the native WSL list has no default distro', () => {
    execFileSyncSpy.mockReturnValue(Buffer.from(
      '  NAME              STATE           VERSION\r\n'
      + '  Ubuntu-24.04      Running         2\r\n'
      + '  Debian            Stopped         2\r\n',
      'utf16le',
    ));

    expect(() => buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
    })).toThrow(
      'Unable to determine the WSL distro. Set WSL distro override or configure a default WSL distro.',
    );
  });

  it('fails fast when the workspace path cannot be represented inside WSL', () => {
    expect(() => buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
            wslDistroOverridesByHost: { [getHostnameKey()]: 'Ubuntu' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: '\\\\server\\share\\repo',
      env: {},
      hostPlatform: 'win32',
    })).toThrow('WSL mode only supports Windows drive paths and \\\\wsl$ or \\\\wsl.localhost workspace paths');
  });

  it('fails fast when the selected distro does not match a \\\\wsl$ workspace path', () => {
    expect(() => buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
            wslDistroOverridesByHost: { [getHostnameKey()]: 'Debian' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
      env: {},
      hostPlatform: 'win32',
    })).toThrow('WSL distro override "Debian" does not match workspace distro "Ubuntu"');
  });

  it('fails fast when WSL mode cannot determine a distro for transcript mapping', () => {
    expect(() => buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({
        providerConfigs: {
          codex: {
            installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          },
        },
      }),
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveDefaultWSLDistro: () => undefined,
    })).toThrow(
      'Unable to determine the WSL distro. Set WSL distro override or configure a default WSL distro.',
    );
  });
});

vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('child_process')>('child_process') }));
