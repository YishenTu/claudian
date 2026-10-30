import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import vitestPlugin from '@vitest/eslint-plugin';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import { defineConfig } from 'eslint/config';
import { isBuiltin } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from './package.json' with { type: 'json' };

const vitestRecommended = vitestPlugin.configs.recommended;
const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));
const obsidianRuleSeverity = 'error';

// Keep acronym boundaries explicit so ordinary words such as Client stay intact.
const filenameAcronyms = [
  'ACP', 'API', 'CLI', 'CSS', 'DOM', 'HTML', 'HTTP', 'HTTPS', 'ID', 'JS',
  'JSON', 'JSONL', 'LAN', 'MCP', 'RPC', 'SDK', 'SQL', 'TLS', 'UI', 'URI', 'URL', 'XML',
];
const acronymSpellings = new Map(filenameAcronyms.map(acronym => [
  acronym[0] + acronym.slice(1).toLowerCase(), acronym,
]));
const acronymWords = new RegExp(`(${[...acronymSpellings.keys()].sort((a, b) => b.length - a.length).join('|')})(s?)(?=[A-Z0-9]|$)`, 'g');
const preserveAcronyms = name => name.replace(acronymWords, (_, word, plural) => acronymSpellings.get(word) + plural);

// Enforces the file naming conventions from AGENTS.md without extra dependencies.
// Exported so scripts/check-eslint-config.test.mjs can exercise it directly.
export const fileNamingRule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Enforce the file naming conventions from AGENTS.md' },
    messages: {
      invalidCase:
        "Filename '{{name}}' must use camelCase, PascalCase, or kebab-case (see AGENTS.md naming conventions).",
      acronymCase:
        "Filename '{{name}}' must preserve acronym capitals ('{{expected}}').",
      conceptMismatch:
        "File '{{name}}' exports '{{concept}}'; modules with a primary named concept use a PascalCase filename ('{{concept}}.ts').",
    },
  },
  create(context) {
    const filename = context.physicalFilename ?? context.filename;
    const base = filename.split(/[\\/]/).pop() ?? '';
    if (!base.endsWith('.ts')) return {};
    const first = base.split('.')[0];
    if (first === 'index' || first === 'types') return {};
    const isCamel = /^[a-z][a-zA-Z0-9]*$/.test(first);
    const isPascal = /^[A-Z][a-zA-Z0-9]*$/.test(first);
    const isKebab = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(first);
    return {
      Program(node) {
        if (!isCamel && !isPascal && !isKebab) {
          context.report({ node, messageId: 'invalidCase', data: { name: base } });
          return;
        }
        const expected = preserveAcronyms(first);
        if (expected !== first) {
          context.report({ node, messageId: 'acronymCase', data: {
            name: base, expected: expected + base.slice(first.length),
          } });
          return;
        }
        if (!isCamel) return;
        const concept = preserveAcronyms(first.charAt(0).toUpperCase() + first.slice(1));
        for (const statement of node.body) {
          if (statement.type !== 'ExportNamedDeclaration' || !statement.declaration) continue;
          const declaration = statement.declaration;
          const declared =
            declaration.type === 'VariableDeclaration'
              ? declaration.declarations.map((d) => d.id).filter((id) => id.type === 'Identifier')
              : declaration.id
                ? [declaration.id]
                : [];
          if (declared.some((id) => id.name === concept)) {
            context.report({ node: statement, messageId: 'conceptMismatch', data: { name: base, concept } });
            return;
          }
        }
      },
    };
  },
};

const declaredTestPackages = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

// Vitest factory imports are invisible to ordinary static-import rules. Check
// declarations rather than resolution: a hoisted transitive package is not ours.
const declaredTestDependenciesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { undeclared: "Test dependency '{{name}}' must be declared in package.json." },
  },
  create(context) {
    function check(source) {
      const specifier = source?.value;
      if (typeof specifier !== 'string' || isBuiltin(specifier)
        || /^(\.{1,2}\/|\/|@\/|@test\/)/.test(specifier)) return;
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (!declaredTestPackages.has(name)) {
        context.report({ node: source, messageId: 'undeclared', data: { name } });
      }
    }
    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source),
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && callee.name === 'require') {
          check(node.arguments[0]);
        } else if (callee.type === 'MemberExpression' && !callee.computed
          && ['vi', 'vitest'].includes(callee.object.name)
          && ['importActual', 'importMock', 'mock', 'doMock'].includes(callee.property.name)) {
          check(node.arguments[0]);
        }
      },
    };
  },
};

