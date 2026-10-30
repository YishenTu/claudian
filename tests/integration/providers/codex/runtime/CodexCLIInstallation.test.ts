import { resolveCodexAppServerLaunchSpec } from '@/providers/codex/runtime/codexAppServerSupport';
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

  async function host(command = 'codex', environmentVariables = ''): Promise<ProviderRuntimeHost> {
    const fixture = await createProviderHostFixture({ vault: sharedVault,
      settings: {
        providerConfigs: { codex: {
          environmentVariables,
          installationMethodsByHost: { [getHostnameKey()]: 'wsl' },
          wslDistroOverridesByHost: { [getHostnameKey()]: 'Ubuntu' },
          cliPathsByHost: command === 'codex' ? {} : { [getHostnameKey()]: command },
        } },
      },
      overrides: { workingDirectory: 'C:\\vault', getResolvedProviderCliPath: async () => command },
    });
    return fixture.host.getRuntimeHost('codex');
  }

  it.each([
    { configuredHome: '/home/linux-user', configuredPath: '/opt/cli:/usr/bin', forwarded: true },
    { configuredHome: 'C:\\Users\\me', configuredPath: 'C:\\tools', forwarded: false },
  ])('uses the same configured environment for runtime and probe ($forwarded Linux HOME/PATH)', async ({ configuredHome, configuredPath, forwarded }) => {
    const environmentText = `CUSTOM_TOKEN=secret\nCODEX_HOME=C:\\Codex Home\nOPENAI_API_KEY=test-key\nNODE_EXTRA_CA_CERTS=C:\\certs\\corp.pem\nTMPDIR=C:\\Temp\nSSL_CERT_DIR=C:\\certs;D:\\more\nSSL_CERT_FILE=/etc/ssl/cert.pem\nHOME=${configuredHome}\nPATH=${configuredPath}`;
    const configuredHost = await host('codex', environmentText);
    vi.mocked(spawn)
      .mockImplementationOnce(() => respond('/home/me/.local/bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
    await inspectCodexInstallation(configuredHost);
    const launch = await resolveCodexAppServerLaunchSpec(configuredHost);
    const forwardedKeys = launch.env.WSLENV.split(':');
    expect(forwardedKeys).toEqual(expect.arrayContaining(['CUSTOM_TOKEN', 'CODEX_HOME/p', 'OPENAI_API_KEY', 'NODE_EXTRA_CA_CERTS/p', 'TMPDIR/p', 'SSL_CERT_DIR/pl', 'SSL_CERT_FILE']));
    expect(forwardedKeys.includes('HOME')).toBe(forwarded);
    expect(launch.env.PATH).toBe(configuredPath);
    expect(forwardedKeys.includes('PATH')).toBe(forwarded);
    for (const [, args, options] of vi.mocked(spawn).mock.calls) {
      expect(options).toMatchObject({ env: launch.env, windowsVerbatimArguments: true });
      expect(args!.join(' ')).not.toContain('secret');
    }
  });
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
