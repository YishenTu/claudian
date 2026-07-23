const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import { normalizeQoderDiscoveredModels } from '@/providers/qoder/models';
import {
  DEFAULT_QODER_PROVIDER_SETTINGS,
  getQoderProviderSettings,
  normalizeQoderVisibleModels,
  updateQoderProviderSettings,
} from '@/providers/qoder/settings';

const discoveredModels = normalizeQoderDiscoveredModels([
  {
    defaultContextWindow: 200_000,
    displayName: 'Claude Sonnet',
    isDefault: true,
    rawId: 'claude-sonnet',
  },
  {
    displayName: 'Planner',
    rawId: 'planner',
  },
]);

describe('Qoder settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('defaults to disabled auto auth with empty host state', () => {
    expect(DEFAULT_QODER_PROVIDER_SETTINGS).toEqual({
      authMode: 'auto',
      checkpointingEnabled: true,
      cliPath: '',
      cliPathsByHost: {},
      discoveredModels: [],
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: {},
      preferredEffortByModel: {},
      selectedPermissionMode: 'default',
      visibleModels: [],
    });
  });

  it('normalizes auth mode, permission mode, and visible models against discovered models', () => {
    const settings = getQoderProviderSettings({
      providerConfigs: {
        qoder: {
          authMode: 'bogus',
          discoveredModels,
          selectedPermissionMode: '  ',
          visibleModels: ['claude-sonnet', 'claude-sonnet', 'planner', 'unknown'],
        },
      },
    });

    expect(settings.authMode).toBe('auto');
    expect(settings.selectedPermissionMode).toBe('default');
    expect(settings.visibleModels).toEqual(['qoder/claude-sonnet', 'qoder/planner']);
  });

  it('migrates the legacy CLI host key to the current opaque host key', () => {
    const settings = getQoderProviderSettings({
      providerConfigs: {
        qoder: {
          cliPathsByHost: {
            'legacy-host': '/legacy/qodercli',
            'other-host': '/other/qodercli',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'device:current': '/legacy/qodercli',
      'other-host': '/other/qodercli',
    });
  });

  it('routes a persisted CLI path to the host map without clobbering other providers', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true },
        qoder: {},
      },
    };

    const next = updateQoderProviderSettings(settings, {
      authMode: 'pat-env',
      cliPath: ' /opt/bin/qodercli ',
      enabled: true,
      selectedPermissionMode: 'acceptEdits',
    });

    expect(next).toMatchObject({
      authMode: 'pat-env',
      cliPath: '',
      cliPathsByHost: { 'device:current': '/opt/bin/qodercli' },
      enabled: true,
      selectedPermissionMode: 'acceptEdits',
    });
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({ enabled: true });
  });
});

describe('normalizeQoderVisibleModels', () => {
  it('falls back to default models when the value is not an array', () => {
    expect(normalizeQoderVisibleModels(undefined, discoveredModels)).toEqual(['qoder/claude-sonnet']);
  });

  it('filters out unknown and duplicate ids when a catalog is present', () => {
    expect(normalizeQoderVisibleModels(
      ['planner', 'qoder/planner', 'unknown'],
      discoveredModels,
    )).toEqual(['qoder/planner']);
  });
});
