#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function findOpenHandleLeakMarkers(output) {
  const markers = [];
  if (/worker process has failed to exit gracefully/iu.test(output)) {
    markers.push('worker-force-exit');
  }
  if (/Jest has detected the following \d+ open handle/iu.test(output)) {
    markers.push('open-handles-detected');
  }
  if (/Jest did not exit .* after the test run has completed/iu.test(output)) {
    markers.push('jest-did-not-exit');
  }
  return markers;
}

export function buildOpenHandleJestArguments(jestPath) {
  return [
    jestPath,
    '--runInBand',
    '--detectOpenHandles',
    '--openHandlesTimeout=2000',
  ];
}

function run() {
  const jestPath = require.resolve('jest/bin/jest');
  const result = spawnSync(process.execPath, buildOpenHandleJestArguments(jestPath), {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    maxBuffer: 128 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const markers = findOpenHandleLeakMarkers(`${stdout}\n${stderr}`);
  if (markers.length > 0) {
    throw new Error(`Jest lifecycle leak detected: ${markers.join(', ')}`);
  }
  console.log('Jest open-handle check: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
