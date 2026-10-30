import { readWSLExec } from '@test/helpers/WSLLaunch';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { getOpencodeWSLForwardedEnvironment, opencodeFileURL,OpencodeTargetEnvironment } from '@/providers/opencode/runtime/OpencodeExecutionTarget';
import { verifyOpencodeNativeVersion } from '@/providers/opencode/runtime/OpencodeVersion';

vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn() }));
const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
afterEach(() => vi.clearAllMocks());

it('forwards owned paths and explicit user values without importing the Windows HOME or PATH', () => {
  expect(getOpencodeWSLForwardedEnvironment({
    HOME: 'C:\\Users\\Alice', PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\Alice',
    OPENCODE_DB: 'C:\\Data\\opencode.db', OPENCODE_CONFIG: '/home/alice/config.json',
    OPENCODE_CONFIG_CONTENT: '{"prompt":"C:\\\\keep"}', XDG_DATA_HOME: '\\\\wsl$\\Ubuntu\\data',
    CUSTOM: 'literal', OPENCODE_PASSWORD: 'secret',
  }, 'CUSTOM=literal')).toEqual(expect.arrayContaining([
    { key: 'OPENCODE_DB', hostPath: true }, { key: 'OPENCODE_CONFIG', hostPath: false },
    { key: 'XDG_DATA_HOME', hostPath: true }, { key: 'OPENCODE_CONFIG_CONTENT', hostPath: false },
    { key: 'OPENCODE_PASSWORD', hostPath: false }, { key: 'CUSTOM', hostPath: false },
  ]));
  expect(getOpencodeWSLForwardedEnvironment({ HOME: 'C:\\Users\\Alice', PATH: 'C:\\bin' })).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: 'HOME' }), expect.objectContaining({ key: 'PATH' })]));
});

it('probes target-visible store settings once and invalidates on transition or target change', async () => {
  vi.mocked(runProcessProbe).mockResolvedValue('x\0/home/alice\0x\0/data\0x\0/native.db\0\0\0\0\0');
  const cache = new OpencodeTargetEnvironment();
  const read = () => cache.resolve(target, 'C:\\vault', 'CUSTOM=value\nOPENCODE_DB=C:\\Data\\native.db', '/opt/bin/opencode');
  const [first, second] = await Promise.all([read(), read()]);
  expect(first).toBe(second);
  expect(first).toMatchObject({ HOME: '/home/alice', XDG_DATA_HOME: '/data', OPENCODE_DB: '/native.db' });
  expect(runProcessProbe).toHaveBeenCalledTimes(1);
  const spec = vi.mocked(runProcessProbe).mock.calls[0][0] as ManagedStdioProcessOptions;
  expect(spec.env.WSLENV).toContain('OPENCODE_DB/p');
  expect(spec.env.WSLENV).toContain('CUSTOM');
  expect(readWSLExec(spec).args).toContain('/usr/bin/awk');
  cache.reset(); await read();
  expect(runProcessProbe).toHaveBeenCalledTimes(2);
  await cache.resolve({ ...target, distroName: 'Debian' }, 'C:\\vault', '', 'opencode');
  expect(runProcessProbe).toHaveBeenCalledTimes(3);
});

it('gates the target binary version without checking a Linux path on the host', async () => {
  vi.mocked(runProcessProbe).mockResolvedValueOnce('/home/alice/bin/open code').mockResolvedValueOnce('opencode v2.2.3');
  expect(await verifyOpencodeNativeVersion('/home/alice/bin/open code', {}, target, 'C:\\vault')).toBe(2);
  const versionSpec = vi.mocked(runProcessProbe).mock.calls[1][0] as ManagedStdioProcessOptions;
  expect(readWSLExec(versionSpec).args.slice(-2)).toEqual(['/home/alice/bin/open code', '--version']);
  vi.mocked(runProcessProbe).mockResolvedValueOnce('/usr/bin/opencode').mockResolvedValueOnce('1.9.0');
  await expect(verifyOpencodeNativeVersion('opencode', {}, target, 'C:\\vault')).rejects.toThrow('v1 is no longer supported');
});

it('emits Linux file URLs with URL escaping for host managed plugin folders', () => {
  expect(opencodeFileURL('C:\\Temp\\plugin #1', target)).toBe('file:///mnt/c/Temp/plugin%20%231');
  expect(opencodeFileURL('\\\\wsl$\\Ubuntu\\home\\alice\\plugin', target)).toBe('file:///home/alice/plugin');
});

it('keeps an explicitly configured inline document without round-tripping it through the bounded environment probe', async () => {
  const content = JSON.stringify({ prompt: 'x'.repeat(20_000) });
  vi.mocked(runProcessProbe).mockImplementation(async options => {
    const args = readWSLExec(options).args;
    const variables = args.slice(args.indexOf('/usr/bin/awk') + 2);
    const values: Record<string, string> = { HOME: '/home/alice', OPENCODE_CONFIG_CONTENT: content };
    const output = variables.map(key => key in values ? `x\0${values[key]}\0` : '\0\0').join('');
    // ProcessProbe's documented implementation bounds all captured output at 16 KiB.
    return Buffer.byteLength(output) > 16_384 ? null : output;
  });
  const result = await new OpencodeTargetEnvironment().resolve(target, 'C:\\Vault', `OPENCODE_CONFIG_CONTENT=${content}`, 'opencode');
  expect(result.OPENCODE_CONFIG_CONTENT).toBe(content);
});
