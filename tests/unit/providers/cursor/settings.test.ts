import {
  DEFAULT_CURSOR_PROVIDER_SETTINGS,
  getCursorProviderSettings,
  updateCursorProviderSettings,
} from '@/providers/cursor/settings';

const mockGetHostnameKey = jest.fn(() => 'host-a');

jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => mockGetHostnameKey(),
  };
});

describe('cursor settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns defaults when no provider config is present', () => {
    const settings = getCursorProviderSettings({});

    expect(settings.enabled).toBe(false);
    expect(settings.cliPath).toBe('');
    expect(settings.cliPathsByHost).toEqual({});
    expect(settings.customModels).toBe('');
    expect(settings.environmentVariables).toBe('');
    expect(settings.environmentHash).toBe('');
    expect(settings.enabled).toBe(DEFAULT_CURSOR_PROVIDER_SETTINGS.enabled);
  });

  it('reads enabled from provider config', () => {
    const settings = getCursorProviderSettings({
      providerConfigs: {
        cursor: {
          enabled: true,
        },
      },
    });
    expect(settings.enabled).toBe(true);
  });

  it('normalizes invalid cliPathsByHost entries', () => {
    const settings = getCursorProviderSettings({
      providerConfigs: {
        cursor: {
          cliPathsByHost: {
            'host-a': '/usr/local/bin/cursor-agent',
            'host-empty': '   ',
            'host-bad': 42,
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'host-a': '/usr/local/bin/cursor-agent',
    });
  });

  it('round-trips updates through provider config', () => {
    const settingsBag: Record<string, unknown> = {};

    const next = updateCursorProviderSettings(settingsBag, {
      enabled: true,
      cliPath: '  /opt/cursor-agent  ',
      customModels: 'composer-1\ngpt-5',
    });

    expect(next.enabled).toBe(true);
    expect(next.cliPath).toBe('  /opt/cursor-agent  ');
    expect(next.customModels).toBe('composer-1\ngpt-5');

    const reread = getCursorProviderSettings(settingsBag);
    expect(reread.enabled).toBe(true);
    expect(reread.cliPath).toBe('  /opt/cursor-agent  ');
    expect(reread.customModels).toBe('composer-1\ngpt-5');
  });

  it('preserves existing cliPathsByHost when other fields are updated', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        cursor: {
          cliPathsByHost: {
            'host-b': '/opt/cursor-agent',
          },
        },
      },
    };

    const next = updateCursorProviderSettings(settingsBag, { enabled: true });

    expect(next.cliPathsByHost).toEqual({
      'host-b': '/opt/cursor-agent',
    });
  });

  it('replaces cliPathsByHost when explicitly provided', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        cursor: {
          cliPathsByHost: {
            'host-b': '/opt/cursor-agent',
          },
        },
      },
    };

    const next = updateCursorProviderSettings(settingsBag, {
      cliPathsByHost: {
        'host-a': '/new/path',
      },
    });

    expect(next.cliPathsByHost).toEqual({
      'host-a': '/new/path',
    });
  });

  it('falls back to provider environmentVariables when set', () => {
    const settings = getCursorProviderSettings({
      providerConfigs: {
        cursor: {
          environmentVariables: 'CURSOR_API_KEY=abc',
        },
      },
    });
    expect(settings.environmentVariables).toBe('CURSOR_API_KEY=abc');
  });
});
