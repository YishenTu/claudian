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
        assertionResults: [
          { fullName: 'recovery skipped', status: 'pending', duration: null },
          { fullName: 'recovery immediate', status: 'passed', duration: 0 },
          { fullName: 'recovery <target> | restart', status: 'failed', duration: 30001,
            failureMessages: ['private assertion payload'] },
        ],
      }, {
        name: path.join(root, 'tests/integration/load-error.test.ts'),
        assertionResults: [], message: 'private module-load failure',
      }],
    }));
    const result = spawnSync(process.execPath, [script, input, output], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'timings.json'), 'utf8')), {
      passed: 1, failed: 1, skipped: 1, failedSuites: 2,
      tests: [
        { file: 'tests/integration/recovery.test.ts', name: 'recovery <target> | restart', status: 'failed', durationMs: 30001 },
        { file: 'tests/integration/recovery.test.ts', name: 'recovery immediate', status: 'passed', durationMs: 0 },
        { file: 'tests/integration/recovery.test.ts', name: 'recovery skipped', status: 'pending', durationMs: null },
      ],
    });
    const markdown = await readFile(path.join(output, 'slowest-tests.md'), 'utf8');
    assert.match(markdown, /1 passed, 1 failed, 1 skipped/);
    assert.match(markdown, /Failed suites: 2/);
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
    assert.equal(markdown.split('\n').filter(line => /^\| \d/.test(line)).length, 20);
    assert.match(markdown, /\| 24 \| passed \|.*case 24/);
    assert.doesNotMatch(markdown, /case 4\s*\|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
