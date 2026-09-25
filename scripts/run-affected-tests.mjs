import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { selectCiTests, selectRelatedCiTests } from './ciTestSelection.mjs';

let base = 'origin/main';
let list = false;
let full = false;
const args = process.argv.slice(2);
while (args.length && args[0] !== '--') {
  const flag = args.shift();
  if (flag === '--base' && args[0] && !args[0].startsWith('-')) base = args.shift();
  else if (flag === '--list') list = true;
  else if (flag === '--full') full = true;
  else throw new Error(`Unknown or incomplete option: ${flag}. Use --base <ref>, --list, --full, or -- <Jest args>.`);
}
if (args[0] === '--') args.shift();
const git = (...gitArgs) => execFileSync('git', gitArgs, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
});
let changes;
if (!full) {
  try {
    // Compare the working tree to the branch point, including index and local edits.
    const mergeBase = git('merge-base', base, 'HEAD').trim();
    const entries = git('diff', '--name-status', '-z', '--no-renames', mergeBase, '--').split('\0');
    entries.pop();
    const files = new Map();
    for (let index = 0; index < entries.length; index += 2) files.set(entries[index + 1], entries[index]);
    for (const file of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
      files.set(file, 'A');
    }
    changes = [...files].map(([path, status]) => ({ path, status: existsSync(path) ? status : 'D' }));
  } catch {
    console.error('Cannot determine the local change range; running full verification.');
  }
}
const selection = changes
  ? selectRelatedCiTests({ changes })
  : selectCiTests({ changes: [], relatedTests: [], eventName: 'workflow_call' });
console.log(JSON.stringify(selection, null, 2));
if (!list) {
  const run = (script, scriptArgs = []) => {
    const result = spawnSync(process.execPath, [script, ...scriptArgs], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  run('scripts/run-tests.js', [
    '--selection', JSON.stringify(selection.testFiles),
    '--script-selection', JSON.stringify(selection.scriptTests), ...args,
  ]);
}
