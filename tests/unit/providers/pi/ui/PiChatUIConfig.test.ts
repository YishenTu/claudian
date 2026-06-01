import { getPiProviderSettings } from '@/providers/pi/settings';
import { piChatUIConfig } from '@/providers/pi/ui/PiChatUIConfig';

const settings: Record<string, unknown> = {
  providerConfigs: {
    pi: {
      discoveredModels: [
        {
          encodedId: 'pi:anthropic/claude-sonnet-4',
          id: 'claude-sonnet-4',
          input: ['text'],
          label: 'Claude Sonnet 4',
          provider: 'anthropic',
          reasoning: true,
          thinkingLevels: ['off', 'medium', 'high'],
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
      ],
      modelAliases: {
        'pi:anthropic/claude-sonnet-4': 'Sonnet',
      },
      preferredThinkingByModel: {
        'pi:anthropic/claude-sonnet-4': 'high',
      },
      visibleModels: ['pi:anthropic/claude-sonnet-4'],
    },
  },
};

describe('PiChatUIConfig', () => {
  it('returns visible model options with aliases and pins saved selections', () => {
    const options = piChatUIConfig.getModelOptions({
      ...settings,
      savedProviderModel: {
        pi: 'pi:openai/gpt-5',
      },
    });

    expect(options).toEqual([
      expect.objectContaining({
        label: 'Sonnet',
        value: 'pi:anthropic/claude-sonnet-4',
      }),
      expect.objectContaining({
        label: 'GPT-5',
        value: 'pi:openai/gpt-5',
      }),
    ]);
  });

  it('returns a synthetic fallback before discovery', () => {
    expect(piChatUIConfig.getModelOptions({ providerConfigs: { pi: {} } })).toEqual([
      { value: 'pi', label: 'Pi', description: 'Configure models in settings' },
    ]);
    expect(piChatUIConfig.ownsModel('pi', { providerConfigs: { pi: {} } })).toBe(true);
    expect(piChatUIConfig.ownsModel('pi:anthropic/claude-sonnet-4', { providerConfigs: { pi: {} } })).toBe(true);
    expect(piChatUIConfig.ownsModel('pi:invalid', { providerConfigs: { pi: {} } })).toBe(false);
    expect(piChatUIConfig.getReasoningOptions('pi', { providerConfigs: { pi: {} } })).toEqual([
      { label: 'Off', value: 'off' },
    ]);
    expect(piChatUIConfig.getDefaultReasoningValue('pi', { providerConfigs: { pi: {} } })).toBe('off');
  });

  it('maps reasoning options and defaults from cached model metadata', () => {
    expect(piChatUIConfig.isAdaptiveReasoningModel('pi:anthropic/claude-sonnet-4', settings)).toBe(true);
    expect(piChatUIConfig.getReasoningOptions('pi:anthropic/claude-sonnet-4', settings)).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(piChatUIConfig.getDefaultReasoningValue('pi:anthropic/claude-sonnet-4', settings)).toBe('high');
  });

  it('resolves context windows from cached Pi model metadata before falling back', () => {
    const contextSettings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          discoveredModels: [{
            contextWindow: 1_000_000,
            encodedId: 'pi:anthropic/claude-sonnet-4',
            id: 'claude-sonnet-4',
            input: ['text'],
            label: 'Claude Sonnet 4',
            provider: 'anthropic',
            reasoning: true,
            thinkingLevels: ['off', 'medium', 'high'],
          }],
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
    };

    expect(piChatUIConfig.getContextWindowSize(
      'pi:anthropic/claude-sonnet-4',
      { 'pi:anthropic/claude-sonnet-4': 123_000 },
      contextSettings,
    )).toBe(1_000_000);
    expect(piChatUIConfig.getContextWindowSize(
      'pi:missing/model',
      { 'pi:missing/model': 123_000 },
      contextSettings,
    )).toBe(123_000);
    expect(piChatUIConfig.getContextWindowSize('pi:missing/model', undefined, contextSettings)).toBe(200_000);
  });

  it('keeps decoded models on Pi effort controls when discovery metadata is stale', () => {
    const staleSettings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          visibleModels: ['pi:custom/model'],
        },
      },
      savedProviderModel: {
        pi: 'pi:custom/model',
      },
    };

    expect(piChatUIConfig.getModelOptions(staleSettings)).toEqual([
      expect.objectContaining({
        label: 'custom/model',
        value: 'pi:custom/model',
      }),
    ]);
    expect(piChatUIConfig.isAdaptiveReasoningModel('pi:custom/model', staleSettings)).toBe(true);
    expect(piChatUIConfig.getReasoningOptions('pi:custom/model', staleSettings)).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'Minimal', value: 'minimal' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(piChatUIConfig.getDefaultReasoningValue('pi:custom/model', staleSettings)).toBe('medium');

    piChatUIConfig.applyReasoningSelection?.('pi:custom/model', 'high', staleSettings);
    expect(getPiProviderSettings(staleSettings).preferredThinkingByModel).toEqual({
      'pi:custom/model': 'high',
    });
  });

  it('maps toolbar permission mode to Pi tool mode', () => {
    const mutableSettings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          toolMode: 'readonly',
        },
      },
    };

    expect(piChatUIConfig.resolvePermissionMode?.(mutableSettings)).toBe('normal');
    piChatUIConfig.applyPermissionMode?.('yolo', mutableSettings);
    expect(piChatUIConfig.resolvePermissionMode?.(mutableSettings)).toBe('yolo');
  });
});
