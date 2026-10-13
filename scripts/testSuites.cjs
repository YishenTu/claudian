const crossPlatformTests = [
  'tests/integration/providers/deepseek/runtime/DeepSeekHostProcess.test.ts',
  'tests/integration/providers/deepseek/runtime/DeepSeekLaunchArtifacts.test.ts',
  'tests/integration/core/process/ProcessProbe.test.ts',
  'tests/integration/core/process/ManagedStdioProcess.test.ts',
  'tests/integration/core/process/cliBinaryLocator.test.ts',
  'tests/integration/core/process/loginShellPath.test.ts',
  'tests/integration/core/session-tools/LoopbackSessionToolServer.test.ts',
  'tests/integration/providers/opencode/http/OpencodeSharedServer.test.ts',
  'tests/integration/providers/pi/execution/PiExecutionKernel.test.ts',
];

const scriptTests = [
  'scripts/check-architecture-boundaries.test.mjs',
  'scripts/check-eslint-config.test.mjs',
  'scripts/check-open-handles.test.mjs',
  'scripts/check-release-version.test.mjs',
  'scripts/summarize-jest-results.test.mjs',
  'scripts/ciTestSelection.test.mjs',
  'scripts/run-tests.test.mjs',
];

module.exports = { crossPlatformTests, scriptTests };
