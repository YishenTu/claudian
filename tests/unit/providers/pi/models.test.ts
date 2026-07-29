import {
  clampPiThinkingLevel,
  decodePiModelId,
  encodePiModelId,
  getPiSupportedThinkingLevels,
  normalizePiDiscoveredModels,
  normalizePiThinkingLevel,
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
    expect(encodePiModelId('', '')).toBe('');
    expect(decodePiModelId('')).toBeNull();
    expect(decodePiModelId('pi:')).toBeNull();
    expect(decodePiModelId('pi:anthropic')).toBeNull();
    expect(decodePiModelId('claude')).toBeNull();
  });

  it('normalizes thinking levels with Pi reasoning rules', () => {
    expect(normalizePiThinkingLevel(' MAX ')).toBe('max');
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
      thinkingLevels: ['max', 'low', null, 'xhigh', 'invalid', 'low'],
    })).toEqual(['low', 'xhigh', 'max']);
    expect(getPiSupportedThinkingLevels({
      reasoning: {
        levels: ['minimal', 'high'],
      },
    })).toEqual(['minimal', 'high']);
    expect(getPiSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        high: null,
        max: 'max',
        minimal: 'low',
        xhigh: 'xhigh',
      },
    })).toEqual(['off', 'minimal', 'low', 'medium', 'xhigh', 'max']);
    expect(getPiSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
    })).toEqual(['low', 'high', 'max']);
  });

  it('clamps supported thinking levels with Pi ladder semantics', () => {
    expect(clampPiThinkingLevel(
      'max',
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    )).toBe('max');
    expect(clampPiThinkingLevel(
      'max',
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    )).toBe('xhigh');
    expect(clampPiThinkingLevel('max', ['off', 'high'])).toBe('high');
    expect(clampPiThinkingLevel('medium', ['low', 'high', 'max'])).toBe('high');
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
