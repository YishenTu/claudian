import {
  decodeGrokModelId,
  encodeGrokModelId,
  findGrokModel,
  getGrokAvailableReasoningEfforts,
  isGrokModelSelectionId,
  mergeGrokDiscoveredModels,
  normalizeGrokDiscoveredModels,
  resolveGrokDefaultReasoningEffort,
} from '@/providers/grok/models';

describe('Grok model identity', () => {
  it('uses only provider-qualified explicit model ids', () => {
    expect(encodeGrokModelId('kimi-coding')).toBe('grok/kimi-coding');
    expect(encodeGrokModelId('grok/kimi-coding')).toBe('grok/kimi-coding');
    expect(encodeGrokModelId('')).toBe('');
    expect(encodeGrokModelId('grok/')).toBe('');
    expect(decodeGrokModelId('grok/kimi-coding')).toBe('kimi-coding');
    expect(decodeGrokModelId('grok')).toBeNull();
    expect(decodeGrokModelId(' grok/kimi-coding ')).toBe('kimi-coding');
    expect(isGrokModelSelectionId('grok')).toBe(false);
    expect(isGrokModelSelectionId('grok/kimi-coding')).toBe(true);
    expect(isGrokModelSelectionId('grok/')).toBe(false);
    expect(isGrokModelSelectionId('kimi-coding')).toBe(false);
  });
});

describe('Grok model metadata', () => {
  it('normalizes only non-secret persisted metadata', () => {
    expect(normalizeGrokDiscoveredModels([{
      agentType: ' coding ',
      apiKey: 'must-not-persist',
      contextWindow: 262_144,
      defaultReasoningEffort: ' high ',
      description: ' Fast custom model ',
      displayName: ' Kimi Coding ',
      rawId: ' kimi-coding ',
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Quick', label: ' Low ', value: ' low ' },
        { value: 'high' },
        { value: 'high' },
      ],
      supportsReasoning: true,
    }])).toEqual([{
      agentType: 'coding',
      contextWindow: 262_144,
      defaultReasoningEffort: 'high',
      description: 'Fast custom model',
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Quick', label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    }]);
  });

  it('normalizes Grok wire reasoning metadata and orders returned fallback modes', () => {
    expect(normalizeGrokDiscoveredModels([{
      modelId: 'grok-wire',
      name: 'Grok Wire',
      reasoningEffort: 'xhigh',
      supportsReasoningEffort: true,
      'x.ai/sessionConfig': {
        options: [
          { category: 'mode', id: 'xhigh', label: 'Extra high', selected: true },
          { category: 'mode', id: 'minimal', label: 'Minimal', selected: false },
          { category: 'mode', id: 'high', label: 'High', selected: false },
        ],
      },
    }])).toEqual([expect.objectContaining({
      defaultReasoningEffort: 'xhigh',
      rawId: 'grok-wire',
      reasoningEfforts: [
        { label: 'Minimal', value: 'minimal' },
        { label: 'High', value: 'high' },
        { label: 'Extra high', value: 'xhigh' },
      ],
      supportsReasoning: true,
    })]);
  });

  it('merges live metadata by raw id while retaining prior catalog-only fields', () => {
    const merged = mergeGrokDiscoveredModels(
      [{
        displayName: 'Kimi',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }, {
        displayName: 'GLM',
        rawId: 'glm-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }],
      [{
        agentType: 'coding',
        contextWindow: 200_000,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      }],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        agentType: 'coding',
        contextWindow: 200_000,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        supportsReasoning: true,
      }),
      expect.objectContaining({ rawId: 'glm-coding' }),
    ]);
    expect(findGrokModel(merged, 'grok/kimi-coding')?.contextWindow).toBe(200_000);
  });

  it('treats resolved ACP reasoning metadata as authoritative', () => {
    const [merged] = mergeGrokDiscoveredModels([{
      defaultReasoningEffort: 'high',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }], [{
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [],
      reasoningMetadataResolved: true,
      supportsReasoning: false,
    }]);

    expect(merged).toEqual({
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [],
      reasoningMetadataResolved: true,
      supportsReasoning: false,
    });
  });

  it('uses fallback efforts only until ACP reasoning metadata is resolved', () => {
    const unresolved = {
      displayName: 'Unresolved',
      rawId: 'unresolved',
      reasoningEfforts: [],
      supportsReasoning: false,
    };
    const resolvedEmpty = {
      ...unresolved,
      displayName: 'Resolved',
      rawId: 'resolved',
      reasoningMetadataResolved: true,
    };

    expect(getGrokAvailableReasoningEfforts(unresolved).map(effort => effort.value))
      .toEqual(['low', 'medium', 'high']);
    expect(getGrokAvailableReasoningEfforts(resolvedEmpty)).toEqual([]);
  });

  it('preserves explicit preferences and always defaults to High', () => {
    const model = normalizeGrokDiscoveredModels([{
      defaultReasoningEffort: 'medium',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: ['low', 'medium', 'high'],
      supportsReasoning: true,
    }])[0];

    expect(resolveGrokDefaultReasoningEffort(model, 'low')).toBe('low');
    expect(resolveGrokDefaultReasoningEffort(model)).toBe('high');
    expect(resolveGrokDefaultReasoningEffort({
      ...model,
      reasoningMetadataResolved: true,
    })).toBe('high');
    expect(resolveGrokDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
    })).toBe('high');
    expect(resolveGrokDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
      reasoningEfforts: [{ label: 'Low', value: 'low' }],
    })).toBe('high');
  });

});
