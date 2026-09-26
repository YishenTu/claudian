import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { selectCiTests, selectRelatedCiTests } from './ciTestSelection.mjs';

const prompt = 'tests/unit/core/prompt/mainAgent.systemPrompt.test.ts';
const panel = 'tests/unit/features/chat/ClaudianView.test.ts';
const native = 'tests/integration/core/process/ManagedStdioProcess.test.ts';
const docs = 'tests/unit/docs/Documentation.test.ts';
const select = (paths, relatedTests = [], eventName = 'pull_request') => selectCiTests({
  changes: paths.map(path => typeof path === 'string' ? { status: 'M', path } : path),
  relatedTests, eventName,
});

test('ordinary PRs and pushes select affected consumers', () => {
  for (const event of ['pull_request', 'push']) {
    const result = select(['src/core/prompt/mainAgent.ts'], [prompt], event);
    assert.deepEqual(result.testFiles, [prompt]);
    assert.deepEqual(result.crossPlatformTests, []);
  }
});

test('presentation changes do not trigger native checks through main composition', () => {
  const result = select(['src/features/chat/ClaudianView.ts'], [panel, 'tests/integration/main.test.ts']);
  assert.deepEqual(result.testFiles, [panel, 'tests/integration/main.test.ts']);
  assert.deepEqual(result.crossPlatformTests, []);
});

test('shared dependencies retain affected native consumers', () => {
  const result = select(['src/utils/env.ts'], [prompt, native]);
  assert.deepEqual(result.testFiles, [prompt, native]);
  assert.deepEqual(result.crossPlatformTests, [native]);
});

test('real subprocess consumers run on native platforms when affected', () => {
  for (const consumer of [
    'tests/integration/core/process/ProcessProbe.test.ts',
    'tests/integration/core/process/ManagedStdioProcess.test.ts',
  ]) {
    const result = select(['src/utils/path.ts'], [consumer]);
    assert.deepEqual(result.crossPlatformTests, [consumer]);
    assert.equal(result.crossPlatform, true);
    assert.deepEqual(select([consumer]).crossPlatformTests, [consumer]);
  }
});

test('mocked process policies remain in the ordinary suite without native jobs', () => {
  const unitTests = [
    'tests/unit/utils/windowsCmdShim.test.ts',
    'tests/unit/core/process/ManagedStdioProcess.test.ts',
  ];
  const result = select(unitTests);
  assert.deepEqual(result.testFiles, unitTests);
  assert.deepEqual(result.crossPlatformTests, []);
  assert.equal(result.crossPlatform, false);
});

test('real dependency discovery retains native launch checks for shared process changes', () => {
  const result = selectRelatedCiTests({
    changes: [{ status: 'M', path: 'src/utils/windowsCmdShim.ts' }],
  });
  assert.deepEqual(result.crossPlatformTests.sort(), [
    'tests/integration/core/process/ManagedStdioProcess.test.ts',
    'tests/integration/core/process/ProcessProbe.test.ts',
  ]);
  assert.equal(result.piWindows, true);
  assert.ok(result.testFiles.includes('tests/unit/utils/windowsCmdShim.test.ts'));
  assert.ok(result.testFiles.includes('tests/unit/core/process/ManagedStdioProcess.test.ts'));
});

test('native selection uses only nonempty shards and retains a Pi-only job', () => {
  const probe = 'tests/integration/core/process/ProcessProbe.test.ts';
  const managed = 'tests/integration/core/process/ManagedStdioProcess.test.ts';
  assert.deepEqual(select([probe]).crossPlatformShards, ['1/1']);
  assert.deepEqual(select([probe, managed]).crossPlatformShards, ['1/2', '2/2']);
  assert.deepEqual(select(['tests/integration/providers/pi/runtime/PiSubprocess.windows.test.ts']).crossPlatformShards, ['1/1']);
  assert.deepEqual(select(['package-lock.json']).crossPlatformShards, ['1/2', '2/2']);
});

test('changed tests run directly, while removed tests are omitted', () => {
  const result = select([{ status: 'D', path: panel }, prompt], [panel]);
  assert.deepEqual(result.testFiles, [prompt]);
  assert.deepEqual(result.crossPlatformTests, []);
});

test('shared test helpers use their graph consumers', () => {
  assert.deepEqual(select(['tests/helpers/testClock.ts'], [native]).testFiles, [native]);
});

