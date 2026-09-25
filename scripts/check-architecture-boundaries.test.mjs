import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import {
  evaluationIndicatorMs,
  evaluationReviewThresholdMs,
  inspectArtifactSize,
  inspectEvaluationDuration,
  inspectPluginArtifactReferences,
  mainBudgetBytes,
  referenceMainBytes,
  preStep11BundleHealthBaselineBytes,
} from './check-startup-performance.mjs';
import {
  bundleCriticalRuntimeDependencies,
  inspectRuntimeDependencyParity,
  parseBunLock,
} from './runtimeDependencyParity.mjs';

function listTypeScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

function normalizeRepositoryPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function findMatches(roots, pattern) {
  const matches = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      if (pattern.test(fs.readFileSync(file, 'utf8'))) {
        matches.push(normalizeRepositoryPath(path.relative(process.cwd(), file)));
      }
    }
  }
  return matches;
}

function listSourceImports(file, sourceText = fs.readFileSync(file, 'utf8')) {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = [];

  function addImport(moduleSpecifier, options = {}) {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile));
    imports.push({
      dynamic: options.dynamic === true,
      line: line + 1,
      specifier: moduleSpecifier.text,
      typeOnly: options.typeOnly === true,
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      addImport(node.moduleSpecifier, { typeOnly: node.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(node)) {
      addImport(node.moduleSpecifier, { typeOnly: node.isTypeOnly === true });
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addImport(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        addImport(node.arguments[0], { dynamic: isDynamicImport });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function resolveSourceImport(importer, specifier) {
  if (specifier.startsWith('@/')) {
    return path.resolve(sourceRoot, specifier.slice(2));
  }
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(importer), specifier);
  }
  return null;
}

function isPathWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeModuleTarget(target) {
  return target.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function resolvedImportKey(importer, target) {
  return `${path.normalize(importer)}::${normalizeModuleTarget(path.normalize(target))}`;
}

function resolveTypeScriptImport(importer, specifier) {
  const target = resolveSourceImport(importer, specifier);
  if (!target) return null;
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    ?? null;
}

function findResolvedImportViolations(roots, isForbidden, allowedImports = new Set()) {
  const violations = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      for (const sourceImport of listSourceImports(file)) {
        const target = resolveSourceImport(file, sourceImport.specifier);
        if (
          !target
          || !isForbidden(target)
          || allowedImports.has(resolvedImportKey(file, target))
        ) {
          continue;
        }
        violations.push(
          `${path.relative(process.cwd(), file)}:${sourceImport.line}`
          + ` imports ${sourceImport.specifier} -> ${path.relative(process.cwd(), target)}`,
        );
      }
    }
  }
  return violations;
}

const sourceRoot = path.join(process.cwd(), 'src');
const appRoot = path.join(sourceRoot, 'app');
const compositionRoot = path.join(sourceRoot, 'composition');
const featuresRoot = path.join(sourceRoot, 'features');
const providersRoot = path.join(sourceRoot, 'providers');

function listConcreteProviderNames() {
  return fs.readdirSync(providersRoot, { withFileTypes: true })
    .filter(entry => (
      entry.isDirectory()
      && fs.existsSync(path.join(providersRoot, entry.name, 'registration.ts'))
    ))
    .map(entry => entry.name)
    .sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const concreteProviderNames = listConcreteProviderNames();
const concreteProviderPathPattern = new RegExp(
  `providers/(?:${concreteProviderNames.map(escapeRegExp).join('|')})(?:/|['"])`,
);
const allowedAppProviderImports = new Set([
  resolvedImportKey(
    path.join(appRoot, 'settings', 'defaultSettings.ts'),
    path.join(providersRoot, 'defaultProviderConfigs'),
  ),
]);

test('repository paths use POSIX separators for stable cross-platform comparison', () => {
  assert.equal(normalizeRepositoryPath('src\\main.ts'), 'src/main.ts');
  assert.equal(normalizeRepositoryPath('src/main.ts'), 'src/main.ts');
});

test('concrete provider pattern covers every registered provider directory', () => {
  assert.notEqual(concreteProviderNames.length, 0);
  for (const providerName of concreteProviderNames) {
    assert.match(`providers/${providerName}/registration`, concreteProviderPathPattern);
  }
});

test('source import resolution distinguishes provider-local app from root app', () => {
  const importer = path.join(providersRoot, 'example', 'ui', 'SettingsTab.ts');
  const providerLocalApp = resolveSourceImport(importer, '../app/WorkspaceServices');
  const rootApp = resolveSourceImport(importer, '../../../app/settings/defaultSettings');

  assert.equal(providerLocalApp, path.join(providersRoot, 'example', 'app', 'WorkspaceServices'));
  assert.equal(isPathWithin(providerLocalApp, appRoot), false);
  assert.equal(rootApp, path.join(appRoot, 'settings', 'defaultSettings'));
  assert.equal(isPathWithin(rootApp, appRoot), true);
  assert.equal(resolveSourceImport(importer, '@/app/settings/defaultSettings'), rootApp);
});

test('core is independent from main, features, and concrete providers', () => {
  const pattern = new RegExp(
    `from\\s+['"][^'"]*(?:main['"]|features/|${concreteProviderPathPattern.source})`,
  );
  assert.deepEqual(findMatches([path.join(sourceRoot, 'core')], pattern), []);
});

test('core is independent from root application adapters', () => {
  assert.deepEqual(findResolvedImportViolations(
    [path.join(sourceRoot, 'core')],
    target => isPathWithin(target, appRoot),
  ), []);
});

test('providers are independent from main and features', () => {
  const pattern = /from\s+['"][^'"]*(?:main['"]|features\/)/;
  assert.deepEqual(findMatches([path.join(sourceRoot, 'providers')], pattern), []);
});

test('providers avoid root app imports', () => {
  assert.deepEqual(findResolvedImportViolations(
    [providersRoot],
    target => isPathWithin(target, appRoot),
  ), []);
});

test('app avoids features and provider implementations outside default assembly', () => {
  assert.deepEqual(findResolvedImportViolations(
    [appRoot],
    target => isPathWithin(target, featuresRoot) || isPathWithin(target, providersRoot),
    allowedAppProviderImports,
  ), []);
});

test('features are independent from the composition root and app adapters', () => {
  const pattern = /from\s+['"][^'"]*(?:main['"]|app\/)/;
  assert.deepEqual(findMatches([path.join(sourceRoot, 'features')], pattern), []);
});

test('only main and composition modules import composition wiring', () => {
  const roots = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'composition')
    .map(entry => path.join(sourceRoot, entry.name));
  assert.deepEqual(findResolvedImportViolations(
    roots,
    target => isPathWithin(target, compositionRoot),
  ), []);
});

