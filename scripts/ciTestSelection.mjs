import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import suites from './testSuites.cjs';

const fullSelection = {
  testFiles: null, scriptTests: null, crossPlatformTests: null,
  crossPlatformShards: ['1/2', '2/2'],
  crossPlatform: true, piWindows: true,
};
const docsTest = 'tests/unit/docs/Documentation.test.ts';
const piTest = 'tests/integration/providers/pi/runtime/PiSubprocess.windows.test.ts';
const isDocumentation = file => file.endsWith('.md') || file.startsWith('docs/');
const isJestTest = file => /^tests\/(?:unit|integration)\/.*\.test\.ts$/.test(file);
const isGraphInput = file => /^(?:src|tests)\/.*\.(?:[cm]?[jt]sx?|json)$/.test(file);

// These consumers read files through fs rather than imports, so Jest cannot find their edges.
const fileConsumers = [
  [/^src\/i18n\/locales\/.*\.json$/, ['tests/integration/build/dependency-envelope.test.ts']],
  [/^src\/style\//, [
    'tests/unit/style/components/code.test.ts',
    'tests/unit/style/components/messages.test.ts',
    'tests/unit/features/chat/tabs/TabAttentionStyles.test.ts',
  ]],
  [/^tests\/fixtures\/providers\/grok\/history\//, [
    'tests/unit/providers/grok/history/GrokConversationHistoryService.test.ts',
    'tests/unit/providers/grok/history/GrokHistoryStore.test.ts',
  ]],
];
const scriptConsumers = new Map(suites.scriptTests.flatMap(file => [
  [file, file], [file.replace('.test.mjs', '.mjs'), file],
]));
const globalInputs = new Set([
  'src/main.ts', 'tests/setupWindow.ts', 'scripts/ciTestSelection.mjs',
  'scripts/run-tests.js', 'scripts/run-jest.js', 'scripts/run-cross-platform-tests.js',
  'scripts/testSuites.cjs', 'tests/tsconfig.json',
]);

export function selectCiTests({ changes, relatedTests, eventName }) {
  if (!['pull_request', 'push'].includes(eventName)) return { ...fullSelection };
  const files = new Set(relatedTests);
  const scripts = new Set();
  for (const { status, path: file } of changes) {
    if (status === 'D' && !isJestTest(file) && !isDocumentation(file)) return { ...fullSelection };
    if (file.startsWith('tests/fixtures/') && !isDocumentation(file)
      && !file.endsWith('.json') && !fileConsumers.some(([pattern]) => pattern.test(file))) return { ...fullSelection };
    if (globalInputs.has(file)) return { ...fullSelection };
    if (isJestTest(file)) {
      if (status !== 'D') files.add(file);
    } else if (isDocumentation(file)) {
      files.add(docsTest);
    } else if (scriptConsumers.has(file)) {
      scripts.add(scriptConsumers.get(file));
    } else if (!isGraphInput(file) && !fileConsumers.some(([pattern]) => pattern.test(file))) {
      return { ...fullSelection };
    }
    if (/^(?:src\/.*\.[jt]sx?|tests\/.*\.ts|.*\/(?:AGENTS|CLAUDE)\.md|AGENTS\.md|CLAUDE\.md)$/.test(file)) {
      scripts.add('scripts/check-architecture-boundaries.test.mjs');
    }
  }
  for (const file of [...changes.map(change => change.path), ...relatedTests]) {
    for (const [pattern, consumers] of fileConsumers) {
      if (pattern.test(file)) consumers.forEach(consumer => files.add(consumer));
    }
  }
  for (const { status, path: file } of changes) {
    if (status === 'D') files.delete(file);
  }
  const testFiles = [...files];
  const crossPlatformTests = suites.crossPlatformTests.filter(file => files.has(file));
  const piWindows = files.has(piTest);
  return {
    testFiles, scriptTests: [...scripts], crossPlatformTests,
    crossPlatformShards: crossPlatformTests.length > 1 ? ['1/2', '2/2'] : ['1/1'],
    crossPlatform: crossPlatformTests.length > 0 || piWindows
      || scripts.has('scripts/ciTestSelection.test.mjs') || scripts.has('scripts/run-tests.test.mjs'),
    piWindows,
  };
}

export function selectRelatedCiTests({ changes, eventName = 'pull_request' }) {
  let selection = selectCiTests({ changes, relatedTests: [], eventName });
  const inputs = changes.filter(change => change.status !== 'D' && isGraphInput(change.path))
    .map(change => change.path);
  if (selection.testFiles !== null && inputs.length > 0) {
    const relatedTests = JSON.parse(execFileSync(process.execPath, [
      'scripts/run-jest.js', '--listTests', '--json', '--findRelatedTests', ...inputs,
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
  const output = [
    `test-files=${JSON.stringify(selection.testFiles)}`,
    `test-shards=${JSON.stringify(selection.testFiles === null ? ['1/2', '2/2'] : ['1/1'])}`,
    `script-tests=${JSON.stringify(selection.scriptTests)}`,
    `cross-platform-tests=${JSON.stringify(selection.crossPlatformTests)}`,
    `cross-platform-shards=${JSON.stringify(selection.crossPlatformShards)}`,
    `cross-platform=${selection.crossPlatform}`,
    `pi-windows=${selection.piWindows}`,
    `has-tests=${selection.testFiles === null || selection.testFiles.length > 0
      || selection.scriptTests === null || selection.scriptTests.length > 0}`,
  ].join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  console.log(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
