const { spawnSync } = require('child_process');
const path = require('path');

const runJestPath = path.join(__dirname, 'run-jest.js');
const testPaths = [
  'tests/unit/providers/claude/runtime/ClaudianService.test.ts',
  'tests/unit/providers/claude/runtime/types.test.ts',
  'tests/unit/providers/claude/stream/transformSDKMessage.test.ts',
];

const result = spawnSync(
  process.execPath,
  [
    runJestPath,
    '--runInBand',
    '--selectProjects',
    'unit',
    '--runTestsByPath',
    ...testPaths,
  ],
  { stdio: 'inherit' }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
