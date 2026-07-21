import {
  decodeGrokModelId,
  encodeGrokModelId,
  findGrokModel,
  GROK_CONTEXT_WINDOW_FALLBACK,
  GROK_SYNTHETIC_MODEL_ID,
  isGrokModelSelectionId,
  mergeGrokDiscoveredModels,
  normalizeGrokDiscoveredModels,
  resolveGrokContextWindow,
  resolveGrokDefaultReasoningEffort,
  resolveGrokRawModelId,
} from '@/providers/grok/models';

describe('Grok model identity', () => {
  it('uses the reserved native default and grok/ for explicit raw ids', () => {
    expect(GROK_SYNTHETIC_MODEL_ID).toBe('grok');
    expect(encodeGrokModelId('kimi-coding')).toBe('grok/kimi-coding');
    expect(encodeGrokModelId('grok/kimi-coding')).toBe('grok/kimi-coding');
    expect(encodeGrokModelId('')).toBe('grok');
    expect(encodeGrokModelId('grok/')).toBe('grok');
    expect(decodeGrokModelId('grok/kimi-coding')).toBe('kimi-coding');
    expect(decodeGrokModelId('grok')).toBeNull();
    expect(decodeGrokModelId(' grok/kimi-coding ')).toBe('kimi-coding');
    expect(isGrokModelSelectionId('grok')).toBe(true);
    expect(isGrokModelSelectionId('grok/kimi-coding')).toBe(true);
    expect(isGrokModelSelectionId('grok/')).toBe(false);
    expect(isGrokModelSelectionId('kimi-coding')).toBe(false);
  });

  it('resolves explicit selections and the synthetic provider default through one contract', () => {
    expect(resolveGrokRawModelId('grok/kimi-coding', 'grok-4.5')).toBe('kimi-coding');
    expect(resolveGrokRawModelId('grok', 'grok-4.5')).toBe('grok-4.5');
    expect(resolveGrokRawModelId('grok', null)).toBeNull();
    expect(resolveGrokRawModelId('claude-sonnet', 'grok-4.5')).toBeNull();
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

  it('resolves preferred, declared, high, and first reasoning defaults in order', () => {
    const model = normalizeGrokDiscoveredModels([{
      defaultReasoningEffort: 'medium',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: ['low', 'medium', 'high'],
      supportsReasoning: true,
    }])[0];

    expect(resolveGrokDefaultReasoningEffort(model, 'low')).toBe('low');
    expect(resolveGrokDefaultReasoningEffort(model)).toBe('medium');
    expect(resolveGrokDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
    })).toBe('high');
    expect(resolveGrokDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
      reasoningEfforts: [{ label: 'Low', value: 'low' }],
    })).toBe('low');
  });

  it('resolves context from metadata, custom limits, then the shared fallback', () => {
    const models = normalizeGrokDiscoveredModels([{
      contextWindow: 300_000,
      displayName: 'Known',
      rawId: 'known',
    }]);

    expect(resolveGrokContextWindow('grok/known', models, {
      'grok/known': 150_000,
    })).toBe(300_000);
    expect(resolveGrokContextWindow('grok/custom', models, {
      'grok/custom': 123_000,
    })).toBe(123_000);
    expect(resolveGrokContextWindow('grok/other', models)).toBe(
      GROK_CONTEXT_WINDOW_FALLBACK,
    );
  });
});
