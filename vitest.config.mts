import { existsSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const parallelism = availableParallelism?.() ?? cpus().length;
const maxWorkers = Math.max(1, Math.floor(parallelism / 2));
const testFiles = ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'];
const processFiles = [
  // Worker threads cannot change process.umask.
  'tests/integration/app/storage/JSONCommitDurability.test.ts',
  // Keep createRequire and the production loader on the same CommonJS cache.
  'tests/unit/i18n/i18n.test.ts',
  // The structuredClone polyfill returns arrays in the native V8 realm.
  'tests/integration/features/chat/composer/PromptHistoryNavigation.dom.test.ts',
  // Pending native history I/O outlives a VM context's teardown.
  'tests/integration/providers/codex/execution/CodexExecutionBackend.protocol.test.ts',
];

for (const file of processFiles) {
  if (!existsSync(resolve(file))) throw new Error(`Missing process-pool test: ${file}`);
}

export default defineConfig({
  // Preserve assignment fields, including declarations inherited from a base class.
  oxc: {
    target: 'esnext',
    assumptions: { setPublicClassFields: true },
    typescript: { removeClassFieldsWithoutInitializer: true },
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve('src')}/` },
      { find: /^@test\//, replacement: `${resolve('tests')}/` },
      { find: /^obsidian$/, replacement: resolve('tests/__mocks__/obsidian.ts') },
      { find: /^@anthropic-ai\/claude-agent-sdk(?:\/core)?$/, replacement: resolve('tests/__mocks__/claude-agent-sdk.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    maxWorkers,
    execArgv: [`--localstorage-file=${join(tmpdir(), 'claudian-localstorage')}`],
    // Preserve mock history and hook registration order.
    clearMocks: false,
    sequence: { hooks: 'list' },
    taskTitleValueFormatTruncate: 0,
    setupFiles: ['tests/setupWindow.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'json', 'clover'],
    },
    // Vite merges inherited include arrays; each pool must own disjoint globs.
    include: [],
    projects: [
      { extends: true, test: { name: 'process', pool: 'forks', include: processFiles } },
      {
        extends: true,
        test: {
          name: 'suite',
          // Reuse workers while retaining a fresh VM context/module graph per file.
          pool: 'vmThreads',
          include: testFiles,
          exclude: processFiles,
        },
      },
    ],
  },
});
