import {
  resolveCodexSessionFileHint,
  resolveCodexTranscriptRootHint,
} from '@/providers/codex/history/CodexHistoryPathResolver';

function createWslContext(distroOverride = '') {
  return {
    environment: { HOME: 'C:\\Users\\me' },
    hostPlatform: 'win32' as const,
    settings: {
      providerConfigs: {
        codex: {
          installationMethod: 'wsl',
          wslDistroOverride: distroOverride,
        },
      },
    },
    vaultPath: 'C:\\vault',
  };
}

describe('CodexHistoryPathResolver', () => {
  it('accepts a configured POSIX Codex home', async () => {
    const sessionPath = '/tmp/custom-codex/sessions/thread.jsonl';

    await expect(resolveCodexSessionFileHint(sessionPath, 'thread', {
      environment: { CODEX_HOME: '/tmp/custom-codex', HOME: '/tmp/home' },
    })).resolves.toBe(sessionPath);
  });

  it('accepts a standard host-readable WSL transcript root for WSL installs', () => {
    const root = '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions';

    expect(resolveCodexTranscriptRootHint(root, createWslContext())).toBe(root);
  });

  it('accepts a WSL session path under the configured distro standard root', async () => {
    const sessionPath = '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\07\\12\\rollout-thread.jsonl';

    await expect(resolveCodexSessionFileHint(
      sessionPath,
      'thread',
      createWslContext('Ubuntu'),
    )).resolves.toBe(sessionPath);
  });

  it('accepts host-readable WSL paths under a custom POSIX Codex home', async () => {
    const root = '\\\\wsl$\\Ubuntu\\srv\\codex-data\\sessions';
    const sessionPath = `${root}\\2026\\07\\12\\rollout-thread.jsonl`;
    const context = {
      ...createWslContext('Ubuntu'),
      environment: {
        CODEX_HOME: '/srv/codex-data',
        HOME: 'C:\\Users\\me',
      },
    };

    expect(resolveCodexTranscriptRootHint(root, context)).toBe(root);
    await expect(resolveCodexSessionFileHint(
      sessionPath,
      'thread',
      context,
    )).resolves.toBe(sessionPath);
  });

  it('accepts host drive paths mapped from a custom WSL mount Codex home', async () => {
    const root = 'D:\\codex-data\\sessions';
    const sessionPath = `${root}\\2026\\07\\12\\rollout-thread.jsonl`;
    const context = {
      ...createWslContext('Ubuntu'),
      environment: {
        CODEX_HOME: '/mnt/d/codex-data',
        HOME: 'C:\\Users\\me',
      },
    };

    expect(resolveCodexTranscriptRootHint(root, context)).toBe(root);
    await expect(resolveCodexSessionFileHint(
      sessionPath,
      'thread',
      context,
    )).resolves.toBe(sessionPath);
  });

  it('rejects a WSL session path from a different explicitly configured distro', async () => {
    const sessionPath = '\\\\wsl$\\Debian\\home\\user\\.codex\\sessions\\rollout-thread.jsonl';

    await expect(resolveCodexSessionFileHint(
      sessionPath,
      null,
      createWslContext('Ubuntu'),
    )).resolves.toBeNull();
  });
});
