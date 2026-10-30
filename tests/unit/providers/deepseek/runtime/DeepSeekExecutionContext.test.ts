import { readWSLExec } from '@test/helpers/WSLLaunch';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { resolveDeepSeekExecutionContext } from '@/providers/deepseek/runtime/DeepSeekExecutionContext';

vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn() }));
const target: ExecutionTarget = { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' };

it.each([
  [undefined, '/home/alice/.dsh'], ['~/Native Store', '/home/alice/Native Store'],
  ['relative/store', '/mnt/c/Vault/relative/store'], ['/home/alice/Store', '/home/alice/Store'],
])('resolves child DSH_HOME %j using Linux HOME and cwd', async (configured, expected) => {
  vi.mocked(runProcessProbe).mockResolvedValue(`x\0/home/alice\0${configured === undefined ? '\0\0' : `x\0${configured}\0`}`);
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', { HOME: 'C:\\wrong', USERPROFILE: 'C:\\also-wrong' }, '');
  expect(context.targetHome).toBe(expected);
  expect(context.targetCwd).toBe('/mnt/c/Vault');
  expect(context.pathMapper.toTargetPath(context.home)).toBe(expected);
});

it('probes the actual child environment with host DSH_HOME conversion and explicit user exports', async () => {
  vi.mocked(runProcessProbe).mockResolvedValue('x\0/home/alice\0x\0/mnt/d/DeepSeek Home\0');
  const context = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', { DSH_HOME: 'D:\\DeepSeek Home', DSH_API_KEY: 'private-key', EXTRA: 'value', HOME: 'C:\\Users\\me' }, 'EXTRA=value');
  expect(context.targetHome).toBe('/mnt/d/DeepSeek Home');
  const [spec] = vi.mocked(runProcessProbe).mock.calls.at(-1)!;
  expect(spec.env.WSLENV).toContain('DSH_HOME/p');
  expect(spec.env.WSLENV).toContain('DSH_API_KEY');
  expect(spec.env.WSLENV).toContain('EXTRA');
  expect(spec.env.WSLENV).not.toContain('HOME:');
  expect(readWSLExec(spec).args.at(-2)).toBe('HOME');
  expect(spec.args.join(' ')).not.toContain('private-key');
});

it('fails without Linux home evidence and rejects a different distro before probing its profile', async () => {
  vi.mocked(runProcessProbe).mockResolvedValue(null);
  await expect(resolveDeepSeekExecutionContext(target, 'C:\\Vault', {}, '')).rejects.toThrow(/home.*WSL|WSL.*home/i);
  await expect(resolveDeepSeekExecutionContext(target, 'C:\\Vault', { DSH_HOME: '\\\\wsl$\\Debian\\home\\alice' }, '')).rejects.toThrow(/DSH_HOME.*distro/);
});

it.each(['/vault', 'C:/Vault', 'C:\\Vault'])('preserves native Windows session cwd %s without rewriting its identity', async cwd => {
  const context = await resolveDeepSeekExecutionContext(
    { method: 'host-native', platformOs: 'windows', platformFamily: 'windows' },
    cwd, { USERPROFILE: 'C:\\Users\\alice' }, '',
  );
  expect(context.targetCwd).toBe(cwd);
});
