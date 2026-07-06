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
      resolveWslDistroVersion: () => 2,
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
            installationMethod: 'wsl2',
            wslDistroOverride: 'Ubuntu',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 2,
    });

    expect(spec.command).toBe('wsl.exe');
    expect(spec.args).toEqual([
      '--distribution',
      'Ubuntu',
      '--cd',
      '/mnt/c/repo',
      '--exec',
      'sh',
      '-lc',
      'exec "$SHELL" -lic "$1"',
      'sh',
      'exec codex app-server --listen stdio://',
    ]);
    expect(spec.spawnCwd).toBe('C:\\repo');
    expect(spec.targetCwd).toBe('/mnt/c/repo');
    expect(spec.target).toMatchObject({
      method: 'wsl',
      wslVersion: 2,
      distroName: 'Ubuntu',
      platformOs: 'linux',
    });
  });

  it('uses wsl.exe with an explicitly selected WSL 1 distro', () => {
    const spec = buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl1',
            wslDistroOverride: 'Legacy Ubuntu',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 1,
    });

    expect(spec.command).toBe('wsl.exe');
    expect(spec.args.slice(0, 5)).toEqual([
      '--distribution',
      'Legacy Ubuntu',
      '--cd',
      '/mnt/c/repo',
      '--exec',
    ]);
    expect(spec.target.wslVersion).toBe(1);
  });

  it('quotes an absolute Linux CLI path for the WSL login shell', () => {
    const spec = buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
            wslDistroOverride: 'Ubuntu',
          },
        },
      },
      resolvedCliCommand: "/home/test user/bin/codex's",
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 2,
    });

    expect(spec.args.at(-1)).toBe(
      "exec '/home/test user/bin/codex'\"'\"'s' app-server --listen stdio://",
    );
  });

  it('requires an explicitly selected WSL distro', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      hostPlatform: 'win32',
    })).toThrow('Select a WSL distro');
  });

  it('fails fast when the workspace path cannot be represented inside WSL', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
            wslDistroOverride: 'Ubuntu',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: '\\\\server\\share\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 2,
    })).toThrow('WSL mode only supports Windows drive paths and \\\\wsl$ workspace paths');
  });

  it('fails fast when the selected distro does not match a \\\\wsl$ workspace path', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
            wslDistroOverride: 'Debian',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 2,
    })).toThrow('WSL distro override "Debian" does not match workspace distro "Ubuntu"');
  });

  it('fails fast when no WSL distro is selected', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
    })).toThrow(
      'Select a WSL distro in Codex settings before starting Codex.',
    );
  });

  it('rejects a selected distro whose installed WSL version does not match', () => {
    expect(() => buildCodexLaunchSpec({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
            wslDistroOverride: 'Legacy Ubuntu',
          },
        },
      },
      resolvedCliCommand: 'codex',
      hostVaultPath: 'C:\\repo',
      env: {},
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 1,
    })).toThrow('uses WSL 1, but WSL 2 is selected');
  });

  it('rejects legacy WSL settings until the user selects WSL 1 or WSL 2', () => {
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
    })).toThrow('Select WSL 1 or WSL 2');
  });
});
