import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import spawn from 'cross-spawn';

import { readTestDeclarations } from './testDeclarations.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scopes = {
  history: 'src/providers/codex/history/CodexHistoryStore.ts',
  sessions: 'src/features/chat/sessions/SessionRuntimePool.ts',
  settings: 'src/app/settings/SettingsCoordinator.ts',
};
const localStorageArg = `--localstorage-file=${path.join(tmpdir(), 'claudian-mutation-localstorage')}`;
const slash = file => file.split(path.sep).join('/');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function parseMutationArgs(args, directory = root) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const files = new Set();
  let incremental = false;
  for (const argument of args) {
    if (argument === '--incremental') {
      incremental = true;
      continue;
    }
    const file = slash(path.relative(directory, path.resolve(directory, scopes[argument] ?? argument)));
    if (!/^src\/.*\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file) || file.endsWith('.d.ts')
      || !existsSync(path.join(directory, file)) || !statSync(path.join(directory, file)).isFile()) {
      throw new Error(`Expected a scope (${Object.keys(scopes).join(', ')}) or an existing src/ file: ${argument}`);
    }
    files.add(file);
  }
  if (!files.size) throw new Error('Choose at least one scope or src/ file. Run npm run mutation -- --help.');
  return { files: [...files], incremental };
}

export function selectMutationTests(file, related, consumers) {
  const selected = new Set(related);
  for (const [input, tests] of consumers) {
    if (path.posix.matchesGlob(file, input)) tests.forEach(test => selected.add(test));
  }
  for (const test of selected) {
    if (!/^tests\/(?:unit|integration)\/.*\.test\.ts$/.test(test)) {
      throw new Error(`Mutation selection is outside tests/: ${test}`);
    }
  }
  if (!selected.size) throw new Error(`No related tests for ${file}`);
  return [...selected].sort();
}

export function createMutationVitestConfig(base, selected, directory) {
  return {
    ...base,
    root: directory,
    cacheDir: path.join(directory, '.mutation/vite'),
    test: {
      ...base.test,
      // Stryker links node_modules; its transformed cache must stay in its sandbox.
      fsModuleCachePath: path.join(directory, '.mutation/modules'),
      include: selected,
      projects: undefined,
      pool: 'forks',
      maxWorkers: 1,
      sequence: { ...base.test?.sequence, setupFiles: 'list' },
    },
  };
}

export function createMutationConfig({ file, vitestConfig, plugin, reportDirectory,
  sandboxDirectory, incrementalFile, incremental }) {
  return {
    mutate: [file],
    testRunner: 'vitest',
    plugins: [plugin],
    // Stryker testFiles forces runtime activation, even for static mutants.
    // Selection belongs in the generated Vitest include instead.
    vitest: { configFile: vitestConfig, pool: 'forks', related: false },
    coverageAnalysis: 'perTest',
    concurrency: 2,
    reporters: ['clear-text', 'json', 'html'],
    jsonReporter: { fileName: path.join(reportDirectory, 'mutation.json') },
    htmlReporter: { fileName: path.join(reportDirectory, 'mutation.html') },
    thresholds: { break: 0 },
    timeoutMS: 3000,
    timeoutFactor: 1.5,
    dryRunTimeoutMinutes: 15,
    testRunnerNodeArgs: [localStorageArg],
    tempDirName: sandboxDirectory,
    cleanTempDir: true,
    incremental,
    incrementalFile,
    ignorePatterns: ['.mutation', '.context', '.agents', '.claude', '.env*', 'build', 'dist', '/main.js',
      '/styles.css', 'coverage', 'test-results', '*.log', '.codex-vendor'],
  };
}

export function summarizeMutationReport(report) {
  const files = [];
  const survivors = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const statuses = {};
    for (const mutant of mutants) {
      statuses[mutant.status] = (statuses[mutant.status] ?? 0) + 1;
      if (mutant.status === 'Survived') {
        survivors.push({ file, id: mutant.id, line: mutant.location.start.line,
          column: mutant.location.start.column, replacement: mutant.replacement });
      }
    }
    files.push({ file, statuses });
  }
  return { files, survivors };
}

