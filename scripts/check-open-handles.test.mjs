import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenHandleJestArguments,
  findOpenHandleLeakMarkers,
} from './check-open-handles.mjs';

test('does not enable Node file-backed localStorage for lifecycle diagnostics', () => {
  const args = buildOpenHandleJestArguments('/repo/node_modules/jest/bin/jest.js');

  assert.equal(args.some((arg) => arg.startsWith('--localstorage-file=')), false);
  assert.deepEqual(args.slice(1), [
    '--runInBand',
    '--detectOpenHandles',
    '--openHandlesTimeout=2000',
  ]);
});

test('recognizes Jest worker and open-handle leak diagnostics', () => {
  assert.deepEqual(findOpenHandleLeakMarkers(`
A worker process has failed to exit gracefully and has been force exited.
Jest has detected the following 1 open handle potentially keeping Jest from exiting:
  `), [
    'worker-force-exit',
    'open-handles-detected',
  ]);
});

test('does not classify ordinary passing output as a lifecycle leak', () => {
  assert.deepEqual(findOpenHandleLeakMarkers(`
Test Suites: 549 passed, 549 total
Tests:       8107 passed, 8107 total
  `), []);
});
