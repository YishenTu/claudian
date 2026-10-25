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

function findResolvedImportViolations(roots, isForbidden) {
  const violations = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      for (const sourceImport of listSourceImports(file)) {
        const target = resolveSourceImport(file, sourceImport.specifier);
        if (!target || !isForbidden(target)) continue;
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

/**
 * Settings-document wrappers adapt a provider's configuration to the application settings.
 * Listed explicitly so a new provider module is runtime until it is reviewed into this set.
 */
const PROVIDER_DOCUMENT_WRAPPERS = new Set([
  'src/providers/claude/ClaudeModelPolicy.ts',
  'src/providers/claude/env/ClaudeSettingsReconciler.ts',
  'src/providers/claude/runtime/ClaudeCLIResolver.ts',
  'src/providers/claude/settings.ts',
  'src/providers/codex/CodexModelPolicy.ts',
  'src/providers/codex/env/CodexSettingsReconciler.ts',
  'src/providers/codex/runtime/CodexCLIResolver.ts',
  'src/providers/codex/settings.ts',
  'src/providers/deepseek/DeepSeekModelPolicy.ts',
  'src/providers/deepseek/app/DeepSeekCommandLoader.ts',
  'src/providers/deepseek/env/DeepSeekSettingsReconciler.ts',
  'src/providers/deepseek/runtime/DeepSeekCLIResolver.ts',
  'src/providers/deepseek/settings.ts',
  'src/providers/grok/GrokModelPolicy.ts',
  'src/providers/grok/app/GrokCommandLoader.ts',
  'src/providers/grok/env/GrokSettingsReconciler.ts',
  'src/providers/grok/runtime/GrokCLIResolver.ts',
  'src/providers/grok/settings.ts',
  'src/providers/opencode/OpencodeModelPolicy.ts',
  'src/providers/opencode/app/OpencodeCommandLoader.ts',
  'src/providers/opencode/env/OpencodeSettingsReconciler.ts',
  'src/providers/opencode/runtime/OpencodeCLIResolver.ts',
  'src/providers/opencode/settings.ts',
  'src/providers/pi/PiModelPolicy.ts',
  'src/providers/pi/app/PiCommandLoader.ts',
  'src/providers/pi/env/PiSettingsReconciler.ts',
  'src/providers/pi/runtime/PiCLIResolver.ts',
  'src/providers/pi/settings.ts',
]);

/**
 * Integration modules adapt a provider to Obsidian and to the application settings
 * document; every other provider module is runtime.
 */
function isProviderIntegrationModule(file) {
  const relative = normalizeRepositoryPath(path.relative(providersRoot, normalizeModuleTarget(file)));
  return relative === 'index'
    || /^[^/]+\/registration$/.test(relative)
    || /^[^/]+\/ui(?:\/|$)/.test(relative)
    || /^[^/]+\/app\/[A-Za-z]+WorkspaceServices$/.test(relative)
    || PROVIDER_DOCUMENT_WRAPPERS.has(normalizeRepositoryPath(path.relative(process.cwd(), file)));
}

/** Original names a named import or export clause binds; null for namespace and default bindings. */
function namedBindingNames(clause) {
  return clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))
    ? clause.elements.map(element => (element.propertyName ?? element.name).text)
    : null;
}

/** Core modules and exports that read or write the application settings document. */
const SETTINGS_DOCUMENT_ACCESS = new Map([
  ['core/providers/ProviderHost', null],
  ['core/providers/ProviderSettingsCoordinator', null],
  ['core/providers/historyPathContext', null],
  ['core/types/index', new Set(['ClaudianSettings'])],
  ['core/types/settings', new Set(['ClaudianSettings'])],
  ['core/providers/providerConfig', new Set([
    'getProviderConfig', 'setProviderConfig', 'getProviderSavedSelection', 'getProviderSelectionDefaults',
    'getProviderSelectionInputs',
  ])],
  ['core/providers/providerEnvironment', new Set([
    'getEnvironmentVariablesForScope', 'getProviderEnvironmentVariables', 'getRuntimeEnvironmentText',
    'getRuntimeEnvironmentVariables', 'getSharedEnvironmentVariables', 'setEnvironmentVariablesForScope',
    'setProviderEnvironmentVariables', 'setSharedEnvironmentVariables',
  ])],
]);

