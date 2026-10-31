const path = require('node:path');
const { readTestDeclarations } = require('./testDeclarations.cjs');

const { crossPlatformTests, fileConsumers } = readTestDeclarations(path.resolve(__dirname, '..'));

const scriptTests = [
  'scripts/check-architecture-boundaries.test.mjs',
  'scripts/check-eslint-config.test.mjs',
  'scripts/check-open-handles.test.mjs',
  'scripts/check-release-version.test.mjs',
  'scripts/summarize-vitest-results.test.mjs',
  'scripts/ciTestSelection.test.mjs',
  'scripts/testDeclarations.test.mjs',
  'scripts/run-tests.test.mjs',
  'scripts/audit-dependencies.test.mjs',
  'scripts/run-mutation.test.mjs',
  'scripts/run-obsidian-smoke.test.mjs',
];

module.exports = { crossPlatformTests, fileConsumers, scriptTests };
