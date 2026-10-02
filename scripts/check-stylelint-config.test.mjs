import assert from 'node:assert/strict';
import test from 'node:test';
import stylelint from 'stylelint';

import packageJson from '../package.json' with { type: 'json' };
import stylelintConfig from '../stylelint.config.mjs';

test('CSS lint rejects important declarations across source styles', () => {
  assert.deepEqual(stylelintConfig.rules['declaration-no-important'], [true]);
  assert.match(packageJson.scripts.lint, /npm run lint:css/);
  assert.match(packageJson.scripts['lint:css'], /stylelint .*src\/style/);
});

for (const [name, code, rule] of [
  ['relational selectors', '.claudian-settings:has(textarea) { display: block; }', 'selector-pseudo-class-disallowed-list'],
  ['display contents', '.claudian-settings { display: contents; }', 'declaration-property-value-disallowed-list'],
  ['hanging text indent', '.claudian-tool-script-call { text-indent: -20px; }', 'property-disallowed-list'],
  ['text indent reset', '.claudian-tool-status { text-indent: 0; }', 'property-disallowed-list'],
]) {
  test(`CSS lint rejects ${name}`, async () => {
    const result = await stylelint.lint({ code, config: stylelintConfig });
    assert.equal(result.errored, true);
    assert.ok(result.results[0].warnings.some(warning => warning.rule === rule && warning.severity === 'error'));
  });
}

test('CSS lint accepts explicit classes, ordinary pseudo-classes, and grid layout', async () => {
  const result = await stylelint.lint({
    code: '.claudian-settings-textarea:focus-within { display: grid; }',
    config: stylelintConfig,
  });
  assert.equal(result.errored, false);
  assert.deepEqual(result.results[0].warnings, []);
});