/** Imports through which a provider runtime module would reach the application settings document. */
function inspectSettingsDocumentAccess(file, sourceText) {
  const relative = normalizeRepositoryPath(path.relative(process.cwd(), file));
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const violations = [];
  const visit = node => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
    if (specifier) {
      const target = resolveTypeScriptImport(file, specifier);
      const key = target && normalizeRepositoryPath(path.relative(sourceRoot, normalizeModuleTarget(target)));
      if (key && SETTINGS_DOCUMENT_ACCESS.has(key)) {
        const names = SETTINGS_DOCUMENT_ACCESS.get(key);
        const imported = namedBindingNames(ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause);
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (names === null || imported === null) {
          violations.push(`${relative}:${line} reaches the settings document through ${specifier}`);
        } else {
          for (const name of imported.filter(name => names.has(name))) {
            violations.push(`${relative}:${line} reaches the settings document through ${name}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** Why a listed document wrapper is stale: it is missing or no longer reaches the document. */
function inspectDocumentWrapper(file, sourceText) {
  const relative = normalizeRepositoryPath(path.relative(process.cwd(), file));
  if (sourceText === null) return [`${relative} is listed as a document wrapper but does not exist`];
  const reachesDocument = inspectSettingsDocumentAccess(file, sourceText).length > 0
    || listSourceImports(file, sourceText).some(sourceImport => {
      const target = resolveTypeScriptImport(file, sourceImport.specifier);
      return target !== null && isPathWithin(target, providersRoot) && isProviderIntegrationModule(target);
    });
  return reachesDocument ? [] : [`${relative} is listed as a document wrapper but never reaches the settings document`];
}

function listProviderRuntimeFiles() {
  return listTypeScriptFiles(providersRoot).filter(file => !isProviderIntegrationModule(file));
}

/** Source files whose emitted (non-type) imports reach the Obsidian package. */
function findObsidianValueReach() {
  const reaches = new Map();
  function reachesObsidian(file) {
    if (reaches.has(file)) return reaches.get(file);
    reaches.set(file, false);
    const emitted = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      fileName: file,
    }).outputText;
    const result = listSourceImports(file, emitted).some(entry => {
      if (entry.specifier === 'obsidian') return true;
      const target = resolveTypeScriptImport(file, entry.specifier);
      return target !== null && /\.tsx?$/.test(target) && isPathWithin(target, sourceRoot) && reachesObsidian(target);
    });
    reaches.set(file, result);
    return result;
  }
  return reachesObsidian;
}

/** Exported functions, classes and values whose declarations use a type imported from Obsidian. */
function createObsidianBoundExports() {
  const cache = new Map();
  return file => {
    if (cache.has(file)) return cache.get(file);
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const obsidianNames = new Set();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'obsidian') continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach(element => obsidianNames.add(element.name.text));
    }
    const bound = new Set();
    const usesObsidian = node => (ts.isIdentifier(node) && obsidianNames.has(node.text))
      || (ts.forEachChild(node, usesObsidian) ?? false);
    for (const statement of sourceFile.statements) {
      const exported = ts.getModifiers?.(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported || obsidianNames.size === 0 || !usesObsidian(statement)) continue;
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        bound.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        statement.declarationList.declarations.forEach(declaration => {
          if (ts.isIdentifier(declaration.name)) bound.add(declaration.name.text);
        });
      }
    }
    cache.set(file, bound);
    return bound;
  };
}

function inspectProviderRuntimeSource(file, sourceText, { reachesObsidian, obsidianBoundExports }) {
  const relative = normalizeRepositoryPath(path.relative(process.cwd(), file));
  const violations = [];
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const lineOf = node => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  for (const sourceImport of listSourceImports(file, sourceText)) {
    if (sourceImport.specifier === 'obsidian') {
      violations.push(`${relative}:${sourceImport.line} imports obsidian`);
      continue;
    }
    const target = resolveTypeScriptImport(file, sourceImport.specifier);
    if (!target || !/\.tsx?$/.test(target) || !isPathWithin(target, sourceRoot)) continue;
    if (isPathWithin(target, providersRoot) && isProviderIntegrationModule(target)) {
      violations.push(`${relative}:${sourceImport.line} imports integration module ${sourceImport.specifier}`);
    } else if (!sourceImport.typeOnly && reachesObsidian(target)) {
      violations.push(`${relative}:${sourceImport.line} reaches obsidian through ${sourceImport.specifier}`);
    }
  }
  const boundExportsOf = specifier => {
    const target = resolveTypeScriptImport(file, specifier);
    return target && /\.tsx?$/.test(target) && isPathWithin(target, sourceRoot) ? obsidianBoundExports(target) : new Set();
  };
  // Namespace imports expose every export; record them so member reads can be checked.
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
  }
  const namespaceMember = (expression, name, node) => {
    if (!ts.isIdentifier(expression) || !namespaces.has(expression.text)) return;
    const specifier = namespaces.get(expression.text);
    if (boundExportsOf(specifier).has(name)) violations.push(`${relative}:${lineOf(node)} reads Obsidian-bound ${name} from ${specifier}`);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const bound = boundExportsOf(node.moduleSpecifier.text);
      for (const element of node.importClause.namedBindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (bound.has(name)) violations.push(`${relative}:${lineOf(element)} imports Obsidian-bound ${name} from ${node.moduleSpecifier.text}`);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const bound = boundExportsOf(node.moduleSpecifier.text);
      const names = namedBindingNames(node.exportClause) ?? [...bound];
      for (const name of names.filter(name => bound.has(name))) {
        violations.push(`${relative}:${lineOf(node)} re-exports Obsidian-bound ${name} from ${node.moduleSpecifier.text}`);
      }
    } else if (ts.isPropertyAccessExpression(node) && node.name.text !== 'app') {
      namespaceMember(node.expression, node.name.text, node);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      namespaceMember(node.expression, node.argumentExpression.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      for (const element of node.name.elements) {
        namespaceMember(node.initializer, (element.propertyName ?? element.name).getText(sourceFile), element);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'app') {
      violations.push(`${relative}:${lineOf(node.name)} reads the Obsidian app`);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'app') {
      violations.push(`${relative}:${lineOf(node)} reads the Obsidian app`);
    } else if (ts.isBindingElement(node) && ((node.propertyName ?? node.name).getText(sourceFile) === 'app')) {
      violations.push(`${relative}:${lineOf(node)} reads the Obsidian app`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

test('provider runtime modules are independent from Obsidian and provider integration', () => {
  const options = { reachesObsidian: findObsidianValueReach(), obsidianBoundExports: createObsidianBoundExports() };
  const violations = listProviderRuntimeFiles()
    .flatMap(file => inspectProviderRuntimeSource(file, fs.readFileSync(file, 'utf8'), options));
  assert.deepEqual(violations, []);
});

test('provider runtimes never reach the application settings document', () => {
  const violations = listProviderRuntimeFiles()
    .flatMap(file => inspectSettingsDocumentAccess(file, fs.readFileSync(file, 'utf8')));
  assert.deepEqual(violations, []);
});

test('the settings document boundary detects direct and type-only access', () => {
  const file = path.join(providersRoot, 'pi', 'runtime', 'BoundaryFixture.ts');
  for (const source of [
    "import type { ProviderHost } from '@/core/providers/ProviderHost';\nexport type Host = ProviderHost;",
    "import type { ClaudianSettings } from '@/core/types';\nexport type Settings = ClaudianSettings;",
    "import { getProviderConfig } from '../../../core/providers/providerConfig';\nexport const read = getProviderConfig;",
    "import { getRuntimeEnvironmentText as env } from '@/core/providers/providerEnvironment';\nexport const read = env;",
    "import * as environment from '@/core/providers/providerEnvironment';\nexport const read = environment;",
    "export { getProviderSelectionInputs } from '@/core/providers/providerConfig';",
    "import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';\nexport const context = createProviderHistoryPathContext;",
    "import { setSharedEnvironmentVariables } from '@/core/providers/providerEnvironment';\nexport const write = setSharedEnvironmentVariables;",
    "import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';\nexport const c = ProviderSettingsCoordinator;",
  ]) assert.notDeepEqual(inspectSettingsDocumentAccess(file, source), [], source);
  for (const source of [
    "import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';\nexport type Host = ProviderRuntimeHost;",
    "import { replaceProviderConfig } from '@/core/providers/providerConfig';\nexport const write = replaceProviderConfig;",
    "import { createConfigCatalogStore } from '@/core/providers/models/ProviderModelCatalog';\nexport const store = createConfigCatalogStore;",
  ]) assert.deepEqual(inspectSettingsDocumentAccess(file, source), [], source);
  // Document wrappers are integration; the configuration modules they wrap are runtime.
  assert.equal(isProviderIntegrationModule(path.join(providersRoot, 'pi', 'settings.ts')), true);
  assert.equal(isProviderIntegrationModule(path.join(providersRoot, 'pi', 'config.ts')), false);
  // A module named like a wrapper is runtime until it is listed.
  for (const unlisted of [
    ['pi', 'runtime', 'FooCLIResolver.ts'],
    ['pi', 'app', 'FooCommandLoader.ts'],
    ['pi', 'FooModelPolicy.ts'],
    ['pi', 'env', 'FooReconciler.ts'],
  ]) assert.equal(isProviderIntegrationModule(path.join(providersRoot, ...unlisted)), false, unlisted.join('/'));
});

test('every listed document wrapper exists and reaches the settings document', () => {
  const problems = [...PROVIDER_DOCUMENT_WRAPPERS].flatMap(relative => {
    const file = path.join(process.cwd(), relative);
    return inspectDocumentWrapper(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  });
  assert.deepEqual(problems, []);
  const listed = path.join(providersRoot, 'pi', 'runtime', 'PiCLIResolver.ts');
  assert.notDeepEqual(inspectDocumentWrapper(listed, null), []);
  assert.notDeepEqual(inspectDocumentWrapper(listed, "import { decodePiConfig } from '../config';\nexport const read = decodePiConfig;"), []);
  assert.deepEqual(inspectDocumentWrapper(listed, "import { getPiProviderSettings } from '../settings';\nexport const read = getPiProviderSettings;"), []);
  assert.deepEqual(inspectDocumentWrapper(listed, "import { getProviderConfig } from '@/core/providers/providerConfig';\nexport const read = getProviderConfig;"), []);
});

test('the provider runtime boundary detects indirect Obsidian access', () => {
  const options = { reachesObsidian: findObsidianValueReach(), obsidianBoundExports: createObsidianBoundExports() };
  const file = path.join(providersRoot, 'claude', 'runtime', 'BoundaryFixture.ts');
  const inspect = source => inspectProviderRuntimeSource(file, source, options);
  const forbidden = [
    "import { getVaultPath } from '@/utils/path';\nexport const cwd = (host: { app: never }) => getVaultPath(host.app);",
    "import { getVaultPath as vault } from '@/utils/path';\nexport const cwd = vault;",
    "export function cwd(host: Record<string, unknown>) { const { app } = host; return app; }",
    "export function cwd({ app: obsidian }: Record<string, unknown>) { return obsidian; }",
    "export function cwd(host: Record<string, unknown>) { return host['app']; }",
    "import { Notice } from 'obsidian';\nexport const warn = (message: string) => new Notice(message);",
    "import { claudeChatUIConfig } from '../ui/ClaudeChatUIConfig';\nexport const config = claudeChatUIConfig;",
    "import * as paths from '@/utils/path';\nexport const cwd = paths.getVaultPath;",
    "import * as paths from '@/utils/path';\nexport const { getVaultPath } = paths;",
    "export { getVaultPath } from '@/utils/path';",
    "export { getVaultPath as vault } from '@/utils/path';",
    "export * from '@/utils/path';",
    "import * as paths from '@/utils/path';\nexport const cwd = paths['getVaultPath'];",
  ];
  for (const source of forbidden) assert.notDeepEqual(inspect(source), [], source);
  for (const source of [
    "import { normalizePathForComparison } from '@/utils/path';\nexport const cwd = (host: { workingDirectory: string | null }) => host.workingDirectory && normalizePathForComparison(host.workingDirectory);",
    "import * as paths from '@/utils/path';\nexport const normalize = paths.normalizePathForComparison;",
    "export { normalizePathForComparison } from '@/utils/path';",
  ]) assert.deepEqual(inspect(source), [], source);
});

test('app avoids features and provider implementations', () => {
  assert.deepEqual(findResolvedImportViolations(
    [appRoot],
    target => isPathWithin(target, featuresRoot) || isPathWithin(target, providersRoot),
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
  const contract = fs.readFileSync(featureHostFile, 'utf8');
  assert.doesNotMatch(
    contract,
    /\b(?:getView|getAllViews|chatModelSelection)\b/,
  );
});

test('persisted settings changes use the coordinator boundary', () => {
  const matches = findMatches([sourceRoot], /\.saveSettings\(\)/).filter(file => ![
    'src/main.ts',
  ].includes(file));
  assert.deepEqual(matches, []);
});

test('runtime command discovery cannot import Vault skill management', () => {
  const roots = [
    path.join(sourceRoot, 'features', 'chat'),
    path.join(sourceRoot, 'shared', 'components'),
    ...concreteProviderNames.flatMap(provider => [
      path.join(sourceRoot, 'providers', provider, 'app'),
      path.join(sourceRoot, 'providers', provider, 'commands'),
    ]).filter(fs.existsSync),
  ];
  const skillManagement = [path.join(featuresRoot, 'agent-skills')];
  assert.deepEqual(findResolvedImportViolations(
    roots,
    target => skillManagement.some(root => isPathWithin(normalizeModuleTarget(target), root)),
  ), []);
});

test('renderer source does not import Node async hooks', () => {
  // Generated native-process programs are string literals, not renderer imports.
  const matches = listTypeScriptFiles(sourceRoot)
    .filter(file => listSourceImports(file).some(sourceImport => /^(?:node:)?async_hooks$/.test(sourceImport.specifier)))
    .map(file => normalizeRepositoryPath(path.relative(process.cwd(), file)));
  assert.deepEqual(matches, []);
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
  ]);
  const packageJson = {
    dependencies: {
      '@anthropic-ai/claude-agent-sdk': '0.3.226',
    },
  };
  const packageLock = {
    packages: {
      '': { dependencies: { ...packageJson.dependencies } },
      'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.226' },
    },
  };
  const bunLock = {
    workspaces: {
      '': { dependencies: { ...packageJson.dependencies } },
    },
    packages: {
      '@anthropic-ai/claude-agent-sdk': ['@anthropic-ai/claude-agent-sdk@0.3.226'],
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
  staleNpmLock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version = '0.3.220';
  assert.deepEqual(
    inspectRuntimeDependencyParity({ bunLock, packageJson, packageLock: staleNpmLock }),
    [{
      actual: '0.3.220',
      dependency: '@anthropic-ai/claude-agent-sdk',
      expected: '0.3.226',
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
  const prototypeKey = '{"__proto__": {"packages": {}}, "constructor": "literal"}';
  assert.deepEqual(parseBunLock(prototypeKey), JSON.parse(prototypeKey));
  for (const invalid of [
    '{ "packages": /* unsupported */ {} }',
    '{ "packages": {} // unsupported\n}',
    '', '{', '{"packages":}', '{"packages":{} "other":1}', '{} trailing',
  ]) {
    assert.throws(() => parseBunLock(invalid), /bun\.lock is not valid JSONC/);
  }
});

test('production artifact entry rejects dependency drift before emitting main.js', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-build-parity-'));
  try {
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      dependencies: {
        '@anthropic-ai/claude-agent-sdk': '0.3.226',
      },
    }));
    fs.writeFileSync(path.join(fixtureRoot, 'package-lock.json'), JSON.stringify({
      packages: {
        '': {
          dependencies: {
            '@anthropic-ai/claude-agent-sdk': '0.3.226',
          },
        },
        'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.220' },
      },
    }));
    fs.writeFileSync(path.join(fixtureRoot, 'bun.lock'), `{
      "workspaces": { "": { "dependencies": {
        "@anthropic-ai/claude-agent-sdk": "0.3.226",
      }, }, },
      "packages": {
        "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.226"],
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
    assert.match(result.stderr, /package-lock\.json resolution: @anthropic-ai\/claude-agent-sdk/);
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

test('shared modules do not depend on application or feature orchestration', () => {
  assert.deepEqual(findResolvedImportViolations(
    [path.join(sourceRoot, 'shared')],
    target => isPathWithin(target, appRoot) || isPathWithin(target, featuresRoot),
  ), []);
});

test('utility modules are leaves that import only other utilities', () => {
  const utilsRoot = path.join(sourceRoot, 'utils');
  assert.deepEqual(findResolvedImportViolations(
    [utilsRoot],
    target => !isPathWithin(target, utilsRoot),
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

test('application and core selection consume provider policy rather than chat UI', () => {
  assert.deepEqual(findMatches([appRoot, path.join(sourceRoot, 'core')], /\.getChatUIConfig\s*\(/), []);
});
