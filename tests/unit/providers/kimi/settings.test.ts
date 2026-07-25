const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import {
  DEFAULT_KIMI_PROVIDER_CONFIG,
  getKimiProviderSettings,
  normalizeKimiStoredConfig,
  updateKimiProviderSettings,
} from '@/providers/kimi/settings';
import {
  buildKimiProviderState,
  buildPersistedKimiProviderState,
  parseKimiProviderState,
} from '@/providers/kimi/types';

describe('Kimi settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('defaults to disabled with empty CLI, environment, and model state', () => {
    expect(DEFAULT_KIMI_PROVIDER_CONFIG).toEqual({
      cliPath: '',
      cliPathsByHost: {},
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: {},
      preferredThinkingByModel: {},
      visibleModels: null,
    });
  });

  it('normalizes garbage stored config into defaults', () => {
    expect(normalizeKimiStoredConfig({
      cliPath: 42,
      cliPathsByHost: ['/not/a/map'],
      enabled: 'yes',
      environmentHash: null,
      environmentVariables: 7,
      modelAliases: 'not-a-map',
      visibleModels: 'kimi-for-coding',
    })).toEqual(DEFAULT_KIMI_PROVIDER_CONFIG);

    expect(normalizeKimiStoredConfig({
      cliPath: '  /opt/kimi  ',
      cliPathsByHost: {
        'device:current': ' /current/kimi ',
        'device:blank': '   ',
        'device:invalid': 9,
      },
      modelAliases: {
        ' kimi-for-coding ': ' Kimi ',
        '': 'dropped',
        'kimi-k2': '   ',
      },
      preferredThinkingByModel: {
        ' kimi-k2 ': ' high ',
        '': 'dropped',
        'kimi-for-coding': '   ',
      },
      visibleModels: [
        ' kimi-for-coding ',
        'kimi-for-coding',
        '',
        12,
        'kimi-k2',
      ],
    })).toEqual({
      cliPath: '/opt/kimi',
      cliPathsByHost: { 'device:current': '/current/kimi' },
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: { 'kimi-for-coding': 'Kimi' },
      preferredThinkingByModel: { 'kimi-k2': 'high' },
      visibleModels: ['kimi-for-coding', 'kimi-k2'],
    });
  });

  it('migrates the legacy hostname CLI path to the opaque current host key', () => {
    const settings = getKimiProviderSettings({
      providerConfigs: {
        kimi: {
          cliPathsByHost: {
            'legacy-host': '/legacy/kimi',
            'other-host': '/other/kimi',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'device:current': '/legacy/kimi',
      'other-host': '/other/kimi',
    });
  });

  it('keeps the current host path when both current and legacy keys exist', () => {
    const settings = getKimiProviderSettings({
      providerConfigs: {
        kimi: {
          cliPathsByHost: {
            'device:current': '/current/kimi',
            'legacy-host': '/legacy/kimi',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({ 'device:current': '/current/kimi' });
  });

  it('migrates a legacy top-level cliPath into the current host when cliPath is set', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: { cliPath: '/legacy/kimi' },
      },
    };

    const preserved = updateKimiProviderSettings(settings, { enabled: true });
    expect(preserved.cliPath).toBe('/legacy/kimi');
    expect(preserved.cliPathsByHost).toEqual({});

    const next = updateKimiProviderSettings(settings, { cliPath: ' /opt/bin/kimi ' });
    expect(next.cliPath).toBe('');
    expect(next.cliPathsByHost).toEqual({ 'device:current': '/opt/bin/kimi' });
    expect(getKimiProviderSettings(settings).cliPathsByHost).toEqual({
      'device:current': '/opt/bin/kimi',
    });
  });

  it('round-trips updates without clobbering unrelated providers', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true },
        kimi: { cliPathsByHost: { 'other-host': '/other/kimi' } },
      },
    };

    const next = updateKimiProviderSettings(settings, {
      cliPath: ' /opt/bin/kimi ',
      enabled: true,
      modelAliases: { 'kimi-for-coding': ' Kimi ' },
      visibleModels: ['kimi-for-coding'],
    });

    expect(next).toMatchObject({
      cliPath: '',
      cliPathsByHost: {
        'device:current': '/opt/bin/kimi',
        'other-host': '/other/kimi',
      },
      enabled: true,
      modelAliases: { 'kimi-for-coding': 'Kimi' },
      visibleModels: ['kimi-for-coding'],
    });
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({ enabled: true });

    const cleared = updateKimiProviderSettings(settings, { cliPath: '' });
    expect(cleared.cliPathsByHost).toEqual({ 'other-host': '/other/kimi' });
  });

  it('replaces host-scoped CLI paths wholesale when cliPathsByHost is provided', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: { cliPathsByHost: { 'device:current': '/old/kimi' } },
      },
    };

    const next = updateKimiProviderSettings(settings, {
      cliPathsByHost: { 'device:current': '/new/kimi', 'device:other': 5 as never },
    });

    expect(next.cliPathsByHost).toEqual({ 'device:current': '/new/kimi' });
    expect(next.cliPath).toBe('');
  });

  it('hashes environment inputs through update round-trips', () => {
    const settings: Record<string, unknown> = {};

    const next = updateKimiProviderSettings(settings, {
      environmentHash: '  abc123  ',
      environmentVariables: 'KIMI_API_KEY=secret',
    });

    expect(next.environmentHash).toBe('abc123');
    expect(next.environmentVariables).toBe('KIMI_API_KEY=secret');
    expect(getKimiProviderSettings(settings)).toMatchObject({
      environmentHash: 'abc123',
      environmentVariables: 'KIMI_API_KEY=secret',
    });

    const preserved = updateKimiProviderSettings(settings, { enabled: true });
    expect(preserved.environmentHash).toBe('abc123');
    expect(preserved.environmentVariables).toBe('KIMI_API_KEY=secret');
  });
});

describe('Kimi provider state', () => {
  it('parses and builds only an absolute native session directory hint', () => {
    expect(parseKimiProviderState({
      sessionDirectory: ' /tmp/.kimi/sessions/vault/session-id ',
      token: 'do-not-preserve',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi/sessions/vault/session-id',
    });
    expect(parseKimiProviderState({ sessionDirectory: '../outside' })).toEqual({});
    expect(parseKimiProviderState({ sessionDirectory: 'relative/path' })).toEqual({});
    expect(parseKimiProviderState(null)).toEqual({});
    expect(parseKimiProviderState('session-id')).toEqual({});
    expect(buildKimiProviderState('/tmp/.kimi/sessions/vault/session-id')).toEqual({
      sessionDirectory: '/tmp/.kimi/sessions/vault/session-id',
    });
    expect(buildKimiProviderState('../outside')).toBeUndefined();
    expect(buildKimiProviderState(null)).toBeUndefined();
  });

  it('persists only the sanitized session directory field', () => {
    expect(buildPersistedKimiProviderState({
      sessionDirectory: ' /tmp/.kimi/sessions/vault/session-id ',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi/sessions/vault/session-id',
    });
    expect(buildPersistedKimiProviderState({})).toBeUndefined();
    expect(buildPersistedKimiProviderState({ sessionDirectory: 'not-absolute' })).toBeUndefined();
  });
});
