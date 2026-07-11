const { spawnSync } = require('child_process');
const path = require('path');

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

run([
  path.join(__dirname, 'run-jest.js'),
  ...process.argv.slice(2),
]);
run([
  '--test',
  path.join(__dirname, 'check-architecture-boundaries.test.mjs'),
  path.join(__dirname, 'check-release-version.test.mjs'),
]);
