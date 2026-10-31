import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { selectCiTests, selectRelatedCiTests } from './ciTestSelection.mjs';

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
    ['src/core/storage/VaultFileAdapter.ts', 'tests/unit/core/storage/VaultFileAdapter.test.ts'],
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
    'tests/integration/app/settings/RuntimeSettingsCoordinator.test.ts',
    'tests/integration/core/process/ManagedStdioProcess.test.ts',
    'tests/integration/core/process/ProcessProbe.test.ts',
    'tests/integration/core/process/cliBinaryLocator.test.ts',
    'tests/integration/core/process/execution-target/WSLCaptureCancellation.test.ts',
    'tests/integration/core/process/execution-target/WSLShellLaunch.test.ts',
    'tests/integration/core/process/loginShellPath.test.ts',
    'tests/integration/features/chat/tabs/forking/ForkSource.opencode-v2.test.ts',
    'tests/integration/features/chat/tabs/forking/ForkSource.opencode.test.ts',
    'tests/integration/providers/claude/execution/ClaudeExecutionBackend.test.ts',
    'tests/integration/providers/codex/execution/CodexExecutionBackend.protocol.test.ts',
    'tests/integration/providers/codex/execution/CodexExecutionBackend.test.ts',
    'tests/integration/providers/codex/runtime/CodexSharedRuntime.test.ts',
    'tests/integration/providers/deepseek/app/DeepSeekWorkspaceServices.test.ts',
    'tests/integration/providers/deepseek/runtime/DeepSeekCLIResolver.test.ts',
    'tests/integration/providers/deepseek/runtime/DeepSeekHostProcess.test.ts',
    'tests/integration/providers/deepseek/ui/DeepSeekSettingsTab.dom.test.ts',
    'tests/integration/providers/grok/app/GrokWorkspaceServices.test.ts',
    'tests/integration/providers/opencode/ToolRendererCompatibility.dom.test.ts',
    'tests/integration/providers/opencode/app/OpencodeCommandLoader.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeExecutionBackend.native.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.background.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.compaction.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.interactions.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.profiles.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.prompts.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.steering.test.ts',
    'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.ephemeral.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.history.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.test.ts',
    'tests/integration/providers/opencode/http/OpencodeSharedServer.transitions.test.ts',
    'tests/integration/providers/pi/execution/PiExecutionKernel.test.ts',
    'tests/integration/providers/pi/execution/PiRecoveryContext.test.ts',
    'tests/unit/providers/deepseek/runtime/DeepSeekInstallation.test.ts',
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
  assert.deepEqual(result.testFiles, [native]);
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
  assert.ok(fixture.testFiles.includes('tests/unit/providers/grok/history/GrokHistoryStore.test.ts'));
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
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.background.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.compaction.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.interactions.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.profiles.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.prompts.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.steering.test.ts',
          'tests/integration/providers/opencode/execution/OpencodeHTTPExecution.test.ts',
          'tests/integration/providers/opencode/history/OpencodeConversationHistoryService.test.ts',
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
          });
        });
      }
    }
  }

  test(`${name} selector retains full verification outside the known Codex fixture boundary`, () => {
    const full = {
      testFiles: null, scriptTests: null, crossPlatformTests: null,
      crossPlatform: true, piWindows: true, wslWindows: true,
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
  }
});

test('real dependency graph preserves prompt and provider coverage without Collab suites', () => {
  const relatedTests = JSON.parse(execFileSync(process.execPath, [
    'scripts/list-related-tests.mjs', 'src/core/prompt/mainAgent.ts',
  ], { encoding: 'utf8' })).map(file => file.split(path.sep).join('/'));
  assert.ok(relatedTests.some(file => file.endsWith('/core/prompt/mainAgent.systemPrompt.test.ts')));
  assert.ok(relatedTests.some(file => file.includes('/providers/')));
  assert.equal(relatedTests.some(file => /collab/i.test(file)), false);
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
    assert.deepEqual(scope(edited)['test-shards'], ['1/1']);
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
    assert.deepEqual(scope(deleted, { BASE_SHA: styled })['test-shards'], ['1/1']);
    for (const overrides of [
      { BASE_SHA: 'f'.repeat(40) }, { BASE_SHA: '0'.repeat(40) }, { BASE_SHA: '' },
      { GITHUB_REF: 'refs/tags/2.3.0' },
    ]) {
      const full = scope(deleted, overrides);
      assert.equal(full['test-files'], null);
      assert.deepEqual(full['test-shards'], ['1/2', '2/2']);
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

test('WSL native job follows shared dependencies and Codex users but skips unrelated UI', () => {
  const wsl = 'tests/integration/core/process/execution-target/WSLExecution.windows.test.ts';
  assert.equal(select([wsl]).wslWindows, true);
  assert.equal(select(['src/core/process/execution-target/TargetLaunchSpec.ts'], [wsl]).wslWindows, true);
  assert.equal(select(['src/providers/codex/runtime/CodexLaunchSpecBuilder.ts']).wslWindows, true);
  assert.equal(select(['src/features/chat/ClaudianView.ts'], [panel]).wslWindows, false);
  for (const file of [
    'src/core/process/execution-target/types.ts',
    'src/core/providers/settings/InstallationSettings.ts',
    'src/shared/settings/ExecutionTargetSettings.ts',
    'src/core/providers/cli/TargetCLIInstallationProbe.ts',
    'tests/integration/core/providers/cli/TargetCLIInstallationProbe.test.ts',
    'tests/unit/core/providers/settings/InstallationSettings.test.ts',
    'tests/integration/providers/codex/ui/CodexCLIPath.dom.test.ts',
    // Siblings that do not exist yet still match the declared owner prefixes.
    'tests/integration/shared/settings/ExecutionTargetSettings.dom.test.ts',
    'tests/unit/core/providers/settings/InstallationSettings.migration.test.ts',
    'src/core/providers/settings/InstallationSettingsMigration.ts',
  ]) {
    const selection = select([file]);
    assert.equal(selection.wslWindows, true, file);
    assert.ok(selection.testFiles.includes(wsl), `${file} must select the declared WSL consumer`);
  }
  assert.equal(selectRelatedCiTests({ changes: [{ status: 'M', path: 'src/core/process/execution-target/WSLEnvironment.ts' }] }).wslWindows, true);
});
