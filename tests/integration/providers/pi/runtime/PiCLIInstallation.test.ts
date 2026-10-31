// @test-ci {"native":true}
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { createPiCommandShim } from '@test/helpers/providers/pi/PiWindowsLaunchers';
import { readWSLExec } from '@test/helpers/WSLLaunch';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { inspectPiInstallation } from '@/providers/pi/runtime/PiCLIInstallation';
import { PiCLIResolver } from '@/providers/pi/runtime/PiCLIResolver';

const actualSpawn = (await vi.importActual<{ default: typeof spawn }>('cross-spawn')).default;
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

let native: WSLProcessFixture;
beforeEach(() => {
  native = new WSLProcessFixture();
  // Only wsl.exe launches reach the fixture; host-native CLIs run for real.
  vi.mocked(spawn).mockReset().mockImplementation((command, args, options) => /wsl\.exe$/iu.test(command)
    ? native.spawn(command, args, options) : actualSpawn(command, args, options));
});

async function piHost(config: Record<string, unknown>, workingDirectory: string) {
  const resolver = new PiCLIResolver();
  const fixture = await createProviderHostFixture({
    settings: { providerConfigs: { pi: config } },
    overrides: { workingDirectory, getResolvedProviderCliPath: async (_id, context) => resolver.resolveFromSettings(fixture.settings, context) },
  });
  return fixture.host.getRuntimeHost('pi');
}

describe('WSL', () => {
  const key = getInstallationKey();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); });
  const wsl = { installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } };

  it('reports a configured Linux CLI with the forwarded configured environment and vault cwd', async () => {
    native.binaries.set('/home/me/bin/pi', { path: '/home/me/bin/pi', version: 'pi 1.2.3' });
    const host = await piHost({ ...wsl, cliPathsByHost: { [key]: '/home/me/bin/pi' },
      environmentVariables: 'PI_TOKEN=secret\nHOME=/home/linux-user' }, 'C:\\vault');
    expect(await inspectPiInstallation(host)).toEqual({ path: '/home/me/bin/pi', version: '1.2.3', source: 'custom' });
    const version = native.requests.find(request => request.argv.includes('--version'))!;
    expect(version.executable).toBe('/home/me/bin/pi');
    expect(version.args.slice(0, version.args.indexOf('--exec'))).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
    expect(version.options.env).toMatchObject({ PI_TOKEN: 'secret', CLAUDIAN_WSL_HOME: '/home/linux-user' });
    expect(String(version.options.env?.WSLENV).split(':')).toEqual(expect.arrayContaining(['PI_TOKEN', 'HOME']));
    expect(readWSLExec({ args: [...version.args] }).args.join(' ')).not.toContain('secret');
  });

  it.each([
    [{ cliPath: '/opt/pi/bin/pi' }, 'custom'],
    [{}, 'auto'],
  ] as const)('attributes a Linux CLI found from %j to its configuration source', async (paths, source) => {
    const expected = 'cliPath' in paths ? paths.cliPath : '/usr/local/bin/pi';
    native.binaries.set('cliPath' in paths ? paths.cliPath : 'pi', { path: expected, version: 'pi 1.2.3' });
    const host = await piHost({ ...wsl, ...paths }, 'C:\\vault');
    expect(await inspectPiInstallation(host)).toEqual({ path: expected, version: '1.2.3', source });
  });
});

it.skipIf(process.platform === 'win32')('reports a host-native CLI version through the real process', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-pi-cli-'));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, 'pi');
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = --version ] && echo "pi $PI_FIXTURE_VERSION"\n', { mode: 0o755 });
  const host = await piHost({ cliPathsByHost: { [getInstallationKey()]: command }, environmentVariables: 'PI_FIXTURE_VERSION=0.9.1' }, root);
  expect(await inspectPiInstallation(host)).toEqual({ path: command, version: '0.9.1', source: 'custom' });
  expect(native.requests).toHaveLength(0);
});

// A POSIX host runs the Windows npm-shim resolution with the platform stubbed; Windows CI runs it natively.
it('inspects a Windows npm shim by running its package entry through Node', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-pi-shim-'));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const cli = path.join(packageRoot, 'dist', 'bundle', 'cli.js');
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin: { pi: 'dist/bundle/cli.js' } }));
  await fs.writeFile(cli, "if (process.argv[2] === '--version') console.log('pi 1.0.4');\n");
  const shim = path.join(root, 'pi.cmd');
  // Windows grants X_OK to every readable file; a POSIX host needs the mode bit.
  await fs.writeFile(shim, createPiCommandShim(shim, cli), { mode: 0o755 });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const host = await piHost({ cliPathsByHost: { [getInstallationKey()]: shim } }, root);
    expect(await inspectPiInstallation(host)).toEqual({ path: shim, version: '1.0.4', source: 'custom' });
  } finally { Object.defineProperty(process, 'platform', platform); }
});
