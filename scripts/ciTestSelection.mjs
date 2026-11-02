import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import suites from './testSuites.cjs';

const docsTest = 'tests/unit/docs/Documentation.test.ts';
export const wslTests = [
  'tests/integration/core/process/execution-target/ClaudeWSL.windows.test.ts',
  'tests/integration/core/process/execution-target/WSLExecution.windows.test.ts',
  'tests/integration/core/process/execution-target/WSLSessionToolRelay.windows.test.ts',
  'tests/integration/providers/deepseek/runtime/DeepSeekWSLHost.windows.test.ts',
  'tests/integration/providers/opencode/runtime/OpencodeWSL.windows.test.ts',
  'tests/integration/providers/codex/runtime/CodexWSL.windows.test.ts',
  'tests/integration/providers/grok/runtime/GrokWSL.windows.test.ts',
];
const fullSelection = {
  testFiles: null, scriptTests: null, crossPlatformTests: null,
  crossPlatform: true, piWindows: true, wslWindows: true, wslSuites: wslTests,
  build: true, dependencies: true, workflows: true,
};
const piTest = 'tests/integration/providers/pi/runtime/PiSubprocess.windows.test.ts';
// ci.yml mirrors this list as paths-ignore, so changes limited to these paths skip CI entirely.
// Node's `**` skips dot directories while GitHub's does not, so `.github/*.md` is listed explicitly.
export const documentationPaths = ['**/*.md', '.github/*.md', '.github/ISSUE_TEMPLATE/**', 'assets/**', 'docs/**', 'LICENSE'];
const isDocumentation = file => documentationPaths.some(pattern => path.posix.matchesGlob(file, pattern));
const isVitestTest = file => /^tests\/(?:unit|integration)\/.*\.test\.ts$/.test(file);
const isGraphInput = file => /^(?:src|tests)\/.*\.(?:[cm]?[jt]sx?|json)$/.test(file);
// Repository automation (`.github/`) is never bundled; ci.yml itself is a global input.
const isAutomation = file => file.startsWith('.github/');
const isWorkflow = file => file.startsWith('.github/workflows/');
const isBuildInput = file => !isDocumentation(file) && !isAutomation(file) && !file.startsWith('tests/')
  && !/^scripts\/.*\.test\.mjs$/.test(file) && file !== 'eslint.config.mjs';
// Inputs to the lockfile parity check; other manifest and lockfile edits already select everything.
const dependencyInputs = new Set(['scripts/check-lockfile-parity.mjs']);
const architectureTest = 'scripts/check-architecture-boundaries.test.mjs';

// Runtime imports drive related selection; declarations supply non-import edges.
const { fileConsumers } = suites;
const matchesInput = (file, pattern) => path.posix.matchesGlob(file, pattern);
const scriptConsumers = new Map(suites.scriptTests.flatMap(file => [
  [file, file], [file.replace('.test.mjs', '.mjs'), file],
]));
const globalInputs = new Set([
  'src/main.ts', 'tests/setupWindow.ts', 'scripts/ciTestSelection.mjs', '.github/workflows/ci.yml',
  'scripts/run-tests.js', 'scripts/run-vitest.js', 'scripts/run-cross-platform-tests.js',
  'scripts/testSuites.cjs', 'scripts/testDeclarations.cjs', 'scripts/list-related-tests.mjs', 'scripts/vitestMetadataReporter.mjs',
]);

