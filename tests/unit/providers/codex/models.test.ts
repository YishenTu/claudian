import {
  findCodexModel,
  getDefaultCodexModel,
  normalizeCodexDiscoveredModels,
} from '@/providers/codex/models';

describe('Codex models', () => {
  const rawModels = [
    {
      id: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      description: 'Latest frontier agentic coding model.',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses' },
        { reasoningEffort: 'max', description: 'Maximum reasoning' },
        { reasoningEffort: 'ultra', description: 'Automatic task delegation' },
      ],
      defaultReasoningEffort: 'low',
      serviceTiers: [
        { id: 'priority', name: 'Fast', description: '1.5x speed' },
      ],
      defaultServiceTier: null,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      isDefault: true,
    },
    {
      id: 'gpt-5.6-luna',
      model: 'gpt-5.6-luna',
      displayName: 'GPT-5.6-Luna',
      description: 'Fast and affordable agentic coding model.',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses' },
        { reasoningEffort: 'medium', description: 'Balanced' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
      defaultServiceTier: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: false,
    },
  ];

  it('normalizes app-server model metadata while excluding ultra', () => {
    expect(normalizeCodexDiscoveredModels(rawModels)).toEqual([
      {
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model.',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Fast responses' },
          { value: 'max', description: 'Maximum reasoning' },
        ],
        defaultReasoningEffort: 'low',
        serviceTiers: [
          { id: 'priority', name: 'Fast', description: '1.5x speed' },
        ],
        defaultServiceTier: null,
        inputModalities: ['text', 'image'],
        isDefault: true,
      },
      {
        model: 'gpt-5.6-luna',
        displayName: 'GPT-5.6-Luna',
        description: 'Fast and affordable agentic coding model.',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Fast responses' },
          { value: 'medium', description: 'Balanced' },
        ],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        defaultServiceTier: null,
        inputModalities: ['text'],
        isDefault: false,
      },
    ]);
  });

  it('keeps a model when its excluded app-server default is ultra', () => {
    expect(normalizeCodexDiscoveredModels([{
      ...rawModels[0],
      defaultReasoningEffort: 'ultra',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses' },
        { reasoningEffort: 'high', description: 'Deep reasoning' },
        { reasoningEffort: 'ultra', description: 'Automatic task delegation' },
      ],
    }])).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Fast responses' },
          { value: 'high', description: 'Deep reasoning' },
        ],
      }),
    ]);
  });

  it('keeps a catalog default service tier that is not an optional tier', () => {
    const models = normalizeCodexDiscoveredModels([{
      ...rawModels[0],
      defaultServiceTier: 'default',
    }]);

    expect(models).toHaveLength(1);
    expect(models[0].defaultServiceTier).toBe('default');
    expect(models[0].serviceTiers).toEqual([
      { id: 'priority', name: 'Fast', description: '1.5x speed' },
    ]);
  });

  it('uses the app-server default marker and model id for lookup', () => {
    const models = normalizeCodexDiscoveredModels(rawModels);

    expect(getDefaultCodexModel(models)?.model).toBe('gpt-5.6-sol');
    expect(findCodexModel(models, 'gpt-5.6-luna')?.displayName).toBe('GPT-5.6-Luna');
  });

  it('rejects malformed entries, hidden entries, duplicate models, and invalid defaults', () => {
    expect(normalizeCodexDiscoveredModels([
      ...rawModels,
      { ...rawModels[0], hidden: true, model: 'hidden-model' },
      { ...rawModels[0], displayName: 'Duplicate' },
      { model: '', displayName: 'Missing id' },
      {
        ...rawModels[0],
        model: 'gpt-invalid-default',
        defaultReasoningEffort: 'unsupported',
      },
    ])).toHaveLength(2);
  });
});
