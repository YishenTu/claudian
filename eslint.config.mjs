import js from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import tseslint from '@typescript-eslint/eslint-plugin';
import jestPlugin from 'eslint-plugin-jest';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import { defineConfig } from 'eslint/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const jestRecommended = jestPlugin.configs['flat/recommended'];
const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));
const obsidianRuleSeverity = 'error';

// Enforces the file naming conventions from AGENTS.md without extra dependencies.
// Exported so scripts/check-eslint-config.test.mjs can exercise it directly.
export const fileNamingRule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Enforce the file naming conventions from AGENTS.md' },
    messages: {
      invalidCase:
        "Filename '{{name}}' must use camelCase, PascalCase, or kebab-case (see AGENTS.md naming conventions).",
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
        if (!isCamel) return;
        const concept = first.charAt(0).toUpperCase() + first.slice(1);
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

const localPlugin = { rules: { 'file-naming': fileNamingRule } };

const stagedObsidianRules = {
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
      ignoreWords: ['Claudian', 'Codex', 'OpenCode', 'Pi', 'WSL'],
      brands: [...DEFAULT_BRANDS, 'Claudian', 'Codex', 'OpenCode', 'Pi'],
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
      '@typescript-eslint/no-explicit-any': 'off',
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
    plugins: {
      'eslint-comments': eslintComments,
      obsidianmd,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      ...stagedObsidianRules,
      ...strictTypeAwareRules,
      'eslint-comments/no-restricted-disable': [
        'error',
        'obsidianmd/*',
      ],
      'eslint-comments/require-description': 'error',
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
    ...jestRecommended,
    rules: {
      ...jestRecommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]);
