import { resolveClaudeExecutionContext } from '@/providers/claude/runtime/ClaudeExecutionContext';

function settings(method: 'wsl1' | 'wsl2', distro = 'Ubuntu'): Record<string, unknown> {
  return {
    providerConfigs: {
      claude: {
        installationMethod: method,
        wslDistroOverride: distro,
      },
    },
  };
}

describe('resolveClaudeExecutionContext', () => {
  it('builds a WSL 2 context with WSL Claude home', () => {
    const context = resolveClaudeExecutionContext({
      settings: settings('wsl2'),
      hostVaultPath: 'C:\\Vault',
      resolvedCliPath: 'claude',
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 2,
      resolveWslHome: () => '/home/tong',
    });

    expect(context.method).toBe('wsl');
    expect(context.targetVaultPath).toBe('/mnt/c/Vault');
    expect(context.claudeHomeHost).toBe('\\\\wsl$\\Ubuntu\\home\\tong\\.claude');
    expect(context.wslVersion).toBe(2);
  });

  it('supports WSL 1 and rejects a version mismatch', () => {
    expect(resolveClaudeExecutionContext({
      settings: settings('wsl1'),
      hostVaultPath: 'C:\\Vault',
      resolvedCliPath: null,
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 1,
      resolveWslHome: () => '/home/tong',
    }).wslVersion).toBe(1);

    expect(() => resolveClaudeExecutionContext({
      settings: settings('wsl2'),
      hostVaultPath: 'C:\\Vault',
      resolvedCliPath: null,
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 1,
      resolveWslHome: () => '/home/tong',
    })).toThrow('uses WSL 1, but WSL 2 is selected');
  });

  it('rejects a workspace from another WSL distro', () => {
    expect(() => resolveClaudeExecutionContext({
      settings: settings('wsl2', 'Ubuntu'),
      hostVaultPath: '\\\\wsl$\\Debian\\home\\tong\\vault',
      resolvedCliPath: null,
      hostPlatform: 'win32',
      resolveWslDistroVersion: () => 2,
      resolveWslHome: () => '/home/tong',
    })).toThrow('does not match workspace distro');
  });
});
