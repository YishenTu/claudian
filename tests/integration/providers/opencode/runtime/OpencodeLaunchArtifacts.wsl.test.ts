import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { parseOpencodeConfig, prepareOpencodeLaunchArtifacts, resolveOpencodePluginReferences } from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
let native: WSLProcessFixture;
let host: ReturnType<typeof createWindowsHostFS>;
beforeEach(() => {
  native = new WSLProcessFixture();
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
});

// Windows-shaped paths are real on a Windows host; the fake refuses to shadow them there.
describe.skipIf(path.sep === '\\')('WSL launch artifacts', () => {
  beforeEach(() => { host = createWindowsHostFS({ fs, fsPromises }); });

  it('writes database directories on the host and embeds Linux plugin URLs without rewriting user strings', async () => {
    await host.write(host.fromLinux('/home/alice/instructions.txt'), 'User file instructions');
    await host.write('C:\\Vault\\.claudian\\opencode\\prompts\\old.md', 'retired');
    const result = await prepareOpencodeLaunchArtifacts({
      target, workspaceRoot: 'C:\\Vault', sessionToolsPluginPath: 'C:\\Temp\\private #1\\session-tools',
      runtimeEnv: { HOME: '/home/alice', OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugins: [{ package: './user-plugin', options: { literal: 'C:\\keep' } }],
        agent: { build: { prompt: '{file:~/instructions.txt}' } }, userText: 'C:\\keep',
      }) },
    });
    expect(result.databasePath).toBe('\\\\wsl$\\Ubuntu\\home\\alice\\.local\\share\\opencode\\opencode.db');
    expect(fs.statSync(host.fromLinux('/home/alice/.local/share/opencode')).isDirectory()).toBe(true);
    // Retired per-profile prompt files are removed from the vault's managed storage.
    expect(fs.existsSync('C:\\Vault\\.claudian\\opencode\\prompts')).toBe(false);
    const config = JSON.parse(result.configContent);
    expect(config.userText).toBe('C:\\keep');
    expect(config.agent.build.prompt).toBe('User file instructions');
    expect(config.plugins).toEqual([
      { package: 'file:///mnt/c/Vault/user-plugin', options: { literal: 'C:\\keep' } },
      { package: 'file:///mnt/c/Temp/private%20%231/session-tools' },
    ]);
    // No `{env:}` reference, so no Linux environment probe.
    expect(native.requests).toEqual([]);
  });

  it('resolves config environment substitutions inside Linux and reads absolute file substitutions through the host', async () => {
    native.environment = { LINUX_API_KEY: 'linux-key' };
    await host.write(host.fromLinux('/home/alice/prompt.txt'), 'Target instructions');
    const result = await parseOpencodeConfig('{"key":"{env:LINUX_API_KEY}","prompt":"{file:/home/alice/prompt.txt}"}', 'explicit.json', { HOME: '/home/alice', LINUX_API_KEY: 'windows-key' }, 'C:\\Vault', target);
    expect(result).toEqual({ key: 'linux-key', prompt: 'Target instructions' });
    expect(native.requests.map(request => [request.executable, request.argv.slice(1)])).toEqual([['/usr/bin/awk', ['LINUX_API_KEY']]]);
    expect(native.requests[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/Vault']));
  });

  it('fails config parsing when the Linux environment cannot be read', async () => {
    native.reply = () => ({ code: 1 });
    await expect(parseOpencodeConfig('{"key":"{env:LINUX_API_KEY}"}', 'explicit.json', { HOME: '/home/alice' }, 'C:\\Vault', target))
      .rejects.toThrow('Could not resolve the WSL environment for OpenCode config: explicit.json');
  });

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
