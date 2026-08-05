import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

import { fileNamingRule } from '../eslint.config.mjs';

test('Obsidian DOM creation helpers are enforced for source files', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile('src/utils/fileLink.ts');

  assert.deepEqual(config.rules['obsidianmd/prefer-create-el'], [2]);
});

test('TypeScript promise rejections require Error reasons', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(
    'src/features/chat/execution/ChatExecutionCoordinator.ts',
  );

  assert.deepEqual(config.rules['prefer-promise-reject-errors'], [
    2,
    { allowEmptyReject: false },
  ]);
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
