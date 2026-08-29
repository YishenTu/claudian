import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('build script', () => {
  it('forwards arguments without evaluating them as shell commands', async () => {
    if (process.platform === 'win32') return;

    const root = await mkdtemp(path.join(tmpdir(), 'claudian-build-script-'));
    try {
      const scriptsDirectory = path.join(root, 'scripts');
      const binaryDirectory = path.join(root, 'bin');
      await mkdir(scriptsDirectory, { recursive: true });
      await mkdir(binaryDirectory, { recursive: true });
      await copyFile(
        path.resolve('scripts/build.mjs'),
        path.join(scriptsDirectory, 'build.mjs'),
      );
      await writeFile(path.join(scriptsDirectory, 'build-css.mjs'), '');
      await writeFile(path.join(root, 'esbuild.config.mjs'), '');
      await writeFile(path.join(binaryDirectory, 'node'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });

      execFileSync(
        process.execPath,
        [path.join(scriptsDirectory, 'build.mjs'), '; touch injected-by-shell; #'],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
          },
          stdio: 'pipe',
        },
      );

      await expect(
        import('node:fs/promises').then(fs => fs.stat(path.join(root, 'injected-by-shell'))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
