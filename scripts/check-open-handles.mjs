#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function findOpenHandleLeakMarkers(output) {
  const markers = [];
  // Unresolved promises alone do not keep Node alive; retain the open-handle
  // contract rather than treating deliberately pending fixture promises as leaks.
  const resources = [...output.matchAll(/^\s*(\w+) leaking in /gm)].map(match => match[1]);
  if (resources.some(type => type !== 'PROMISE')) markers.push('open-handles-detected');
  if (/close timed out after|Failed to terminate worker|Timeout terminating/iu.test(output)) markers.push('worker-did-not-exit');
  return markers;
}

export function buildOpenHandleVitestArguments(vitestPath) {
  return [
    vitestPath, 'run',
    '--config', path.join(root, 'scripts/vitest-open-handles.config.mts'),
    '--maxWorkers=1', '--detectAsyncLeaks',
    '--teardownTimeout=2000', '--reporter=default', '--reporter=hanging-process', '--no-color',
  ];
}

function run() {
  const vitestPath = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const result = spawnSync(process.execPath, buildOpenHandleVitestArguments(vitestPath), {
    cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
    maxBuffer: 128 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const markers = findOpenHandleLeakMarkers(`${stdout}\n${stderr}`);
  if (markers.length) throw new Error(`Vitest lifecycle leak detected: ${markers.join(', ')}`);
  console.log('Vitest open-handle check: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
