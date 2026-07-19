import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';

describe('enhanced default settings', () => {
  it('starts new installs with Codex and GPT-5.6 selected', () => {
    expect(DEFAULT_CLAUDIAN_SETTINGS.settingsProvider).toBe('codex');
    expect(DEFAULT_CLAUDIAN_SETTINGS.model).toBe('gpt-5.6-sol');
    expect(DEFAULT_CLAUDIAN_SETTINGS.savedProviderModel).toMatchObject({
      codex: 'gpt-5.6-sol',
    });
    expect(DEFAULT_CLAUDIAN_SETTINGS.providerConfigs.codex).toMatchObject({
      enabled: true,
    });
  });

  it('does not grant fresh installs approval-free full-machine access', () => {
    expect(DEFAULT_CLAUDIAN_SETTINGS.permissionMode).toBe('normal');
  });
});
