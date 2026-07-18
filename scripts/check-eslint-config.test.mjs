import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

test('Obsidian DOM creation helpers are enforced for source files', async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText([
    "document.createElement('p');",
    "createEl('span');",
    'document.createDocumentFragment();',
  ].join('\n'), {
    filePath: 'src/utils/fileLink.ts',
  });
  const helperErrors = result.messages.filter(message => (
    message.ruleId === 'obsidianmd/prefer-create-el'
  ));

  assert.equal(helperErrors.length, 3);
  assert.ok(helperErrors.every(message => message.severity === 2));
});
