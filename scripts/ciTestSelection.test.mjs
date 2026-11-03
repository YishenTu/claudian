import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';

import { ciTestLanes, documentationPaths, selectCiTests, selectRelatedCiTests, wslTests } from './ciTestSelection.mjs';

const prompt = 'tests/unit/core/prompt/mainAgent.systemPrompt.test.ts';
const panel = 'tests/integration/features/chat/ClaudianView.test.ts';
const native = 'tests/integration/core/process/ManagedStdioProcess.test.ts';
const docs = 'tests/unit/docs/Documentation.test.ts';
const select = (paths, relatedTests = [], eventName = 'pull_request') => selectCiTests({
  changes: paths.map(path => typeof path === 'string' ? { status: 'M', path } : path),
  relatedTests, eventName,
});

test('ordinary PRs and pushes select affected consumers', () => {
  for (const event of ['pull_request', 'push']) {
    const result = select(['src/core/prompt/mainAgent.ts'], [prompt], event);
    assert.deepEqual(result.testFiles, [prompt]);
    assert.deepEqual(result.crossPlatformTests, []);
  }
});

test('presentation changes do not trigger native checks through main composition', () => {
  const result = select(['src/features/chat/ClaudianView.ts'], [panel, 'tests/integration/main.test.ts']);
  assert.deepEqual(result.testFiles, [panel, 'tests/integration/main.test.ts']);
  assert.deepEqual(result.crossPlatformTests, []);
});

test('shared dependencies retain affected native consumers', () => {
  const result = select(['src/core/process/env.ts'], [prompt, native]);
  assert.deepEqual(result.testFiles, [prompt, native]);
  assert.deepEqual(result.crossPlatformTests, [native]);
});

test('real subprocess consumers run on native platforms when affected', () => {
  for (const consumer of [
    'tests/integration/providers/opencode/ToolRendererCompatibility.dom.test.ts',
    'tests/integration/providers/opencode/app/OpencodeCommandLoader.test.ts',
    'tests/integration/providers/grok/app/GrokWorkspaceServices.test.ts',
    'tests/integration/features/chat/tabs/forking/ForkSource.opencode-v2.test.ts',
    'tests/integration/core/process/ProcessProbe.test.ts',
    'tests/integration/core/process/ManagedStdioProcess.test.ts',
    'tests/integration/core/process/cliBinaryLocator.test.ts',
  ]) {
    const result = select(['src/core/process/cliPath.ts'], [consumer]);
    assert.deepEqual(result.crossPlatformTests, [consumer]);
    assert.equal(result.crossPlatform, true);
    assert.deepEqual(select([consumer]).crossPlatformTests, [consumer]);
  }
});

test('mocked process policies remain in the ordinary suite without native jobs', () => {
  const unitTests = [
    'tests/unit/core/process/windowsCmdShim.test.ts',
    'tests/unit/core/process/ManagedStdioProcess.test.ts',
  ];
  const result = select(unitTests);
  assert.deepEqual(result.testFiles, unitTests);
  assert.deepEqual(result.crossPlatformTests, []);
  assert.equal(result.crossPlatform, false);
});

test('platform-sensitive unit tests retain native checks for both direct and source changes', () => {
  for (const [source, consumer] of [
    ['src/core/process/env.ts', 'tests/unit/core/process/env.test.ts'],
    ['src/core/storage/VaultFileAdapter.ts', 'tests/integration/core/storage/VaultFileAdapter.test.ts'],
    ['src/providers/codex/history/CodexHistoryStore.ts', 'tests/unit/providers/codex/history/CodexHistoryStore.test.ts'],
    ['src/providers/deepseek/ui/DeepSeekSettingsTab.ts', 'tests/integration/providers/deepseek/ui/DeepSeekSettingsTab.dom.test.ts'],
  ]) {
    for (const eventName of ['pull_request', 'push']) {
      const result = select([source], [consumer], eventName);
      assert.deepEqual(result.crossPlatformTests, [consumer]);
      assert.equal(result.crossPlatform, true);
      assert.deepEqual(select([consumer], [], eventName).crossPlatformTests, [consumer]);
    }
  }
});

