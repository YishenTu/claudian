import assert from 'node:assert/strict';
import test from 'node:test';
import stylelint from 'stylelint';

import packageJson from '../package.json' with { type: 'json' };
import stylelintConfig from '../stylelint.config.mjs';

test('CSS lint runs across source styles and fails on official preset warnings', () => {
  assert.match(packageJson.scripts.lint, /npm run lint:css/);
  assert.match(packageJson.scripts['lint:css'], /stylelint .*src\/style/);
  assert.match(packageJson.scripts['lint:css'], /--max-warnings=0/);
});

for (const [name, code, rule] of [
  ['important declarations', '.claudian-settings { color: #fff !important; }', 'declaration-no-important'],
  ['relational selectors', '.claudian-settings:has(textarea) { display: block; }', 'selector-pseudo-class-disallowed-list'],
  ['display contents', '.claudian-settings { display: contents; }', 'plugin/no-unsupported-browser-features'],
  ['hanging text indent', '.claudian-tool-script-call { text-indent: -20px; }', 'plugin/no-unsupported-browser-features'],
  ['text indent reset', '.claudian-tool-status { text-indent: 0; }', 'plugin/no-unsupported-browser-features'],
  ['external CSS assets', '.claudian-settings { background: url("https://example.com/image.png"); }', 'function-url-scheme-disallowed-list'],
  ['unknown properties', '.claudian-settings { colr: #fff; }', 'property-no-unknown'],
  ['global resets', '.claudian-settings { all: initial; }', 'property-disallowed-list'],
]) {
  test(`CSS lint rejects ${name}`, async () => {
    const result = await stylelint.lint({ code, config: stylelintConfig, maxWarnings: 0 });
    assert.ok(result.errored || result.maxWarningsExceeded);
    assert.ok(result.results[0].warnings.some(warning => warning.rule === rule));
  });
}

test('CSS lint accepts component modifiers, host classes, ordinary pseudo-classes, and grid layout', async () => {
  const result = await stylelint.lint({
    code: '.claudian-settings-tab--active .cm-widgetBuffer:focus-within { display: grid; }',
    config: stylelintConfig,
    maxWarnings: 0,
  });
  assert.equal(result.errored, false);
  assert.equal(result.maxWarningsExceeded, undefined);
  assert.deepEqual(result.results[0].warnings, []);
});
