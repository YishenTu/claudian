import '@/providers';

import {
  getEnvironmentScopeUpdates,
  getRuntimeEnvironmentVariables,
  setEnvironmentVariablesForScope,
} from '@/core/providers/providerEnvironment';

it('keeps a tab-exported provider assignment scoped when applying a shell snippet', () => {
  const snippet = '# Custom Claude endpoint\nexport\tANTHROPIC_BASE_URL="https://example.test/api"';
  const settings: Record<string, unknown> = {};
  const updates = getEnvironmentScopeUpdates(snippet, 'shared');

  expect(updates).toEqual([{ scope: 'provider:claude', envText: snippet }]);
  for (const { scope, envText } of updates) {
    setEnvironmentVariablesForScope(settings, scope, envText);
  }

  expect(getRuntimeEnvironmentVariables(settings, 'claude')).toEqual({
    ANTHROPIC_BASE_URL: 'https://example.test/api',
  });
  expect(getRuntimeEnvironmentVariables(settings, 'codex')).toEqual({});
});
