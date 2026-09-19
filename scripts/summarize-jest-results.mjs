import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('Usage: node scripts/summarize-jest-results.mjs <jest.json> <output-directory>');
}

const results = JSON.parse(await readFile(input, 'utf8'));
const tests = results.testResults.flatMap(suite => suite.assertionResults.map(test => ({
  file: path.relative(process.cwd(), suite.name).split(path.sep).join('/'),
  name: test.fullName,
  status: test.status,
  durationMs: Number.isFinite(test.duration) ? test.duration : null,
}))).sort((left, right) => (
  (right.durationMs ?? -1) - (left.durationMs ?? -1)
  || left.file.localeCompare(right.file)
  || left.name.localeCompare(right.name)
));
const suites = results.testResults.map(suite => {
  // Jest synthesizes current timestamps for skipped and module-load failures.
  const executed = suite.status !== 'skipped' && suite.assertionResults.some(test => test.status !== 'pending' && test.status !== 'todo');
  const startTime = executed && Number.isFinite(suite.startTime) && suite.startTime > 0 ? suite.startTime : null;
  const endTime = startTime !== null && Number.isFinite(suite.endTime) && suite.endTime >= startTime
    ? suite.endTime : null;
  return {
    file: path.relative(process.cwd(), suite.name).split(path.sep).join('/'),
    status: suite.status,
    startTime,
    endTime,
    durationMs: endTime === null ? null : endTime - startTime,
  };
}).sort((left, right) => (right.durationMs ?? -1) - (left.durationMs ?? -1)
  || left.file.localeCompare(right.file));
let execution = null;
try {
  execution = JSON.parse(await readFile(`${input}.metadata.json`, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const report = {
  passed: results.numPassedTests,
  failed: results.numFailedTests,
  skipped: results.numPendingTests,
  failedSuites: results.numFailedTestSuites,
  suiteCount: suites.length,
  execution,
  suites,
  tests,
};
const cell = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ');
const summary = [
  '## Jest timings',
  '',
  `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`,
  `Failed suites: ${report.failedSuites} (including failures before test execution).`,
  '',
  `${report.suiteCount} selected suites. Suite durations include setup and teardown; concurrent durations overlap.`,
  ...(execution ? [`Node ${execution.nodeVersion}; ${execution.platform}/${execution.arch}; max workers ${execution.maxWorkers}.`] : []),
  '',
  'Slowest 20 suites. All timings are in the uploaded timing artifact.',
  '',
  '| Duration (ms) | Status | File |',
  '| ---: | --- | --- |',
  ...suites.filter(suite => suite.durationMs !== null).slice(0, 20).map(suite => (
    `| ${suite.durationMs} | ${cell(suite.status)} | ${cell(suite.file)} |`
  )),
  '',
  'Slowest 20 completed tests.',
  '',
  '| Duration (ms) | Status | File | Test |',
  '| ---: | --- | --- | --- |',
  ...tests.filter(test => test.durationMs !== null).slice(0, 20).map(test => (
    `| ${test.durationMs} | ${cell(test.status)} | ${cell(test.file)} | ${cell(test.name)} |`
  )),
  '',
].join('\n');

await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'timings.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(output, 'slowest-tests.md'), summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
