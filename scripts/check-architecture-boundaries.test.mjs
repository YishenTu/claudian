import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
  preCollabReferenceMainBytes,
  privateCloudBootstrapAllowanceBytes,
} from './check-startup-performance.mjs';

function listTypeScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

function findMatches(roots, pattern) {
  const matches = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      if (pattern.test(fs.readFileSync(file, 'utf8'))) {
        matches.push(path.relative(process.cwd(), file));
      }
    }
  }
  return matches;
}

function inspectForbiddenSymbolInventory(entries, pattern, allowedOccurrences) {
  const counts = new Map();
  const matcherFlags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const entry of entries) {
    const count = [...entry.source.matchAll(new RegExp(pattern.source, matcherFlags))].length;
    if (count > 0) counts.set(entry.file, count);
  }
  const files = new Set([...counts.keys(), ...allowedOccurrences.keys()]);
  return [...files].sort().flatMap(file => {
    const actual = counts.get(file) ?? 0;
    const expected = allowedOccurrences.get(file) ?? 0;
    return actual === expected
      ? []
      : [`${file}: expected ${expected} compatibility occurrence, found ${actual}`];
  });
}

function findForbiddenSymbolInventoryViolations(pattern, allowedOccurrences) {
  return inspectForbiddenSymbolInventory(
    listTypeScriptFiles(sourceRoot).map(file => ({
      file: path.relative(process.cwd(), file),
      source: fs.readFileSync(file, 'utf8'),
    })),
    pattern,
    allowedOccurrences,
  );
}

function listSourceImports(file) {
  const sourceText = fs.readFileSync(file, 'utf8');
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

function importsPackage(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
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

function listStaticSourceGraph(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    for (const sourceImport of listSourceImports(file)) {
      if (sourceImport.dynamic || sourceImport.typeOnly) continue;
      const target = resolveTypeScriptImport(file, sourceImport.specifier);
      if (target && isPathWithin(target, sourceRoot)) pending.push(target);
    }
  }
  return [...visited].sort();
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
const allowedProviderAppImports = new Set([
  resolvedImportKey(
    path.join(providersRoot, 'claude', 'types', 'settings.ts'),
    path.join(appRoot, 'settings', 'defaultSettings'),
  ),
  resolvedImportKey(
    path.join(providersRoot, 'claude', 'storage', 'StorageService.ts'),
    path.join(appRoot, 'settings', 'ClaudianSettingsStorage'),
  ),
  resolvedImportKey(
    path.join(providersRoot, 'claude', 'storage', 'ClaudianSettingsStorage.ts'),
    path.join(appRoot, 'settings', 'ClaudianSettingsStorage'),
  ),
]);

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

test('providers avoid root app imports outside Claude compatibility seams', () => {
  assert.deepEqual(findResolvedImportViolations(
    [providersRoot],
    target => isPathWithin(target, appRoot),
    allowedProviderAppImports,
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

test('Collab modal and shared code do not depend on detail or sidebar surfaces', () => {
  const collabRoot = path.join(featuresRoot, 'collab');
  const detailRoot = path.join(collabRoot, 'detail');
  const sidebarRoot = path.join(collabRoot, 'sidebar');
  assert.deepEqual(findResolvedImportViolations(
    [path.join(collabRoot, 'modals'), path.join(collabRoot, 'shared')],
    target => isPathWithin(target, detailRoot) || isPathWithin(target, sidebarRoot),
  ), []);
});

test('active Collab code has no singular Manager or transfer compatibility surface', () => {
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /\bmanager_member_id\b/,
    new Map([['src/app/collab/authority/AuthoritySchema.ts', 5]]),
  ), []);
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /\bmanagerMemberId\b/,
    new Map(),
  ), []);
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /\btransferManager\b/,
    new Map(),
  ), []);
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /manager-transfer/,
    new Map([
      ['src/app/collab/authority/AuthoritySchema.ts', 2],
      ['src/app/collab/exit/LocalExitStores.ts', 3],
      ['src/app/collab/exit/ManagerResponsibilityReceiptRecord.ts', 2],
    ]),
  ), []);
  assert.deepEqual(
    findForbiddenSymbolInventoryViolations(
      /\bexpectedManagerMemberId\b/,
      new Map([
        ['src/app/collab/authority/MembershipAdminService.ts', 1],
        ['src/app/collab/exit/PendingLeaveRecord.ts', 2],
        ['src/app/collab/retirement/RetirementIntent.ts', 1],
      ]),
    ),
    [],
  );
});

