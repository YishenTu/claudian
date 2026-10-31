// @test-ci {"native":true}
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runProcessProbe } from '@/core/process/ProcessProbe';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

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

  describePosix('POSIX node candidate admission', () => {
    it('skips a non-executable node file ahead of a runnable Node when probing a JS CLI', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'claudian-node-admission-'));
      try {
        const badDir = path.join(root, 'bad');
        const goodDir = path.join(root, 'good');
        const cliDir = path.join(root, 'cli');
        mkdirSync(badDir);
        mkdirSync(goodDir);
        mkdirSync(cliDir);

        const badNode = path.join(badDir, 'node');
        writeFileSync(badNode, '#!/bin/sh\necho fixture 1.2.3\n');
        chmodSync(badNode, 0o644);
        symlinkSync(process.execPath, path.join(goodDir, 'node'));

        const cliPath = path.join(cliDir, 'fixture-cli.cjs');
        writeFileSync(cliPath, "process.stdout.write('fixture 1.2.3\\n');\n");

        const result = await probeCLIInstallation({
          path: cliPath,
          configuredPath: cliPath,
          args: ['--version'],
          env: { ...process.env, PATH: `${badDir}${path.delimiter}${goodDir}` },
        });

        expect(result).toEqual({ path: cliPath, source: 'custom', version: '1.2.3' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
