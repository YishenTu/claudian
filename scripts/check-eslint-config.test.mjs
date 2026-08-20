import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

import { fileNamingRule } from '../eslint.config.mjs';

test('Obsidian DOM creation helpers are enforced for source files', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile('src/utils/fileLink.ts');

  assert.deepEqual(config.rules['obsidianmd/prefer-create-el'], [2]);
});

test('TypeScript promise rejections require Error reasons with type information', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(
    'src/features/chat/execution/ChatExecutionCoordinator.ts',
  );

  assert.equal(config.rules['prefer-promise-reject-errors'][0], 0);
  assert.equal(config.rules['@typescript-eslint/prefer-promise-reject-errors'][0], 2);
});

test('source lint matches strict Obsidian and type-aware review policy', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(
    'src/features/chat/ClaudianView.ts',
  );

  for (const rule of [
    '@typescript-eslint/await-thenable',
    '@typescript-eslint/no-deprecated',
    '@typescript-eslint/no-redundant-type-constituents',
    '@typescript-eslint/no-unsafe-call',
    '@typescript-eslint/no-unsafe-member-access',
    '@typescript-eslint/prefer-promise-reject-errors',
    'eslint-comments/require-description',
    'obsidianmd/detach-leaves',
    'obsidianmd/hardcoded-config-path',
    'obsidianmd/settings-tab/no-deprecated-display',
  ]) {
    assert.equal(config.rules[rule]?.[0], 2, `${rule} must be an error`);
  }
  assert.deepEqual(config.rules['eslint-comments/no-restricted-disable'], [
    2,
    'obsidianmd/*',
  ]);
});

test('collab protocol source receives type-aware lint rules', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(
    'packages/collab-protocol/src/CollabControlOperationCodecs.ts',
  );

  for (const rule of [
    '@typescript-eslint/await-thenable',
    '@typescript-eslint/no-redundant-type-constituents',
    '@typescript-eslint/no-unnecessary-type-assertion',
    '@typescript-eslint/no-unsafe-call',
    '@typescript-eslint/no-unsafe-member-access',
  ]) {
    assert.equal(config.rules[rule]?.[0], 2, `${rule} must be an error`);
  }
});

// ESLint hands the rule an absolute path using the host platform's separator, so the
// basename has to be taken from either separator. Windows paths are used here on every
// platform on purpose: they are what regressed, and CI only runs Linux.
function reportsFor(physicalFilename) {
  const reported = [];
  const visitor = fileNamingRule.create({
    physicalFilename,
    report: descriptor => reported.push(descriptor),
  });
  visitor.Program({ body: [] });

  return reported;
}

test('file naming reads the basename from either path separator', () => {
  assert.deepEqual(reportsFor('/repo/src/utils/fileLink.ts'), []);
  assert.deepEqual(reportsFor('D:\\repo\\src\\utils\\fileLink.ts'), []);
});

test('file naming still rejects an invalid basename behind a Windows path', () => {
  const reported = reportsFor('D:\\repo\\src\\utils\\some_snake_case.ts');

  assert.equal(reported.length, 1);
  assert.equal(reported[0].messageId, 'invalidCase');
  assert.equal(reported[0].data.name, 'some_snake_case.ts');
});
