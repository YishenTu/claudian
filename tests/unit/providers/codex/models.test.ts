import {
  type CodexDiscoveredModel,
  findCodexModel,
  getDefaultCodexModel,
  normalizeCodexDiscoveredModels,
  resolveCodexModelServiceTier,
} from '@/providers/codex/models';

function createFastModel(defaultServiceTier: string | null = null): CodexDiscoveredModel {
  return {
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    supportedReasoningEfforts: [{ value: 'low', description: 'Fast responses' }],
    defaultReasoningEffort: 'low',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    defaultServiceTier,
    inputModalities: ['text', 'image'],
    isDefault: true,
  };
}

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

  it('normalizes all app-server reasoning efforts without changing model capabilities', () => {
    expect(normalizeCodexDiscoveredModels(rawModels)).toEqual([
      {
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model.',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Fast responses' },
          { value: 'max', description: 'Maximum reasoning' },
          { value: 'ultra', description: 'Automatic task delegation' },
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

  it('preserves an app-server default of ultra in the discovered catalog', () => {
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
        defaultReasoningEffort: 'ultra',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Fast responses' },
          { value: 'high', description: 'Deep reasoning' },
          { value: 'ultra', description: 'Automatic task delegation' },
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

  it.each([
    {
      caseName: 'returns no tier without a model',
      model: null,
      selectedServiceTier: 'priority',
      expectedServiceTier: null,
    },
    {
      caseName: 'preserves explicit Standard when the catalog defaults to Fast',
      model: createFastModel('priority'),
      selectedServiceTier: 'default',
      expectedServiceTier: 'default',
    },
    {
      caseName: 'preserves an advertised tier id',
      model: createFastModel(),
      selectedServiceTier: 'priority',
      expectedServiceTier: 'priority',
    },
    {
      caseName: 'maps the legacy Fast value to the advertised tier id',
      model: createFastModel(),
      selectedServiceTier: 'fast',
      expectedServiceTier: 'priority',
    },
    {
      caseName: 'uses the catalog default for an invalid selection',
      model: createFastModel('priority'),
      selectedServiceTier: 'unsupported',
      expectedServiceTier: 'priority',
    },
  ])('$caseName', ({ model, selectedServiceTier, expectedServiceTier }) => {
    expect(resolveCodexModelServiceTier(model, selectedServiceTier)).toBe(expectedServiceTier);
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