const localPlugin = { rules: {
  'file-naming': fileNamingRule,
  'declared-test-dependencies': declaredTestDependenciesRule,
} };

// Hard-coded ISO timestamps for expiries or injected clocks make tests depend on the date they run.
const ISO_TIMESTAMP = "/^\\d{4}-\\d{2}-\\d{2}T/";
const TIME_KEY = '/^now$|[eE]xpiresAt$/';
const hardCodedTestTimeSelectors = [
  `Property[key.name=${TIME_KEY}] > Literal[value=${ISO_TIMESTAMP}]`,
  `Property[key.name=${TIME_KEY}] NewExpression[callee.name='Date'] > Literal[value=${ISO_TIMESTAMP}]`,
  `AssignmentExpression[left.property.name=${TIME_KEY}] NewExpression[callee.name='Date'] > Literal[value=${ISO_TIMESTAMP}]`,
];

// W2 removed duplicate host/identity implementations that hid real regressions.
// Current exception allowlist: none. A necessary fault-only override needs a
// narrow eslint-disable-next-line with the concrete fault explained beside it.
const sharedBoundaryMockRestrictions = ['obsidian', '@/core/device/InstallationKey'].flatMap(source => [
  'arguments.0.value',
  'arguments.0.source.value',
].map(argument => ({
  selector: `CallExpression[callee.object.name=/^(vi|vitest)$/][callee.property.name=/^(mock|doMock)$/][${argument}='${source}']`,
  message: 'Use the shared Obsidian fake or seeded InstallationKey; extend that owner for missing behavior. Keep test-specific faults at the public boundary.',
})));

// Keep the existing source policy stricter than the preset's advisory severities.
const strictObsidianRules = {
  'obsidianmd/commands/no-command-in-command-id': obsidianRuleSeverity,
  'obsidianmd/commands/no-command-in-command-name': obsidianRuleSeverity,
  'obsidianmd/commands/no-default-hotkeys': obsidianRuleSeverity,
  'obsidianmd/commands/no-plugin-id-in-command-id': obsidianRuleSeverity,
  'obsidianmd/commands/no-plugin-name-in-command-name': obsidianRuleSeverity,
  'obsidianmd/detach-leaves': obsidianRuleSeverity,
  'obsidianmd/editor-drop-paste': obsidianRuleSeverity,
  'obsidianmd/hardcoded-config-path': obsidianRuleSeverity,
  'obsidianmd/no-forbidden-elements': obsidianRuleSeverity,
  'obsidianmd/no-global-this': obsidianRuleSeverity,
  'obsidianmd/no-plugin-as-component': obsidianRuleSeverity,
  'obsidianmd/no-sample-code': obsidianRuleSeverity,
  'obsidianmd/no-static-styles-assignment': obsidianRuleSeverity,
  'obsidianmd/no-tfile-tfolder-cast': obsidianRuleSeverity,
  'obsidianmd/no-unsupported-api': obsidianRuleSeverity,
  'obsidianmd/no-view-references-in-plugin': obsidianRuleSeverity,
  'obsidianmd/object-assign': obsidianRuleSeverity,
  'obsidianmd/platform': obsidianRuleSeverity,
  'obsidianmd/prefer-abstract-input-suggest': obsidianRuleSeverity,
  'obsidianmd/prefer-active-doc': obsidianRuleSeverity,
  'obsidianmd/prefer-file-manager-trash-file': obsidianRuleSeverity,
  'obsidianmd/prefer-get-language': obsidianRuleSeverity,
  'obsidianmd/prefer-instanceof': obsidianRuleSeverity,
  'obsidianmd/prefer-window-timers': obsidianRuleSeverity,
  'obsidianmd/regex-lookbehind': obsidianRuleSeverity,
  'obsidianmd/sample-names': obsidianRuleSeverity,
  'obsidianmd/settings-tab/no-deprecated-display': obsidianRuleSeverity,
  'obsidianmd/settings-tab/no-manual-html-headings': obsidianRuleSeverity,
  'obsidianmd/settings-tab/no-problematic-settings-headings': obsidianRuleSeverity,
  'obsidianmd/ui/sentence-case': [
    obsidianRuleSeverity,
    {
      ignoreWords: ['Claudian', 'Codex', 'Grok', 'OpenCode', 'Pi', 'WSL'],
      brands: [...DEFAULT_BRANDS, 'Claude Code', 'Claudian', 'Codex', 'Grok Build', 'OpenCode', 'Pi'],
      acronyms: [...DEFAULT_ACRONYMS, 'TOML', 'WSL'],
      ignoreRegex: ['\\.(?:claude|codex|opencode)/'],
      enforceCamelCaseLower: true,
    },
  ],
  'obsidianmd/vault/iterate': obsidianRuleSeverity,
};

