const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import {
  DEFAULT_GROK_PROVIDER_SETTINGS,
  getGrokProviderSettings,
  normalizeGrokSafeMode,
  updateGrokProviderSettings,
} from '../../../../src/providers/grok/settings';

describe('Grok provider settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('host-a');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('defaults to disabled with workspace sandbox', () => {
    expect(DEFAULT_GROK_PROVIDER_SETTINGS).toEqual({
      enabled: false,
      safeMode: 'workspace',
      cliPath: '',
      cliPathsByHost: {},
      environmentVariables: '',
      environmentHash: '',
    });
    expect(getGrokProviderSettings({})).toMatchObject({
      enabled: false,
      safeMode: 'workspace',
    });
  });

  it('normalizes legacy workspace-write sandbox to workspace', () => {
    expect(normalizeGrokSafeMode('workspace-write')).toBe('workspace');
    expect(normalizeGrokSafeMode('read-only')).toBe('read-only');
    expect(normalizeGrokSafeMode('read_only')).toBe('read-only');
  });

  it('reads and updates providerConfigs.grok', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          enabled: true,
          safeMode: 'workspace-write',
          cliPathsByHost: {
            'host-a': '/host-a/grok',
          },
          environmentVariables: 'GROK_MODEL=grok-4.5',
        },
      },
    };

    expect(getGrokProviderSettings(settings)).toMatchObject({
      enabled: true,
      safeMode: 'workspace',
      cliPathsByHost: {
        'host-a': '/host-a/grok',
      },
      environmentVariables: 'GROK_MODEL=grok-4.5',
    });

    updateGrokProviderSettings(settings, {
      enabled: false,
      safeMode: 'read-only',
      cliPathsByHost: {
        'host-a': '/custom/grok',
      },
    });

    expect(getGrokProviderSettings(settings)).toMatchObject({
      enabled: false,
      safeMode: 'read-only',
      cliPathsByHost: {
        'host-a': '/custom/grok',
      },
    });
  });

  it('maps bare cliPath updates onto the current host', () => {
    const settings: Record<string, unknown> = { providerConfigs: {} };
    updateGrokProviderSettings(settings, { cliPath: '/usr/local/bin/grok' });

    expect(getGrokProviderSettings(settings)).toMatchObject({
      cliPath: '',
      cliPathsByHost: {
        'host-a': '/usr/local/bin/grok',
      },
    });
  });

  it('migrates legacy hostname-scoped CLI paths', () => {
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('host-a');

    expect(getGrokProviderSettings({
      providerConfigs: {
        grok: {
          cliPathsByHost: {
            'host-a': '/legacy/host/grok',
          },
        },
      },
    }).cliPathsByHost).toEqual({
      'device:current': '/legacy/host/grok',
    });
  });
});