test('real dependency discovery retains native launch checks for shared process changes', () => {
  const result = selectRelatedCiTests({
    changes: [{ status: 'M', path: 'src/core/process/windowsCmdShim.ts' }],
  });
  assert.deepEqual(result.crossPlatformTests.sort(), [
    'tests/integration/app/projects/ProjectService.test.ts',
    'tests/integration/app/settings/RuntimeSettingsCoordinator.test.ts',
    'tests/integration/core/process/ManagedStdioProcess.test.ts',
    'tests/integration/core/process/ProcessProbe.test.ts',
    'tests/integration/core/process/cliBinaryLocator.test.ts',
    'tests/integration/core/process/execution-target/WSLCaptureCancellation.test.ts',
    'tests/integration/core/process/execution-target/WSLShellLaunch.test.ts',
    'tests/integration/core/process/loginShellPath.test.ts',
    'tests/integration/features/chat/tabs/forking/ForkSource.opencode-v2.test.ts',
    'tests/integration/features/chat/tabs/forking/ForkSource.opencode.test.ts',
    'tests/integration/helpers/WSLProcessFixture.test.ts',
    'tests/integration/providers/claude/execution/ClaudeExecutionBackend.test.ts',
    'tests/integration/providers/claude/runtime/ClaudeCLIInstallation.test.ts',
    'tests/integration/providers/claude/runtime/ClaudeSDKSpawn.test.ts',
    'tests/integration/providers/codex/execution/CodexExecutionBackend.protocol.test.ts',
    'tests/integration/providers/codex/execution/CodexExecutionBackend.test.ts',
    'tests/integration/providers/codex/runtime/CodexSharedRuntime.test.ts',
    'tests/integration/providers/deepseek/app/DeepSeekWorkspaceServices.test.ts',
    'tests/integration/providers/deepseek/runtime/DeepSeekCLIResolver.test.ts',
    'tests/integration/providers/deepseek/runtime/DeepSeekHostProcess.test.ts',
    'tests/integration/providers/deepseek/runtime/DeepSeekInstallation.test.ts',
    'tests/integration/providers/deepseek/ui/DeepSeekSettingsTab.dom.test.ts',
    'tests/integration/providers/grok/app/GrokWorkspaceServices.test.ts',
    'tests/integration/providers/opencode/ToolRendererCompatibility.dom.test.ts',
    'tests/integration/providers/opencode/app/OpencodeCommandLoader.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeExecutionBackend.native.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeExecutionBackend.wsl.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.background.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.compaction.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.interactions.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.profiles.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.prompts.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.steering.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.test.ts',
    'tests/integration/providers/opencode/history/OpencodeConversationHistoryService.test.ts',
    'tests/integration/providers/opencode/history/OpencodeConversationHistoryService.wsl.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.ephemeral.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.history.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.transitions.test.ts',
    'tests/integration/providers/pi/env/PiSettingsReconciler.test.ts',
    'tests/integration/providers/pi/execution/PiExecutionKernel.test.ts',
    'tests/integration/providers/pi/execution/PiRecoveryContext.test.ts',
    'tests/integration/providers/pi/runtime/PiCLIInstallation.test.ts',
  ]);
  assert.equal(result.piWindows, true);
  assert.ok(result.testFiles.includes('tests/unit/core/process/windowsCmdShim.test.ts'));
  assert.ok(result.testFiles.includes('tests/unit/core/process/ManagedStdioProcess.test.ts'));
});

test('Pi-only changes retain native verification without unrelated process suites', () => {
  const result = select(['tests/integration/providers/pi/runtime/PiSubprocess.windows.test.ts']);
  assert.equal(result.crossPlatform, true);
  assert.equal(result.piWindows, true);
  assert.deepEqual(result.crossPlatformTests, []);
});

test('changed tests run directly, while removed tests are omitted', () => {
  const result = select([{ status: 'D', path: panel }, prompt], [panel]);
  assert.deepEqual(result.testFiles, [prompt]);
  assert.deepEqual(result.crossPlatformTests, []);
});

test('moved skill sync retains native verification', () => {
  const successor = 'tests/integration/features/agent-skills/ClaudeSkillSync.test.ts';
  assert.deepEqual(select([successor]).crossPlatformTests, [successor]);
});

test('shared test helpers use their graph consumers and validate declaration placement', () => {
  const result = select(['tests/helpers/testClock.ts'], [native]);
  assert.deepEqual(result.testFiles, [native,
    'tests/integration/providers/codex/runtime/CodexWSL.windows.test.ts',
    'tests/integration/providers/grok/runtime/GrokWSL.windows.test.ts',
  ]);
  assert.ok(result.scriptTests.includes('scripts/testDeclarations.test.mjs'));
  assert.equal(select(['tests/helpers/testClock.ts'], [prompt]).crossPlatform, false);
});

