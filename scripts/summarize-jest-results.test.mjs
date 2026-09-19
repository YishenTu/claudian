import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./summarize-jest-results.mjs', import.meta.url));

test('reports every test, retains failed timings, and summarizes the slowest cases', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claudian-jest-report-'));
  try {
    const input = path.join(directory, 'jest.json');
    const output = path.join(directory, 'timings');
    const summary = path.join(directory, 'summary.md');
    await writeFile(input, JSON.stringify({
      numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numFailedTestSuites: 2,
      testResults: [{
        name: path.join(root, 'tests/integration/recovery.test.ts'),
        startTime: 1000, endTime: 32000, status: 'failed',
        assertionResults: [
          { fullName: 'recovery skipped', status: 'pending', duration: null },
          { fullName: 'recovery immediate', status: 'passed', duration: 0 },
          { fullName: 'recovery <target> | restart', status: 'failed', duration: 30001,
            failureMessages: ['private assertion payload'] },
        ],
      }, {
        name: path.join(root, 'tests/integration/load-error.test.ts'),
        startTime: 0, endTime: 0, status: 'failed',
        assertionResults: [], message: 'private module-load failure',
      }],
    }));
    const result = spawnSync(process.execPath, [script, input, output], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'timings.json'), 'utf8')), {
      passed: 1, failed: 1, skipped: 1, failedSuites: 2,
      suiteCount: 2,
      execution: null,
      suites: [
        { file: 'tests/integration/recovery.test.ts', status: 'failed', startTime: 1000, endTime: 32000, durationMs: 31000 },
        { file: 'tests/integration/load-error.test.ts', status: 'failed', startTime: null, endTime: null, durationMs: null },
      ],
      tests: [
        { file: 'tests/integration/recovery.test.ts', name: 'recovery <target> | restart', status: 'failed', durationMs: 30001 },
        { file: 'tests/integration/recovery.test.ts', name: 'recovery immediate', status: 'passed', durationMs: 0 },
        { file: 'tests/integration/recovery.test.ts', name: 'recovery skipped', status: 'pending', durationMs: null },
      ],
    });
    const markdown = await readFile(path.join(output, 'slowest-tests.md'), 'utf8');
    assert.match(markdown, /1 passed, 1 failed, 1 skipped/);
    assert.match(markdown, /Failed suites: 2/);
    assert.match(markdown, /31000 \| failed \| tests\/integration\/recovery/);
    assert.match(markdown, /30001 \| failed \|.*recovery &lt;target&gt; &#124; restart/);
    assert.doesNotMatch(markdown, /recovery skipped|private assertion payload/);
    assert.equal(await readFile(summary, 'utf8'), markdown);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounds the summary while retaining timings for all tests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claudian-jest-report-'));
  try {
    const input = path.join(directory, 'jest.json');
    const output = path.join(directory, 'timings');
    await writeFile(input, JSON.stringify({
      numPassedTests: 25, numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 0,
      testResults: [{
        name: path.join(root, 'tests/unit/example.test.ts'),
        assertionResults: Array.from({ length: 25 }, (_, index) => ({
          fullName: `case ${index}`, status: 'passed', duration: index,
        })),
      }],
    }));
    const result = spawnSync(process.execPath, [script, input, output], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(path.join(output, 'timings.json'), 'utf8'));
    assert.equal(report.tests.length, 25);
    const markdown = await readFile(path.join(output, 'slowest-tests.md'), 'utf8');
    assert.equal(markdown.split('Slowest 20 completed tests.')[1].split('\n').filter(line => /^\| \d/.test(line)).length, 20);
    assert.match(markdown, /\| 24 \| passed \|.*case 24/);
    assert.doesNotMatch(markdown, /case 4\s*\|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real Jest execution records resolved workers and environment alongside suite timings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claudian-jest-metadata-'));
  try {
    const input = path.join(directory, 'jest.json');
    const output = path.join(directory, 'timings');
    await writeFile(path.join(directory, 'example.test.js'), "test('example', () => expect(2 + 3).toBe(5));");
    const config = {
      rootDir: directory,
      testMatch: ['<rootDir>/*.test.js'],
      reporters: [path.join(root, 'scripts/jestTimingReporter.cjs')],
    };
    const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [
      path.join(root, 'scripts/run-jest.js'), '--config', JSON.stringify(config),
      '--runInBand', '--json', '--outputFile', input,
    ], { cwd: root, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    const summary = spawnSync(process.execPath, [script, input, output], { cwd: root, encoding: 'utf8', env });
    assert.equal(summary.status, 0, summary.stderr);
    const report = JSON.parse(await readFile(path.join(output, 'timings.json'), 'utf8'));
    assert.equal(report.execution.maxWorkers, 1);
    assert.equal(report.execution.nodeVersion, process.version);
    assert.equal(report.execution.platform, process.platform);
    assert.equal(report.execution.arch, process.arch);
    assert.equal(report.suiteCount, 1);
    assert.ok(report.suites[0].durationMs > 0);
    assert.equal(report.tests[0].name, 'example');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('real skipped and load-error suites have no measured execution duration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claudian-jest-unexecuted-'));
  try {
    const input = path.join(directory, 'jest.json');
    const output = path.join(directory, 'timings');
    await writeFile(path.join(directory, 'skipped.test.js'), "test.skip('skipped', () => {});");
    await writeFile(path.join(directory, 'load-error.test.js'), "throw new Error('fixture load error');");
    const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [
      path.join(root, 'scripts/run-jest.js'), '--config', JSON.stringify({ rootDir: directory }),
      '--runInBand', '--json', '--outputFile', input,
    ], { cwd: root, encoding: 'utf8', env });
    assert.equal(run.status, 1, run.stderr);
    const summary = spawnSync(process.execPath, [script, input, output], { cwd: root, encoding: 'utf8', env });
    assert.equal(summary.status, 0, summary.stderr);
    const report = JSON.parse(await readFile(path.join(output, 'timings.json'), 'utf8'));
    assert.equal(report.failedSuites, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.suiteCount, 2);
    for (const suite of report.suites) {
      assert.equal(suite.durationMs, null);
      assert.equal(suite.startTime, null);
      assert.equal(suite.endTime, null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