test('filesystem-read documentation, styles, and captured fixtures retain their consumers', () => {
  assert.deepEqual(select(['README.md']).testFiles, [docs]);
  assert.deepEqual(select(['src/features/chat/AGENTS.md']).testFiles, [docs]);
  assert.ok(select(['src/style/components/code.css']).testFiles.includes('tests/unit/style/components/code.test.ts'));
  const fixture = select(['tests/fixtures/providers/grok/history/example.json']);
  assert.ok(fixture.testFiles.includes('tests/unit/providers/grok/history/GrokHistoryStore.test.ts'));
});

test('native Pi launch runs only when affected', () => {
  const pi = 'tests/integration/providers/pi/runtime/PiSubprocess.windows.test.ts';
  assert.equal(select(['src/providers/pi/runtime/PiSubprocess.ts'], [pi]).piWindows, true);
  assert.equal(select(['src/features/chat/ClaudianView.ts'], [panel]).piWindows, false);
});

test('script edits select their script tests without unrelated Jest work', () => {
  const result = select(['scripts/summarize-jest-results.mjs']);
  assert.deepEqual(result.testFiles, []);
  assert.deepEqual(result.scriptTests, ['scripts/summarize-jest-results.test.mjs']);
  assert.equal(result.crossPlatform, false);
});

test('native script regressions retain a Windows job without selecting unrelated Jest suites', () => {
  for (const script of ['scripts/ciTestSelection.test.mjs', 'scripts/run-tests.test.mjs']) {
    const result = select([script]);
    assert.deepEqual(result.scriptTests, [script]);
    assert.deepEqual(result.testFiles, []);
    assert.deepEqual(result.crossPlatformTests, []);
    assert.deepEqual(result.crossPlatformShards, ['1/1']);
    assert.equal(result.crossPlatform, true);
  }
});

test('unsafe deletions and global or unknown changes retain full verification', () => {
  for (const change of [
    { status: 'D', path: 'src/core/prompt/mainAgent.ts' },
    { status: 'D', path: 'tests/helpers/testClock.ts' },
    ...['package-lock.json', 'jest.config.js', 'tests/setupWindow.ts',
      'scripts/ciTestSelection.mjs', '.github/workflows/ci.yml', 'unknown-config'].map(path => ({ status: 'M', path })),
  ]) {
    const result = select([change]);
    assert.equal(result.testFiles, null);
    assert.equal(result.crossPlatformTests, null);
    assert.equal(result.scriptTests, null);
    assert.equal(result.piWindows, true);
  }
});

test('scheduled and reusable verification retain full coverage', () => {
  for (const event of ['workflow_call', 'schedule', 'workflow_dispatch']) {
    assert.equal(select([], [], event).testFiles, null);
  }
});

test('real dependency graph preserves prompt and provider coverage without Collab suites', () => {
  const relatedTests = JSON.parse(execFileSync(process.execPath, [
    'scripts/run-jest.js', '--listTests', '--json', '--findRelatedTests', 'src/core/prompt/mainAgent.ts',
  ], { encoding: 'utf8' })).map(file => file.split(path.sep).join('/'));
  assert.ok(relatedTests.some(file => file.endsWith('/core/prompt/mainAgent.systemPrompt.test.ts')));
  assert.ok(relatedTests.some(file => file.includes('/providers/')));
  assert.equal(relatedTests.some(file => /collab/i.test(file)), false);
});

