import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';

import { resolveCodexAppServerLaunchSpec } from '@/providers/codex/runtime/codexAppServerSupport';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import spawn from 'cross-spawn';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { inspectCodexInstallation } from '@/providers/codex/runtime/CodexCLIInstallation';

describe('Codex CLI installation', () => {
  const platform = process.platform;
  let native: WSLProcessFixture;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    native = new WSLProcessFixture();
    native.binaries.set('codex', { path: '/home/me/.local/bin/codex', version: 'codex-cli 0.154.0' });
    vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
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
    expect(await inspectCodexInstallation(configuredHost)).toEqual({
      path: '/home/me/.local/bin/codex', version: '0.154.0', source: 'auto',
    });
    expect(native.requests).toHaveLength(2);
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
