import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';

import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));

const context = {
  executionTarget: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' } as const,
  environment: { TMPDIR: '/tmp' },
};
const nativeOutput = (file: string) => `<output>[Truncated. Full output: ${file}]</output>`;
const recovered = JSON.stringify({ type: 'result', result: 'Recovered WSL answer' });
const interpret = (file: string) => new ClaudeTaskResultInterpreter(context)
  .interpretResult(nativeOutput(file), false, { mode: 'async' }).result;

async function distro() {
  const host = createWindowsHostFS({ fs, fsPromises });
  await host.write('\\\\wsl$\\Ubuntu\\tmp\\.keep', '');
  return host;
}

// WindowsHostFS models Windows paths on POSIX hosts; on Windows they are real host paths.
const onWindows = process.platform === 'win32';

it.skipIf(onWindows)('reads legacy Linux output files via the selected distro after checking the real temp root', async () => {
  const host = await distro();
  await host.write('\\\\wsl$\\Ubuntu\\tmp\\task.output', recovered);
  expect(interpret('/tmp/task.output')).toBe('Recovered WSL answer');
});

it.skipIf(onWindows).each(['/home/me/task.output', '/tmp/../home/me/task.output', '/tmp/task.json'])('rejects untrusted Linux output %s', async file => {
  const host = await distro();
  // Each rejected path exists and holds a readable result, so only the trust check can reject it.
  for (const hostPath of ['\\\\wsl$\\Ubuntu\\home\\me\\task.output', '\\\\wsl$\\Ubuntu\\tmp\\task.json']) await host.write(hostPath, recovered);
  expect(interpret(file)).not.toBe('Recovered WSL answer');
});

it.skipIf(onWindows)('rejects a temp-file symlink escaping to another distro', async () => {
  const host = await distro();
  await host.write('\\\\wsl$\\Debian\\tmp\\task.output', recovered);
  fs.symlinkSync(host.local('\\\\wsl$\\Debian\\tmp\\task.output'), host.local('\\\\wsl$\\Ubuntu\\tmp\\task.output'));
  expect(interpret('/tmp/task.output')).not.toBe('Recovered WSL answer');
});
