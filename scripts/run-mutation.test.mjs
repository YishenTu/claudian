import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createMutationConfig,
  createMutationVitestConfig,
  parseMutationArgs,
  selectMutationTests,
  summarizeMutationReport,
} from './run-mutation.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'claudian-mutation-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    'src/providers/codex/history/CodexHistoryStore.ts',
    'src/features/chat/sessions/SessionRuntimePool.ts',
    'src/app/settings/SettingsCoordinator.ts',
    'src/shared/other.ts',
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), 'export {};\n');
  }
  return root;
}

test('mutation arguments resolve pilot scopes and arbitrary source files once', t => {
  const root = fixture(t);
  const result = parseMutationArgs([
    'history', 'sessions', 'settings', 'src/shared/other.ts',
    path.join(root, 'src/shared/other.ts'), '--incremental',
  ], root);
  assert.deepEqual(result.files, [
    'src/providers/codex/history/CodexHistoryStore.ts',
    'src/features/chat/sessions/SessionRuntimePool.ts',
    'src/app/settings/SettingsCoordinator.ts',
    'src/shared/other.ts',
  ]);
  assert.equal(result.incremental, true);
  assert.deepEqual(parseMutationArgs(['--help'], root), { help: true });
});

test('mutation argument errors fail before installing tools or running tests', t => {
  const root = fixture(t);
  for (const args of [[], ['unknown'], ['--mutants', '1'], ['--incremental'],
    ['src/missing.ts'], ['../outside.ts'], ['package.json'], ['src/**/*.ts']]) {
    assert.throws(() => parseMutationArgs(args, root), Error, args.join(' '));
  }
});

test('mutation selection combines imports and declared file consumers without cache tests', () => {
  const direct = 'tests/unit/settings.test.ts';
  const declared = 'tests/integration/settings.dom.test.ts';
  const result = selectMutationTests('src/app/settings/SettingsCoordinator.ts', [direct, direct], [
    ['src/app/settings/**', [declared]],
    ['src/providers/**', ['tests/unit/unrelated.test.ts']],
  ]);
  assert.deepEqual(result, [declared, direct]);
  assert.throws(() => selectMutationTests('src/uncovered.ts', [], []), /No related tests/);
  assert.throws(() => selectMutationTests('src/a.ts', ['.mutation/sandbox/tests/unit/a.test.ts'], []), /outside tests/);
});

test('mutation configuration keeps selection in Vitest and preserves sandbox resolution', () => {
  const selected = ['tests/unit/a.test.ts', 'tests/integration/b.test.ts'];
  const base = {
    resolve: { alias: [{ find: '@/', replacement: '/sandbox/src/' }] },
    test: {
      globals: true, setupFiles: ['tests/setupWindow.ts'],
      sequence: { hooks: 'list' }, include: [],
      projects: [{ test: { pool: 'vmThreads', include: ['tests/**/*.ts'] } }],
    },
  };
  const vitest = createMutationVitestConfig(base, selected, '/sandbox');
  assert.deepEqual(vitest.test.include, selected);
  assert.equal(vitest.root, '/sandbox');
  assert.equal(vitest.cacheDir, path.join('/sandbox', '.mutation/vite'));
  assert.equal(vitest.test.fsModuleCachePath, path.join('/sandbox', '.mutation/modules'));
  assert.equal(vitest.resolve, base.resolve);
  assert.equal(vitest.test.globals, true);
  assert.deepEqual(vitest.test.setupFiles, base.test.setupFiles);
  assert.equal(vitest.test.projects, undefined);
  assert.equal(vitest.test.pool, 'forks');
  assert.equal(vitest.test.sequence.setupFiles, 'list');
  assert.equal(base.test.projects[0].test.pool, 'vmThreads');

  const config = createMutationConfig({
    file: 'src/a.ts', vitestConfig: '/reports/vitest.mjs',
    plugin: '/tools/vitest-runner.js', reportDirectory: '/reports',
    sandboxDirectory: '/sandboxes/a', incrementalFile: '/cache/a.json', incremental: true,
  });
  // A truthy Stryker testFiles option activates even static faults in beforeAll.
  assert.equal(Object.hasOwn(config, 'testFiles'), false);
  assert.deepEqual(config.mutate, ['src/a.ts']);
  assert.equal(config.vitest.pool, 'forks');
  assert.equal(config.vitest.related, false);
  assert.equal(config.incremental, true);
  assert.ok(config.ignorePatterns.includes('.mutation'));
});

test('mutation summaries keep timeouts and runner errors separate from assertion kills', () => {
  const summary = summarizeMutationReport({ files: {
    'src/a.ts': { mutants: [
      { id: '1', status: 'Killed' }, { id: '2', status: 'Timeout' },
      { id: '3', status: 'NoCoverage' }, { id: '4', status: 'RuntimeError' },
      { id: '5', status: 'Survived', replacement: 'false', location: { start: { line: 4, column: 9 } } },
    ] },
  } });
  assert.deepEqual(summary.files, [{ file: 'src/a.ts', statuses: {
    Killed: 1, Timeout: 1, NoCoverage: 1, RuntimeError: 1, Survived: 1,
  } }]);
  assert.deepEqual(summary.survivors, [{ file: 'src/a.ts', id: '5', line: 4, column: 9, replacement: 'false' }]);
});

test('mutation help is available in CI without installing or starting Stryker', () => {
  const output = execFileSync(process.execPath, ['scripts/run-mutation.mjs', '--help'], {
    encoding: 'utf8', env: { ...process.env, CI: 'true' },
  });
  assert.match(output, /history/);
  assert.match(output, /--incremental/);
  assert.match(output, /\.mutation/);
});