export function selectCiTests({ changes, relatedTests, eventName }) {
  if (!['pull_request', 'push'].includes(eventName)) return { ...fullSelection };
  const files = new Set(relatedTests);
  const scripts = new Set();
  let wslProvisioning = false;
  for (const { status, path: file } of changes) {
    if (globalInputs.has(file)) return { ...fullSelection };
    if (status === 'D' && !isVitestTest(file) && !isDocumentation(file) && !isAutomation(file)) return { ...fullSelection };
    if (file.startsWith('tests/fixtures/') && !isDocumentation(file)
      && !file.endsWith('.json') && !fileConsumers.some(([pattern]) => matchesInput(file, pattern))) return { ...fullSelection };
    if (isVitestTest(file)) {
      if (status !== 'D') files.add(file);
    } else if (isDocumentation(file)) {
      files.add(docsTest);
    } else if (scriptConsumers.has(file)) {
      scripts.add(scriptConsumers.get(file));
    } else if (isWorkflow(file)) {
      // The architecture check validates npm commands invoked by every workflow.
      scripts.add(architectureTest);
    } else if (file.startsWith('.github/wsl/')) {
      wslProvisioning = true;
    } else if (file.startsWith('.github/codeql/')) {
      // Only the scheduled CodeQL workflow reads its configuration.
    } else if (file === 'eslint.config.mjs') {
      scripts.add('scripts/check-eslint-config.test.mjs');
    } else if (!isGraphInput(file) && !fileConsumers.some(([pattern]) => matchesInput(file, pattern))) {
      return { ...fullSelection };
    }
    if (/^tests\/.*\.[cm]?[jt]sx?$/.test(file) && !isVitestTest(file)) {
      scripts.add('scripts/testDeclarations.test.mjs');
    }
    if (/^(?:src\/.*\.[jt]sx?|tests\/.*\.ts|.*\/(?:AGENTS|CLAUDE)\.md|AGENTS\.md|CLAUDE\.md)$/.test(file)) {
      scripts.add(architectureTest);
    }
  }
  for (const file of [...changes.map(change => change.path), ...relatedTests]) {
    for (const [pattern, consumers] of fileConsumers) {
      if (matchesInput(file, pattern)) consumers.forEach(consumer => files.add(consumer));
    }
  }
  for (const { status, path: file } of changes) {
    if (status === 'D') files.delete(file);
  }
  const testFiles = [...files];
  const crossPlatformTests = suites.crossPlatformTests.filter(file => files.has(file));
  const piWindows = files.has(piTest);
  const wslSuites = wslProvisioning ? wslTests : wslTests.filter(file => files.has(file));
  return {
    testFiles, scriptTests: [...scripts], crossPlatformTests,
    crossPlatform: crossPlatformTests.length > 0 || piWindows
      || scripts.has('scripts/ciTestSelection.test.mjs') || scripts.has('scripts/run-tests.test.mjs')
      || changes.some(change => change.path === 'scripts/testDeclarations.test.mjs'),
    piWindows,
    wslWindows: wslSuites.length > 0,
    wslSuites,
    build: changes.some(change => isBuildInput(change.path)),
    dependencies: changes.some(change => dependencyInputs.has(change.path)),
    workflows: changes.some(change => isWorkflow(change.path)),
  };
}

// A full run fills four runners; smaller selections stop adding runners once a shard
// would hold fewer suites than its fixed setup and Vitest startup cost justify.
const fullVitestShards = 4;
const suitesPerShard = 200;

// Script checks run on their own runner so they overlap the Vitest shards.
export function ciTestLanes({ testFiles, scriptTests }) {
  const shards = testFiles === null ? fullVitestShards
    : Math.min(fullVitestShards, Math.ceil(testFiles.length / suitesPerShard));
  return [
    ...Array.from({ length: shards }, (_, index) => `${index + 1}/${shards}`),
    ...(scriptTests === null || scriptTests.length > 0 ? ['scripts'] : []),
  ];
}

export function selectRelatedCiTests({ changes, eventName = 'pull_request' }) {
  let selection = selectCiTests({ changes, relatedTests: [], eventName });
  const inputs = changes.filter(change => change.status !== 'D' && isGraphInput(change.path))
    .map(change => change.path);
  if (selection.testFiles !== null && inputs.length > 0) {
    const relatedTests = JSON.parse(execFileSync(process.execPath, [
      'scripts/list-related-tests.mjs', ...inputs,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
      .map(file => path.relative(realpathSync.native(process.cwd()), realpathSync.native(file)).split(path.sep).join('/'));
    selection = selectCiTests({ changes, relatedTests, eventName });
  }
  return selection;
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const { BASE_SHA: base, HEAD_SHA: head } = process.env;
  let selection = { ...fullSelection };
  // Tag pushes include reusable release verification and always retain the full suite.
  if (['pull_request', 'push'].includes(eventName) && !process.env.GITHUB_REF?.startsWith('refs/tags/')
    && base && head && !/^0+$/.test(base)) {
    let entries;
    try {
      entries = execFileSync('git', [
        'diff', '--name-status', '-z', '--no-renames', eventName === 'pull_request' ? `${base}...${head}` : base,
        ...(eventName === 'push' ? [head] : []),
      ], { encoding: 'utf8' }).split('\0');
    } catch {
      // A missing/force-pushed base cannot safely narrow coverage.
      entries = undefined;
    }
    if (entries) {
      entries.pop();
      const changes = [];
      for (let index = 0; index < entries.length; index += 2) {
        changes.push({ status: entries[index], path: entries[index + 1] });
      }
      selection = selectRelatedCiTests({ changes, eventName });
    }
  }
  const lanes = ciTestLanes(selection);
  const output = [
    `test-files=${JSON.stringify(selection.testFiles)}`,
    `test-lanes=${JSON.stringify(lanes)}`,
    `script-tests=${JSON.stringify(selection.scriptTests)}`,
    `cross-platform-tests=${JSON.stringify(selection.crossPlatformTests)}`,
    `cross-platform=${selection.crossPlatform}`,
    `pi-windows=${selection.piWindows}`,
    `wsl-windows=${selection.wslWindows}`,
    `has-tests=${lanes.length > 0}`,
    `wsl-suites=${JSON.stringify(selection.wslSuites)}`,
    `build=${selection.build}`,
    `dependencies=${selection.dependencies}`,
    `workflows=${selection.workflows}`,
  ].join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  console.log(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
