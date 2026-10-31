import { getInstallationKey } from '@/core/device/InstallationKey';
import { getSDKProjectsPath, getSDKSessionPath } from '@/providers/claude/history/ClaudeHistoryPathResolver';

const executionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' } as const;
const context = { executionTarget, environment: { HOME: '/home/me' }, hostPlatform: 'win32' as const };

describe('Claude WSL history paths', () => {
  it('encodes the Linux cwd and maps the config directory to the selected distro', () => {
    expect(getSDKSessionPath('C:\\Vault', 'session-1', context))
      .toBe('\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-mnt-c-Vault\\session-1.jsonl');
    expect(getSDKSessionPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\vault', 'session-1', context))
      .toBe('\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-home-me-vault\\session-1.jsonl');
  });

  it.each([
    ['/custom/claude', '\\\\wsl$\\Ubuntu\\custom\\claude'],
    ['D:\\Claude home', 'D:\\Claude home'],
    ['.claude-local', 'C:\\Vault\\.claude-local'],
  ])('resolves configured directory %s using Linux working-directory semantics', (configured, root) => {
    expect(getSDKSessionPath('C:\\Vault', 'session-1', {
      ...context, vaultPath: 'C:\\Vault', environment: { HOME: '/home/me', CLAUDE_CONFIG_DIR: configured },
    })).toBe(`${root}\\projects\\-mnt-c-Vault\\session-1.jsonl`);
  });

  it('rejects another distro and never substitutes Windows HOME for unknown Linux HOME', () => {
    expect(() => getSDKSessionPath('\\\\wsl$\\Debian\\home\\me\\vault', 'session-1', context)).toThrow();
    for (const environment of [{ HOME: 'C:\\Users\\me' }, {}]) {
      expect(() => getSDKSessionPath('C:\\Vault', 'session-1', { ...context, environment }))
        .toThrow('Unable to resolve Claude Code Linux HOME');
    }
    expect(() => getSDKSessionPath('C:\\Vault', 'session-1', {
      ...context, environment: { CLAUDE_CONFIG_DIR: '\\\\wsl$\\Debian\\home\\me\\.claude' },
    })).toThrow('Claude config directory is outside the selected WSL distro');
  });

  it('resolves an absolute Linux directory without a vault, but not a relative one', () => {
    const noVault = { executionTarget, hostPlatform: 'win32' as const };
    // A colon inside a Linux path is not a Windows drive.
    expect(getSDKProjectsPath({ ...noVault, environment: { CLAUDE_CONFIG_DIR: '/opt/claude:e' } }))
      .toBe('\\\\wsl$\\Ubuntu\\opt\\claude:e\\projects');
    expect(() => getSDKProjectsPath({ ...noVault, environment: { CLAUDE_CONFIG_DIR: '.claude-local' } }))
      .toThrow('Claude config directory requires a Linux working directory');
  });

  it('refuses a Linux store it cannot reach from the host', () => {
    expect(() => getSDKSessionPath('C:\\Vault', 'session-1', {
      ...context, executionTarget: { ...executionTarget, distroName: undefined },
    })).toThrow('Unable to map Claude Code config directory to the host');
  });

  it('derives the WSL target from Claude settings when none is given', () => {
    const key = getInstallationKey();
    expect(getSDKSessionPath('C:\\Vault', 'session-1', { hostPlatform: 'win32', environment: { HOME: '/home/me' },
      config: { installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } } }))
      .toBe('\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-mnt-c-Vault\\session-1.jsonl');
  });
});
