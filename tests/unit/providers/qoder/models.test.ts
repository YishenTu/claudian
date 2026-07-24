import {
  decodeQoderModelId,
  encodeQoderModelId,
  findQoderModel,
  getQoderAvailableReasoningEfforts,
  isQoderModelSelectionId,
  normalizeQoderDiscoveredModels,
  QODER_CONTEXT_WINDOW_FALLBACK,
  resolveQoderContextWindow,
  resolveQoderDefaultReasoningEffort,
} from '@/providers/qoder/models';

describe('Qoder model identity', () => {
  it('uses only provider-qualified explicit model ids', () => {
    expect(encodeQoderModelId('claude-sonnet')).toBe('qoder/claude-sonnet');
    expect(encodeQoderModelId('qoder/claude-sonnet')).toBe('qoder/claude-sonnet');
    expect(encodeQoderModelId('')).toBe('');
    expect(encodeQoderModelId('  ')).toBe('');
    expect(decodeQoderModelId('qoder/claude-sonnet')).toBe('claude-sonnet');
    expect(decodeQoderModelId(' qoder/claude-sonnet ')).toBe('claude-sonnet');
    expect(decodeQoderModelId('qoder/')).toBeNull();
    expect(decodeQoderModelId('claude-sonnet')).toBeNull();
    expect(isQoderModelSelectionId('qoder/claude-sonnet')).toBe(true);
    expect(isQoderModelSelectionId('qoder/')).toBe(false);
    expect(isQoderModelSelectionId('claude-sonnet')).toBe(false);
  });
});

describe('Qoder model metadata', () => {
  it('normalizes wire metadata, trims fields, and dedupes by raw id', () => {
    expect(normalizeQoderDiscoveredModels([
      {
        defaultContextWindow: 262_144,
        defaultEffort: 'high',
        description: ' Fast model ',
        displayName: ' Claude Sonnet ',
        efforts: ['low', 'high'],
        icon: ' star ',
        isDefault: true,
        isReasoning: true,
        rawId: ' claude-sonnet ',
      },
      {
        // Duplicate raw id keeps the last entry.
        displayName: 'Claude Sonnet v2',
        rawId: 'claude-sonnet',
      },
    ])).toEqual([{
      contextWindow: QODER_CONTEXT_WINDOW_FALLBACK,
      contextWindowIsAuthoritative: false,
      displayName: 'Claude Sonnet v2',
      isDefault: false,
      rawId: 'claude-sonnet',
      reasoningEfforts: [],
      supportsReasoning: false,
    }]);
  });

  it('derives context, labels, and reasoning support from wire fields', () => {
    expect(normalizeQoderDiscoveredModels([{
      defaultEffort: 'high',
      efforts: ['low', 'high'],
      maxInputTokens: 128_000,
      modelId: 'planner',
    }])).toEqual([{
      contextWindow: 128_000,
      contextWindowIsAuthoritative: true,
      defaultEffort: 'high',
      displayName: 'planner',
      isDefault: false,
      rawId: 'planner',
      reasoningEfforts: [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    }]);
  });

  it('attaches per-effort descriptions from thinking_config', () => {
    const [model] = normalizeQoderDiscoveredModels([{
      efforts: ['low', 'high'],
      rawId: 'reasoner',
      thinking_config: {
        enabled: {
          efforts: {
            low: { description: ' Quick, shallow reasoning ' },
            high: { description: 'Deep, thorough reasoning' },
            max: { description: 'Ignored: no matching effort' },
          },
        },
      },
    }]);

    expect(model?.reasoningEfforts).toEqual([
      { description: 'Quick, shallow reasoning', label: 'Low', value: 'low' },
      { description: 'Deep, thorough reasoning', label: 'High', value: 'high' },
    ]);
  });

  it('preserves normalized reasoning metadata when settings normalize it again', () => {
    const discovered = normalizeQoderDiscoveredModels([{
      defaultEffort: 'high',
      efforts: ['xhigh', 'high', 'low', 'max', 'medium'],
      isReasoning: true,
      rawId: 'ultimate',
      thinking_config: {
        enabled: {
          efforts: {
            high: { description: 'High thinking intensity' },
          },
        },
      },
    }]);

    expect(normalizeQoderDiscoveredModels(discovered)).toEqual(discovered);
  });

  it('offers the CLI reasoning levels when a routed model omits explicit efforts', () => {
    const [model] = normalizeQoderDiscoveredModels([{
      displayName: 'Auto',
      rawId: 'auto',
    }]);

    expect(getQoderAvailableReasoningEfforts(model)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
    ]);
    expect(getQoderAvailableReasoningEfforts(null)).toEqual([]);
  });

  it('does not invent reasoning controls for models without reasoning metadata', () => {
    const [model] = normalizeQoderDiscoveredModels([{
      displayName: 'Lite',
      rawId: 'lite',
    }]);

    expect(getQoderAvailableReasoningEfforts(model)).toEqual([]);
  });

  it('preserves an authoritative context window across settings normalization', () => {
    const discovered = normalizeQoderDiscoveredModels([{
      defaultContextWindow: 180_000,
      rawId: 'auto',
    }]);

    expect(normalizeQoderDiscoveredModels(discovered)).toEqual(discovered);
    expect(discovered[0]).toMatchObject({
      contextWindow: 180_000,
      contextWindowIsAuthoritative: true,
    });
  });

  it('drops entries without a resolvable raw id', () => {
    expect(normalizeQoderDiscoveredModels([{ displayName: 'No id' }, 'nope', null])).toEqual([]);
    expect(normalizeQoderDiscoveredModels('not-an-array')).toEqual([]);
  });

  it('resolves preferred, declared, high, then first reasoning defaults', () => {
    const model = normalizeQoderDiscoveredModels([{
      defaultEffort: 'medium',
      efforts: ['low', 'medium', 'high'],
      rawId: 'reasoner',
    }])[0];

    expect(resolveQoderDefaultReasoningEffort(model, 'low')).toBe('low');
    expect(resolveQoderDefaultReasoningEffort(model)).toBe('medium');
    expect(resolveQoderDefaultReasoningEffort({
      ...model,
      defaultEffort: undefined,
    })).toBe('high');
    expect(resolveQoderDefaultReasoningEffort({
      ...model,
      defaultEffort: undefined,
      reasoningEfforts: [{ label: 'Low', value: 'low' }],
    })).toBe('low');
    expect(resolveQoderDefaultReasoningEffort(null)).toBe('high');
  });

  it('uses a declared default with fallback reasoning levels', () => {
    const [model] = normalizeQoderDiscoveredModels([{
      defaultEffort: 'medium',
      rawId: 'performance',
    }]);

    expect(resolveQoderDefaultReasoningEffort(model)).toBe('medium');
  });

  it('resolves context from metadata, custom limits, then the shared fallback', () => {
    const models = normalizeQoderDiscoveredModels([{
      defaultContextWindow: 300_000,
      rawId: 'known',
    }]);

    expect(findQoderModel(models, 'qoder/known')?.rawId).toBe('known');
    expect(resolveQoderContextWindow('qoder/known', models, {
      'qoder/known': 150_000,
    })).toBe(300_000);
    expect(resolveQoderContextWindow('qoder/custom', models, {
      'qoder/custom': 123_000,
    })).toBe(123_000);
    expect(resolveQoderContextWindow('qoder/other', models)).toBe(
      QODER_CONTEXT_WINDOW_FALLBACK,
    );
  });
});