test('singular Manager compatibility inventory rejects an extra active occurrence', () => {
  assert.deepEqual(inspectForbiddenSymbolInventory(
    [{ file: 'compatibility-owner.ts', source: 'manager_member_id manager_member_id' }],
    /\bmanager_member_id\b/,
    new Map([['compatibility-owner.ts', 1]]),
  ), [
    'compatibility-owner.ts: expected 1 compatibility occurrence, found 2',
  ]);
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

test('chat consumes Collab only through the FeatureHost surface seam', () => {
  const chatRoot = path.join(featuresRoot, 'chat');
  const collabRoot = path.join(featuresRoot, 'collab');
  const violations = findResolvedImportViolations(
    [chatRoot],
    target => isPathWithin(target, collabRoot) || isPathWithin(target, path.join(appRoot, 'collab')),
  );

  assert.deepEqual(violations, []);
  assert.ok(
    listSourceImports(path.join(chatRoot, 'ClaudianView.ts'))
      .some(sourceImport => normalizeModuleTarget(resolveSourceImport(
        path.join(chatRoot, 'ClaudianView.ts'),
        sourceImport.specifier,
      ) ?? '') === normalizeModuleTarget(path.join(featuresRoot, 'FeatureHost'))),
  );
});

test('the retired Vault file-tree surface stays outside the plugin', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const viewSource = fs.readFileSync(path.join(featuresRoot, 'chat', 'ClaudianView.ts'), 'utf8');
  const settingsTypeSource = fs.readFileSync(path.join(sourceRoot, 'core', 'types', 'settings.ts'), 'utf8');
  const treeRoot = path.join(featuresRoot, 'chat', 'ui', 'vault-file-tree');

  assert.equal(packageJson.dependencies?.['@pierre/trees'], undefined);
  assert.equal(fs.existsSync(treeRoot) && listTypeScriptFiles(treeRoot).length > 0, false);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'style', 'components', 'vault-file-tree.css')), false);
  assert.doesNotMatch(viewSource, /VaultFileTree|filesSurface|showVaultFiles/);
  assert.doesNotMatch(settingsTypeSource, /enableFilePane/);
});

test('ordinary main evaluation cannot reach Collab runtime foundations', () => {
  const mainFile = path.join(sourceRoot, 'main.ts');
  const eagerGraph = listStaticSourceGraph(mainFile);
  const collabAppRoot = path.join(appRoot, 'collab');
  const forbiddenPackages = ['@pierre/diffs', 'node-forge', 'sql.js', 'ws'];
  const heavyImports = eagerGraph.flatMap(file => (
    listSourceImports(file)
      .filter(sourceImport => (
        !sourceImport.dynamic
        && !sourceImport.typeOnly
        && forbiddenPackages.some(packageName => (
          importsPackage(sourceImport.specifier, packageName)
        ))
      ))
      .map(sourceImport => (
        `${path.relative(process.cwd(), file)}:${sourceImport.line}`
        + ` imports ${sourceImport.specifier}`
      ))
  ));

  assert.deepEqual(eagerGraph.filter(file => isPathWithin(file, collabAppRoot)), []);
  assert.deepEqual(heavyImports, []);
  assert.ok(
    listSourceImports(mainFile).some(sourceImport => (
      sourceImport.dynamic && sourceImport.specifier === './app/collab'
    )),
  );
  const collabReviewRoot = path.join(featuresRoot, 'collab', 'detail', 'review');
  assert.ok(
    listSourceImports(path.join(collabReviewRoot, 'CollabDiffRenderer.ts'))
      .some(sourceImport => (
        sourceImport.dynamic
        && sourceImport.specifier === './CollabPierreDiffModule'
      )),
  );
  assert.ok(
    listSourceImports(path.join(collabReviewRoot, 'CollabPierreDiffModule.ts'))
      .some(sourceImport => (
        !sourceImport.dynamic
        && sourceImport.specifier === '@pierre/diffs'
      )),
  );
});

