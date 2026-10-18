const crossPlatformTests = [
  // Filesystem, path, URI, and platform-policy regressions need native hosts even without a subprocess.
  'tests/unit/core/process/env.test.ts',
  'tests/unit/core/storage/VaultFileAdapter.test.ts',
  'tests/unit/features/agent-skills/ClaudeSkillSync.test.ts',
  'tests/unit/providers/claude/execution/ClaudeExecutionBackend.test.ts',
  'tests/unit/providers/codex/execution/CodexExecutionBackend.test.ts',
  'tests/unit/providers/codex/history/CodexHistoryStore.test.ts',
  'tests/unit/providers/codex/runtime/CodexBinaryLocator.test.ts',
  'tests/unit/providers/codex/runtime/CodexCLIResolver.desktop.test.ts',
  'tests/unit/providers/deepseek/runtime/DeepSeekCLIResolver.test.ts',
  'tests/unit/providers/deepseek/runtime/DeepSeekInstallation.test.ts',
  'tests/unit/providers/deepseek/runtime/DeepSeekPresetPlugins.test.ts',
  'tests/unit/providers/deepseek/ui/DeepSeekSettingsTab.test.ts',
  'tests/integration/providers/claude/history/ClaudeTurnStats.test.ts',
  'tests/integration/providers/deepseek/app/DeepSeekWorkspaceServices.test.ts',
  'tests/integration/providers/opencode/execution/OpencodeV2Execution.test.ts',
  'tests/integration/providers/deepseek/runtime/DeepSeekHostProcess.test.ts',
  'tests/integration/providers/deepseek/runtime/DeepSeekLaunchArtifacts.test.ts',
  'tests/integration/core/process/ProcessProbe.test.ts',
  'tests/integration/core/process/ManagedStdioProcess.test.ts',
  'tests/integration/core/process/cliBinaryLocator.test.ts',
  'tests/integration/core/process/loginShellPath.test.ts',
  'tests/integration/core/session-tools/LoopbackSessionToolServer.test.ts',
  'tests/integration/features/chat/tabs/forking/ForkSource.opencode.test.ts',
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
