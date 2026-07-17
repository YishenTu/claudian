import { GROK_DEFAULT_MODEL, grokChatUIConfig } from '@/providers/grok/ui/GrokChatUIConfig';

describe('grokChatUIConfig', () => {
  it('exposes grok-4.5 and effort levels from Grok Build 0.2.99', () => {
    expect(GROK_DEFAULT_MODEL).toBe('grok-4.5');
    expect(grokChatUIConfig.getModelOptions({})).toEqual([
      expect.objectContaining({ value: 'grok-4.5' }),
    ]);
    expect(grokChatUIConfig.getReasoningOptions('grok-4.5', {})).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]);
    expect(grokChatUIConfig.getDefaultReasoningValue('grok-4.5', {})).toBe('high');
    expect(grokChatUIConfig.getContextWindowSize('grok-4.5')).toBe(500_000);
    expect(grokChatUIConfig.ownsModel('grok-4.5', {})).toBe(true);
    expect(grokChatUIConfig.ownsModel('claude-opus-4', {})).toBe(false);
  });

  it('includes custom env model when configured', () => {
    const options = grokChatUIConfig.getModelOptions({
      providerConfigs: {
        grok: {
          environmentVariables: 'GROK_MODEL=custom-grok',
        },
      },
    });
    expect(options[0]).toEqual(expect.objectContaining({
      value: 'custom-grok',
      description: 'Custom (env)',
    }));
  });
});
