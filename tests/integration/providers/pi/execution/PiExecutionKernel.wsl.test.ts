import { ChildProcess, spawn as nativeSpawn } from 'node:child_process';
import * as syncFS from 'node:fs';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { readWSLExec } from '@test/helpers/WSLLaunch';

import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';

// WindowsHostFS serves the Windows temporary directory on POSIX hosts; wsl.exe is the process boundary.
vi.mock('node:fs', async () => ({ ...(await vi.importActual<typeof import('node:fs')>('node:fs')) }));
vi.mock('node:fs/promises', async () => ({ ...(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')) }));
vi.mock('node:child_process', async () => ({
  ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
  spawn: vi.fn(),
}));

// Windows hosts have a real Windows temporary directory, so the modeled one only runs elsewhere.
it.skipIf(process.platform === 'win32')('loads its generated extensions from their Linux paths in a WSL launch', async () => {
  const files = createWindowsHostFS({ fs: syncFS, fsPromises: fs });
  await fs.mkdir(String.raw`C:\Temp`, { recursive: true });
  // POSIX os.tmpdir() follows TMPDIR, so the extensions land on the modeled Windows drive.
  vi.stubEnv('TMPDIR', String.raw`C:\Temp`);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242,
  });
  vi.mocked(nativeSpawn).mockReturnValue(child);
  const kernel = new PiRPCSessionKernel({
    args: ['--mode', 'rpc'], command: 'pi', cwd: String.raw`C:\Vault`, env: {},
    enableSessionTools: true, enableTreeBridge: true, processKey: 'wsl-extensions', sessionTarget: null,
    executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
  }, { onClose: vi.fn(), onEvent: vi.fn(), onExtensionChunk: vi.fn(), onExtensionRequest: () => false }, null);
  kernel.start();

  const [directory] = syncFS.readdirSync(String.raw`C:\Temp`);
  expect(directory).toMatch(/^claudian-pi-extensions-/u);
  const args = readWSLExec({ args: vi.mocked(nativeSpawn).mock.calls.at(-1)![1] as string[] }).args;
  const extensions = args.filter((_arg, index) => args[index - 1] === '--extension');
  expect(extensions).toEqual([`/mnt/c/Temp/${directory}/tree.ts`, `/mnt/c/Temp/${directory}/session-tools.ts`]);
  for (const name of ['tree', 'session-tools']) {
    expect(await files.read(`C:\\Temp\\${directory}\\${name}.ts`)).not.toBe('');
  }
  child.emit('exit', 0, null);
  await kernel.shutdown();
  expect(syncFS.readdirSync(String.raw`C:\Temp`)).toEqual([]);
});
