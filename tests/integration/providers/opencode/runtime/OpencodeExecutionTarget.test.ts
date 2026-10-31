import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { OpencodeTargetEnvironment } from '@/providers/opencode/runtime/OpencodeExecutionTarget';
import { OpencodeCLINotInstalledError, verifyOpencodeNativeVersion } from '@/providers/opencode/runtime/OpencodeVersion';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
let native: WSLProcessFixture;
beforeEach(() => { native = new WSLProcessFixture(); vi.mocked(spawn).mockReset().mockImplementation(native.spawn); });

const environmentProbes = () => native.requests.filter(request => request.executable === '/usr/bin/awk');

it('probes target-visible store settings once and invalidates on transition or target change', async () => {
  // The Linux environment as WSL presents it: `/p` has already translated the forwarded Windows database path.
  native.environment = { HOME: '/home/alice', XDG_DATA_HOME: '/data', OPENCODE_DB: '/mnt/c/Data/native.db' };
  const cache = new OpencodeTargetEnvironment();
  const read = () => cache.resolve(target, 'C:\\vault', 'CUSTOM=value\nOPENCODE_DB=C:\\Data\\native.db', '/opt/bin/opencode');
  const [first, second] = await Promise.all([read(), read()]);
  expect(first).toBe(second);
  expect(first).toMatchObject({ HOME: '/home/alice', XDG_DATA_HOME: '/data', OPENCODE_DB: '/mnt/c/Data/native.db', CUSTOM: 'value' });
  expect(environmentProbes()).toHaveLength(1);
  const [probe] = environmentProbes();
  expect(probe.argv.slice(1)).toEqual(['HOME', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT']);
  expect(probe.options.env?.WSLENV?.split(':')).toEqual(expect.arrayContaining(['OPENCODE_DB/p', 'CUSTOM']));
  expect(probe.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
  cache.reset();
  await read();
  expect(environmentProbes()).toHaveLength(2);
  await cache.resolve({ ...target, distroName: 'Debian' }, 'C:\\vault', '', 'opencode');
  expect(environmentProbes().map(request => request.args[request.args.indexOf('--distribution') + 1])).toEqual(['Ubuntu', 'Ubuntu', 'Debian']);
});

it('does not cache a failed home probe', async () => {
  native.environment = { HOME: '/home/alice' };
  native.reply = () => ({ code: 1 });
  const cache = new OpencodeTargetEnvironment();
  await expect(cache.resolve(target, 'C:\\vault', '', 'opencode')).rejects.toThrow('Could not resolve the OpenCode WSL home');
  native.reply = undefined;
  await expect(cache.resolve(target, 'C:\\vault', '', 'opencode')).resolves.toMatchObject({ HOME: '/home/alice' });
  expect(environmentProbes()).toHaveLength(2);
});

it('keeps a newer target entry when an older probe fails, and reports a failure that outlives a reset', async () => {
  native.environment = { HOME: '/home/alice' };
  // The Debian distro is not installed; wsl.exe fails before running anything.
  native.reply = request => request.args.includes('Debian') ? { code: 1 } : undefined;
  const cache = new OpencodeTargetEnvironment();
  const failed = cache.resolve({ ...target, distroName: 'Debian' }, 'C:\\vault', '', 'opencode');
  const current = cache.resolve(target, 'C:\\vault', '', 'opencode');
  await expect(failed).rejects.toThrow('Could not resolve the OpenCode WSL home');
  await current;
  await cache.resolve(target, 'C:\\vault', '', 'opencode');
  expect(environmentProbes()).toHaveLength(2);
  const pending = cache.resolve({ ...target, distroName: 'Debian' }, 'C:\\vault', '', 'opencode');
  cache.reset();
  await expect(pending).rejects.toThrow('Could not resolve the OpenCode WSL home');
});

it('gates the target binary version inside the distro', async () => {
  native.binaries.set('/home/alice/bin/open code', { path: '/home/alice/bin/open code', version: 'opencode v2.2.3' });
  expect(await verifyOpencodeNativeVersion('/home/alice/bin/open code', { OPENCODE_DB: 'C:\\Data\\native.db' }, target, 'C:\\vault')).toBe(2);
  const version = native.requests.at(-1)!;
  expect([version.executable, ...version.argv]).toEqual(['/home/alice/bin/open code', '--version']);
  expect(version.options.env?.WSLENV?.split(':')).toContain('OPENCODE_DB/p');
  native.binaries.set('opencode', { path: '/usr/bin/opencode', version: '1.9.0' });
  await expect(verifyOpencodeNativeVersion('opencode', {}, target, 'C:\\vault')).rejects.toThrow('v1 is no longer supported');
  await expect(verifyOpencodeNativeVersion('missing-opencode', {}, target, 'C:\\vault')).rejects.toBeInstanceOf(OpencodeCLINotInstalledError);
});

it('keeps an explicitly configured inline document without round-tripping it through the bounded environment probe', async () => {
  const content = JSON.stringify({ prompt: 'x'.repeat(20_000) });
  // Echoing this value back would exceed the real probe's 16 KiB output bound.
  native.environment = { HOME: '/home/alice', OPENCODE_CONFIG_CONTENT: content };
  const result = await new OpencodeTargetEnvironment().resolve(target, 'C:\\Vault', `OPENCODE_CONFIG_CONTENT=${content}`, 'opencode');
  expect(result.OPENCODE_CONFIG_CONTENT).toBe(content);
  expect(environmentProbes()[0].argv.slice(1)).toEqual(['HOME', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG']);
});
