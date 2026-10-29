import * as fsPromises from 'node:fs/promises';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import { decodeCodexConfig } from '@/providers/codex/config';
import {
  getCodexArchivedTranscriptRoots,
  resolveCodexRolloutFile,
  resolveCodexSessionFileHint,
  resolveCodexTranscriptRootHint,
} from '@/providers/codex/history/CodexHistoryPathResolver';

function createWslContext(distroOverride = '') {
  return {
    environment: { HOME: 'C:\\Users\\me' },
    hostPlatform: 'win32' as const,
    installation: decodeCodexConfig({
      installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
      wslDistroOverridesByHost: { [getHostnameKey()]: distroOverride },
    }),
    vaultPath: 'C:\\vault',
  };
}

describe('CodexHistoryPathResolver', () => {
  it('accepts a configured POSIX Codex home', () => {
    const sessionPath = '/tmp/custom-codex/sessions/thread.jsonl';

    expect(resolveCodexSessionFileHint(sessionPath, {
      environment: { CODEX_HOME: '/tmp/custom-codex', HOME: '/tmp/home' },
    })).toBe(sessionPath);
  });

  it.each([
    ['\\\\wsl$\\Ubuntu\\home\\user\\.codex', '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions', '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\archived_sessions'],
    ['//wsl$\\Ubuntu\\home\\user\\.codex', '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions', '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\archived_sessions'],
    ['C:\\Users\\me\\.codex', 'C:\\Users\\me\\.codex\\sessions', 'C:\\Users\\me\\.codex\\archived_sessions'],
  ])('retains Windows configured-home and archive roots: %s', (home, sessions, archive) => {
    const context = {
      environment: { CODEX_HOME: home, HOME: 'C:\\Users\\me' },
      hostPlatform: 'win32' as const,
    };
    const sessionPath = `${sessions}\\rollout-thread.jsonl`;

    expect(resolveCodexTranscriptRootHint(sessions, context)).toBe(sessions);
    expect(resolveCodexSessionFileHint(sessionPath, context)).toBe(sessionPath);
    expect(getCodexArchivedTranscriptRoots(context)).toContain(archive);
  });

  it.each(['wsl$', 'wsl.localhost'])('accepts a standard host-readable %s transcript root for WSL installs', (server) => {
    const root = `\\\\${server}\\Ubuntu\\home\\user\\.codex\\sessions`;

    expect(resolveCodexTranscriptRootHint(root, createWslContext())).toBe(root);
  });

  it('accepts a WSL session path under the configured distro standard root', () => {
    const sessionPath = '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\07\\12\\rollout-thread.jsonl';

    expect(resolveCodexSessionFileHint(sessionPath, createWslContext('Ubuntu'))).toBe(sessionPath);
  });

  it.each(['wsl$', 'wsl.localhost'])('accepts host-readable %s paths under a custom POSIX Codex home', server => {
    const root = `\\\\${server}\\Ubuntu\\srv\\codex-data\\sessions`;
    const sessionPath = `${root}\\2026\\07\\12\\rollout-thread.jsonl`;
    const context = {
      ...createWslContext('Ubuntu'),
      environment: {
        CODEX_HOME: '/srv/codex-data',
        HOME: 'C:\\Users\\me',
      },
    };

    expect(resolveCodexTranscriptRootHint(root, context)).toBe(root);
    expect(resolveCodexSessionFileHint(sessionPath, context)).toBe(sessionPath);
  });

  it('accepts host drive paths mapped from a custom WSL mount Codex home', () => {
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
    expect(resolveCodexSessionFileHint(sessionPath, context)).toBe(sessionPath);
  });

  it.each(['wsl$', 'wsl.localhost'])('rejects a %s session path from a different explicitly configured distro', server => {
    const sessionPath = `\\\\${server}\\Debian\\home\\user\\.codex\\sessions\\rollout-thread.jsonl`;

    expect(resolveCodexSessionFileHint(sessionPath, createWslContext('Ubuntu'))).toBeNull();
  });

  it('ends the saved-path check at the lookup deadline when the filesystem stalls', async () => {
    const access = vi.spyOn(fsPromises, 'access').mockReturnValue(new Promise<never>(() => {}));
    try {
      await expect(resolveCodexRolloutFile('/tmp/stalled/sessions/rollout-thread.jsonl', 'thread', null, {
        environment: { CODEX_HOME: '/tmp/stalled', HOME: '/tmp/home' },
      }, Date.now() + 20)).resolves.toBeNull();
      expect(access).toHaveBeenCalled();
    } finally {
      access.mockRestore();
    }
  });
});

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));
