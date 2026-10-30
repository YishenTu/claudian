import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { readWSLExec } from '@test/helpers/WSLLaunch';

import { runProcessProbe } from '@/core/process/ProcessProbe';
import { probeDeepSeekWSLInstallation } from '@/providers/deepseek/runtime/DeepSeekWSLInstallation';

vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn() }));

// Shared launch/probe code and the npm package remain real. Only the WSL OS boundary is emulated locally;
// the native Windows suite separately exercises Windows argument parsing and Linux Node.
describe.skipIf(process.platform === 'win32')('DeepSeek Linux npm entry discovery', () => {
  let root: string;
  let entry: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'deepseek Linux # ')));
    entry = join(root, 'package/lib/bin.js');
    await mkdir(join(root, 'package/lib'), { recursive: true });
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    await writeFile(entry, '#!/usr/bin/env node\nprocess.stdout.write("dsh 1.2.3\\n");\n');
    await chmod(entry, 0o700);
    await symlink(entry, join(root, 'bin/dsh'));
    await symlink(process.execPath, join(root, 'bin/node'));
    vi.mocked(runProcessProbe).mockImplementation(async spec => {
      const { command, args } = readWSLExec(spec);
      try { return (await promisify(execFile)(command, args, { cwd: root, env: spec.env })).stdout; }
      catch { return null; }
    });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const probe = () => probeDeepSeekWSLInstallation({
    target: { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' },
    hostCwd: 'C:\\Vault', env: { PATH: `${join(root, 'bin')}${delimiter}/usr/bin${delimiter}/bin`, HOME: root },
    command: 'dsh', configuredPath: '',
  });

  it('resolves the installed package entry and target Node without host shim discovery', async () => {
    const result = await probe();
    expect(result.entryPath).toBe(entry);
    expect(result.nodePath).toBe(join(root, 'bin/node'));
    expect(result.installation).toMatchObject({ path: join(root, 'bin/dsh'), version: '1.2.3' });
  });

  it('does not accept an unrelated executable as a Linux dsh package', async () => {
    await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: 'desktop-wrapper', bin: { dsh: 'lib/bin.js' } }));
    expect((await probe()).installation.path).toBeNull();
  });
});
