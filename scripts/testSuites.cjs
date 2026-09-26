const crossPlatformTests = [
  'tests/integration/core/process/ProcessProbe.test.ts',
  'tests/integration/core/process/ManagedStdioProcess.test.ts',
  'tests/integration/utils/cliBinaryLocator.test.ts',
];

const scriptTests = [
  'scripts/check-architecture-boundaries.test.mjs',
  'scripts/check-eslint-config.test.mjs',
  'scripts/check-open-handles.test.mjs',
  'scripts/check-release-version.test.mjs',
  'scripts/check-stylelint-config.test.mjs',
  'scripts/summarize-jest-results.test.mjs',
  'scripts/ciTestSelection.test.mjs',
  'scripts/run-tests.test.mjs',
];

module.exports = { crossPlatformTests, scriptTests };