const strictTypeAwareRules = {
  'prefer-promise-reject-errors': 'off',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-deprecated': 'error',
  '@typescript-eslint/no-duplicate-type-constituents': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-redundant-type-constituents': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/unbound-method': 'error',
};

export default defineConfig([
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'main.js'],
  },
  js.configs.recommended,
  {
    files: ['esbuild.config.mjs', 'scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        module: 'readonly',
        process: 'readonly',
      },
    },
  },
  ...tseslint.configs['flat/recommended'],
  {
    // Checked-in native peers run as standalone Node CommonJS processes.
    files: ['tests/helpers/providers/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['src/**/*.ts', 'package.json'],
    extends: obsidianmd.configs.recommended,
  },
  {
    files: ['manifest.json'],
    languageOptions: { parser: tsparser, parserOptions: { project: false } },
    plugins: { obsidianmd },
    rules: {
      'obsidianmd/validate-manifest': 'error',
      // JSON is parsed as an object expression for the official manifest rule.
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    plugins: {
      'simple-import-sort': simpleImportSort,
      local: localPlugin,
    },
    rules: {
      'local/file-naming': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', ignoreRestSiblings: true },
      ],
      'prefer-promise-reject-errors': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir,
      },
    },
    rules: {
      ...strictObsidianRules,
      ...strictTypeAwareRules,
      // Preserve project constraints that the official preset relaxes.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: false, allowTernary: false }],
      'prefer-const': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      // Desktop-only plugin; legacy display() and license checks do not apply here.
      'obsidianmd/no-nodejs-modules': 'off',
      'obsidianmd/settings-tab/require-display': 'off',
      'obsidianmd/validate-license': 'off',
      'obsidianmd/validate-manifest': 'off',
      'obsidianmd/prefer-create-el': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow', trailingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'classProperty', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow', trailingUnderscore: 'allow' },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'typeProperty', format: null },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    ...vitestRecommended,
    rules: {
      ...vitestRecommended.rules,
      'local/declared-test-dependencies': 'error',
      'vitest/no-alias-methods': 'error',
      'vitest/no-done-callback': 'error',
      'vitest/no-test-prefixes': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: false }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': [
        'error',
        ...sharedBoundaryMockRestrictions,
        ...hardCodedTestTimeSelectors.map(selector => ({
          selector,
          message: 'Express expiries and clocks with testTime/testDate/testClock from @test/helpers/testClock.',
        })),
      ],
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sharedBoundaryMockRestrictions,
        ...hardCodedTestTimeSelectors.map(selector => ({
          selector,
          message: 'Express expiries and clocks with testTime/testDate/testClock from @test/helpers/testClock.',
        })),
        { selector: 'ExportNamedDeclaration, ExportDefaultDeclaration, ExportAllDeclaration', message: 'Keep reusable exports in test helpers rather than test suites.' },
      ],
    },
  },
  {
    files: ['tests/helpers/testClock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sharedBoundaryMockRestrictions,
        ...[
          'Literal[value=/\\d{4}-\\d{2}-\\d{2}T/]',
          'TemplateElement[value.raw=/\\d{4}-\\d{2}-\\d{2}T/]',
          "NewExpression[callee.name='Date'][arguments.length>1][arguments.0.type='Literal']",
          "CallExpression[callee.object.name='Date'][callee.property.name='UTC'][arguments.0.type='Literal']",
        ].map(selector => ({
          selector,
          message: 'Derive fixture timestamps from @test/helpers/testClock instead of a fixed calendar date.',
        })),
      ],
    },
  },
]);