test('the CI entry point handles real Git ranges, renames, missing bases and release tags', async () => {
  const { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'claudian-ci-scope-'));
  try {
    for (const directory of ['scripts', 'src', 'tests/unit']) mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ['ciTestSelection.mjs', 'testSuites.cjs']) copyFileSync(`scripts/${file}`, path.join(root, 'scripts', file));
    writeFileSync(path.join(root, 'scripts/run-jest.js'), `require(${JSON.stringify(path.resolve('scripts/run-jest.js'))});`);
    writeFileSync(path.join(root, 'jest.config.js'), `module.exports = { testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] };`);
    writeFileSync(path.join(root, 'src/value.ts'), 'export const value = 1;');
    writeFileSync(path.join(root, 'tests/unit/value.test.ts'), "import { value } from '../../src/value'; test('value', () => expect(value).toBe(1));");
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Initial fixture');
    const base = git('rev-parse', 'HEAD');
    const scope = (head, overrides = {}) => {
      const output = execFileSync(process.execPath, ['scripts/ciTestSelection.mjs'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
          BASE_SHA: base, HEAD_SHA: head, ...overrides },
      });
      return Object.fromEntries(output.trim().split('\n').map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
      }));
    };
    writeFileSync(path.join(root, 'src/value.ts'), 'export const value = 2;');
    git('add', '.'); git('commit', '-m', 'Edit source');
    const edited = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(edited)['test-files'], ['tests/unit/value.test.ts']);
    assert.deepEqual(scope(edited)['test-shards'], ['1/1']);
    assert.deepEqual(scope(edited, { GITHUB_EVENT_NAME: 'pull_request' })['test-files'], ['tests/unit/value.test.ts']);
    renameSync(path.join(root, 'tests/unit/value.test.ts'), path.join(root, 'tests/unit/renamed.test.ts'));
    git('add', '.'); git('commit', '-m', 'Rename test');
    const renamed = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(renamed, { BASE_SHA: edited })['test-files'], ['tests/unit/renamed.test.ts']);
    rmSync(path.join(root, 'tests/unit/renamed.test.ts'));
    git('add', '.'); git('commit', '-m', 'Delete test');
    const deleted = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(deleted, { BASE_SHA: renamed })['test-files'], []);
    assert.deepEqual(scope(deleted, { BASE_SHA: renamed })['test-shards'], ['1/1']);
    for (const overrides of [
      { BASE_SHA: 'f'.repeat(40) }, { BASE_SHA: '0'.repeat(40) }, { BASE_SHA: '' },
      { GITHUB_REF: 'refs/tags/2.3.0' },
    ]) {
      const full = scope(deleted, overrides);
      assert.equal(full['test-files'], null);
      assert.deepEqual(full['test-shards'], ['1/2', '2/2']);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale changes retain the dependency envelope', () => {
  assert.ok(select(['src/i18n/locales/en.json']).testFiles.includes('tests/integration/build/dependency-envelope.test.ts'));
});

test('local selection includes committed, staged, unstaged and untracked edits with safe fallbacks', async () => {
  const { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'claudian-local-scope-'));
  try {
    for (const directory of ['scripts', 'src', 'tests/unit']) mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ['ciTestSelection.mjs', 'testSuites.cjs', 'run-affected-tests.mjs']) copyFileSync(`scripts/${file}`, path.join(root, 'scripts', file));
    writeFileSync(path.join(root, 'scripts/run-jest.js'), `require(${JSON.stringify(path.resolve('scripts/run-jest.js'))});`);
    writeFileSync(path.join(root, 'jest.config.js'), `module.exports = { testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] };`);
    for (const name of ['committed', 'staged', 'unstaged', 'deleted']) {
      writeFileSync(path.join(root, `tests/unit/${name}.test.ts`), "test('example', () => {});");
    }
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    git('config', 'commit.gpgsign', 'false'); git('add', '.'); git('commit', '-m', 'Baseline');
    const base = git('rev-parse', 'HEAD');
    const scope = (...args) => JSON.parse(execFileSync(process.execPath, [
      'scripts/run-affected-tests.mjs', '--base', base, '--list', ...args,
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(scope().testFiles, []);
    writeFileSync(path.join(root, 'tests/unit/committed.test.ts'), "test('committed edit', () => {});");
    git('add', '.'); git('commit', '-m', 'Committed edit');
    renameSync(path.join(root, 'tests/unit/staged.test.ts'), path.join(root, 'tests/unit/renamed.test.ts'));
    git('add', '.');
    writeFileSync(path.join(root, 'tests/unit/unstaged.test.ts'), "test('unstaged edit', () => {});");
    writeFileSync(path.join(root, 'tests/unit/new test.test.ts'), "test('new', () => {});");
    rmSync(path.join(root, 'tests/unit/deleted.test.ts'));
    assert.deepEqual(scope().testFiles.sort(), [
      'tests/unit/committed.test.ts', 'tests/unit/new test.test.ts',
      'tests/unit/renamed.test.ts', 'tests/unit/unstaged.test.ts',
    ]);
    assert.deepEqual(scope().scriptTests, ['scripts/check-architecture-boundaries.test.mjs']);
    assert.equal(scope('--full').testFiles, null);
    assert.equal(scope('--base', 'missing-base').testFiles, null);
    writeFileSync(path.join(root, 'unknown-config'), 'new');
    assert.equal(scope().testFiles, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
