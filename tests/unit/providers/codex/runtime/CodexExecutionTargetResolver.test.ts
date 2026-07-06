import { resolveCodexExecutionTarget } from '@/providers/codex/runtime/CodexExecutionTargetResolver';

describe('resolveCodexExecutionTarget', () => {
  it('uses the explicitly selected distro for a \\\\wsl$ workspace path', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
            wslDistroOverride: 'Ubuntu',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      wslVersion: 2,
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
            installationMethod: 'wsl2',
            wslDistroOverride: 'Debian',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      wslVersion: 2,
      distroName: 'Debian',
    });
  });

  it('keeps the distro unset until the user explicitly selects one', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl1',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      wslVersion: 1,
    });
    expect(target.distroName).toBeUndefined();
  });

  it('preserves native host execution on non-Windows hosts', () => {
    const target = resolveCodexExecutionTarget({
      settings: {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl2',
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