test('persisted settings changes use the coordinator boundary', () => {
  const matches = findMatches([sourceRoot], /\.saveSettings\(\)/).filter(file => ![
    'src/main.ts',
    'src/app/providers/ClaudianProviderHost.ts',
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

  assert.deepEqual(assemblyReferences, [path.relative(process.cwd(), factorySource)]);
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
    path.relative(process.cwd(), factorySource),
    path.relative(process.cwd(), lifecycleSource),
  ].sort());
});

test('collab protocol package imports only relative modules and allowlisted dependencies', () => {
  const protocolPackageSourceRoot = path.join(process.cwd(), 'packages', 'collab-protocol', 'src');
  const violations = [];
  for (const file of listTypeScriptFiles(protocolPackageSourceRoot)) {
    for (const sourceImport of listSourceImports(file)) {
      const { specifier } = sourceImport;
      if (specifier.startsWith('.') || specifier === '@lezer/markdown') continue;
      violations.push(
        `${path.relative(process.cwd(), file)}:${sourceImport.line} imports ${specifier}`,
      );
    }
  }
  assert.deepEqual(violations, []);
});

test('collab protocol registry and contract constants exist only in the package', () => {
  const pattern = /export\s+(?:const|interface|type|class|function)\s+(?:COLLAB_CONTROL_OPERATION_CODECS|CollabControlOperationMap|COLLAB_EVENT_KINDS|COLLAB_ERROR_CODES|COLLAB_LIMITS|COLLAB_PROTOCOL_VERSION|COLLAB_MAIN_REF|COLLAB_MEMBER_REF_PREFIX)\b/;
  assert.deepEqual(findMatches([sourceRoot], pattern), []);
});

test('active Collab consumers use protocol-owned semantic identity predicates', () => {
  const entries = [
    ...listTypeScriptFiles(path.join(appRoot, 'collab')),
    ...listTypeScriptFiles(path.join(featuresRoot, 'collab')),
  ].map(file => ({
    file: path.relative(process.cwd(), file),
    source: fs.readFileSync(file, 'utf8'),
  }));

  // These are application-owned filesystem slugs, directory names, and a Host lock nonce.
  assert.deepEqual(inspectForbiddenSymbolInventory(
    entries,
    /\[A-Za-z0-9\]\[A-Za-z0-9_-\]\{0,63\}/,
    new Map([
      ['src/app/collab/CollabLocalProjectRepository.ts', 1],
      ['src/app/collab/exit/PendingLeaveRecord.ts', 1],
      ['src/app/collab/join/JoinProjectCoordinator.ts', 1],
      ['src/app/collab/join/JoinProjectRecord.ts', 1],
      ['src/app/collab/lan/LanHostCoordinator.ts', 1],
      ['src/app/collab/project/CollabProjectSetupRecord.ts', 1],
    ]),
  ), []);

  // These are application-owned workspace and Host-transfer staging directory names.
  assert.deepEqual(inspectForbiddenSymbolInventory(
    entries,
    /\[A-Za-z0-9\]\[A-Za-z0-9_-\]\{0,127\}/,
    new Map([
      ['src/app/collab/exit/LocalCleanupRecord.ts', 1],
      ['src/app/collab/host-transfer/HostTransferRecoveryRecord.ts', 1],
    ]),
  ), []);

  // Native Git machine-output parsers retain their exact subprocess grammar.
  assert.deepEqual(inspectForbiddenSymbolInventory(
    entries,
    /\[0-9a-f\]\{40\}\(\?:\[0-9a-f\]\{24\}\)\?/,
    new Map([
      ['src/app/collab/conflicts/ConflictScratchGitRepository.ts', 1],
      ['src/app/collab/git/GitRepositoryService.ts', 10],
      ['src/app/collab/join/JoinProjectCoordinator.ts', 1],
    ]),
  ), []);

  // Agent Runtime v5 owns a frozen declarative JSON-schema descriptor, not a runtime validator.
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)/,
    new Map([['src/app/agent-runtime/AgentRuntimeMethodRegistry.ts', 1]]),
  ), []);
});

