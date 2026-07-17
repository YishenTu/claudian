import { CODEX_SPARK_MODEL, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

const DISCOVERED_MODELS = [
  {
    model: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    description: 'Fast',
    supportedReasoningEfforts: [
      { value: 'medium', description: 'Balanced' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'],
    isDefault: false,
  },
  {
    model: TEST_CODEX_MODEL,
    displayName: 'GPT-5.5',
    description: 'Latest',
    supportedReasoningEfforts: [
      { value: 'medium', description: 'Balanced' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'],
    isDefault: true,
  },
];

function withDiscoveredModels(settings: Record<string, unknown> = {}): Record<string, unknown> {
  const providerConfigs = settings.providerConfigs as Record<string, Record<string, unknown>> | undefined;
  return {
    ...settings,
    providerConfigs: {
      ...providerConfigs,
      codex: {
        ...providerConfigs?.codex,
        discoveredModels: DISCOVERED_MODELS.map(model => ({
          ...model,
          supportedReasoningEfforts: [...model.supportedReasoningEfforts],
          serviceTiers: [...model.serviceTiers],
          inputModalities: [...model.inputModalities],
        })),
      },
    },
  };
}

describe('CodexChatUIConfig', () => {
  describe('getModelOptions', () => {
    it('returns models in reverse app-server catalog order', () => {
      const options = codexChatUIConfig.getModelOptions({
        providerConfigs: {
          codex: {
            discoveredModels: [
              {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
                description: 'Latest frontier agentic coding model.',
                supportedReasoningEfforts: [
                  { value: 'low', description: 'Fast responses' },
                ],
                defaultReasoningEffort: 'low',
                serviceTiers: [],
                defaultServiceTier: null,
                inputModalities: ['text', 'image'],
                isDefault: true,
              },
              {
                model: 'gpt-5.6-luna',
                displayName: 'GPT-5.6-Luna',
                description: 'Fast and affordable agentic coding model.',
                supportedReasoningEfforts: [
                  { value: 'medium', description: 'Balanced' },
                ],
                defaultReasoningEffort: 'medium',
                serviceTiers: [],
                defaultServiceTier: null,
                inputModalities: ['text', 'image'],
                isDefault: false,
              },
            ],
          },
        },
      });

      expect(options).toEqual([
        {
          value: 'gpt-5.6-luna',
          label: 'GPT-5.6-Luna',
          description: 'Fast and affordable agentic coding model.',
        },
        {
          value: 'gpt-5.6-sol',
          label: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
        },
      ]);
    });

    it('uses configured model aliases as selector labels', () => {
      const options = codexChatUIConfig.getModelOptions(withDiscoveredModels({
        providerConfigs: {
          codex: {
            modelAliases: {
              [TEST_CODEX_MODEL]: 'Primary',
            },
          },
        },
      }));

      expect(options.find(option => option.value === TEST_CODEX_MODEL)?.label).toBe('Primary');
    });

    it('appends settings-defined custom models after the built-in options', () => {
      const options = codexChatUIConfig.getModelOptions(withDiscoveredModels({
        providerConfigs: {
          codex: {
            customModels: 'gpt-5.6-preview\nmy-custom-model\nmy-custom-model',
          },
        },
      }));

      expect(options).toEqual([
        {
          value: TEST_CODEX_MODEL,
          label: 'GPT-5.5',
          description: 'Latest',
        },
        {
          value: 'gpt-5.4-mini',
          label: 'GPT-5.4 Mini',
          description: 'Fast',
        },
        {
          value: 'openai-codex/gpt-5.6-preview',
          label: 'GPT-5.6 Preview',
          description: 'Custom model',
        },
        {
          value: 'openai-codex/my-custom-model',
          label: 'my-custom-model',
          description: 'Custom model',
        },
      ]);
    });

    it('should prepend custom model from OPENAI_MODEL env var', () => {
      const options = codexChatUIConfig.getModelOptions(withDiscoveredModels({
        environmentVariables: 'OPENAI_MODEL=my-custom-model',
      }));
      expect(options[0].value).toBe('openai-codex/my-custom-model');
      expect(options[0].description).toBe('Custom (env)');
      expect(options.length).toBe(3);
    });

    it('deduplicates env and settings-defined custom models', () => {
      const options = codexChatUIConfig.getModelOptions(withDiscoveredModels({
        providerConfigs: {
          codex: {
            customModels: 'my-custom-model\nsecond-custom-model',
            environmentVariables: 'OPENAI_MODEL=my-custom-model',
          },
        },
      }));

      expect(options.map(option => option.value)).toEqual([
        'openai-codex/my-custom-model',
        TEST_CODEX_MODEL,
        'gpt-5.4-mini',
        'openai-codex/second-custom-model',
      ]);
    });

    it('should not duplicate when OPENAI_MODEL matches a default model', () => {
      const options = codexChatUIConfig.getModelOptions(withDiscoveredModels({
        environmentVariables: `OPENAI_MODEL=${TEST_CODEX_MODEL}`,
      }));
      expect(options.length).toBe(2);
    });

    it('only includes discovered models selected by the visibility filter', () => {
      const settings = withDiscoveredModels({
        settingsProvider: 'claude',
        model: 'sonnet',
        providerConfigs: {
          codex: {
            visibleModels: ['gpt-5.4-mini'],
          },
        },
      });

      expect(codexChatUIConfig.getModelOptions(settings).map(option => option.value)).toEqual([
        'gpt-5.4-mini',
      ]);
    });

    it('keeps an existing Codex session model pinned when it is filtered out', () => {
      const settings = withDiscoveredModels({
        model: TEST_CODEX_MODEL,
        providerConfigs: {
          codex: {
            visibleModels: ['gpt-5.4-mini'],
          },
        },
      });

      expect(codexChatUIConfig.getModelOptions(settings).map(option => option.value)).toEqual([
        'gpt-5.4-mini',
        TEST_CODEX_MODEL,
      ]);
    });

    it('keeps hand-picked model IDs usable before the runtime catalog loads', () => {
      const options = codexChatUIConfig.getModelOptions({
        settingsProvider: 'claude',
        model: 'sonnet',
        providerConfigs: {
          codex: {
            discoveredModels: [],
            visibleModels: ['gpt-5.6-sol'],
          },
        },
      });

      expect(options).toEqual([{
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Selected model',
      }]);
    });

    it('keeps saved and current Codex selections usable when discovery fails', () => {
      const options = codexChatUIConfig.getModelOptions({
        settingsProvider: 'claude',
        model: 'gpt-current-session',
        savedProviderModel: {
          claude: 'sonnet',
          codex: 'openai-codex/saved-custom-model',
        },
        providerConfigs: {
          codex: {
            discoveredModels: [],
            modelAliases: {
              'gpt-current-session': 'Current',
              'saved-custom-model': 'Saved',
            },
            visibleModels: null,
          },
        },
      });

      expect(options).toEqual([
        {
          value: 'gpt-current-session',
          label: 'Current',
          description: 'Selected model',
        },
        {
          value: 'openai-codex/saved-custom-model',
          label: 'Saved',
          description: 'Selected model',
        },
      ]);
    });

    it('does not treat another provider current model as a Codex fallback', () => {
      expect(codexChatUIConfig.getModelOptions({
        settingsProvider: 'claude',
        model: 'sonnet',
        providerConfigs: {
          codex: {
            discoveredModels: [],
            visibleModels: null,
          },
        },
      })).toEqual([]);
    });

    it('deduplicates an unavailable current model against OPENAI_MODEL', () => {
      const options = codexChatUIConfig.getModelOptions({
        model: 'gpt-env-model',
        providerConfigs: {
          codex: {
            discoveredModels: [],
            environmentVariables: 'OPENAI_MODEL=gpt-env-model',
            visibleModels: null,
          },
        },
      });

      expect(options).toEqual([{
        value: 'openai-codex/gpt-env-model',
        label: 'GPT-env Model',
        description: 'Custom (env)',
      }]);
    });
  });

  describe('getDefaultModel', () => {
    it('keeps the app-server default independent from reverse picker order', () => {
      expect(codexChatUIConfig.getDefaultModel!(withDiscoveredModels())).toBe(TEST_CODEX_MODEL);
    });

    it('uses the first visible model when the app-server default is filtered out', () => {
      expect(codexChatUIConfig.getDefaultModel!(withDiscoveredModels({
        providerConfigs: {
          codex: {
            visibleModels: ['gpt-5.4-mini'],
          },
        },
      }))).toBe('gpt-5.4-mini');
    });
  });

  describe('isAdaptiveReasoningModel', () => {
    it('should return true for all models', () => {
      expect(codexChatUIConfig.isAdaptiveReasoningModel(TEST_CODEX_MODEL, {})).toBe(true);
      expect(codexChatUIConfig.isAdaptiveReasoningModel('unknown-model', {})).toBe(true);
    });
  });

  describe('getReasoningOptions', () => {
    it('keeps max available before the runtime catalog loads', () => {
      const options = codexChatUIConfig.getReasoningOptions('gpt-runtime-model', {
        providerConfigs: {
          codex: {
            discoveredModels: [],
          },
        },
      });

      expect(options.map(option => option.value)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(options.find(option => option.value === 'xhigh')?.label).toBe('xHigh');
    });

    it('uses the selected model effort levels from app-server', () => {
      const settings = {
        providerConfigs: {
          codex: {
            discoveredModels: [{
              model: 'gpt-5.6-sol',
              displayName: 'GPT-5.6-Sol',
              description: 'Latest',
              supportedReasoningEfforts: [
                { value: 'low', description: 'Fast responses' },
                { value: 'max', description: 'Maximum reasoning' },
              ],
              defaultReasoningEffort: 'low',
              serviceTiers: [],
              defaultServiceTier: null,
              inputModalities: ['text', 'image'],
              isDefault: true,
            }],
          },
        },
      };

      expect(codexChatUIConfig.getReasoningOptions('gpt-5.6-sol', settings)).toEqual([
        { value: 'low', label: 'Low', description: 'Fast responses' },
        { value: 'max', label: 'Max', description: 'Maximum reasoning' },
      ]);
      expect(codexChatUIConfig.getDefaultReasoningValue('gpt-5.6-sol', settings)).toBe('low');
    });

    it('prefers high over the app-server default when the model supports it', () => {
      const settings = withDiscoveredModels({ model: TEST_CODEX_MODEL });
      const config = settings.providerConfigs as { codex: { discoveredModels: any[] } };
      config.codex.discoveredModels[1] = {
        ...config.codex.discoveredModels[1],
        supportedReasoningEfforts: [
          { value: 'medium', description: 'Balanced' },
          { value: 'high', description: 'Deep reasoning' },
        ],
      };

      expect(codexChatUIConfig.getDefaultReasoningValue(TEST_CODEX_MODEL, settings)).toBe('high');
    });
  });

  describe('getDefaultReasoningValue', () => {
    it('defaults unknown models to high', () => {
      expect(codexChatUIConfig.getDefaultReasoningValue(TEST_CODEX_MODEL, {})).toBe('high');
    });
  });

  describe('getContextWindowSize', () => {
    it('should return 200000 for all models', () => {
      expect(codexChatUIConfig.getContextWindowSize(TEST_CODEX_MODEL)).toBe(200_000);
    });
  });

  describe('applyModelDefaults', () => {
    it('sets reasoning summary off for GPT-5.3 Codex Spark', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: {
          codex: {
            reasoningSummary: 'detailed',
          },
        },
      };

      codexChatUIConfig.applyModelDefaults(CODEX_SPARK_MODEL, settings);

      expect(settings).toMatchObject({
        providerConfigs: {
          codex: {
            reasoningSummary: 'none',
          },
        },
      });
    });

    it('leaves reasoning summary unchanged for other Codex models', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: {
          codex: {
            reasoningSummary: 'detailed',
          },
        },
      };

      codexChatUIConfig.applyModelDefaults(TEST_CODEX_MODEL, settings);

      expect(settings).toMatchObject({
        providerConfigs: {
          codex: {
            reasoningSummary: 'detailed',
          },
        },
      });
    });
  });

  describe('isDefaultModel', () => {
    it('should return true for built-in models', () => {
      expect(codexChatUIConfig.isDefaultModel(TEST_CODEX_MODEL)).toBe(true);
      expect(codexChatUIConfig.isDefaultModel('gpt-5.4-mini')).toBe(true);
    });

    it('should return false for custom models', () => {
      expect(codexChatUIConfig.isDefaultModel('my-custom-model')).toBe(false);
    });
  });

  describe('normalizeModelVariant', () => {
    it('falls back unavailable Codex models to the current primary model', () => {
      expect(codexChatUIConfig.normalizeModelVariant('gpt-5.4', withDiscoveredModels()))
        .toBe(TEST_CODEX_MODEL);
    });

    it('keeps visible models as-is', () => {
      expect(codexChatUIConfig.normalizeModelVariant(TEST_CODEX_MODEL, withDiscoveredModels()))
        .toBe(TEST_CODEX_MODEL);
      expect(codexChatUIConfig.normalizeModelVariant('custom', {
        environmentVariables: 'OPENAI_MODEL=custom',
      })).toBe('openai-codex/custom');
      expect(codexChatUIConfig.normalizeModelVariant('settings-custom', {
        providerConfigs: {
          codex: {
            customModels: 'settings-custom',
          },
        },
      })).toBe('openai-codex/settings-custom');
    });
  });

  describe('getCustomModelIds', () => {
    it('should return custom model from env', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: 'my-model' });
      expect(ids.has('my-model')).toBe(true);
    });

    it('should not include default models', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: TEST_CODEX_MODEL });
      expect(ids.size).toBe(0);
    });

    it('should return empty set when no OPENAI_MODEL', () => {
      const ids = codexChatUIConfig.getCustomModelIds({});
      expect(ids.size).toBe(0);
    });
  });

  describe('getPermissionModeToggle', () => {
    it('should return yolo/safe toggle config with plan mode', () => {
      const toggle = codexChatUIConfig.getPermissionModeToggle!();
      expect(toggle).toEqual({
        inactiveValue: 'normal',
        inactiveLabel: 'Safe',
        activeValue: 'yolo',
        activeLabel: 'YOLO',
        planValue: 'plan',
        planLabel: 'Plan',
      });
    });
  });

  describe('getServiceTierToggle', () => {
    it.each([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])('enables Fast mode for %s when app-server advertises it', (modelId) => {
      const settings = {
        model: modelId,
        providerConfigs: {
          codex: {
            discoveredModels: [{
              model: modelId,
              displayName: modelId,
              description: 'GPT-5.6 Codex model',
              supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }],
              defaultReasoningEffort: 'medium',
              serviceTiers: [{
                id: 'priority',
                name: 'Fast',
                description: '1.5x speed, increased usage',
              }],
              defaultServiceTier: null,
              inputModalities: ['text', 'image'],
              isDefault: true,
            }],
          },
        },
      };

      expect(codexChatUIConfig.getServiceTierToggle!(settings)).toMatchObject({
        activeValue: 'priority',
        activeLabel: 'Fast',
      });
    });

    it('uses the selected model service tier metadata from app-server', () => {
      const settings = withDiscoveredModels({ model: TEST_CODEX_MODEL });
      const config = settings.providerConfigs as { codex: { discoveredModels: any[] } };
      config.codex.discoveredModels[1] = {
        ...config.codex.discoveredModels[1],
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
      };

      expect(codexChatUIConfig.getServiceTierToggle!(settings)).toEqual({
        inactiveValue: 'default',
        inactiveLabel: 'Standard',
        activeValue: 'priority',
        activeLabel: 'Fast',
        description: '1.5x speed',
      });
    });

    it('hides Fast mode for models without a Fast service tier', () => {
      expect(codexChatUIConfig.getServiceTierToggle!(withDiscoveredModels({
        model: 'gpt-5.4-mini',
      }))).toBeNull();
    });

    it('ignores service tiers that are not Fast mode', () => {
      const settings = withDiscoveredModels({ model: TEST_CODEX_MODEL });
      const config = settings.providerConfigs as { codex: { discoveredModels: any[] } };
      config.codex.discoveredModels[1] = {
        ...config.codex.discoveredModels[1],
        serviceTiers: [{ id: 'batch', name: 'Batch', description: 'Background work' }],
      };

      expect(codexChatUIConfig.getServiceTierToggle!(settings)).toBeNull();
    });
  });
});
