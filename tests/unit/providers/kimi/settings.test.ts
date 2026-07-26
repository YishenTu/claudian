const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import {
  getKimiDiscoveryState,
  updateKimiDiscoveryState,
} from '@/providers/kimi/discoveryState';
import {
  DEFAULT_KIMI_PROVIDER_CONFIG,
  getKimiProviderSettings,
  normalizeKimiStoredConfig,
  updateKimiProviderSettings,
} from '@/providers/kimi/settings';
import {
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
      currentThinkingByModel: {},
      discoveredModels: [],
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: {},
      preferredThinkingByModel: {},
      thinkingOptionsByModel: {},
      visibleModels: null,
    });
  });

  it('normalizes garbage stored config into defaults', () => {
    expect(normalizeKimiStoredConfig({
      cliPath: 42,
      cliPathsByHost: ['/not/a/map'],
      currentThinkingByModel: 'not-a-map',
      enabled: 'yes',
      environmentHash: null,
      environmentVariables: 7,
      modelAliases: 'not-a-map',
      discoveredModels: 'not-a-list',
      thinkingOptionsByModel: 'not-a-map',
      visibleModels: 'kimi-for-coding',
    })).toEqual(DEFAULT_KIMI_PROVIDER_CONFIG);

    expect(normalizeKimiStoredConfig({
      cliPath: '  /opt/kimi  ',
      cliPathsByHost: {
        'device:current': ' /current/kimi ',
        'device:blank': '   ',
        'device:invalid': 9,
      },
      currentThinkingByModel: {
        ' kimi-k2 ': ' high ',
        '': 'dropped',
        'kimi-for-coding': '   ',
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
      thinkingOptionsByModel: {
        ' kimi-k2 ': [
          { label: ' Off ', value: ' off ' },
          { label: 'Duplicate', value: 'off' },
          'garbage',
        ],
        'empty-options': [],
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
      currentThinkingByModel: { 'kimi-k2': 'high' },
      discoveredModels: [],
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: { 'kimi-for-coding': 'Kimi' },
      preferredThinkingByModel: { 'kimi-k2': 'high' },
      thinkingOptionsByModel: { 'kimi-k2': [{ label: 'Off', value: 'off' }] },
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
      environmentVariables: 'KIMI_LOG_LEVEL=debug',
    });

    expect(next.environmentHash).toBe('abc123');
    expect(next.environmentVariables).toBe('KIMI_LOG_LEVEL=debug');
    expect(getKimiProviderSettings(settings)).toMatchObject({
      environmentHash: 'abc123',
      environmentVariables: 'KIMI_LOG_LEVEL=debug',
    });

    const preserved = updateKimiProviderSettings(settings, { enabled: true });
    expect(preserved.environmentHash).toBe('abc123');
    expect(preserved.environmentVariables).toBe('KIMI_LOG_LEVEL=debug');
  });

  it('persists the discovered model catalog and mirrors it in memory', () => {
    const settings: Record<string, unknown> = {};
    const discovered = [
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { description: 'Latest K2', label: 'K2 Latest', rawId: 'kimi-k2-latest' },
    ];

    const next = updateKimiProviderSettings(settings, { discoveredModels: discovered });

    expect(next.discoveredModels).toEqual(discovered);
    expect(getKimiProviderSettings(settings).discoveredModels).toEqual(discovered);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual(discovered);
    const stored = (settings.providerConfigs as Record<string, Record<string, unknown>>).kimi;
    expect(stored.discoveredModels).toEqual(discovered);

    const preserved = updateKimiProviderSettings(settings, { enabled: true });
    expect(preserved.discoveredModels).toEqual(discovered);
  });

  it('persists thinking options and current levels per model', () => {
    const settings: Record<string, unknown> = {};
    const thinkingOptionsByModel = {
      'kimi-k2': [
        { label: 'Off', value: 'off' },
        { label: 'High', value: 'high' },
      ],
    };

    const next = updateKimiProviderSettings(settings, {
      currentThinkingByModel: { 'kimi-k2': 'high' },
      thinkingOptionsByModel,
    });

    expect(next.thinkingOptionsByModel).toEqual(thinkingOptionsByModel);
    expect(next.currentThinkingByModel).toEqual({ 'kimi-k2': 'high' });
    expect(getKimiProviderSettings(settings).thinkingOptionsByModel).toEqual(thinkingOptionsByModel);
    expect(getKimiDiscoveryState(settings).thinkingOptionsByModel).toEqual(thinkingOptionsByModel);
    expect(getKimiDiscoveryState(settings).currentThinkingByModel).toEqual({ 'kimi-k2': 'high' });
    const stored = (settings.providerConfigs as Record<string, Record<string, unknown>>).kimi;
    expect(stored.thinkingOptionsByModel).toEqual(thinkingOptionsByModel);
    expect(stored.currentThinkingByModel).toEqual({ 'kimi-k2': 'high' });
    expect(JSON.parse(JSON.stringify(settings.providerConfigs))).toEqual(settings.providerConfigs);

    const cleared = updateKimiProviderSettings(settings, {
      currentThinkingByModel: {},
      thinkingOptionsByModel: {},
    });
    expect(cleared.thinkingOptionsByModel).toEqual({});
    expect(getKimiProviderSettings(settings).thinkingOptionsByModel).toEqual({});
  });

  it('seeds the in-memory discovery mirror from the persisted catalog', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          currentThinkingByModel: { 'kimi-for-coding': 'high' },
          discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
          thinkingOptionsByModel: { 'kimi-for-coding': [{ label: 'High', value: 'high' }] },
        },
      },
    };

    // The mirror self-heals from the persisted config on first read.
    expect(getKimiDiscoveryState(settings)).toEqual({
      currentThinkingByModel: { 'kimi-for-coding': 'high' },
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
      thinkingOptionsByModel: { 'kimi-for-coding': [{ label: 'High', value: 'high' }] },
    });
    expect(getKimiProviderSettings(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);
  });

  it('does not overwrite a fresher in-memory catalog when seeding', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          discoveredModels: [{ label: 'Old', rawId: 'old-model' }],
          thinkingOptionsByModel: { 'old-model': [{ label: 'Off', value: 'off' }] },
        },
      },
    };
    updateKimiDiscoveryState(settings, {
      discoveredModels: [{ label: 'New', rawId: 'new-model' }],
      thinkingOptionsByModel: { 'new-model': [{ label: 'High', value: 'high' }] },
    });

    getKimiProviderSettings(settings);

    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'New', rawId: 'new-model' },
    ]);
    expect(getKimiDiscoveryState(settings).thinkingOptionsByModel).toEqual({
      'new-model': [{ label: 'High', value: 'high' }],
    });
  });
});

