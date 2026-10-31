import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { resolveDeepSeekExecutionContext, toDeepSeekHostPath } from '@/providers/deepseek/runtime/DeepSeekExecutionContext';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const target: ExecutionTarget = { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let wsl: WSLProcessFixture;

beforeEach(() => {
  wsl = new WSLProcessFixture();
  vi.mocked(spawn).mockReset().mockImplementation(wsl.spawn);
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

it.each([
  [undefined, '/home/alice/.dsh', '\\\\wsl$\\Ubuntu\\home\\alice\\.dsh'],
  ['~/Native Store', '/home/alice/Native Store', '\\\\wsl$\\Ubuntu\\home\\alice\\Native Store'],
  ['relative/store', '/mnt/c/Vault/relative/store', 'C:\\Vault\\relative\\store'],
  ['/home/alice/Store', '/home/alice/Store', '\\\\wsl$\\Ubuntu\\home\\alice\\Store'],
])('resolves child DSH_HOME %j using Linux HOME and cwd', async (configured, expected, home) => {
  wsl.environment = { HOME: '/home/alice', DSH_HOME: configured };
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', { HOME: 'C:\\wrong', USERPROFILE: 'C:\\also-wrong' }, '');
  expect(context.targetHome).toBe(expected);
  expect(context.targetCwd).toBe('/mnt/c/Vault');
  expect(context.home).toBe(home);
  expect(wsl.requests.map(request => [request.executable, ...request.argv.slice(1)])).toEqual([['/usr/bin/awk', 'HOME', 'DSH_HOME']]);
  expect(wsl.requests[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/Vault']));
});

it('probes the actual child environment with host DSH_HOME conversion and explicit user exports', async () => {
  wsl.environment = { HOME: '/home/alice', DSH_HOME: '/mnt/d/DeepSeek Home' };
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', {
    DSH_HOME: 'D:\\DeepSeek Home', DSH_API_KEY: 'private-key', DEEPSEEK_REGION: 'cn', EXTRA: 'value', OTHER: 'host-only', HOME: 'C:\\Users\\me',
    // Only a leading DSH_/DEEPSEEK_ prefix marks a DeepSeek variable.
    LEGACY_DSH_TOKEN: 'host-only', MY_DEEPSEEK_KEY: 'host-only',
  }, 'EXTRA=value');
  expect(context.targetHome).toBe('/mnt/d/DeepSeek Home');
  expect(context.home).toBe('D:\\DeepSeek Home');
  expect(context.forwardEnvironment).toEqual(expect.arrayContaining([
    { key: 'DSH_HOME', hostPath: true, pathList: false }, { key: 'DSH_API_KEY', hostPath: false, pathList: false },
    { key: 'DEEPSEEK_REGION', hostPath: false, pathList: false }, { key: 'EXTRA', hostPath: false, pathList: false },
  ]));
  expect(context.forwardEnvironment).toHaveLength(4);
  const [probe] = wsl.requests;
  expect(probe.options.env?.WSLENV?.split(':')).toEqual(expect.arrayContaining(['DSH_HOME/p', 'DSH_API_KEY', 'DEEPSEEK_REGION', 'EXTRA']));
  expect(probe.options.env?.WSLENV?.split(':')).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(?:HOME|OTHER|LEGACY_DSH_TOKEN|MY_DEEPSEEK_KEY)(?:\/|$)/u)]));
  expect(probe.argv.slice(1)).toEqual(['HOME', 'DSH_HOME']);
  expect(probe.args.join(' ')).not.toContain('private-key');
});

it.each([
  ['HOME', 'HOME=/opt/linux-home', true], ['HOME', 'HOME=C:\\Users\\me', false], ['HOME', 'HOME=relative/home', false],
  ['PATH', 'PATH=/usr/local/bin', true], ['PATH', 'PATH=C:\\Windows', false], ['PATH', 'PATH=/mnt/c/x\\y', false],
  ['USERPROFILE', 'USERPROFILE=/home/me', false], ['WSLENV', 'WSLENV=FOO', false],
])('forwards a configured %s only as a Linux value (%s)', async (key, text, forwarded) => {
  wsl.environment = { HOME: '/home/alice' };
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', { [key]: text.slice(key.length + 1) }, text);
  expect(context.forwardEnvironment.some(row => row.key === key)).toBe(forwarded);
});

