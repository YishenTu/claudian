const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import { piSettingsReconciler } from '@/providers/pi/env/PiSettingsReconciler';
import {
  DEFAULT_PI_PROVIDER_SETTINGS,
  getPiProviderSettings,
  normalizePiModelAliases,
  normalizePiPreferredThinkingByModel,
  normalizePiVisibleModels,
  updatePiProviderSettings,
} from '@/providers/pi/settings';

describe('Pi settings normalization', () => {
  const discoveredModels = [
    {
      encodedId: 'pi:anthropic/claude-sonnet-4',
      id: 'claude-sonnet-4',
      input: ['text' as const],
      label: 'Claude Sonnet 4',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevels: ['off' as const, 'medium' as const, 'high' as const],
    },
    {
      encodedId: 'pi:openai/gpt-5',
      id: 'gpt-5',
      input: ['text' as const, 'image' as const],
      label: 'GPT-5',
      provider: 'openai',
      reasoning: true,
      thinkingLevels: ['off' as const, 'low' as const, 'medium' as const],
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('host-a');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('defaults Pi to disabled all-tools mode', () => {
    expect(DEFAULT_PI_PROVIDER_SETTINGS).toMatchObject({
      enabled: false,
      toolMode: 'all',
      visibleModels: [],
    });
  });

  it('migrates current legacy hostname-scoped CLI paths', () => {
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('host-a');

    expect(getPiProviderSettings({
      providerConfigs: {
        pi: {
          cliPathsByHost: {
            'host-a': '/host-a/pi',
            'host-b': '/host-b/pi',
          },
        },
      },
    }).cliPathsByHost).toEqual({
      'device:current': '/host-a/pi',
      'host-b': '/host-b/pi',
    });
  });

  it('normalizes visible models to valid encoded ids', () => {
    expect(normalizePiVisibleModels([
      'pi:anthropic/claude-sonnet-4',
      'pi:anthropic/claude-sonnet-4',
      'pi:missing/model',
      'openai/gpt-5',
    ], discoveredModels)).toEqual(['pi:anthropic/claude-sonnet-4']);
  });

  it('normalizes aliases and preferred thinking', () => {
    expect(normalizePiModelAliases({
      'pi:anthropic/claude-sonnet-4': '  Sonnet  ',
      'pi:missing/model': 'Missing',
    }, discoveredModels)).toEqual({
      'pi:anthropic/claude-sonnet-4': 'Sonnet',
    });
    expect(normalizePiPreferredThinkingByModel({
      'pi:anthropic/claude-sonnet-4': 'high',
      'pi:openai/gpt-5': 'xhigh',
    }, discoveredModels)).toEqual({
      'pi:anthropic/claude-sonnet-4': 'high',
    });
  });

  it('keeps selected model metadata even when the selected model is no longer discovered', () => {
    const settings: Record<string, unknown> = {
      model: 'pi:old-provider/old-model',
      providerConfigs: {
        pi: {
          discoveredModels,
          modelAliases: {
            'pi:old-provider/old-model': 'Legacy model',
            'pi:missing/model': 'Missing',
          },
          preferredThinkingByModel: {
            'pi:old-provider/old-model': 'high',
            'pi:missing/model': 'low',
          },
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
      savedProviderModel: {},
      titleGenerationModel: '',
    };

    expect(getPiProviderSettings(settings).modelAliases).toEqual({
      'pi:old-provider/old-model': 'Legacy model',
    });
    expect(getPiProviderSettings(settings).preferredThinkingByModel).toEqual({
      'pi:old-provider/old-model': 'high',
    });
  });

  it('preserves selected model metadata during model variant reconciliation when discovery is stale', () => {
    const settings: Record<string, unknown> = {
      model: 'pi:old-provider/old-model',
      providerConfigs: {
        pi: {
          discoveredModels,
          modelAliases: {
            'pi:old-provider/old-model': 'Legacy model',
          },
          preferredThinkingByModel: {
            'pi:old-provider/old-model': 'high',
          },
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
      savedProviderModel: {},
      titleGenerationModel: '',
    };

    expect(piSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(getPiProviderSettings(settings).modelAliases).toEqual({
      'pi:old-provider/old-model': 'Legacy model',
    });
    expect(getPiProviderSettings(settings).preferredThinkingByModel).toEqual({
      'pi:old-provider/old-model': 'high',
    });
  });

  it('retargets active and saved Pi selections when visible models change', () => {
    const settings: Record<string, unknown> = {
      effortLevel: 'high',
      model: 'pi:openai/gpt-5',
      providerConfigs: {
        pi: {
          discoveredModels,
          preferredThinkingByModel: {
            'pi:anthropic/claude-sonnet-4': 'high',
          },
          visibleModels: ['pi:openai/gpt-5', 'pi:anthropic/claude-sonnet-4'],
        },
      },
      savedProviderEffort: {
        pi: 'medium',
      },
      savedProviderModel: {
        pi: 'pi:openai/gpt-5',
      },
      titleGenerationModel: 'pi:openai/gpt-5',
    };

    updatePiProviderSettings(settings, {
      visibleModels: ['pi:anthropic/claude-sonnet-4'],
    });

    expect(settings.model).toBe('pi:anthropic/claude-sonnet-4');
    expect(settings.effortLevel).toBe('high');
    expect((settings.savedProviderModel as Record<string, string>).pi).toBe('pi:anthropic/claude-sonnet-4');
    expect((settings.savedProviderEffort as Record<string, string>).pi).toBe('high');
    expect(settings.titleGenerationModel).toBe('pi:anthropic/claude-sonnet-4');
  });

  it('clears the Pi title model when all visible models are removed', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          discoveredModels,
          visibleModels: ['pi:openai/gpt-5'],
        },
      },
      titleGenerationModel: 'pi:openai/gpt-5',
    };

    updatePiProviderSettings(settings, { visibleModels: [] });

    expect(settings.titleGenerationModel).toBe('');
  });

  it('clears stale discovery metadata on environment change without dropping visible model choices', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          discoveredModels,
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
    };

    expect(piSettingsReconciler.handleEnvironmentChange?.(settings)).toBe(true);

    expect(getPiProviderSettings(settings).discoveredModels).toEqual([]);
    expect(getPiProviderSettings(settings).visibleModels).toEqual(['pi:anthropic/claude-sonnet-4']);
  });

  it('normalizes blank Pi effort to a value supported by the selected model', () => {
    const nonReasoningSettings: Record<string, unknown> = {
      effortLevel: '',
      model: 'pi:openai/gpt-5',
      providerConfigs: {
        pi: {
          discoveredModels: [{
            encodedId: 'pi:openai/gpt-5',
            id: 'gpt-5',
            input: ['text'],
            label: 'GPT-5',
            provider: 'openai',
            reasoning: false,
            thinkingLevels: ['off'],
          }],
          visibleModels: ['pi:openai/gpt-5'],
        },
      },
    };

    expect(piSettingsReconciler.normalizeModelVariantSettings(nonReasoningSettings)).toBe(true);
    expect(nonReasoningSettings.effortLevel).toBe('off');

    const fallbackSettings: Record<string, unknown> = {
      effortLevel: '',
      model: 'pi',
      providerConfigs: { pi: {} },
    };

    expect(piSettingsReconciler.normalizeModelVariantSettings(fallbackSettings)).toBe(true);
    expect(fallbackSettings.effortLevel).toBe('off');
  });
});
