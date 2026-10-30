import * as fs from 'node:fs/promises';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { parseOpencodeConfig, prepareOpencodeLaunchArtifacts, resolveOpencodePluginReferences } from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>(), readFile: vi.fn(), mkdir: vi.fn(), rm: vi.fn() }));
vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn() }));
const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
afterEach(() => vi.clearAllMocks());

it('writes database directories on the host and embeds Linux plugin URLs without rewriting user strings', async () => {
  vi.mocked(fs.readFile).mockResolvedValue('User file instructions');
  const result = await prepareOpencodeLaunchArtifacts({
    target, workspaceRoot: 'C:\\Vault', sessionToolsPluginPath: 'C:\\Temp\\private #1\\session-tools',
    runtimeEnv: { HOME: '/home/alice', OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugins: [{ package: './user-plugin', options: { literal: 'C:\\keep' } }],
      agent: { build: { prompt: '{file:~/instructions.txt}' } }, userText: 'C:\\keep',
    }) },
  });
  expect(result.databasePath).toBe('\\\\wsl$\\Ubuntu\\home\\alice\\.local\\share\\opencode\\opencode.db');
  expect(fs.mkdir).toHaveBeenCalledWith('\\\\wsl$\\Ubuntu\\home\\alice\\.local\\share\\opencode', { recursive: true });
  expect(fs.readFile).toHaveBeenCalledWith('\\\\wsl$\\Ubuntu\\home\\alice\\instructions.txt', 'utf8');
  const config = JSON.parse(result.configContent);
  expect(config.userText).toBe('C:\\keep');
  expect(config.agent.build.prompt).toBe('User file instructions');
  expect(config.plugins).toEqual([
    { package: 'file:///mnt/c/Vault/user-plugin', options: { literal: 'C:\\keep' } },
    { package: 'file:///mnt/c/Temp/private%20%231/session-tools' },
  ]);
});

it('resolves config environment substitutions inside Linux and reads absolute file substitutions through the host', async () => {
  vi.mocked(runProcessProbe).mockResolvedValue('x\0linux-key\0');
  vi.mocked(fs.readFile).mockResolvedValue('Target instructions');
  const result = await parseOpencodeConfig('{"key":"{env:LINUX_API_KEY}","prompt":"{file:/home/alice/prompt.txt}"}', 'explicit.json', { HOME: '/home/alice' }, 'C:\\Vault', target);
  expect(result).toEqual({ key: 'linux-key', prompt: 'Target instructions' });
  expect(fs.readFile).toHaveBeenCalledWith('\\\\wsl$\\Ubuntu\\home\\alice\\prompt.txt', 'utf8');
});

it('preserves config-relative plugin meaning for both legacy and v2 rows', () => {
  const config = { plugin: [['../legacy', { untouched: 'C:\\keep' }]], plugins: [
    { package: 'file:///C:/Plugins/my%20plugin', options: { file: 'C:\\keep' } },
    { package: './native' }, { package: 'file:///home/alice/existing' }, { package: '@scope/package' },
  ] };
  resolveOpencodePluginReferences(config, '\\\\wsl$\\Ubuntu\\home\\alice\\config', target);
  expect(config).toEqual({ plugin: [['file:///home/alice/legacy', { untouched: 'C:\\keep' }]], plugins: [
    { package: 'file:///mnt/c/Plugins/my%20plugin', options: { file: 'C:\\keep' } },
    { package: 'file:///home/alice/config/native' }, { package: 'file:///home/alice/existing' }, { package: '@scope/package' },
  ] });
});