test('Collab application barrel exposes only composition values', () => {
  const barrelPath = path.join(appRoot, 'collab', 'index.ts');
  const source = fs.readFileSync(barrelPath, 'utf8');
  assert.doesNotMatch(source, /export\s+\*/);

  const sourceFile = ts.createSourceFile(
    barrelPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const runtimeExports = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (!statement.isTypeOnly && !element.isTypeOnly) runtimeExports.push(element.name.text);
    }
  }
  assert.deepEqual(runtimeExports.sort(), [
    'ClaudianCollabService',
    'CollabFeatureService',
    'CollabProjectSetupService',
    'createCollabFeatureSubcomposition',
  ].sort());
});

test('superseded Collab state authorities stay removed', () => {
  assert.deepEqual(findMatches(
    [path.join(appRoot, 'collab')],
    /\bupdateMembershipEventSequence\b/,
  ), []);
  assert.deepEqual(findMatches(
    [path.join(appRoot, 'collab', 'publish')],
    /\bconfirmed\s*:/,
  ), []);
});

test('production consumes protocol-owned canonical Collab Git refs', () => {
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /refs\/heads\/main/,
    new Map([['src/app/collab/authority/AuthoritySchema.ts', 2]]),
  ), []);
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /refs\/heads\/members\//,
    new Map([['src/app/collab/authority/AuthoritySchema.ts', 1]]),
  ), []);
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /refs\/remotes\/origin\/main/,
    new Map(),
  ), []);
  assert.deepEqual(findForbiddenSymbolInventoryViolations(
    /refs\/remotes\/origin\/members\//,
    new Map(),
  ), []);
});

