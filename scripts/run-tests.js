const { spawnSync } = require('child_process');
const path = require('path');
const { scriptTests } = require('./testSuites.cjs');

const root = path.join(__dirname, '..');

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const args = process.argv.slice(2);
let selectedTests = null;
let selectedScripts = scriptTests;
while (args[0] === '--selection' || args[0] === '--script-selection') {
  const [flag, value] = args.splice(0, 2);
  const selection = JSON.parse(value);
  if (selection !== null && (!Array.isArray(selection) || selection.some(file => (
    typeof file !== 'string' || (flag === '--selection'
      ? !/^tests\/(?:unit|integration)\/[^\\]*\.test\.ts$/.test(file) || file.split('/').includes('..')
      : !scriptTests.includes(file))
  )))) throw new Error(`Invalid test selection for ${flag}`);
  if (flag === '--selection') selectedTests = selection;
  else selectedScripts = selection ?? scriptTests;
}
if (selectedTests === null || selectedTests.length > 0) {
  run([
    path.join(__dirname, 'run-vitest.js'),
    ...args,
    ...(selectedTests === null ? [] : selectedTests),
  ]);
}
if (selectedScripts.length > 0) run(['--test', ...selectedScripts.map(file => path.join(root, file))]);
