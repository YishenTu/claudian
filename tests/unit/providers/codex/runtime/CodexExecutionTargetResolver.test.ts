import {
  parseDefaultWslDistroListOutput,
  resolveCodexExecutionTarget,
} from '@/providers/codex/runtime/CodexExecutionTargetResolver';

describe('resolveCodexExecutionTarget', () => {
  it('infers the WSL distro from a \\\\wsl$ workspace path', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });
  });

  it('uses the explicit WSL distro override when the workspace path is a Windows drive path', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
            wslDistroOverride: 'Debian',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      distroName: 'Debian',
    });
  });

  it('falls back to the default WSL distro when the workspace path is a Windows drive path', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
      resolveDefaultWslDistro: () => 'Ubuntu',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      distroName: 'Ubuntu',
    });
  });

  it('preserves native host execution on non-Windows hosts', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
          },
        },
      },
      hostPlatform: 'darwin',
      hostVaultPath: '/Users/example/repo',
    });

    expect(target).toMatchObject({
      method: 'host-native',
      platformFamily: 'unix',
      platformOs: 'macos',
    });
  });
});

describe('parseDefaultWslDistroListOutput', () => {
  it('extracts the starred default distro from wsl --list --verbose output', () => {
    expect(parseDefaultWslDistroListOutput(`
  NAME              STATE           VERSION
* Ubuntu-24.04      Running         2
  Debian            Stopped         2
`)).toBe('Ubuntu-24.04');
  });

  it('returns undefined when no default distro marker is present', () => {
    expect(parseDefaultWslDistroListOutput(`
NAME              STATE           VERSION
Ubuntu-24.04      Running         2
Debian            Stopped         2
`)).toBeUndefined();
  });
});
