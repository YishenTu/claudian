import {
  normalizeGrokModelUpdateMetadata,
  normalizeGrokSessionModelMetadata,
  normalizeGrokSetModelMetadata,
} from '@/providers/grok/execution/GrokSessionModelMetadata';

const sessionReasoningMeta = {
  reasoningEffort: 'max',
  'x.ai/sessionConfig': {
    options: [
      { category: 'mode', id: 'low', label: 'Low', selected: false },
      { category: 'mode', id: 'high', label: 'High', selected: false },
      { category: 'mode', id: 'max', label: 'Maximum', selected: true },
    ],
  },
};

describe('GrokSessionModelMetadata', () => {
  it('combines session and per-model metadata without leaking the current default', () => {
    const result = normalizeGrokSessionModelMetadata({
      _meta: sessionReasoningMeta,
      configOptions: [{
        category: 'model',
        currentValue: 'grok-4.5',
        id: 'model',
        name: 'Model',
        options: [
          { name: 'Grok 4.5', value: 'grok-4.5' },
          { name: 'Other', value: 'other-model' },
        ],
        type: 'select',
      }],
      models: {
        availableModels: [{
          _meta: {
            agentType: 'grok-build-plan',
            supportsReasoningEffort: true,
            totalContextTokens: 200_000,
          },
          modelId: 'grok-4.5',
          name: 'Grok 4.5',
        }, {
          _meta: {
            agentType: 'grok-build',
            supportsReasoningEffort: false,
          },
          modelId: 'other-model',
          name: 'Other',
        }],
        currentModelId: 'grok-4.5',
      },
    });

    expect(result.currentModelId).toBe('grok-4.5');
    expect(result.models).toEqual([
      expect.objectContaining({
        agentType: 'grok-build-plan',
        contextWindow: 200_000,
        defaultReasoningEffort: 'max',
        rawId: 'grok-4.5',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
          { label: 'Maximum', value: 'max' },
        ],
        reasoningMetadataResolved: true,
        supportsReasoning: true,
      }),
      expect.objectContaining({
        agentType: 'grok-build',
        rawId: 'other-model',
        reasoningEfforts: [],
        reasoningMetadataResolved: true,
        supportsReasoning: false,
      }),
    ]);
    expect(result.models[1]).not.toHaveProperty('defaultReasoningEffort');
  });

  it('attaches the requested model id to set-model metadata', () => {
    expect(normalizeGrokSetModelMetadata('grok-future', {
      model: {
        ...sessionReasoningMeta,
        displayName: 'Grok Future',
        supportsReasoningEffort: true,
      },
    })).toEqual(expect.objectContaining({
      defaultReasoningEffort: 'max',
      displayName: 'Grok Future',
      rawId: 'grok-future',
      reasoningMetadataResolved: true,
      reasoningEfforts: expect.arrayContaining([
        expect.objectContaining({ value: 'max' }),
      ]),
    }));
  });

  it('normalizes direct and wrapped xAI model update payloads', () => {
    const state = {
      availableModels: [{
        _meta: sessionReasoningMeta,
        modelId: 'grok-future',
        name: 'Grok Future',
      }],
      currentModelId: 'grok-future',
    };

    expect(normalizeGrokModelUpdateMetadata(state)).toEqual(expect.objectContaining({
      currentModelId: 'grok-future',
      models: [expect.objectContaining({
        rawId: 'grok-future',
        reasoningMetadataResolved: true,
      })],
    }));
    expect(normalizeGrokModelUpdateMetadata({ models: state }))
      .toEqual(normalizeGrokModelUpdateMetadata(state));
    expect(normalizeGrokModelUpdateMetadata({ invalid: true })).toBeNull();
  });
});
