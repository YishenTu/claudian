import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise the real runner in an isolated checkout with observable child programs.
test('the runner executes only selected Jest and script suites, and handles empty selections', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claudian-test-runner-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    for (const file of ['run-tests.js', 'run-cross-platform-tests.js', 'testSuites.cjs']) copyFileSync(`scripts/${file}`, path.join(root, 'scripts', file));
    writeFileSync(path.join(root, 'scripts/run-jest.js'), `require('node:fs').writeFileSync('jest-args.json', JSON.stringify(process.argv.slice(2)));`);
    writeFileSync(path.join(root, 'scripts/summarize-jest-results.test.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('script-ran', 'yes');`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (...args) => execFileSync(process.execPath, ['scripts/run-tests.js', ...args], { cwd: root, encoding: 'utf8', env });
    run('--selection', '[]', '--script-selection', '[]');
    const selected = ['tests/unit/example.test.ts'];
    run('--selection', JSON.stringify(selected), '--script-selection', '["scripts/summarize-jest-results.test.mjs"]');
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'jest-args.json'))), ['--runTestsByPath', ...selected]);
    assert.equal(readFileSync(path.join(root, 'script-ran'), 'utf8'), 'yes');
    rmSync(path.join(root, 'jest-args.json'));
    rmSync(path.join(root, 'script-ran'));
    run('--selection', '[]', '--script-selection', '[]');
    assert.throws(() => readFileSync(path.join(root, 'jest-args.json')), { code: 'ENOENT' });
    assert.throws(() => readFileSync(path.join(root, 'script-ran')), { code: 'ENOENT' });
    const nativeTest = 'tests/integration/core/process/ManagedStdioProcess.test.ts';
    execFileSync(process.execPath, ['scripts/run-cross-platform-tests.js', '--selection', JSON.stringify([nativeTest])], { cwd: root, env });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'jest-args.json'))), ['--runInBand', '--runTestsByPath', nativeTest]);
    execFileSync(process.execPath, ['scripts/run-cross-platform-tests.js', '--selection', JSON.stringify([nativeTest]), '--maxWorkers=2'], { cwd: root, env });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'jest-args.json'))), ['--maxWorkers=2', '--runTestsByPath', nativeTest]);
    execFileSync(process.execPath, ['scripts/run-cross-platform-tests.js', '--selection', JSON.stringify([nativeTest]), '--maxWorkers', '4'], { cwd: root, env });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'jest-args.json'))), ['--maxWorkers', '4', '--runTestsByPath', nativeTest]);
    const invalid = spawnSync(process.execPath, ['scripts/run-tests.js', '--selection', '[]', '--script-selection', '["scripts/unknown.mjs"]'], { cwd: root });
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full Jest shards cover every suite once and propagate failures from either shard', () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'claudian-sharded-tests-')));
  try {
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
    for (const file of ['run-tests.js', 'testSuites.cjs']) copyFileSync(`scripts/${file}`, path.join(root, 'scripts', file));
    writeFileSync(path.join(root, 'scripts/run-jest.js'), `require(${JSON.stringify(path.resolve('scripts/run-jest.js'))});`);
    writeFileSync(path.join(root, 'jest.config.js'), `module.exports = { testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] };`);
    const script = 'scripts/summarize-jest-results.test.mjs';
    writeFileSync(path.join(root, script), `import { appendFileSync } from 'node:fs'; appendFileSync('script-runs', 'ran\\n');`);
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    const sources = names.map(name => path.join(root, 'tests/unit', `${name}.test.ts`));
    sources.forEach((source, index) => writeFileSync(source, `test('${names[index]}', () => expect(true).toBe(true));`));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (shard, scripts = []) => {
      const output = path.join(root, `shard-${shard}.json`);
      const result = spawnSync(process.execPath, [
        'scripts/run-tests.js', '--script-selection', JSON.stringify(scripts),
        '--runInBand', `--shard=${shard}/2`, '--json', `--outputFile=${output}`,
      ], { cwd: root, encoding: 'utf8', env });
      return { result, report: JSON.parse(readFileSync(output, 'utf8')) };
    };
    const first = run(1, [script]);
    const second = run(2);
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    const firstFiles = first.report.testResults.map(suite => suite.name);
    const secondFiles = second.report.testResults.map(suite => suite.name);
    assert.equal(firstFiles.some(file => secondFiles.includes(file)), false);
    assert.deepEqual([...firstFiles, ...secondFiles].sort(), sources.sort());
    assert.equal(readFileSync(path.join(root, 'script-runs'), 'utf8'), 'ran\n');
    for (const [index, files] of [firstFiles, secondFiles].entries()) {
      const source = files[0];
      const original = readFileSync(source, 'utf8');
      writeFileSync(source, "test('failure reaches the gate', () => expect(true).toBe(false));");
      const failed = run(index + 1);
      assert.notEqual(failed.result.status, 0);
      assert.equal(failed.report.numFailedTests, 1);
      writeFileSync(source, original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
