import {
  encodeOmpModelId,
  normalizeOmpConfigOptionModels,
  normalizeOmpDiscoveredModels,
} from '@/providers/omp/models';

describe('OMP models', () => {
  it('normalizes real ACP model metadata into stable selector values', () => {
    expect(normalizeOmpDiscoveredModels([
      { description: 'Fast model', modelId: 'gpt-5-mini', name: 'OpenAI GPT-5 mini' },
      { id: 'gpt-5-mini', name: 'Duplicate' },
      { modelId: 'claude-sonnet', name: 'Claude Sonnet' },
    ])).toEqual([
      {
        description: 'Fast model',
        label: 'OpenAI GPT-5 mini',
        rawId: 'gpt-5-mini',
      },
      {
        label: 'Claude Sonnet',
        rawId: 'claude-sonnet',
      },
    ]);
  });

  it('preserves persisted OMP model records during settings normalization', () => {
    expect(normalizeOmpDiscoveredModels([
      { description: 'openai/gpt-5-mini', label: 'GPT-5 mini', rawId: 'openai/gpt-5-mini' },
    ])).toEqual([
      { description: 'openai/gpt-5-mini', label: 'GPT-5 mini', rawId: 'openai/gpt-5-mini' },
    ]);
  });

  it('keeps the provider namespace out of the native model id', () => {
    expect(encodeOmpModelId('gpt-5-mini')).toBe('omp:gpt-5-mini');
  });

  it('reads OMP model choices from the ACP model config option', () => {
    expect(normalizeOmpConfigOptionModels([
      {
        category: 'model',
        currentValue: 'openai/gpt-5-mini',
        id: 'model',
        name: 'Model',
        options: [
          { description: 'openai/gpt-5-mini', name: 'GPT-5 mini', value: 'openai/gpt-5-mini' },
          { name: 'Claude Sonnet', value: 'anthropic/claude-sonnet' },
        ],
        type: 'select',
      },
    ])).toEqual([
      { description: 'openai/gpt-5-mini', label: 'GPT-5 mini', rawId: 'openai/gpt-5-mini' },
      { label: 'Claude Sonnet', rawId: 'anthropic/claude-sonnet' },
    ]);
  });
});
