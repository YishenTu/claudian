import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = '8b9d499ba92b0e4d0044782ef9c14a565b034cb7';
const scratch = path.join(root, '.context');
await mkdir(scratch, { recursive: true });
const workspace = await mkdtemp(path.join(scratch, 'lan-compatibility-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, maxBuffer: 64 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`LAN compatibility setup failed: ${path.basename(command)}`);
  }
  return result.stdout;
}

try {
  if (spawnSync('git', ['cat-file', '-e', `${baseline}^{commit}`], { cwd: root }).status !== 0) {
    run('git', ['fetch', '--no-tags', 'origin', baseline]);
  }
  const legacy = path.join(workspace, 'legacy');
  await mkdir(legacy);
  const archive = path.join(workspace, 'source.tar');
  await writeFile(archive, run('git', [
    'archive', baseline, 'src', 'tsconfig.json', 'tests/helpers/installations.ts',
  ]));
  run('tar', ['-xf', archive, '-C', legacy]);

  const lock = JSON.parse(run('git', ['show', `${baseline}:package-lock.json`]).toString());
  const protocol = lock.packages['node_modules/@claudian-collab/protocol'];
  const response = await fetch(protocol.resolved, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Could not download the published LAN protocol artifact');
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== protocol.integrity) throw new Error('Published LAN protocol artifact integrity mismatch');
  const tarball = path.join(workspace, 'protocol.tgz');
  await writeFile(tarball, bytes);
  const dependency = path.join(workspace, 'protocol');
  await mkdir(dependency);
  run('tar', ['-xf', tarball, '-C', dependency]);

  await writeFile(path.join(legacy, 'entry.ts'), `
export { ClaudianCollabService } from './src/app/collab/ClaudianCollabService';
export { createCollabFeatureSubcomposition } from './src/app/collab/CollabFeatureSubcomposition';
export { CollabProjectSetupService } from './src/app/collab/project/CollabProjectSetupService';
export { SqlJsProjectDatabase } from './src/app/collab/authority/SqlJsProjectDatabase';
export { ProjectEventClient } from './src/app/collab/client/ProjectEventClient';
export { InvitationCodec } from './src/app/collab/lan/InvitationCodec';
export { decodeRetirementRecord } from './src/app/collab/retirement/RetirementRecord';
`);
  const bundle = path.join(workspace, 'baseline.cjs');
  await build({
    absWorkingDir: legacy, entryPoints: ['entry.ts'], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    supported: { 'dynamic-import': false },
    plugins: [{ name: 'published-lan-source', setup(builder) {
      builder.onResolve({ filter: /^@\// }, ({ path: name }) => {
        const base = path.join(legacy, 'src', name.slice(2));
        for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
          if (existsSync(candidate)) return { path: candidate };
        }
        throw new Error(`Missing published LAN module: ${name}`);
      });
      builder.onResolve({ filter: /^@claudian-collab\/protocol$/ }, () => ({
        path: path.join(dependency, 'package', 'dist', 'index.js'), external: true,
      }));
    } }],
  });
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'run-jest.js'),
    '--config', path.join(root, 'jest.lan-compatibility.config.cjs'), '--runInBand',
    ...process.argv.slice(2),
  ], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, CLAUDIAN_LAN_BASELINE_MODULE: bundle },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
