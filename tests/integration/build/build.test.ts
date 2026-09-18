import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('build script', () => {
  it('leaves prefix-only Node modules to the runtime when the build host omits them from builtinModules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-node-builtins-'));
    try {
      await mkdir(path.join(root, 'src'));
      await Promise.all(['package.json', 'package-lock.json', 'bun.lock'].map(file => (
        copyFile(path.resolve(file), path.join(root, file))
      )));
      await writeFile(path.join(root, 'src/main.ts'), `
        export function loadSqlite() { return require('node:sqlite'); }
      `);
      // Node 22's builtinModules omits modules that require the node: prefix.
      const preload = `
        import module from 'node:module';
        module.builtinModules = module.builtinModules.filter(name => !name.startsWith('node:'));
        module.syncBuiltinESMExports();
      `;
      execFileSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        path.resolve('esbuild.config.mjs'), 'production',
      ], {
        cwd: root,
        env: { ...process.env, OBSIDIAN_VAULT: '' },
        stdio: 'pipe',
      });

      const pluginModule = { exports: {} as { loadSqlite(): unknown } };
      const sqlite = { DatabaseSync: class {} };
      Function('require', 'module', 'exports', await readFile(path.join(root, 'main.js'), 'utf8'))(
        (name: string) => {
          if (name === 'node:sqlite') return sqlite;
          throw new Error(`Unexpected runtime dependency: ${name}`);
        }, pluginModule, pluginModule.exports,
      );
      expect(pluginModule.exports.loadSqlite()).toBe(sqlite);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

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
