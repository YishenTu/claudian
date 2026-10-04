import {
  getAntigravityProviderSettings,
  updateAntigravityProviderSettings,
} from '@/providers/antigravity/settings';

describe('Antigravity provider settings', () => {
  it('returns default settings when none are configured', () => {
    const settings = getAntigravityProviderSettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.authMethod).toBe('oauth-personal');
    expect(settings.permissionMode).toBe('default');
    expect(settings.selectedModel).toBe('gemini-3.8-flash-high');
    expect(settings.visibleModels).toContain('gemini-3.8-flash-high');
  });

  it('updates settings and preserves overrides', () => {
    const baseSettings = { providerConfigs: {} };
    updateAntigravityProviderSettings(baseSettings, {
      authMethod: 'gemini-api-key',
      geminiApiKey: 'test-api-key',
      permissionMode: 'yolo',
      selectedModel: 'gemini-pro-agent',
    });

    const parsed = getAntigravityProviderSettings(baseSettings);
    expect(parsed.authMethod).toBe('gemini-api-key');
    expect(parsed.geminiApiKey).toBe('test-api-key');
    expect(parsed.permissionMode).toBe('yolo');
    expect(parsed.selectedModel).toBe('gemini-pro-agent');
  });

  it('supports host-scoped cli paths', () => {
    const baseSettings = { providerConfigs: {} };
    updateAntigravityProviderSettings(baseSettings, {
      cliPathsByHost: {
        'desktop-workstation': '/usr/local/bin/agy_acp_server.par',
      },
    });

    const parsed = getAntigravityProviderSettings(baseSettings);
    expect(parsed.cliPathsByHost['desktop-workstation']).toBe(
      '/usr/local/bin/agy_acp_server.par',
    );
  });
});
