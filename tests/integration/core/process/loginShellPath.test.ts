import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { ClaudianProviderHostDeps } from '@/composition/ClaudianProviderHost';
import type { ClaudianSettings } from '@/core/types';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('login shell PATH for GUI-launched processes', () => {
  const originalEnv = process.env;
  let directory: string;
  let loginBin: string;

  beforeEach(() => {
    jest.resetModules();
    directory = mkdtempSync(path.join(tmpdir(), 'claudian login shell '));
    loginBin = path.join(directory, 'login only bin');
    mkdirSync(loginBin);
    const cli = path.join(loginBin, 'claudian-login-probe');
    writeFileSync(cli, '#!/bin/sh\necho ok\n');
    chmodSync(cli, 0o755);
    // Mirrors a GUI app: minimal PATH, and an empty home so no guessed location holds the CLI.
    process.env = { ...originalEnv, HOME: directory, PATH: '/usr/bin:/bin' };
    for (const key of ['FNM_DIR', 'FNM_MULTISHELL_PATH', 'NVM_BIN', 'VOLTA_HOME', 'XDG_DATA_HOME']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  });

  function writeShell(body: string): void {
    const shell = path.join(directory, 'fake shell');
    writeFileSync(shell, `#!/bin/sh\n${body}\n`);
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
  }

  /** A profile that prints noise and exports a PATH only the login shell knows. */
  function writeLoginShell(): void {
    writeShell([
      'echo "profile noise $PATH"',
      'for last; do :; done',
      `PATH='${loginBin}:/usr/bin:/bin'; export PATH`,
      'eval "$last"',
    ].join('\n'));
  }

  async function createHost() {
    const { ClaudianProviderHost } = await import('@/composition/ClaudianProviderHost');
    const { ProviderExecutionLifecycleRegistry } = await import('@/core/execution');
    const { SettingsCoordinator } = await import('@/app/settings/SettingsCoordinator');
    const { ProviderWorkspaceRegistry } = await import('@/core/providers/ProviderWorkspaceRegistry');
    const { findCLIBinaryPath } = await import('@/core/process/cliBinaryLocator');
    ProviderWorkspaceRegistry.register('login-probe', {
      initialize: async () => ({
        cliResolver: { resolveFromSettings: () => findCLIBinaryPath('claudian-login-probe'), reset: () => undefined },
      }),
    });
    return new ClaudianProviderHost({
      app: {} as ClaudianProviderHostDeps['app'],
      executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
      storage: { installationKey: 'device-key' as never },
      settings: new SettingsCoordinator({} as ClaudianSettings, async () => undefined),
      environment: {} as ClaudianProviderHostDeps['environment'],
      sessionToolEndpoint: { registerMCPRoute: jest.fn(), registerCallRoute: jest.fn() },
      notifyProviderChatOptionsChanged: async () => undefined,
    });
  }

  it('resolves provider CLIs and child PATH from the login shell before launch', async () => {
    writeLoginShell();
    const host = await createHost();

    await expect(host.getResolvedProviderCliPath('login-probe'))
      .resolves.toBe(path.join(loginBin, 'claudian-login-probe'));

    const { getEnhancedPath } = await import('@/core/process/env');
    const entries = getEnhancedPath('/configured/bin').split(path.delimiter);
    expect(entries[0]).toBe('/configured/bin');
    expect(entries[1]).toBe(loginBin);
    expect(entries.some(entry => entry.includes('profile noise'))).toBe(false);
  });

  it('falls back to guessed locations when the login shell fails', async () => {
    writeShell('echo broken >&2\nexit 1');
    const host = await createHost();

    await expect(host.getResolvedProviderCliPath('login-probe')).resolves.toBeNull();
    const { getEnhancedPath } = await import('@/core/process/env');
    expect(getEnhancedPath().split(path.delimiter)).toContain(path.join(directory, '.local', 'bin'));
  });
});
