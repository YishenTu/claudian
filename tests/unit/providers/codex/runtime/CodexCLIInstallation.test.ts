import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('cross-spawn', () => jest.fn());

import spawn from 'cross-spawn';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { inspectCodexInstallation } from '@/providers/codex/runtime/CodexCLIInstallation';
import { getHostnameKey } from '@/utils/env';

function respond(stdout: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(),
  });
  setImmediate(() => {
    child.stdout.end(stdout);
    child.emit('exit', code, null);
    child.emit('close', code, null);
  });
  return child;
}

describe('Codex CLI installation', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.mocked(spawn).mockReset();
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  function host(command = 'codex'): ProviderHost {
    return {
      settings: {
        providerConfigs: { codex: {
          installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          wslDistroOverridesByHost: { [getHostnameKey()]: 'Ubuntu' },
          cliPathsByHost: command === 'codex' ? {} : { [getHostnameKey()]: command },
        } },
      },
      app: { vault: { adapter: { basePath: 'C:\\vault' } } },
      getResolvedProviderCliPath: async () => command,
      getActiveEnvironmentVariables: () => '',
    } as unknown as ProviderHost;
  }

  it('resolves the real WSL binary before reading its version', async () => {
    jest.mocked(spawn)
      .mockImplementationOnce(() => respond('/home/me/.local/bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
    expect(await inspectCodexInstallation(host())).toEqual({
      path: '/home/me/.local/bin/codex', version: '0.154.0', source: 'auto',
    });
    expect(jest.mocked(spawn).mock.calls.at(-1)?.slice(0, 2)).toEqual(['wsl.exe', [
      '--distribution', 'Ubuntu', '--cd', '/mnt/c/vault', "'/home/me/.local/bin/codex'", '--version',
    ]]);
  });

  it('looks up relative commands in the vault through the default WSL shell', async () => {
    jest.mocked(spawn)
      .mockImplementationOnce(() => respond('./my bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
    expect(await inspectCodexInstallation(host('./my bin/codex'))).toEqual({
      path: '/mnt/c/vault/my bin/codex', version: '0.154.0', source: 'custom',
    });
    const lookup = jest.mocked(spawn).mock.calls[0];
    expect(lookup[0]).toBe('wsl.exe');
    expect(lookup[2]).toMatchObject({ windowsVerbatimArguments: true, cwd: 'C:\\vault' });
    expect(lookup[1]).toEqual([
      '--distribution', 'Ubuntu', '--cd', '/mnt/c/vault', 'sh', '-c',
      expect.stringMatching(/^'.*command -v.*'$/u),
      'claudian-cli-probe', "'./my bin/codex'",
    ]);
  });

  it('does not treat the WSL resolver command fallback as a detected binary', async () => {
    jest.mocked(spawn).mockImplementationOnce(() => respond('', 1) as never);
    expect(await inspectCodexInstallation(host())).toEqual({ path: null, version: null, source: 'auto' });
  });
});