test('filesystem-read documentation, styles, and captured fixtures retain their consumers', () => {
  assert.ok(select(['src/style/base/visibility.css']).testFiles.includes('tests/integration/features/chat/composer/PromptHistoryNavigation.dom.test.ts'));
  assert.deepEqual(select(['README.md']).testFiles, [docs]);
  assert.deepEqual(select(['src/features/chat/AGENTS.md']).testFiles, [docs]);
  assert.ok(select(['src/style/components/code.css']).testFiles.includes('tests/unit/style/components/code.test.ts'));
  for (const consumer of [
    'tests/unit/style/components/zen-mode.test.ts',
    'tests/unit/style/settings/base.test.ts',
    'tests/integration/features/chat/navigation/NavigationSidebar.dom.test.ts',
  ]) {
    assert.ok(select(['src/style/components/zen-mode.css']).testFiles.includes(consumer), consumer);
  }
  const fixture = select(['tests/fixtures/providers/grok/history/example.json']);
  assert.ok(fixture.testFiles.includes('tests/integration/providers/grok/history/GrokHistoryStore.test.ts'));
  assert.ok(fixture.testFiles.includes('tests/integration/providers/grok/history/GrokConversationHistoryService.test.ts'));
  for (const status of ['A', 'M']) {
    for (const event of ['pull_request', 'push']) {
      for (const [file, consumers] of [
        ['tests/helpers/providers/opencode/OpencodeNativePeer.cjs', [
          'tests/integration/providers/opencode/ToolRendererCompatibility.dom.test.ts',
          'tests/integration/providers/opencode/app/OpencodeCommandLoader.test.ts',
          'tests/integration/features/chat/tabs/forking/ForkSource.opencode.test.ts',
          'tests/integration/features/chat/tabs/forking/ForkSource.opencode-v2.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeExecutionBackend.native.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeExecutionBackend.wsl.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.background.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.compaction.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.interactions.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.profiles.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.prompts.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.steering.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.test.ts',
          'tests/integration/providers/opencode/history/OpencodeConversationHistoryService.test.ts',
          'tests/integration/providers/opencode/history/OpencodeConversationHistoryService.wsl.test.ts',
          'tests/integration/providers/opencode/history/OpencodeInvalidatedHistory.test.ts',
          'tests/integration/providers/opencode/http/OpencodeHTTPHistory.test.ts',
          'tests/integration/providers/opencode/http/OpencodeProcessRetention.test.ts',
          'tests/integration/providers/opencode/http/OpencodeSharedServer.ephemeral.test.ts',
          'tests/integration/providers/opencode/http/OpencodeSharedServer.history.test.ts',
          'tests/integration/providers/opencode/http/OpencodeSharedServer.test.ts',
          'tests/integration/providers/opencode/http/OpencodeSharedServer.transitions.test.ts',
          'tests/integration/providers/opencode/metadata/OpencodeHTTPMetadataCancellation.test.ts',
          'tests/integration/providers/opencode/metadata/OpencodeHTTPMetadataCatalog.test.ts',
          'tests/integration/providers/opencode/metadata/OpencodeHTTPMetadataReadiness.test.ts',
          'tests/integration/providers/opencode/metadata/OpencodeHTTPMetadataServerLifecycle.test.ts',
          'tests/integration/providers/opencode/ui/OpencodeCommands.dom.test.ts',
          'tests/integration/providers/opencode/ui/OpencodeModels.dom.test.ts',
          'tests/integration/providers/opencode/ui/OpencodeSettingsTab.dom.test.ts',
        ]],
        ['tests/fixtures/providers/grok/runtime/models-list.json', [
          'tests/integration/providers/grok/app/GrokWorkspaceServices.test.ts',
          'tests/integration/providers/grok/runtime/GrokModelCatalogCoordinator.test.ts',
          'tests/integration/providers/grok/runtime/GrokModels.test.ts',
          'tests/integration/providers/grok/runtime/GrokModelDiscoveryService.test.ts',
        ]],
        ['tests/fixtures/providers/grok/runtime/models-list-byok.json', [
          'tests/integration/providers/grok/app/GrokWorkspaceServices.test.ts',
          'tests/integration/providers/grok/runtime/GrokModels.test.ts',
          'tests/integration/providers/grok/runtime/GrokModelDiscoveryService.test.ts',
        ]],
        ['tests/fixtures/providers/grok/runtime/GrokModelCatalogProcess.mjs', [
          'tests/integration/providers/grok/app/GrokWorkspaceServices.test.ts',
          'tests/integration/providers/grok/runtime/GrokModelCatalogCoordinator.test.ts',
          'tests/integration/providers/grok/runtime/GrokModelDiscoveryService.test.ts',
        ]],
      ]) {
        const selected = select([{ status, path: file }], [], event);
        for (const consumer of consumers) {
          assert.ok(selected.testFiles.includes(consumer), `${status} ${file} on ${event} must select ${consumer}`);
        }
        assert.deepEqual([...selected.testFiles].sort(), [...consumers].sort(),
          `${status} ${file} on ${event} must select exactly its filesystem consumers`);
      }
    }
  }
});

const codexHistoryFixtures = [
  'tests/fixtures/providers/codex/history/codex-session-persisted-tools.jsonl',
  'tests/fixtures/providers/codex/history/codex-session-agent-lifecycle.jsonl',
  'tests/fixtures/providers/codex/history/codex-session-websearch-persisted.jsonl',
];

for (const [name, selector] of [
  ['pure', input => selectCiTests({ ...input, relatedTests: [] })],
  ['related', selectRelatedCiTests],
]) {
  for (const fixture of codexHistoryFixtures) {
    for (const status of ['A', 'M']) {
      for (const eventName of ['pull_request', 'push']) {
        test(`${name} selector registers ${status} ${fixture} on ${eventName}`, () => {
          assert.deepEqual(selector({ changes: [{ status, path: fixture }], eventName }), {
            testFiles: ['tests/unit/providers/codex/history/CodexHistoryStore.test.ts'],
            scriptTests: [],
            crossPlatformTests: ['tests/unit/providers/codex/history/CodexHistoryStore.test.ts'],
            crossPlatform: true,
            piWindows: false,
            wslWindows: false,
            wslSuites: [], build: false, dependencies: false, workflows: false,
          });
        });
      }
    }
  }

  test(`${name} selector retains full verification outside the known Codex fixture boundary`, () => {
    const full = {
      testFiles: null, scriptTests: null, crossPlatformTests: null,
      crossPlatform: true, piWindows: true, wslWindows: true,
      wslSuites: wslTests, build: true, dependencies: true, workflows: true,
    };
    for (const eventName of ['pull_request', 'push']) {
      for (const changes of [
        ...codexHistoryFixtures.map(path => [{ status: 'D', path }]),
        [{ status: 'M', path: 'tests/fixtures/providers/codex/history/unregistered.jsonl' }],
        [{ status: 'M', path: 'tests/fixtures/providers/codex/history/codex-session-persisted-tools-extra.jsonl' }],
        [{ status: 'M', path: 'scripts/ciTestSelection.mjs' }],
        [{ status: 'M', path: codexHistoryFixtures[0] }, { status: 'M', path: 'unknown-config' }],
      ]) {
        assert.deepEqual(selector({ changes, eventName }), full);
      }
    }
    for (const eventName of ['schedule', 'workflow_call', 'workflow_dispatch']) {
      assert.deepEqual(selector({ changes: [{ status: 'M', path: codexHistoryFixtures[0] }], eventName }), full);
    }
  });
}

