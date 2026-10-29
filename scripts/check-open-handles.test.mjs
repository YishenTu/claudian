import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildOpenHandleVitestArguments, findOpenHandleLeakMarkers } from './check-open-handles.mjs';

const require = createRequire(import.meta.url);
const vitestPath = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

test('lifecycle diagnostics preserve suite pools and run serially without file-backed localStorage', () => {
  const args = buildOpenHandleVitestArguments(vitestPath);
  assert.equal(args.some(arg => arg.startsWith('--localstorage-file=')), false);
  assert.equal(args.some(arg => arg.startsWith('--pool=')), false);
  for (const flag of ['--maxWorkers=1', '--detectAsyncLeaks', '--reporter=hanging-process']) assert.ok(args.includes(flag));
});

test('recognizes open resources and termination failures without rejecting pending promises', () => {
  assert.deepEqual(findOpenHandleLeakMarkers('Timeout leaking in fixture.test.ts\nclose timed out after 2000ms'), ['open-handles-detected', 'worker-did-not-exit']);
  assert.deepEqual(findOpenHandleLeakMarkers('PROMISE leaking in fixture.test.ts\nTest Files 1 passed'), []);
});

test('real Vitest detects native leaks after owned DOM timers and transient work settle', () => {
  // Vite resolves files canonically; Windows TEMP may contain an 8.3 alias.
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'claudian-vitest-leaks-')));
  try {
    const config = path.join(root, 'vitest.config.mjs');
    const runner = path.join(root, 'openHandleTestRunner.mjs');
    copyFileSync(path.resolve('scripts/openHandleTestRunner.mjs'), runner);
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(config, `export default ${JSON.stringify({ root, test: { globals: true, include: ['*.test.js'], runner: './openHandleTestRunner.mjs', pool: 'vmThreads', fsModuleCache: false } })};`);
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.NODE_TEST_CONTEXT;
    for (const [source, expected] of [
      ["import { setTimeout } from 'node:timers'; test('native leak', () => { setTimeout(() => {}, 60000); });", ['open-handles-detected']],
      ["test('cleaned timer', () => { const timer = setTimeout(() => {}, 60000); clearTimeout(timer); });", []],
      ["test('transient timer', () => { setTimeout(() => {}, 10); });", []],
      ["// @vitest-environment jsdom\ntest('environment-owned interval', () => { window.setInterval(() => {}, 1000); });", []],
      ["// @vitest-environment jsdom\nimport { setInterval } from 'node:timers'; test('native DOM leak', () => { setInterval(() => {}, 60000); });", ['open-handles-detected']],
    ]) {
      writeFileSync(path.join(root, 'timer.test.js'), source);
      const result = spawnSync(process.execPath, [vitestPath, 'run', '--config', config, '--maxWorkers=1', '--detectAsyncLeaks', '--no-color'], { cwd: root, encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(findOpenHandleLeakMarkers(`${result.stdout}\n${result.stderr}`), expected, `${source}\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