test('no source module imports the composition root', () => {
  const roots = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(sourceRoot, entry.name));
  assert.deepEqual(findResolvedImportViolations(
    roots,
    target => normalizeModuleTarget(target) === path.join(sourceRoot, 'main'),
  ), []);
});

test('composition modules do not import main or concrete providers', () => {
  assert.deepEqual(findResolvedImportViolations(
    [compositionRoot],
    target => (
      normalizeModuleTarget(target) === path.join(sourceRoot, 'main')
      || isPathWithin(target, providersRoot)
    ),
  ), []);
});


test('features and shared UI are independent from concrete providers', () => {
  const pattern = new RegExp(
    `from\\s+['"][^'"]*${concreteProviderPathPattern.source}`,
  );
  assert.deepEqual(findMatches([
    path.join(sourceRoot, 'features'),
    path.join(sourceRoot, 'shared'),
  ], pattern), []);
});

test('the shared FeatureHost contract does not depend on chat', () => {
  const featureHostFile = path.join(featuresRoot, 'FeatureHost.ts');
  const violations = listSourceImports(featureHostFile)
    .filter(sourceImport => {
      const target = resolveSourceImport(featureHostFile, sourceImport.specifier);
      return target !== null && isPathWithin(target, path.join(featuresRoot, 'chat'));
    })
    .map(sourceImport => `${sourceImport.line}: ${sourceImport.specifier}`);
  assert.deepEqual(violations, []);
});



test('persisted settings changes use the coordinator boundary', () => {
  const matches = findMatches([sourceRoot], /\.saveSettings\(\)/).filter(file => ![
    'src/main.ts',
  ].includes(file));
  assert.deepEqual(matches, []);
});

