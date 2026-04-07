import { buildCodexLaunchSpec } from '@/providers/codex/runtime/CodexLaunchSpecBuilder';

describe('buildCodexLaunchSpec', () => {
  it('builds a native Windows launch spec with a direct codex executable', () => {
    const spec = buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'native-windows',
          },
        },
      },
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

  it('builds a WSL launch spec with translated cwd and distro targeting', () => {
    const spec = buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
            wslDistroOverride: 'Ubuntu',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
    });

    expect(spec.command).toBe('wsl.exe');
    expect(spec.args).toEqual([
      '--distribution',
      'Ubuntu',
      '--cd',
      '/mnt/c/repo',
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

  it('uses the default WSL distro when no override is configured', () => {
    const spec = buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
      resolveDefaultWslDistro: () => 'Ubuntu',
    });

    expect(spec.args).toEqual([
      '--distribution',
      'Ubuntu',
      '--cd',
      '/mnt/c/repo',
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

  it('fails fast when the workspace path cannot be represented inside WSL', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
            wslDistroOverride: 'Ubuntu',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: '\\\\server\\share\\repo',
      env: {},
      hostPlatform: 'win32',
    })).toThrow('WSL mode only supports Windows drive paths and \\\\wsl$ workspace paths');
  });

  it('fails fast when the selected distro does not match a \\\\wsl$ workspace path', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
            wslDistroOverride: 'Debian',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
      env: {},
      hostPlatform: 'win32',
    })).toThrow('WSL distro override "Debian" does not match workspace distro "Ubuntu"');
  });

  it('fails fast when WSL mode cannot determine a distro for transcript mapping', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveDefaultWslDistro: () => undefined,
    })).toThrow(
      'Unable to determine the WSL distro. Set WSL distro override or configure a default WSL distro.',
    );
  });
});
