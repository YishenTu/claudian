import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { readWSLExec } from '@test/helpers/WSLLaunch';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import spawn from 'cross-spawn';

import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';

function respond(stdout: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  setImmediate(() => {
    child.stdout.end(stdout);
    child.emit('exit', code, null);
    child.emit('close', code, null);
  });
  return child;
}

describe('target CLI installation', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(spawn).mockReset();
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
    vi.mocked(spawn)
      .mockImplementationOnce(() => respond('/home/me/.local/bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
    expect(await inspect()).toEqual({
      path: '/home/me/.local/bin/codex', version: '0.154.0', source: 'auto',
    });
    expect(readWSLExec({ args: [...vi.mocked(spawn).mock.calls.at(-1)![1]!] }).args.slice(3))
      .toEqual(['/home/me/.local/bin/codex', '--version']);
  });

  it('looks up relative commands in the vault with literal positional arguments', async () => {
    vi.mocked(spawn)
      .mockImplementationOnce(() => respond('./my bin/codex\n') as never)
      .mockImplementationOnce(() => respond('codex-cli 0.154.0\n') as never);
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
    vi.mocked(spawn)
      .mockImplementationOnce(() => respond('', 1) as never);
    expect(await inspect()).toEqual({ path: null, version: null, source: 'auto' });
  });
});
