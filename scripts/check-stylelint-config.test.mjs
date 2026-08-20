import assert from 'node:assert/strict';
import test from 'node:test';

import packageJson from '../package.json' with { type: 'json' };
import stylelintConfig from '../stylelint.config.mjs';

test('CSS lint rejects important declarations across source styles', () => {
  assert.deepEqual(stylelintConfig.rules['declaration-no-important'], [true]);
  assert.match(packageJson.scripts.lint, /npm run lint:css/);
  assert.match(packageJson.scripts['lint:css'], /stylelint .*src\/style/);
});
