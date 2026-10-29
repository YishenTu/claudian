const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const vitestPath = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2);
if (!['run', 'watch', 'list', 'related'].includes(args[0])) args.unshift('run');
// Every JSON execution also records resolved workers and runtime errors, which the
// built-in JSON report does not include. `list` has its own JSON output format.
if (args[0] !== 'list' && args.some(arg => arg === '--outputFile' || arg.startsWith('--outputFile='))) {
  if (!args.some(arg => arg === '--reporter' || arg.startsWith('--reporter='))) {
    args.push('--reporter=default', '--reporter=json');
  }
  args.push(`--reporter=${path.join(__dirname, 'vitestMetadataReporter.mjs')}`);
}
const localStorageFile = path.join(os.tmpdir(), 'claudian-localstorage');
const result = spawnSync(process.execPath, [
  `--localstorage-file=${localStorageFile}`, vitestPath, ...args,
], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
