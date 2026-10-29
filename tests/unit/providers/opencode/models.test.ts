import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  resolveOpencodeDefaultThinkingLevel,
  splitOpencodeModelLabel,
} from '../../../../src/providers/opencode/models';
import { opencodeChatUIConfig } from '../../../../src/providers/opencode/ui/OpencodeChatUIConfig';

describe('OpenCode model identity', () => {
  it('namespaces provider-owned model ids for the shared selector', () => {
    expect(encodeOpencodeModelId('anthropic/claude-sonnet-4')).toBe('opencode:anthropic/claude-sonnet-4');
    expect(decodeOpencodeModelId('opencode:anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(encodeOpencodeModelId('')).toBe('');
    expect(isOpencodeModelSelectionId('opencode:anthropic/claude-sonnet-4')).toBe(true);
    expect(isOpencodeModelSelectionId('claude-sonnet-4')).toBe(false);
  });
});

describe('OpenCode thinking defaults', () => {
  it.each([
    { options: [] },
    { options: [{ label: 'Default', value: 'default' }, { label: 'High', value: 'high' }] },
  ])('resolves a saved Default preference to High with options $options', ({ options }) => {
    expect(resolveOpencodeDefaultThinkingLevel(options, 'default')).toBe('high');
  });

  it('defaults to High instead of inheriting the native Medium default', () => {
    expect(resolveOpencodeDefaultThinkingLevel(
      [
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
      ],
      undefined,
    )).toBe('high');
  });
});

describe('opencodeChatUIConfig', () => {
  it('omits Default from cached native efforts while preserving explicit selection values', () => {
    const options = opencodeChatUIConfig.getReasoningOptions('opencode:openai/gpt-5', {
      providerConfigs: {
        opencode: {
          thinkingOptionsByModel: {
            'openai/gpt-5': [
              { label: 'none', value: 'none' },
              { label: 'low', value: 'low' },
              { label: 'high', value: 'high' },
              { label: 'max', value: 'max' },
              { label: 'default', value: 'default' },
            ],
          },
        },
      },
    });

    expect(options).toEqual([
      { label: 'None', value: 'none' },
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
    ]);
  });

  it('excludes saved model selections when they are not enabled', () => {
    const options = opencodeChatUIConfig.getModelOptions({
      model: 'haiku',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
            { label: 'OpenAI/GPT-5 (high)', rawId: 'openai/gpt-5/high' },
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
            { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
          ],
          visibleModels: [
            'openai/gpt-5',
          ],
          preferredThinkingByModel: {
            'anthropic/claude-sonnet-4': 'high',
          },
        },
      },
      savedProviderModel: {
        opencode: 'opencode:anthropic/claude-sonnet-4/high',
      },
    });

    // The upstream provider prefix becomes the model's group, not part of its name.
    expect(options).toEqual([
      {
        group: 'OpenAI',
        label: 'GPT-5',
        value: 'opencode:openai/gpt-5',
      },
    ]);
  });

  it('returns visible model selector options in saved order with aliases', () => {
    const options = opencodeChatUIConfig.getModelOptions({
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
            { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
          ],
          modelAliases: {
            'anthropic/claude-sonnet-4': 'Sonnet',
          },
          visibleModels: [
            'anthropic/claude-sonnet-4',
            'openai/gpt-5',
          ],
        },
      },
    });

    expect(options).toEqual([
      {
        group: 'Anthropic',
        label: 'Sonnet',
        value: 'opencode:anthropic/claude-sonnet-4',
      },
      {
        group: 'OpenAI',
        label: 'GPT-5',
        value: 'opencode:openai/gpt-5',
      },
    ]);
    expect(opencodeChatUIConfig.getDefaultModel!({
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
            { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
          ],
          visibleModels: [
            'anthropic/claude-sonnet-4',
            'openai/gpt-5',
          ],
        },
      },
    })).toBe('opencode:anthropic/claude-sonnet-4');
  });

  it('requires metadata before offering configured base models', () => {
    expect(opencodeChatUIConfig.getModelOptions({
      providerConfigs: {
        opencode: {
          visibleModels: [
            'google/gemini-2.5-pro',
          ],
        },
      },
    })).toEqual([]);
  });

  it('has no model fallback when no models are enabled', () => {
    expect(opencodeChatUIConfig.getModelOptions({})).toEqual([]);
    expect(opencodeChatUIConfig.getDefaultModel!({})).toBeNull();
    expect(opencodeChatUIConfig.ownsModel('opencode:anthropic/claude-sonnet-4', {})).toBe(true);
  });

  it('orders native thinking options by effort and retains the saved preference', () => {
    const settings = {
      model: 'opencode:anthropic/claude-sonnet-4',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
          ],
          preferredThinkingByModel: {
            'anthropic/claude-sonnet-4': 'max',
          },
          thinkingOptionsByModel: {
            'anthropic/claude-sonnet-4': [
              { label: 'xHigh', value: 'xhigh' },
              { label: 'Medium', value: 'medium' },
              { label: 'Low', value: 'low' },
              { label: 'High', value: 'high' },
              { label: 'Max', value: 'max' },
            ],
          },
        },
      },
    };

    expect(opencodeChatUIConfig.getReasoningOptions(
      'opencode:anthropic/claude-sonnet-4',
      settings,
    )).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
      { label: 'xHigh', value: 'xhigh' },
    ]);
    expect(opencodeChatUIConfig.getDefaultReasoningValue(
      'opencode:anthropic/claude-sonnet-4',
      settings,
    )).toBe('max');
  });

  it('defaults models with discovered variants to high without a saved preference', () => {
    const settings = {
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
          ],
          preferredThinkingByModel: {},
          thinkingOptionsByModel: {
            'anthropic/claude-sonnet-4': [
              { label: 'Low', value: 'low' },
              { label: 'High', value: 'high' },
              { label: 'Max', value: 'max' },
            ],
          },
        },
      },
    };

    expect(opencodeChatUIConfig.getDefaultReasoningValue(
      'opencode:anthropic/claude-sonnet-4',
      settings,
    )).toBe('high');
  });
});

describe('OpenCode discovered model grouping', () => {
  it('splits provider and model labels for grouped picker rendering', () => {
    expect(splitOpencodeModelLabel('Google/Gemini 2.5 Flash')).toEqual({
      modelLabel: 'Gemini 2.5 Flash',
      providerLabel: 'Google',
    });
    expect(splitOpencodeModelLabel('standalone-model')).toEqual({
      modelLabel: 'standalone-model',
      providerLabel: 'Other',
    });
  });
});
