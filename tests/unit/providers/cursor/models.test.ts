import {
  decodeCursorModelId,
  encodeCursorModelId,
  normalizeCursorDiscoveredModels,
} from '@/providers/cursor/models';

describe('Cursor models', () => {
  it('normalizes ACP model state and isolates Cursor selector ids', () => {
    expect(normalizeCursorDiscoveredModels([
      { modelId: 'claude-4-sonnet', name: 'Claude 4 Sonnet' },
      { id: 'gpt-5', name: 'GPT-5', description: 'OpenAI model' },
      { modelId: 'claude-4-sonnet', name: 'Duplicate' },
    ])).toEqual([
      { label: 'Claude 4 Sonnet', rawId: 'claude-4-sonnet' },
      { description: 'OpenAI model', label: 'GPT-5', rawId: 'gpt-5' },
    ]);

    expect(encodeCursorModelId('gpt-5')).toBe('cursor:gpt-5');
    expect(decodeCursorModelId('cursor:gpt-5')).toBe('gpt-5');
    expect(decodeCursorModelId('omp:gpt-5')).toBeNull();
  });
});
