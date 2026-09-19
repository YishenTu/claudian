import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runProcessProbe } from '@/core/process/ProcessProbe';

describe('process probe subprocess integration', () => {
  it('closes stdin and collects stdout through process close without mixing in stderr', async () => {
    const output = await runProcessProbe({
      command: process.execPath,
      args: ['-e', `
        process.stdin.resume();
        process.stdin.on('end', () => {
          process.stderr.write('diagnostic only');
          process.stdout.write('probe ');
          setImmediate(() => process.stdout.write('1.2.3\\n'));
        });
      `],
      cwd: process.cwd(),
      env: process.env,
    });

    expect(output).toBe('probe 1.2.3\n');
  });

  it('discards partial stdout when the child exits unsuccessfully', async () => {
    await expect(runProcessProbe({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("probe 1.2.3"); process.exitCode = 1;'],
      cwd: process.cwd(),
      env: process.env,
    })).resolves.toBeNull();
  });

  it('returns null when the executable cannot be spawned', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claudian-process-probe-'));
    try {
      await expect(runProcessProbe({
        command: path.join(directory, 'missing-executable'),
        args: [],
        cwd: directory,
        env: process.env,
      })).resolves.toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
