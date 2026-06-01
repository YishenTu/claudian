import {
  decodePiModelId,
  encodePiModelId,
  getPiSupportedThinkingLevels,
  normalizePiDiscoveredModels,
} from '@/providers/pi/models';

describe('Pi model helpers', () => {
  it('encodes and decodes provider/model ids', () => {
    expect(encodePiModelId('anthropic', 'claude/sonnet')).toBe('pi:anthropic/claude/sonnet');
    expect(decodePiModelId('pi:anthropic/claude/sonnet')).toEqual({
      modelId: 'claude/sonnet',
      provider: 'anthropic',
    });
  });

  it('rejects invalid Pi model ids', () => {
    expect(decodePiModelId('')).toBeNull();
    expect(decodePiModelId('pi:')).toBeNull();
    expect(decodePiModelId('pi:anthropic')).toBeNull();
    expect(decodePiModelId('claude')).toBeNull();
  });

  it('normalizes thinking levels with Pi reasoning rules', () => {
    expect(getPiSupportedThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(getPiSupportedThinkingLevels({ reasoning: true })).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(getPiSupportedThinkingLevels({
      reasoning: true,
      thinkingLevels: ['low', null, 'xhigh', 'invalid', 'low'],
    })).toEqual(['low', 'xhigh']);
    expect(getPiSupportedThinkingLevels({
      reasoning: {
        levels: ['minimal', 'high'],
      },
    })).toEqual(['minimal', 'high']);
    expect(getPiSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        high: null,
        minimal: 'low',
        xhigh: 'xhigh',
      },
    })).toEqual(['off', 'minimal', 'low', 'medium', 'xhigh']);
  });

  it('normalizes discovered model records', () => {
    expect(normalizePiDiscoveredModels([
      {
        contextWindow: 100_000,
        id: 'claude/sonnet',
        input: ['text', 'image', 'audio'],
        label: '  Sonnet  ',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'medium'],
      },
      {
        id: 'claude/sonnet',
        label: 'Duplicate',
        provider: 'anthropic',
      },
      {
        id: 'gpt-5',
        name: 'GPT-5',
        provider: 'openai',
        reasoning: false,
      },
    ])).toEqual([
      {
        contextWindow: 100_000,
        encodedId: 'pi:anthropic/claude/sonnet',
        id: 'claude/sonnet',
        input: ['text', 'image'],
        label: 'Sonnet',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'medium'],
      },
      {
        encodedId: 'pi:openai/gpt-5',
        id: 'gpt-5',
        input: ['text'],
        label: 'GPT-5',
        provider: 'openai',
        reasoning: false,
        thinkingLevels: ['off'],
      },
    ]);
  });
});
