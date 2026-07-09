import { getOctoAgentProviderSettings } from '@/providers/octo-agent/settings';

describe('getOctoAgentProviderSettings', () => {
  it('returns defaults when no provider config exists', () => {
    const settings = getOctoAgentProviderSettings({});

    expect(settings.enabled).toBe(false);
    expect(settings.host).toBe('127.0.0.1');
    expect(settings.port).toBe(8088);
    expect(settings.autoStartServer).toBe(true);
    expect(settings.cliPath).toBe('octo');
    expect(settings.accessKey).toBe('');
  });

  it('reads values from the octo-agent provider config', () => {
    const settings = getOctoAgentProviderSettings({
      providerConfigs: {
        'octo-agent': {
          accessKey: 'octo_secret',
          autoStartServer: false,
          cliPath: '/opt/homebrew/bin/octo',
          enabled: true,
          host: '0.0.0.0',
          port: 9999,
        },
      },
    });

    expect(settings.enabled).toBe(true);
    expect(settings.host).toBe('0.0.0.0');
    expect(settings.port).toBe(9999);
    expect(settings.autoStartServer).toBe(false);
    expect(settings.cliPath).toBe('/opt/homebrew/bin/octo');
    expect(settings.accessKey).toBe('octo_secret');
  });
});