test('runtime command discovery cannot import shared skill management', () => {
  const roots = [
    path.join(sourceRoot, 'features', 'chat'),
    path.join(sourceRoot, 'shared', 'components'),
    ...concreteProviderNames.flatMap(provider => [
      path.join(sourceRoot, 'providers', provider, 'app'),
      path.join(sourceRoot, 'providers', provider, 'commands'),
    ]).filter(fs.existsSync),
  ];
  const pattern = /from\s+['"][^'"]*(?:core\/skills|AgentSkillSettings)/;
  assert.deepEqual(findMatches(roots, pattern), []);
});

test('renderer source does not import AsyncLocalStorage', () => {
  const pattern = /import\s*\{[^}]*\bAsyncLocalStorage\b[^}]*\}\s*from\s*['"](?:node:)?async_hooks['"]/s;
  assert.deepEqual(findMatches([sourceRoot], pattern), []);
});

test('tab runtime construction stays private to the factory boundary', () => {
  const chatRoot = path.join(featuresRoot, 'chat');
  const tabsRoot = path.join(chatRoot, 'tabs');
  const tabSource = path.join(tabsRoot, 'Tab.ts');
  const factorySource = path.join(featuresRoot, 'chat', 'tabs', 'TabRuntimeFactory.ts');
  const runtimeRoot = path.join(tabsRoot, 'runtime');
  const assemblySymbol = ['assemble', 'TabRuntime'].join('');
  const assemblyReferences = findMatches(
    [sourceRoot],
    new RegExp(`\\b${assemblySymbol}\\b`),
  ).sort();

  assert.deepEqual(assemblyReferences, [
    normalizeRepositoryPath(path.relative(process.cwd(), factorySource)),
  ]);
  assert.equal(fs.existsSync(tabSource), false);

  const factory = fs.readFileSync(factorySource, 'utf8');
  assert.match(factory, new RegExp(`\\bfunction\\s+${assemblySymbol}\\b`));
  assert.doesNotMatch(
    factory,
    new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${assemblySymbol}\\b`),
  );

  const internalImportViolations = [];
  const factoryImportViolations = [];
  for (const file of listTypeScriptFiles(sourceRoot)) {
    for (const sourceImport of listSourceImports(file)) {
      const target = resolveSourceImport(file, sourceImport.specifier);
      if (!target) continue;
      if (
        isPathWithin(target, runtimeRoot)
        && file !== factorySource
        && !isPathWithin(file, runtimeRoot)
      ) {
        internalImportViolations.push(
          `${path.relative(process.cwd(), file)}:${sourceImport.line} -> ${sourceImport.specifier}`,
        );
      }
      if (
        isPathWithin(file, runtimeRoot)
        && normalizeModuleTarget(target) === normalizeModuleTarget(factorySource)
      ) {
        factoryImportViolations.push(
          `${path.relative(process.cwd(), file)}:${sourceImport.line} -> ${sourceImport.specifier}`,
        );
      }
    }
  }
  assert.deepEqual(internalImportViolations, []);
  assert.deepEqual(factoryImportViolations, []);

  const retiredConstructionExports = findMatches(
    [chatRoot],
    /export\s+(?:async\s+)?function\s+(?:createTab|initializeTabUI|initializeTabControllers|wireTabInputEvents)\b/,
  );
  assert.deepEqual(retiredConstructionExports, []);

  for (const retiredConstructionHelper of [
    'ReadyTabData',
    'setControllers',
    'setUI',
  ]) {
    assert.deepEqual(
      findMatches([chatRoot], new RegExp(`\\b${retiredConstructionHelper}\\b`)),
      [],
    );
  }
});

test('only TabRuntimeFactory can register runtime resource ownership', () => {
  const lifecycleSource = path.join(
    featuresRoot,
    'chat',
    'tabs',
    'TabLifecycle.ts',
  );
  const factorySource = path.join(
    featuresRoot,
    'chat',
    'tabs',
    'TabRuntimeFactory.ts',
  );
  const registrationReferences = findMatches(
    [sourceRoot],
    /\bregisterTabRuntimeResourceOwner\b/,
  ).sort();

  assert.deepEqual(registrationReferences, [
    normalizeRepositoryPath(path.relative(process.cwd(), factorySource)),
    normalizeRepositoryPath(path.relative(process.cwd(), lifecycleSource)),
  ].sort());
});









test('performance policy enforces the main bundle budget and reports health deltas', () => {
  assert.equal(preStep11BundleHealthBaselineBytes, 4_896_000);
  assert.equal(mainBudgetBytes, 5_000_000);
  assert.deepEqual(inspectArtifactSize(mainBudgetBytes), {
    budgetExceeded: false,
    healthBaselineDeltaBytes: mainBudgetBytes - preStep11BundleHealthBaselineBytes,
    referenceDeltaBytes: mainBudgetBytes - referenceMainBytes,
  });
  assert.equal(inspectArtifactSize(5_000_001).budgetExceeded, true);
  assert.equal(inspectEvaluationDuration(evaluationIndicatorMs), 'within-indicator');
  assert.equal(inspectEvaluationDuration(evaluationIndicatorMs + 1), 'warning');
  assert.equal(
    inspectEvaluationDuration(evaluationReviewThresholdMs + 1),
    'review-required',
  );
});

test('bundle-critical runtime dependencies require exact manifest and lock agreement', () => {
  assert.deepEqual(bundleCriticalRuntimeDependencies, [
    '@anthropic-ai/claude-agent-sdk',
    'smol-toml',
  ]);
  const packageJson = {
    dependencies: {
      '@anthropic-ai/claude-agent-sdk': '0.3.226',
      'smol-toml': '1.7.1',
    },
  };
  const packageLock = {
    packages: {
      '': { dependencies: { ...packageJson.dependencies } },
      'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.226' },
      'node_modules/smol-toml': { version: '1.7.1' },
    },
  };
  const bunLock = {
    workspaces: {
      '': { dependencies: { ...packageJson.dependencies } },
    },
    packages: {
      '@anthropic-ai/claude-agent-sdk': ['@anthropic-ai/claude-agent-sdk@0.3.226'],
      'smol-toml': ['smol-toml@1.7.1'],
    },
  };

  assert.deepEqual(inspectRuntimeDependencyParity({ bunLock, packageJson, packageLock }), []);

  const rangedManifest = structuredClone(packageJson);
  rangedManifest.dependencies['@anthropic-ai/claude-agent-sdk'] = '^0.3.220';
  assert.deepEqual(
    inspectRuntimeDependencyParity({ bunLock, packageJson: rangedManifest, packageLock }),
    [{
      actual: '^0.3.220',
      dependency: '@anthropic-ai/claude-agent-sdk',
      expected: 'an exact version',
      source: 'package.json',
    }],
  );

  const staleNpmLock = structuredClone(packageLock);
  staleNpmLock.packages['node_modules/smol-toml'].version = '1.6.1';
  assert.deepEqual(
    inspectRuntimeDependencyParity({ bunLock, packageJson, packageLock: staleNpmLock }),
    [{
      actual: '1.6.1',
      dependency: 'smol-toml',
      expected: '1.7.1',
      source: 'package-lock.json resolution',
    }],
  );

  const staleBunLock = structuredClone(bunLock);
  staleBunLock.packages['@anthropic-ai/claude-agent-sdk'][0] = '@anthropic-ai/claude-agent-sdk@0.3.220';
  assert.deepEqual(
    inspectRuntimeDependencyParity({ bunLock: staleBunLock, packageJson, packageLock }),
    [{
      actual: '0.3.220',
      dependency: '@anthropic-ai/claude-agent-sdk',
      expected: '0.3.226',
      source: 'bun.lock resolution',
    }],
  );
});

test('Bun lock parsing accepts the repository JSONC shape without weakening JSON validation', () => {
  assert.deepEqual(parseBunLock(`{
    "literal": "preserve ,} and escaped \\\"text\\\"",
    "workspaces": { "": { "dependencies": { "smol-toml": "1.7.1", }, }, },
    "packages": { "smol-toml": ["smol-toml@1.7.1",], },
  }`), {
    literal: 'preserve ,} and escaped "text"',
    workspaces: { '': { dependencies: { 'smol-toml': '1.7.1' } } },
    packages: { 'smol-toml': ['smol-toml@1.7.1'] },
  });
  assert.throws(
    () => parseBunLock('{ "packages": /* unsupported */ {} }'),
    /bun\.lock is not valid JSONC/,
  );
});

test('production artifact entry rejects dependency drift before emitting main.js', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-build-parity-'));
  try {
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      dependencies: {
        '@anthropic-ai/claude-agent-sdk': '0.3.226',
        'smol-toml': '1.7.1',
      },
    }));
    fs.writeFileSync(path.join(fixtureRoot, 'package-lock.json'), JSON.stringify({
      packages: {
        '': {
          dependencies: {
            '@anthropic-ai/claude-agent-sdk': '0.3.226',
            'smol-toml': '1.7.1',
          },
        },
        'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.226' },
        'node_modules/smol-toml': { version: '1.6.1' },
      },
    }));
    fs.writeFileSync(path.join(fixtureRoot, 'bun.lock'), `{
      "workspaces": { "": { "dependencies": {
        "@anthropic-ai/claude-agent-sdk": "0.3.226",
        "smol-toml": "1.7.1",
      }, }, },
      "packages": {
        "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.226"],
        "smol-toml": ["smol-toml@1.7.1"],
      },
    }`);

    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'esbuild.config.mjs'), 'production'],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, OBSIDIAN_VAULT: '' },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bundle-critical runtime dependency parity failed/);
    assert.match(result.stderr, /package-lock\.json resolution: smol-toml/);
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'main.js')), false);
  } finally {
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('production bundle policy rejects plugin artifact filename references', () => {
  assert.deepEqual(
    inspectPluginArtifactReferences('writeFile("manifest.json")'),
    ['manifest.json'],
  );
  assert.deepEqual(
    inspectPluginArtifactReferences('copyFile("main.js")'),
    ['main.js'],
  );
  assert.deepEqual(
    inspectPluginArtifactReferences('writeFile("host-transfer-metadata.json")'),
    [],
  );
});

test('shared and utility modules do not depend on application or feature orchestration', () => {
  assert.deepEqual(findResolvedImportViolations(
    [path.join(sourceRoot, 'shared'), path.join(sourceRoot, 'utils')],
    target => isPathWithin(target, appRoot) || isPathWithin(target, featuresRoot),
  ), []);
});

test('runtime source imports are acyclic', () => {
  const files = listTypeScriptFiles(sourceRoot).filter(file => !file.endsWith('.d.ts'));
  const graph = new Map(files.map(file => {
    // Check emitted imports: type dependencies do not form runtime cycles.
    const emitted = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      fileName: file,
    }).outputText;
    return [file, listSourceImports(file, emitted)
      .filter(entry => !entry.dynamic)
      .map(entry => resolveTypeScriptImport(file, entry.specifier))
      .filter(target => target && isPathWithin(target, sourceRoot))];
  }));
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];
  function visit(file) {
    if (active.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]
        .map(entry => normalizeRepositoryPath(path.relative(sourceRoot, entry))).join(' -> '));
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    active.delete(file);
  }
  for (const file of files) visit(file);
  assert.deepEqual(cycles, []);
});

test('Claudian is independent from the standalone collaboration plugin', () => {
  const sources = listTypeScriptFiles(sourceRoot);
  const dependencies = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).dependencies;
  assert.equal(dependencies['@claudian-collab/protocol'], undefined);
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"][^'"]*(?:\/collab(?:\/|['"])|\/agent-runtime(?:\/|['"])|@claudian-collab\/protocol)/, file);
  }
});

test('documented and scheduled npm commands exist in the package manifest', () => {
  const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const files = [
    'README.md',
    'CONTRIBUTING.md',
    ...fs.readdirSync('.github/workflows')
      .filter(file => /\.ya?ml$/.test(file))
      .map(file => path.join('.github/workflows', file)),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, command] of source.matchAll(/\bnpm run ([\w:-]+)/g)) {
      assert.ok(Object.hasOwn(scripts, command), `${file} invokes missing npm script: ${command}`);
    }
  }
});
