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
const report = {
  passed: results.numPassedTests,
  failed: results.numFailedTests,
  skipped: results.numPendingTests,
  failedSuites: results.numFailedTestSuites,
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
  'Slowest 20 completed tests. All test timings are in the `jest-timings` artifact.',
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
