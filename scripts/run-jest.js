const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const jestPath = require.resolve('jest/bin/jest');
const localStorageFile = path.join(os.tmpdir(), 'claudian-localstorage');
const projectRoot = path.resolve(__dirname, '..');

const result = spawnSync(
  process.execPath,
  [`--localstorage-file=${localStorageFile}`, jestPath, ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
