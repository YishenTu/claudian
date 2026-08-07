import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

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

  function addImport(moduleSpecifier) {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile));
    imports.push({
      line: line + 1,
      specifier: moduleSpecifier.text,
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addImport(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addImport(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) addImport(node.arguments[0]);
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

test('features and shared UI are independent from concrete providers', () => {
  const pattern = new RegExp(
    `from\\s+['"][^'"]*${concreteProviderPathPattern.source}`,
  );
  assert.deepEqual(findMatches([
    path.join(sourceRoot, 'features'),
    path.join(sourceRoot, 'shared'),
  ], pattern), []);
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