test('collab protocol build scripts avoid platform-specific shell commands', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'packages', 'collab-protocol', 'package.json'),
    'utf8',
  ));
  assert.equal(manifest.scripts.clean, 'node scripts/clean.mjs');

  const verifier = fs.readFileSync(
    path.join(process.cwd(), 'packages', 'collab-protocol', 'scripts', 'verify-pack.mjs'),
    'utf8',
  );
  assert.match(verifier, /fileURLToPath\(import\.meta\.url\)/);
  assert.doesNotMatch(verifier, /new URL\(import\.meta\.url\)\.pathname/);
  assert.doesNotMatch(verifier, /run\(['"](?:npm|tar)['"]/);
  assert.doesNotMatch(verifier, /\bexecSync\b/);

  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const crossPlatformJob = workflow
    .split(/^  build:/mu)[0]
    .split(/^  cross-platform-smoke:/mu)[1] ?? '';
  assert.match(crossPlatformJob, /npm run verify:protocol/);
});

test('Collab Git process owners await Windows process-tree termination', () => {
  for (const relativePath of [
    'src/app/collab/git/GitCommandRunner.ts',
    'src/app/collab/lan/GitHttpBackendProxy.ts',
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    assert.match(source, /killProcessTree:\s*true/);
    assert.match(source, /terminateSpawnedProcessTree\(/);
    assert.match(source, /await\s+(?:active\.)?terminationTask/);
  }
});

test('CI gates releases, cross-platform behavior, protocol changes, and security', () => {
  const workflowsRoot = path.join(process.cwd(), '.github', 'workflows');
  const ci = fs.readFileSync(path.join(workflowsRoot, 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(workflowsRoot, 'release.yml'), 'utf8');
  const nightly = fs.readFileSync(path.join(workflowsRoot, 'nightly.yml'), 'utf8');
  const codeql = fs.readFileSync(path.join(workflowsRoot, 'codeql.yml'), 'utf8');

  assert.match(ci, /workflow_call:/);
  assert.match(ci, /rhysd\/actionlint:1\.7\.12/);
  assert.match(ci, /diff-hygiene:/);
  assert.match(ci, /dependency-review-action@v4/);
  assert.match(ci, /protocol-contract:/);
  assert.match(ci, /npm run check:protocol-compatibility/);
  assert.match(ci, /cross-platform-smoke:/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /cross-platform-collab-scope:/);
  assert.match(ci, /packages\/collab-protocol\/\*/);
  assert.match(ci, /src\/app\/collab\/\*/);
  assert.match(ci, /src\/core\/collab\/\*/);
  assert.match(ci, /src\/features\/collab\/\*/);
  assert.match(ci, /tests\/\*collab\/\*/);
  assert.match(ci, /needs:\s*cross-platform-collab-scope/);
  assert.match(ci, /needs\.cross-platform-collab-scope\.outputs\.run == 'true'/);

  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  assert.match(release, /needs:\s*verify/);

  assert.match(nightly, /schedule:/);
  assert.match(nightly, /ubuntu-latest/);
  assert.match(nightly, /windows-latest/);
  assert.match(nightly, /macos-latest/);
  assert.match(nightly, /npm run check:open-handles/);
  assert.match(nightly, /npm audit --omit=dev --audit-level=high/);

  assert.match(codeql, /schedule:/);
  assert.match(codeql, /github\/codeql-action\/init@v4/);
  assert.match(codeql, /github\/codeql-action\/analyze@v4/);
  assert.match(codeql, /javascript-typescript/);
});

test('src does not re-export the collab protocol package', () => {
  const pattern = /export\s+(?:\*|\{[^}]*\})\s*from\s*['"]@claudian\/collab-protocol['"]/;
  assert.deepEqual(findMatches([sourceRoot], pattern), []);
});

test('src and tests import the collab protocol package only through its root entry', () => {
  const violations = [];
  for (const root of [sourceRoot, path.join(process.cwd(), 'tests')]) {
    for (const file of listTypeScriptFiles(root)) {
      for (const sourceImport of listSourceImports(file)) {
        const { specifier } = sourceImport;
        if (
          specifier.startsWith('@claudian/collab-protocol/')
          || specifier.includes('packages/collab-protocol')
        ) {
          violations.push(
            `${path.relative(process.cwd(), file)}:${sourceImport.line} imports ${specifier}`,
          );
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('root tooling resolves the collab protocol package without generated artifacts', () => {
  const configPath = path.join(process.cwd(), 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = {
    ...ts.sys,
    fileExists(file) {
      return !file.includes(`${path.sep}collab-protocol${path.sep}dist${path.sep}`)
        && ts.sys.fileExists(file);
    },
  };
  const resolution = ts.resolveModuleName(
    '@claudian/collab-protocol',
    path.join(process.cwd(), 'src', 'main.ts'),
    parsed.options,
    host,
  ).resolvedModule;

  assert.equal(
    resolution?.resolvedFileName,
    path.join(process.cwd(), 'packages', 'collab-protocol', 'src', 'index.ts'),
  );
});

test('source-only typecheck resolves the canonical collab protocol source', () => {
  const configPath = path.join(process.cwd(), 'tsconfig.source.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const resolution = ts.resolveModuleName(
    '@claudian/collab-protocol',
    path.join(process.cwd(), 'src', 'main.ts'),
    parsed.options,
    ts.sys,
  ).resolvedModule;

  assert.equal(
    resolution?.resolvedFileName,
    path.join(process.cwd(), 'packages', 'collab-protocol', 'src', 'index.ts'),
  );
});

test('performance policy enforces the main bundle budget and reports the pre-Collab delta', () => {
  assert.equal(privateCloudBootstrapAllowanceBytes, 100_000);
  assert.equal(mainBudgetBytes, 5_100_000);
  assert.deepEqual(inspectArtifactSize(mainBudgetBytes), {
    budgetExceeded: false,
    referenceDeltaBytes: mainBudgetBytes - preCollabReferenceMainBytes,
  });
  assert.equal(inspectArtifactSize(mainBudgetBytes + 1).budgetExceeded, true);
  assert.equal(inspectEvaluationDuration(evaluationIndicatorMs), 'within-indicator');
  assert.equal(inspectEvaluationDuration(evaluationIndicatorMs + 1), 'warning');
  assert.equal(
    inspectEvaluationDuration(evaluationReviewThresholdMs + 1),
    'review-required',
  );
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
