import { readWSLExec } from '@test/helpers/WSLLaunch';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import spawn from 'cross-spawn';

import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';

describe('target CLI installation', () => {
  const platform = process.platform;
  let native: WSLProcessFixture;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    native = new WSLProcessFixture();
    vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  function inspect(command = 'codex') {
    return probeTargetCLIInstallation({
      target: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
      hostCwd: 'C:\\vault', env: {}, command, args: ['--version'],
      configuredPath: command === 'codex' ? '' : command,
    });
  }

  it('resolves the real WSL binary before reading its version', async () => {
    native.binaries.set('codex', { path: '/home/me/.local/bin/codex', version: 'codex-cli 0.154.0' });
    expect(await inspect()).toEqual({
      path: '/home/me/.local/bin/codex', version: '0.154.0', source: 'auto',
    });
    expect(readWSLExec({ args: [...vi.mocked(spawn).mock.calls.at(-1)![1]!] }).args.slice(3))
      .toEqual(['/home/me/.local/bin/codex', '--version']);
  });

  it('looks up relative commands in the vault with literal positional arguments', async () => {
    native.binaries.set('./my bin/codex', { path: '/mnt/c/vault/my bin/codex', version: 'codex-cli 0.154.0' });
    native.reply = request => request.executable === '/bin/sh' ? { stdout: './my bin/codex\n' } : undefined;
    expect(await inspect('./my bin/codex')).toEqual({
      path: '/mnt/c/vault/my bin/codex', version: '0.154.0', source: 'custom',
    });
    const lookup = vi.mocked(spawn).mock.calls[0];
    expect(lookup[0]).toMatch(/(?:^|\\)wsl\.exe$/u);
    expect(lookup[2]).toMatchObject({ windowsVerbatimArguments: true, cwd: 'C:\\vault' });
    expect(readWSLExec({ args: [...lookup[1]!] }).args.slice(3)).toEqual([
      '/bin/sh', '-c', expect.stringContaining('command -v -- "$candidate"'),
      'claudian-cli-probe', './my bin/codex',
    ]);
  });

  it('does not treat the WSL resolver command fallback as a detected binary', async () => {
    expect(await inspect()).toEqual({ path: null, version: null, source: 'auto' });
  });
});
