import '@/providers';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { readWSLExec } from '@test/helpers/WSLLaunch';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { resolveGrokExecutionContext } from '@/providers/grok/runtime/GrokExecutionContext';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

async function wslHost(grok: Record<string, unknown> = {}) {
  const key = getInstallationKey();
  const { host } = await createProviderHostFixture({ settings: { providerConfigs: { grok: {
    enabled: true, installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' }, ...grok,
  } } } });
  return host;
}

it('uses one resolved distro, a Linux CLI reference and explicitly forwarded environment', async () => {
  const host = await wslHost({
    cliPathsByHost: { [getInstallationKey()]: '~/cli with spaces/grok' },
    environmentVariables: 'GROK_HOME=C:\\grok-home\nXAI_API_KEY=secret\nPATH=/linux/bin:/usr/bin',
  });
  const context = await resolveGrokExecutionContext(host.getRuntimeHost('grok'), 'C:\\vault');
  const spec = buildTargetLaunchSpec({ ...context, args: ['agent', '--no-leader', 'stdio'] });
  expect(context.target.distroName).toBe('Ubuntu');
  expect(spec.targetCwd).toBe('/mnt/c/vault');
  expect(readWSLExec(spec).args.slice(-4)).toEqual(['~/cli with spaces/grok', 'agent', '--no-leader', 'stdio']);
  expect(spec.env.PATH).toBe('/linux/bin:/usr/bin');
  expect(spec.env.WSLENV).toContain('GROK_HOME/p');
  expect(spec.env.WSLENV).toContain('XAI_API_KEY');
  expect(spec.env.WSLENV).toContain('GROK_FOLDER_TRUST');
  expect(spec.env.WSLENV).toContain('PATH');
  expect(spec.args.join(' ')).not.toContain('secret');
});

it.each([
  ['C:\\vault', '/mnt/c/vault'],
  ['\\\\wsl$\\Ubuntu\\home\\alice\\vault', '/home/alice/vault'],
])('projects the prompt working directory %s to the same cwd used by launch', async (hostCwd, expected) => {
  const host = await wslHost();
  const promptCwd = await ProviderRegistry.resolveExecutionWorkingDirectory(host, 'grok', hostCwd);
  const launch = buildTargetLaunchSpec({ ...await resolveGrokExecutionContext(host.getRuntimeHost('grok'), hostCwd), args: [] });
  expect(promptCwd).toBe(expected);
  expect(launch.targetCwd).toBe(expected);
});

it('forwards only Grok-owned and explicitly configured Linux values, with path and list conversions', async () => {
  vi.stubEnv('WSLENV', undefined);
  vi.stubEnv('GROK_FROM_HOST', 'host');
  vi.stubEnv('XAI_FROM_HOST', 'host');
  vi.stubEnv('MY_GROK_TOKEN', 'not-grok-owned');
  try {
    const host = await wslHost({ environmentVariables: [
      'GROK_HOME=C:\\grok', 'SSL_CERT_DIR=C:\\certs;D:\\more', 'SSL_CERT_FILE=\\\\server\\share\\ca.pem', 'TMPDIR=/tmp/linux',
      'HOME=/home/linux', 'PATH=C:\\Windows', 'USERPROFILE=/home/profile', 'CUSTOM=value', 'WSLENV=INJECTED',
    ].join('\n') });
    const context = await resolveGrokExecutionContext(host.getRuntimeHost('grok'), 'C:\\vault');
    expect(Object.fromEntries(context.forwardEnvironment!.map(({ key, hostPath, pathList }) => [key, [hostPath, pathList]]))).toEqual({
      GROK_HOME: [true, false], SSL_CERT_DIR: [true, true], SSL_CERT_FILE: [true, false], TMPDIR: [false, false],
      HOME: [false, false], CUSTOM: [false, false], GROK_FOLDER_TRUST: [false, false],
      GROK_FROM_HOST: [false, false], XAI_FROM_HOST: [false, false],
    });
  } finally { vi.unstubAllEnvs(); }
});

it('keeps Windows-shaped homes and Linux paths that merely contain a drive pattern on their own sides', async () => {
  vi.stubEnv('WSLENV', undefined);
  try {
    const host = await wslHost({ environmentVariables: [
      'HOME=C:/Users/me', 'PATH=/usr/local/bin:/usr/bin', 'GROK_HOME=/srv/c:/grok',
      'NODE_EXTRA_CA_CERTS=C:\\ca.pem', 'TMPDIR=D:\\tmp', 'TMP=\\\\server\\tmp', 'TEMP=E:/temp',
    ].join('\n') });
    const context = await resolveGrokExecutionContext(host.getRuntimeHost('grok'), 'C:\\vault');
    const flags = Object.fromEntries(context.forwardEnvironment!.map(({ key, hostPath }) => [key, hostPath]));
    expect(flags).not.toHaveProperty('HOME');
    expect(flags).toMatchObject({ PATH: false, GROK_HOME: false, NODE_EXTRA_CA_CERTS: true, TMPDIR: true, TMP: true, TEMP: true });
  } finally { vi.unstubAllEnvs(); }
});

it('rejects a vault the selected distro cannot address', async () => {
  const host = await wslHost();
  await expect(ProviderRegistry.resolveExecutionWorkingDirectory(host, 'grok', '\\\\wsl$\\Debian\\vault'))
    .rejects.toThrow('cannot be represented in the selected WSL distro');
});

it('keeps native working directories and the resolved native CLI', async () => {
  Object.defineProperty(process, 'platform', platform);
  const { host } = await createProviderHostFixture({ settings: { providerConfigs: { grok: { enabled: true } } } });
  expect(await ProviderRegistry.resolveExecutionWorkingDirectory(host, 'grok', '/vault')).toBe('/vault');
  const context = await resolveGrokExecutionContext(host.getRuntimeHost('grok'), '/vault');
  expect([context.target.method, context.command]).toEqual(['host-native', 'grok']);
});