describe('Kimi provider state', () => {
  it('parses and builds only an absolute native session directory hint', () => {
    expect(parseKimiProviderState({
      sessionDirectory: ' /tmp/.kimi-code/sessions/vault/session-id ',
      token: 'do-not-preserve',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi-code/sessions/vault/session-id',
    });
    expect(parseKimiProviderState({ sessionDirectory: '../outside' })).toEqual({});
    expect(parseKimiProviderState({ sessionDirectory: 'relative/path' })).toEqual({});
    expect(parseKimiProviderState(null)).toEqual({});
    expect(parseKimiProviderState('session-id')).toEqual({});
    expect(buildPersistedKimiProviderState({
      sessionDirectory: '/tmp/.kimi-code/sessions/vault/session-id',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi-code/sessions/vault/session-id',
    });
    expect(buildPersistedKimiProviderState({ sessionDirectory: '../outside' })).toBeUndefined();
    expect(buildPersistedKimiProviderState({})).toBeUndefined();
  });

  it('persists only the sanitized session directory field', () => {
    expect(buildPersistedKimiProviderState({
      sessionDirectory: ' /tmp/.kimi-code/sessions/vault/session-id ',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi-code/sessions/vault/session-id',
    });
    expect(buildPersistedKimiProviderState({})).toBeUndefined();
    expect(buildPersistedKimiProviderState({ sessionDirectory: 'not-absolute' })).toBeUndefined();
  });
});