test('native Pi launch runs only when affected', () => {
  const pi = 'tests/integration/providers/pi/runtime/PiSubprocess.windows.test.ts';
  assert.equal(select(['src/providers/pi/runtime/PiSubprocess.ts'], [pi]).piWindows, true);
  assert.equal(select(['src/features/chat/ClaudianView.ts'], [panel]).piWindows, false);
});

test('script edits select their script tests without unrelated Vitest work', () => {
  const result = select(['scripts/summarize-vitest-results.mjs']);
  assert.deepEqual(result.testFiles, []);
  assert.deepEqual(result.scriptTests, ['scripts/summarize-vitest-results.test.mjs']);
  assert.equal(result.crossPlatform, false);
});

test('native script regressions retain a Windows job without selecting unrelated Vitest suites', () => {
  for (const script of ['scripts/ciTestSelection.test.mjs', 'scripts/run-tests.test.mjs', 'scripts/testDeclarations.test.mjs']) {
    const result = select([script]);
    assert.deepEqual(result.scriptTests, [script]);
    assert.deepEqual(result.testFiles, []);
    assert.deepEqual(result.crossPlatformTests, []);
    assert.equal(result.crossPlatform, true);
  }
});

test('unsafe deletions and global or unknown changes retain full verification', () => {
  for (const change of [
    { status: 'D', path: 'src/core/prompt/mainAgent.ts' },
    { status: 'D', path: 'tests/helpers/testClock.ts' },
    ...['package-lock.json', 'vitest.config.mts', 'scripts/vitest-open-handles.config.mts', 'tests/setupWindow.ts',
      'scripts/ciTestSelection.mjs', '.github/workflows/ci.yml', 'unknown-config'].map(path => ({ status: 'M', path })),
  ]) {
    const result = select([change]);
    assert.equal(result.testFiles, null);
    assert.equal(result.crossPlatformTests, null);
    assert.equal(result.scriptTests, null);
    assert.equal(result.piWindows, true);
  }
});

