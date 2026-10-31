import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { build } from 'esbuild';
import { onTestFinished } from 'vitest';

import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';

/** Bundle the provider's existing native peer for the real Linux Node installed by CI. */
export async function provisionWSLPeer(provider: 'codex' | 'grok', location: 'drive' | 'distro', entry: string) {
  const target = await resolveExecutionTargetAsync({ settings: { installationMethod: 'wsl', wslDistroOverride: '' } });
  if (!target.distroName) throw new Error('Native WSL fixture requires a resolved distro');
  const prefix = location === 'drive' ? tmpdir() : `\\\\wsl$\\${target.distroName}\\tmp`;
  const root = await mkdtemp(path.win32.join(prefix, `claudian ${provider} WSL # 中文 `));
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Independent oracle: the fixture knows where it created the directory; no production mapper.
  const targetRoot = location === 'drive'
    ? `/mnt/${root[0].toLowerCase()}${root.slice(2).replace(/\\/g, '/')}`
    : `/tmp/${path.win32.basename(root)}`;
  const vault = path.win32.join(root, 'vault');
  const home = path.win32.join(root, 'native home');
  await Promise.all([mkdir(vault), mkdir(home)]);
  const cli = `${targetRoot}/peer.cjs`;
  await build({ entryPoints: [entry], outfile: path.win32.join(root, 'peer.cjs'), bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', banner: { js: '#!/usr/bin/env node' } });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const spec = buildTargetLaunchSpec({ target, hostCwd: root, command: '/bin/chmod', args: ['+x', cli], env });
  if (await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 20_000) !== '') throw new Error('Cannot make Linux peer executable');
  return { target, root, targetRoot, vault, home, cli, targetVault: `${targetRoot}/vault`, targetHome: `${targetRoot}/native home` };
}