it.each([
  ['SSL_CERT_DIR', 'C:\\certs;D:\\more', { hostPath: true, pathList: true }, '/mnt/c/certs:/mnt/d/more'],
  ['SSL_CERT_DIR', '/etc/ssl//certs', { hostPath: false, pathList: false }, '/etc/ssl//certs'],
  ['SSL_CERT_FILE', 'C:\\certs\\ca.pem', { hostPath: true, pathList: false }, '/mnt/c/certs/ca.pem'],
  ['SSL_CERT_FILE', 'certs\\C:\\ca.pem', { hostPath: false, pathList: false }, 'certs\\C:\\ca.pem'],
  ['DSH_HOME', 'd:/DeepSeek', { hostPath: true, pathList: false }, '/mnt/d/DeepSeek'],
  ['NODE_EXTRA_CA_CERTS', 'C:\\certs\\extra.pem', { hostPath: true, pathList: false }, '/mnt/c/certs/extra.pem'],
  ['TMPDIR', 'C:\\Temp', { hostPath: true, pathList: false }, '/mnt/c/Temp'],
  ['TMP', 'C:\\Temp', { hostPath: true, pathList: false }, '/mnt/c/Temp'],
  ['TEMP', 'C:\\Temp', { hostPath: true, pathList: false }, '/mnt/c/Temp'],
  ['TMPDIR', '/tmp/linux', { hostPath: false, pathList: false }, '/tmp/linux'],
  ['DSH_TOKEN', 'C:\\not-a-path-key', { hostPath: false, pathList: false }, 'C:\\not-a-path-key'],
])('marks %s=%j for host path translation only when it is a path key with a Windows path', async (key, value, flags, expected) => {
  wsl.environment = { HOME: '/home/alice' };
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', { [key]: value }, `${key}=${value}`);
  expect(context.forwardEnvironment).toContainEqual({ key, ...flags });
  expect(wsl.requests[0].env[key]).toBe(expected);
});

it('fails without Linux home evidence and rejects a different distro before probing its profile', async () => {
  wsl.reply = () => ({ code: 1 });
  await expect(resolveDeepSeekExecutionContext(target, 'C:\\Vault', {}, '')).rejects.toThrow(/home.*WSL|WSL.*home/i);
  expect(wsl.requests).toHaveLength(1);
  await expect(resolveDeepSeekExecutionContext(target, 'C:\\Vault', { DSH_HOME: '\\\\wsl$\\Debian\\home\\alice' }, '')).rejects.toThrow(/DSH_HOME.*distro/);
  expect(wsl.requests).toHaveLength(1);
});

it.each(['/vault', 'C:/Vault', 'C:\\Vault'])('preserves native Windows session cwd %s without rewriting its identity', async cwd => {
  const context = await resolveDeepSeekExecutionContext(
    { method: 'host-native', platformOs: 'windows', platformFamily: 'windows' },
    cwd, { USERPROFILE: 'C:\\Users\\alice' }, '',
  );
  expect(context.targetCwd).toBe(cwd);
  // Native Windows dsh resolves its store from USERPROFILE with Windows path semantics.
  expect(context.targetHome).toBe('C:\\Users\\alice\\.dsh');
  expect(wsl.requests).toEqual([]);
});

it('maps native tool paths to host paths only for WSL contexts', async () => {
  wsl.environment = { HOME: '/home/alice' };
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', {}, '');
  expect(toDeepSeekHostPath('notes/a.md', context)).toBe('C:\\Vault\\notes\\a.md');
  expect(toDeepSeekHostPath('/home/alice/a.md', context)).toBe('\\\\wsl$\\Ubuntu\\home\\alice\\a.md');
  expect(toDeepSeekHostPath('', context)).toBe('');
  expect(toDeepSeekHostPath('/home/alice/a.md')).toBe('/home/alice/a.md');
  const native = await resolveDeepSeekExecutionContext({ method: 'host-native', platformOs: 'windows', platformFamily: 'windows' }, 'C:\\Vault', {}, '');
  expect(toDeepSeekHostPath('/home/alice/a.md', native)).toBe('/home/alice/a.md');
});