test('scheduled and reusable verification retain full coverage', () => {
  for (const event of ['workflow_call', 'schedule', 'workflow_dispatch']) {
    assert.equal(select([], [], event).testFiles, null);
    assert.deepEqual(select([], [], event).wslSuites, wslTests);
  }
  // Scheduled verification reuses CI so every WSL suite runs weekly.
  const nightly = parse(readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8'));
  assert.ok(Object.values(nightly.jobs).some(job => job.uses === './.github/workflows/ci.yml'));
});

test('real dependency graph preserves prompt and provider coverage without Collab suites', () => {
  const relatedTests = JSON.parse(execFileSync(process.execPath, [
    'scripts/list-related-tests.mjs', 'src/core/prompt/mainAgent.ts',
  ], { encoding: 'utf8' })).map(file => file.split(path.sep).join('/'));
  assert.ok(relatedTests.some(file => file.endsWith('/core/prompt/mainAgent.systemPrompt.test.ts')));
  assert.ok(relatedTests.some(file => file.includes('/providers/')));
  assert.equal(relatedTests.some(file => /collab/i.test(file)), false);
});

test('a provider-internal change selects no other provider suites through the real dependency graph', () => {
  const tracker = 'src/providers/codex/execution/CodexSubagentTracker.ts';
  const selection = selectRelatedCiTests({ changes: [{ status: 'M', path: tracker }] });
  const others = /^tests\/(?:unit|integration)\/providers\/(?:claude|deepseek|grok|opencode|pi)\//;
  assert.ok(selection.testFiles.includes('tests/unit/providers/codex/execution/CodexSubagentTracker.test.ts'));
  // Another provider's suite is selected only when it registers Codex itself.
  const registersCodex = file => readFileSync(file, 'utf8').includes('codexProviderRegistration');
  assert.deepEqual(selection.testFiles.filter(file => others.test(file) && !registersCodex(file)), []);
  assert.ok(selection.testFiles.includes('tests/integration/providers/claude/execution/ClaudeExecutionBackend.test.ts'));
  // The tracker is platform-neutral, so the native WSL job does not run.
  assert.deepEqual(selection.wslSuites, []);
});

test('Vitest shards scale with the selection and script checks run in their own lane', () => {
  const files = count => Array.from({ length: count }, (_, index) => `tests/unit/${index}.test.ts`);
  assert.deepEqual(ciTestLanes({ testFiles: [], scriptTests: [] }), []);
  assert.deepEqual(ciTestLanes({ testFiles: [], scriptTests: ['scripts/run-tests.test.mjs'] }), ['scripts']);
  assert.deepEqual(ciTestLanes({ testFiles: files(200), scriptTests: [] }), ['1/1']);
  assert.deepEqual(ciTestLanes({ testFiles: files(201), scriptTests: [] }), ['1/2', '2/2']);
  assert.deepEqual(ciTestLanes({ testFiles: files(5000), scriptTests: [] }), ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(ciTestLanes({ testFiles: null, scriptTests: null }), ['1/4', '2/4', '3/4', '4/4', 'scripts']);
});

test('the CI entry point handles real Git ranges, renames, missing bases and release tags', async () => {
  const { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'claudian-ci-scope-'));
  try {
    for (const directory of ['scripts', 'src', 'tests/unit']) mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ['ciTestSelection.mjs', 'testSuites.cjs', 'testDeclarations.cjs']) copyFileSync(`scripts/${file}`, path.join(root, 'scripts', file));
    writeFileSync(path.join(root, 'scripts/run-vitest.js'), `require(${JSON.stringify(path.resolve('scripts/run-vitest.js'))});`);
    writeFileSync(path.join(root, 'scripts/list-related-tests.mjs'), `import ${JSON.stringify(pathToFileURL(path.resolve('scripts/list-related-tests.mjs')).href)};`);
    writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: { globals: true, maxWorkers: 1, include: ['tests/unit/**/*.test.ts'] } };`);
    writeFileSync(path.join(root, 'src/value.ts'), 'export const value = 1;');
    writeFileSync(path.join(root, 'src/value.css'), 'body {}');
    writeFileSync(path.join(root, 'tests/unit/types.test.ts'), "import type { value } from '../../src/value'; const example: typeof value = 1; test('type-only', () => expect(example).toBe(1));");
    writeFileSync(path.join(root, 'tests/unit/value.test.ts'), "// @test-ci {\"native\":true,\"inputs\":[\"src/value.css\"]}\nimport { value } from '../../src/value'; test('value', () => expect(value).toBe(1));");
    writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Initial fixture');
    const base = git('rev-parse', 'HEAD');
    const scope = (head, overrides = {}) => {
      const output = execFileSync(process.execPath, ['scripts/ciTestSelection.mjs'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
          BASE_SHA: base, HEAD_SHA: head, ...overrides },
      });
      return Object.fromEntries(output.trim().split('\n').map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
      }));
    };
    writeFileSync(path.join(root, 'src/value.ts'), 'export const value = 2;');
    git('add', '.'); git('commit', '-m', 'Edit source');
    const edited = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(edited)['test-files'], ['tests/unit/value.test.ts']);
    assert.deepEqual(scope(edited)['test-lanes'], ['1/1', 'scripts']);
    assert.deepEqual([scope(edited).build, scope(edited).dependencies, scope(edited).workflows, scope(edited)['wsl-suites']], [true, false, false, []]);
    assert.deepEqual(scope(edited, { GITHUB_EVENT_NAME: 'pull_request' })['test-files'], ['tests/unit/value.test.ts']);
    renameSync(path.join(root, 'tests/unit/value.test.ts'), path.join(root, 'tests/unit/renamed.test.ts'));
    git('add', '.'); git('commit', '-m', 'Rename test');
    const renamed = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(renamed, { BASE_SHA: edited })['test-files'], ['tests/unit/renamed.test.ts']);
    assert.deepEqual(scope(renamed, { BASE_SHA: edited })['cross-platform-tests'], ['tests/unit/renamed.test.ts']);
    writeFileSync(path.join(root, 'src/value.css'), 'body { color: red }');
    git('add', '.'); git('commit', '-m', 'Edit a non-import input');
    const styled = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(styled, { BASE_SHA: renamed })['test-files'], ['tests/unit/renamed.test.ts']);
    assert.deepEqual(scope(styled, { BASE_SHA: renamed })['cross-platform-tests'], ['tests/unit/renamed.test.ts']);
    rmSync(path.join(root, 'tests/unit/renamed.test.ts'));
    git('add', '.'); git('commit', '-m', 'Delete test');
    const deleted = git('rev-parse', 'HEAD');
    assert.deepEqual(scope(deleted, { BASE_SHA: styled })['test-files'], []);
    assert.deepEqual(scope(deleted, { BASE_SHA: styled })['test-lanes'], ['scripts']);
    for (const overrides of [
      { BASE_SHA: 'f'.repeat(40) }, { BASE_SHA: '0'.repeat(40) }, { BASE_SHA: '' },
      { GITHUB_REF: 'refs/tags/2.3.0' },
    ]) {
      const full = scope(deleted, overrides);
      assert.equal(full['test-files'], null);
      assert.deepEqual(full['test-lanes'], ['1/4', '2/4', '3/4', '4/4', 'scripts']);
      assert.deepEqual([full.build, full.dependencies, full.workflows, full['wsl-suites']], [true, true, true, wslTests]);
    }
    // Release scope must work before dependency installation, without invoking Vitest.
    writeFileSync(path.join(root, 'scripts/run-vitest.js'), "throw new Error('Vitest is unavailable');");
    const tag = scope(deleted, { GITHUB_REF: 'refs/tags/2.3.0' });
    assert.equal(tag['test-files'], null);
    assert.equal(tag['script-tests'], null);
    assert.equal(tag['cross-platform-tests'], null);
    assert.equal(tag['pi-windows'], true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale changes retain the dependency envelope and lazy CommonJS loader coverage', () => {
  const result = selectRelatedCiTests({ changes: [{ status: 'M', path: 'src/i18n/locales/de.json' }] });
  assert.ok(result.testFiles.includes('tests/integration/build/dependency-envelope.test.ts'));
  assert.ok(result.testFiles.includes('tests/unit/i18n/i18n.test.ts'));
});

test('local selection includes committed, staged, unstaged and untracked edits with safe fallbacks', async () => {
  const { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'claudian-local-scope-'));
  try {
    for (const directory of ['scripts', 'src', 'tests/unit']) mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ['ciTestSelection.mjs', 'testSuites.cjs', 'testDeclarations.cjs', 'run-affected-tests.mjs']) copyFileSync(`scripts/${file}`, path.join(root, 'scripts', file));
    writeFileSync(path.join(root, 'scripts/run-vitest.js'), `require(${JSON.stringify(path.resolve('scripts/run-vitest.js'))});`);
    writeFileSync(path.join(root, 'scripts/list-related-tests.mjs'), `import ${JSON.stringify(pathToFileURL(path.resolve('scripts/list-related-tests.mjs')).href)};`);
    writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: { globals: true, maxWorkers: 1, include: ['tests/unit/**/*.test.ts'] } };`);
    for (const name of ['committed', 'staged', 'unstaged', 'deleted']) {
      writeFileSync(path.join(root, `tests/unit/${name}.test.ts`), "test('example', () => {});");
    }
    writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    git('config', 'commit.gpgsign', 'false'); git('add', '.'); git('commit', '-m', 'Baseline');
    const base = git('rev-parse', 'HEAD');
    const scope = (...args) => JSON.parse(execFileSync(process.execPath, [
      'scripts/run-affected-tests.mjs', '--base', base, '--list', ...args,
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(scope().testFiles, []);
    writeFileSync(path.join(root, 'tests/unit/committed.test.ts'), "test('committed edit', () => {});");
    git('add', '.'); git('commit', '-m', 'Committed edit');
    renameSync(path.join(root, 'tests/unit/staged.test.ts'), path.join(root, 'tests/unit/renamed.test.ts'));
    git('add', '.');
    writeFileSync(path.join(root, 'tests/unit/unstaged.test.ts'), "test('unstaged edit', () => {});");
    writeFileSync(path.join(root, 'tests/unit/new test.test.ts'), "test('new', () => {});");
    rmSync(path.join(root, 'tests/unit/deleted.test.ts'));
    assert.deepEqual(scope().testFiles.sort(), [
      'tests/unit/committed.test.ts', 'tests/unit/new test.test.ts',
      'tests/unit/renamed.test.ts', 'tests/unit/unstaged.test.ts',
    ]);
    assert.deepEqual(scope().scriptTests, ['scripts/check-architecture-boundaries.test.mjs']);
    assert.equal(scope('--full').testFiles, null);
    assert.equal(scope('--base', 'missing-base').testFiles, null);
    writeFileSync(path.join(root, 'unknown-config'), 'new');
    assert.equal(scope().testFiles, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WSL suites run only for changes to WSL-related code or WSL test infrastructure', () => {
  const wsl = 'tests/integration/core/process/execution-target/WSLExecution.windows.test.ts';
  const relay = 'tests/integration/core/process/execution-target/WSLSessionToolRelay.windows.test.ts';
  const deepseek = 'tests/integration/providers/deepseek/runtime/DeepSeekWSLHost.windows.test.ts';
  const opencode = 'tests/integration/providers/opencode/runtime/OpencodeWSL.windows.test.ts';
  const codex = 'tests/integration/providers/codex/runtime/CodexWSL.windows.test.ts';
  const grok = 'tests/integration/providers/grok/runtime/GrokWSL.windows.test.ts';
  const claude = 'tests/integration/core/process/execution-target/ClaudeWSL.windows.test.ts';
  // Source that launches, targets, maps paths or chooses the installation method for WSL keeps its declared suites.
  for (const [file, suite] of [
    ['src/core/process/execution-target/TargetLaunchSpec.ts', wsl],
    ['src/core/process/execution-target/types.ts', wsl],
    ['src/core/session-tools/SessionToolEndpoint.ts', relay],
    ['src/core/providers/settings/InstallationSettings.ts', wsl],
    ['src/core/providers/cli/TargetCLIInstallationProbe.ts', wsl],
    ['src/shared/settings/ExecutionTargetSettings.ts', wsl],
    ['src/providers/deepseek/runtime/DeepSeekHostProcess.ts', deepseek],
    ['src/providers/deepseek/ui/DeepSeekSettingsTab.ts', deepseek],
    ['src/providers/grok/runtime/GrokExecutionContext.ts', relay],
    ['src/providers/grok/history/GrokConversationHistoryService.ts', grok],
    ['src/providers/opencode/runtime/OpencodeExecutionTarget.ts', opencode],
    ['src/providers/opencode/ui/OpencodeSettingsTab.ts', opencode],
    ['src/providers/codex/runtime/CodexLaunchSpecBuilder.ts', codex],
    ['src/providers/codex/settings.ts', codex],
    ['src/providers/codex/history/CodexConversationHistoryService.ts', codex],
    ['src/providers/pi/settings.ts', wsl],
    ['src/providers/pi/runtime/PiSubprocess.ts', wsl],
  ]) {
    const selection = select([file]);
    assert.ok(selection.wslSuites.includes(suite), `${file} must select ${suite}`);
  }
  assert.ok(select(['src/providers/claude/runtime/customSpawn.ts'], [claude]).wslSuites.includes(claude));
  assert.deepEqual(selectRelatedCiTests({ changes: [{ status: 'M', path: 'src/core/process/execution-target/WSLEnvironment.ts' }] }).wslSuites.includes(wsl), true);
  // Relay launchers and path owners reach WSL suites through the real dependency graph without naming WSL.
  for (const [file, suite] of [
    ['src/providers/opencode/runtime/OpencodeSessionToolsPlugin.ts', opencode],
    ['src/core/storage/pathContainment.ts', null],
    ['src/utils/path.ts', null],
  ]) {
    const { wslSuites } = selectRelatedCiTests({ changes: [{ status: 'M', path: file }] });
    assert.ok(suite ? wslSuites.includes(suite) : wslSuites.length > 0, `${file} must select its WSL suites`);
  }
  // WSL suites, helpers and fixtures change what the native job runs.
  for (const [file, suite] of [
    [wsl, wsl], [relay, relay], [deepseek, deepseek], [opencode, opencode], [codex, codex], [grok, grok], [claude, claude],
    ['tests/fixtures/providers/deepseek/runtime/FakeDeepSeekWSLHost.mjs', deepseek],
    ['tests/fixtures/providers/pi/PiSessionProcess.mjs', wsl],
    ['tests/helpers/providers/codex/CodexWSLPeer.ts', codex],
  ]) assert.ok(select([file]).wslSuites.includes(suite), `${file} must select ${suite}`);
  for (const [helper, suite] of [['tests/helpers/WSLNativeTarget.ts', relay], ['tests/helpers/WSLNativePeer.ts', grok], ['tests/helpers/WSLClaudeFixture.ts', claude]]) {
    assert.ok(select([helper], [suite]).wslSuites.includes(suite), `${helper} must select ${suite}`);
  }
  // Platform-neutral source and test-only edits leave the native WSL job out, even when declarations select the suite on Linux.
  for (const file of [
    'src/providers/deepseek/types.ts',
    'src/providers/grok/types.ts',
    'src/providers/codex/execution/CodexExecutionBackend.ts',
    'src/providers/codex/execution/CodexSubagentTracker.ts',
    'src/providers/grok/execution/GrokExecutionBackend.ts',
    'src/utils/markdownMath.ts',
    'tests/unit/providers/deepseek/settings.test.ts',
    'tests/integration/providers/deepseek/runtime/DeepSeekHostProcess.wsl.test.ts',
    'tests/integration/providers/grok/ui/GrokSettingsTab.dom.test.ts',
    'tests/integration/providers/pi/history/PiWSLHistory.test.ts',
    'tests/integration/core/providers/cli/TargetCLIInstallationProbe.test.ts',
  ]) {
    const selection = select([file]);
    assert.deepEqual([selection.wslSuites, selection.wslWindows], [[], false], file);
  }
  assert.deepEqual(select(['src/features/chat/ClaudianView.ts'], [panel]).wslSuites, []);
  // Declarations still select the suites on Linux, where they skip without a distro.
  assert.ok(select(['src/providers/deepseek/types.ts']).testFiles.includes(deepseek));
  const piFixture = select(['tests/fixtures/providers/pi/PiSessionProcess.mjs']);
  for (const consumer of [
    'tests/integration/features/chat/side-chat/SideChatNative.pi.test.ts',
    'tests/integration/features/chat/tabs/forking/ForkSource.pi.test.ts',
    'tests/integration/providers/pi/execution/PiExecutionKernel.test.ts',
  ]) assert.ok(piFixture.testFiles.includes(consumer), `${consumer} must follow Pi RPC fixture changes`);
  // A mixed change runs WSL suites only through its WSL-related part.
  const mixed = select(['src/providers/codex/execution/CodexSubagentTracker.ts', 'src/providers/codex/runtime/CodexLaunchSpecBuilder.ts']);
  assert.ok(mixed.wslSuites.includes(codex));
});


test('documentation-only changes skip the CI workflow and select only the documentation test', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  for (const event of ['push', 'pull_request']) {
    assert.deepEqual(workflow.on[event]['paths-ignore'], documentationPaths, event);
  }
  for (const file of ['assets/Preview.png', 'LICENSE', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/PULL_REQUEST_TEMPLATE.md']) {
    assert.deepEqual(select([file]).testFiles, [docs], file);
  }
  assert.equal(select(['.github/workflows/ci.yml']).testFiles, null);
});

const jobs = result => ({
  build: result.build, dependencies: result.dependencies, workflows: result.workflows,
});
const noJobs = { build: false, dependencies: false, workflows: false };

test('pipeline jobs run only for the changes they verify', () => {
  assert.deepEqual(jobs(select(['src/core/prompt/mainAgent.ts'], [prompt])), { ...noJobs, build: true });
  assert.deepEqual(jobs(select([prompt, 'scripts/run-tests.test.mjs'])), noJobs);
  assert.deepEqual(jobs(select(['README.md'])), noJobs);
  assert.deepEqual(jobs(select(['scripts/check-lockfile-parity.mjs'])), { ...noJobs, build: true, dependencies: true });
  for (const full of [select(['package.json']), select([], [], 'workflow_call')]) {
    assert.deepEqual(jobs(full), { build: true, dependencies: true, workflows: true });
  }
});

test('repository automation and lint configuration select only their own checks', () => {
  const architecture = 'scripts/check-architecture-boundaries.test.mjs';
  for (const change of [{ status: 'M', path: '.github/workflows/stale.yml' }, { status: 'D', path: '.github/workflows/stale.yml' }]) {
    const workflow = select([change]);
    assert.deepEqual(workflow.testFiles, [], change.status);
    assert.deepEqual(workflow.scriptTests, [architecture], change.status);
    assert.equal(workflow.crossPlatform, false, change.status);
    assert.equal(workflow.wslWindows, false, change.status);
    assert.deepEqual(jobs(workflow), { ...noJobs, workflows: true }, change.status);
  }
  const wsl = select(['.github/wsl/provision-rootfs.sh']);
  assert.deepEqual([wsl.testFiles, wsl.scriptTests, wsl.crossPlatform, wsl.wslWindows], [[], [], false, true]);
  assert.deepEqual(jobs(wsl), noJobs);
  const codeql = select(['.github/codeql/codeql-config.yml']);
  assert.deepEqual([codeql.testFiles, codeql.scriptTests, codeql.wslWindows], [[], [], false]);
  assert.deepEqual(jobs(codeql), noJobs);
  const eslint = select(['eslint.config.mjs']);
  assert.deepEqual([eslint.testFiles, eslint.scriptTests], [[], ['scripts/check-eslint-config.test.mjs']]);
  assert.deepEqual(jobs(eslint), noJobs);
});

test('CI jobs are gated by their selection outputs', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  for (const [job, output] of [
    ['workflow-lint', 'workflows'], ['dependencies', 'dependencies'], ['dependency-review', 'dependencies'],
    ['build-artifacts', 'build'],
  ]) {
    assert.ok(workflow.jobs[job].needs.includes('test-scope'), job);
    assert.match(workflow.jobs[job].if, new RegExp(`needs\\.test-scope\\.outputs\\.${output} == 'true'`), job);
    assert.equal(workflow.jobs['test-scope'].outputs[output], `\${{ steps.scope.outputs.${output} }}`, output);
  }
});

test('dependency audit runs for every change that triggers CI and gates the build', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const audit = workflow.jobs['dependency-audit'];
  assert.equal(audit.if, undefined);
  assert.equal(audit.needs, undefined);
  assert.ok(audit.steps.some(step => step.run === 'npm audit --audit-level=moderate'));
  assert.ok(workflow.jobs.build.needs.includes('dependency-audit'));
  for (const job of ['typecheck', 'lint', 'dependencies']) {
    assert.equal(workflow.jobs[job].steps.some(step => step.run?.startsWith('npm audit')), false, job);
  }
});

test('WSL runs only the suites a change affects', () => {
  const codex = 'tests/integration/providers/codex/runtime/CodexWSL.windows.test.ts';
  const affected = select([codex]).wslSuites;
  assert.ok(affected.includes(codex));
  assert.equal(affected.includes('tests/integration/providers/deepseek/runtime/DeepSeekWSLHost.windows.test.ts'), false);
  assert.ok(affected.every(file => wslTests.includes(file)));
  assert.deepEqual(select(['.github/wsl/provision-rootfs.sh']).wslSuites, wslTests);
  assert.deepEqual(select(['package.json']).wslSuites, wslTests);
  assert.deepEqual(select(['src/features/chat/ClaudianView.ts'], [panel]).wslSuites, []);
});

test('CI starts independent checks immediately and runs affected WSL suites together in one job', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.jobs.quality, undefined);
  for (const job of ['typecheck', 'lint', 'dependency-audit', 'test-scope', 'diff-hygiene']) {
    assert.equal(workflow.jobs[job].needs, undefined, job);
  }
  assert.ok(workflow.jobs.typecheck.steps.some(step => step.run === 'npm run typecheck'));
  assert.ok(workflow.jobs.lint.steps.some(step => step.run === 'npm run lint'));
  const wsl = workflow.jobs['wsl-native'];
  assert.equal(wsl.strategy, undefined);
  const suites = wsl.steps.find(step => step.env?.WSL_TESTS);
  assert.equal(suites.env.WSL_TESTS, "${{ join(fromJSON(needs.test-scope.outputs.wsl-suites), ' ') }}");
  assert.equal(wsl.if, "needs.test-scope.outputs.wsl-windows == 'true'");
  for (const job of ['typecheck', 'lint']) assert.ok(workflow.jobs.build.needs.includes(job), job);
});
