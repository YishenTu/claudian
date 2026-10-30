import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { DesktopVault } from '@test/helpers/core/DesktopVault';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import spawn from 'cross-spawn';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { inspectCodexInstallation } from '@/providers/codex/runtime/CodexCLIInstallation';

function respond(stdout: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
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
    vi.mocked(spawn).mockReset();
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  async function host(command = 'codex'): Promise<ProviderRuntimeHost> {
    const fixture = await createProviderHostFixture({ vault: sharedVault,
      settings: {
        providerConfigs: { codex: {
          installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          wslDistroOverridesByHost: { [getHostnameKey()]: 'Ubuntu' },
          cliPathsByHost: command === 'codex' ? {} : { [getHostnameKey()]: command },
        } },
      },
      overrides: { workingDirectory: 'C:\\vault', getResolvedProviderCliPath: async () => command },
    });
    return fixture.host.getRuntimeHost('codex');
  }

  it('resolves the real WSL binary before reading its version', async () => {
    vi.mocked(spawn)
      .mockImplementationOnce(() => respond('/home/me/.local/bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
    expect(await inspectCodexInstallation(await host())).toEqual({
      path: '/home/me/.local/bin/codex', version: '0.154.0', source: 'auto',
    });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.slice(0, 2)).toEqual(['wsl.exe', [
      '--distribution', 'Ubuntu', '--cd', '/mnt/c/vault', "'/home/me/.local/bin/codex'", '--version',
    ]]);
  });

  it('looks up relative commands in the vault through the default WSL shell', async () => {
    vi.mocked(spawn)
      .mockImplementationOnce(() => respond('./my bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
    expect(await inspectCodexInstallation(await host('./my bin/codex'))).toEqual({
      path: '/mnt/c/vault/my bin/codex', version: '0.154.0', source: 'custom',
    });
    const lookup = vi.mocked(spawn).mock.calls[0];
    expect(lookup[0]).toBe('wsl.exe');
    expect(lookup[2]).toMatchObject({ windowsVerbatimArguments: true, cwd: 'C:\\vault' });
    expect(lookup[1]).toEqual([
      '--distribution', 'Ubuntu', '--cd', '/mnt/c/vault', 'sh', '-c',
      expect.stringMatching(/^'.*command -v.*'$/u),
      'claudian-cli-probe', "'./my bin/codex'",
    ]);
  });

  it('does not treat the WSL resolver command fallback as a detected binary', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => respond('', 1) as never);
    expect(await inspectCodexInstallation(await host())).toEqual({ path: null, version: null, source: 'auto' });
  });
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
