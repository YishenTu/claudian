import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';

it('scopes a history path context to the provider configuration and its environment', () => {
  const settings = {
    sharedEnvironmentVariables: 'SHARED=1',
    providerConfigs: {
      opencode: { cliPath: '/bin/opencode', environmentVariables: 'OPENCODE_DB=/tmp/native.db' },
      codex: { cliPath: '/bin/codex', environmentVariables: 'CODEX_HOME=/tmp/claudian-test-codex-home' },
    },
  };

  const context = createProviderHistoryPathContext(settings, 'opencode', '/vault');

  expect(context).toMatchObject({
    config: { cliPath: '/bin/opencode', environmentVariables: 'OPENCODE_DB=/tmp/native.db' },
    environmentText: 'SHARED=1\nOPENCODE_DB=/tmp/native.db',
    hostPlatform: process.platform,
    vaultPath: '/vault',
  });
  expect(context.environment).toMatchObject({ SHARED: '1', OPENCODE_DB: '/tmp/native.db' });
  // Another provider's configured environment never leaks in; inherited process values still apply.
  expect(context.environment.CODEX_HOME).toBe(process.env.CODEX_HOME);
  expect(context).not.toHaveProperty('settings');
});
