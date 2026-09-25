const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const runJest = path.join(__dirname, 'run-jest.js');
const { crossPlatformTests: tests } = require('./testSuites.cjs');

const args = process.argv.slice(2);
let selected = tests;
if (args[0] === '--selection') {
  const selection = JSON.parse(args[1]);
  if (selection !== null && (!Array.isArray(selection) || selection.some(file => !tests.includes(file)))) {
    throw new Error('Unknown cross-platform test selection');
  }
  selected = selection ?? tests;
  args.splice(0, 2);
}
if (selected.length === 0) process.exit(0);
const workers = args.some(arg => arg === '--maxWorkers' || arg.startsWith('--maxWorkers=') || arg === '-w' || /^-w\d/.test(arg));
const result = spawnSync(process.execPath, [runJest, ...(workers ? [] : ['--runInBand']), ...args, '--runTestsByPath', ...selected], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