function run(command, args, directory) {
  const result = spawn.sync(command, args, { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

function installTools() {
  const manifestDirectory = path.join(root, 'scripts/mutation');
  const version = hash(readFileSync(path.join(manifestDirectory, 'package.json'), 'utf8')
    + readFileSync(path.join(manifestDirectory, 'package-lock.json'), 'utf8'));
  const directory = path.join(root, '.mutation/tools', version);
  const ready = path.join(directory, '.ready');
  if (!existsSync(ready)) {
    mkdirSync(directory, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      copyFileSync(path.join(manifestDirectory, file), path.join(directory, file));
    }
    console.log(`Installing pinned mutation tools in ${directory}`);
    // Reuse the root Vitest peer; neither root lockfile is changed.
    run('npm', ['ci', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
    writeFileSync(ready, `${version}\n`);
  }
  return directory;
}

function main() {
  const options = parseMutationArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: npm run mutation -- <scope|src/file.ts>... [--incremental]

Scopes: ${Object.keys(scopes).join(', ')}
Runs locally only; the first run installs pinned Stryker tools under .mutation/.
Tools, temporary sandboxes, JSON/HTML reports and incremental state stay there.
Tests are selected by Vitest imports plus @test-ci inputs. Each source runs separately.
--incremental reuses Stryker's prior results for that source. Omit it for a fresh audit.
Survivors are reported for review; they do not make the command fail.`);
    return;
  }
  if (process.env.CI && process.env.CI !== 'false') throw new Error('Mutation testing is a local-only command.');
  const { fileConsumers } = readTestDeclarations(root);
  const selections = options.files.map(file => {
    const related = JSON.parse(execFileSync(process.execPath,
      [localStorageArg, path.join(root, 'scripts/list-related-tests.mjs'), path.join(root, file)],
      { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
    return { file, tests: selectMutationTests(file,
      related.map(test => slash(path.relative(root, test))), fileConsumers) };
  });
  const toolsDirectory = installTools();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const reports = path.join(root, '.mutation/reports', runId);
  const summary = { files: [], survivors: [] };
  for (const { file, tests } of selections) {
    const key = `${path.basename(file, path.extname(file))}-${hash(file)}`;
    const reportDirectory = path.join(reports, key);
    mkdirSync(reportDirectory, { recursive: true });
    const vitestConfig = path.join(reportDirectory, 'vitest.config.mjs');
    writeFileSync(vitestConfig, `import base from ${JSON.stringify(pathToFileURL(path.join(root, 'vitest.config.mts')).href)};
import { createMutationVitestConfig } from ${JSON.stringify(import.meta.url)};
export default createMutationVitestConfig(base, ${JSON.stringify(tests)}, process.cwd());
`);
    const configFile = path.join(reportDirectory, 'stryker.config.json');
    writeFileSync(configFile, JSON.stringify(createMutationConfig({
      file, vitestConfig, reportDirectory,
      plugin: path.join(toolsDirectory, 'node_modules/@stryker-mutator/vitest-runner/dist/src/index.js'),
      sandboxDirectory: path.join(root, '.mutation/sandboxes', runId, key),
      incremental: options.incremental,
      incrementalFile: path.join(root, '.mutation/incremental', `${key}.json`),
    }), null, 2));
    console.log(`\nMutating ${file} with ${tests.length} related suites`);
    run(process.execPath, [localStorageArg,
      path.join(toolsDirectory, 'node_modules/@stryker-mutator/core/bin/stryker.js'),
      'run', configFile], root);
    const result = summarizeMutationReport(JSON.parse(readFileSync(path.join(reportDirectory, 'mutation.json'), 'utf8')));
    summary.files.push(...result.files);
    summary.survivors.push(...result.survivors);
    writeFileSync(path.join(reports, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const lines = summary.files.map(({ file: source, statuses }) =>
      `${source}: ${Object.entries(statuses).map(([status, count]) => `${status}=${count}`).join(', ')}`);
    lines.push(...summary.survivors.map(item =>
      `Survived ${item.file}:${item.line}:${item.column} #${item.id}: ${JSON.stringify(item.replacement)}`));
    writeFileSync(path.join(reports, 'summary.txt'), `${lines.join('\n')}\n`);
  }
  console.log(`\nMutation reports and survivor summary: ${reports}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
