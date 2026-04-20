import {
  buildOpencodeBaseModels,
  combineOpencodeRawModelSelection,
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  extractOpencodeModelVariantValue,
  extractOpencodeSessionModelState,
  getOpencodeModelVariants,
  groupOpencodeDiscoveredModels,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  OPENCODE_SYNTHETIC_MODEL_ID,
  resolveOpencodeBaseModelRawId,
  splitOpencodeModelLabel,
} from '../../../../src/providers/opencode/models';
import { opencodeChatUIConfig } from '../../../../src/providers/opencode/ui/OpencodeChatUIConfig';

describe('OpenCode model identity', () => {
  it('namespaces provider-owned model ids for the shared selector', () => {
    expect(encodeOpencodeModelId('anthropic/claude-sonnet-4')).toBe('opencode:anthropic/claude-sonnet-4');
    expect(decodeOpencodeModelId('opencode:anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(decodeOpencodeModelId(OPENCODE_SYNTHETIC_MODEL_ID)).toBeNull();
    expect(isOpencodeModelSelectionId('opencode:anthropic/claude-sonnet-4')).toBe(true);
    expect(isOpencodeModelSelectionId('claude-sonnet-4')).toBe(false);
  });
});

describe('extractOpencodeSessionModelState', () => {
  it('prefers ACP config options so variants remain discoverable', () => {
    expect(extractOpencodeSessionModelState({
      configOptions: [
        {
          category: 'model',
          currentValue: 'anthropic/claude-sonnet-4/high',
          id: 'model',
          name: 'Model',
          options: [
            { name: 'Anthropic/Claude Sonnet 4', value: 'anthropic/claude-sonnet-4' },
            { name: 'Anthropic/Claude Sonnet 4 (high)', value: 'anthropic/claude-sonnet-4/high' },
          ],
          type: 'select',
        },
      ],
    })).toEqual({
      currentRawModelId: 'anthropic/claude-sonnet-4/high',
      discoveredModels: [
        { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
        { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
      ],
    });
  });

  it('falls back to session model metadata when config options are unavailable', () => {
    expect(extractOpencodeSessionModelState({
      models: {
        availableModels: [
          { description: 'Fast', id: 'openai/gpt-5-mini', name: 'OpenAI/GPT-5 Mini' },
        ],
        currentModelId: 'openai/gpt-5-mini',
      },
    })).toEqual({
      currentRawModelId: 'openai/gpt-5-mini',
      discoveredModels: [
        { description: 'Fast', label: 'OpenAI/GPT-5 Mini', rawId: 'openai/gpt-5-mini' },
      ],
    });
  });
});

describe('OpenCode base model derivation', () => {
  const discoveredModels = [
    { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
    { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
    { label: 'Anthropic/Claude Sonnet 4 (max)', rawId: 'anthropic/claude-sonnet-4/max' },
    { label: 'Google/Gemini 2.5 Pro', rawId: 'google/gemini-2.5-pro' },
  ];

  it('collapses discovered variants into base models', () => {
    expect(buildOpencodeBaseModels(discoveredModels)).toEqual([
      {
        label: 'Anthropic/Claude Sonnet 4',
        rawId: 'anthropic/claude-sonnet-4',
        variants: [
          { label: 'High', value: 'high' },
          { label: 'Max', value: 'max' },
        ],
      },
      {
        label: 'Google/Gemini 2.5 Pro',
        rawId: 'google/gemini-2.5-pro',
        variants: [],
      },
    ]);
  });

  it('sorts thinking variants by semantic effort instead of alphabetically', () => {
    expect(buildOpencodeBaseModels([
      { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
      { label: 'OpenAI/GPT-5 (xhigh)', rawId: 'openai/gpt-5/xhigh' },
      { label: 'OpenAI/GPT-5 (medium)', rawId: 'openai/gpt-5/medium' },
      { label: 'OpenAI/GPT-5 (low)', rawId: 'openai/gpt-5/low' },
      { label: 'OpenAI/GPT-5 (high)', rawId: 'openai/gpt-5/high' },
      { label: 'OpenAI/GPT-5 (max)', rawId: 'openai/gpt-5/max' },
    ])).toEqual([
      {
        label: 'OpenAI/GPT-5',
        rawId: 'openai/gpt-5',
        variants: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
          { label: 'Max', value: 'max' },
          { label: 'XHigh', value: 'xhigh' },
        ],
      },
    ]);
  });

  it('extracts and combines thinking variants from discovered model ids', () => {
    expect(resolveOpencodeBaseModelRawId(
      'anthropic/claude-sonnet-4/high',
      discoveredModels,
    )).toBe('anthropic/claude-sonnet-4');
    expect(extractOpencodeModelVariantValue(
      'anthropic/claude-sonnet-4/high',
      discoveredModels,
    )).toBe('high');
    expect(getOpencodeModelVariants(
      'anthropic/claude-sonnet-4',
      discoveredModels,
    )).toEqual([
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
    ]);
    expect(combineOpencodeRawModelSelection(
      'anthropic/claude-sonnet-4',
      'high',
      discoveredModels,
    )).toBe('anthropic/claude-sonnet-4/high');
    expect(combineOpencodeRawModelSelection(
      'anthropic/claude-sonnet-4',
      OPENCODE_DEFAULT_THINKING_LEVEL,
      discoveredModels,
    )).toBe('anthropic/claude-sonnet-4');
  });
});

describe('opencodeChatUIConfig', () => {
  it('shows only curated base models and keeps saved variant selections visible as their base model', () => {
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

    expect(options).toEqual([
      {
        description: 'ACP runtime',
        label: 'Anthropic/Claude Sonnet 4',
        value: 'opencode:anthropic/claude-sonnet-4',
      },
      {
        description: 'ACP runtime',
        label: 'OpenAI/GPT-5',
        value: 'opencode:openai/gpt-5',
      },
    ]);
  });

  it('uses modelAliases to override the label in model selector options', () => {
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
        description: 'ACP runtime',
        label: 'Sonnet',
        value: 'opencode:anthropic/claude-sonnet-4',
      },
      {
        description: 'ACP runtime',
        label: 'OpenAI/GPT-5',
        value: 'opencode:openai/gpt-5',
      },
    ]);
  });

  it('shows configured base model ids even before discovery finishes', () => {
    expect(opencodeChatUIConfig.getModelOptions({
      providerConfigs: {
        opencode: {
          visibleModels: [
            'google/gemini-2.5-pro',
          ],
        },
      },
    })).toEqual([
      {
        description: 'Configured model',
        label: 'google/gemini-2.5-pro',
        value: 'opencode:google/gemini-2.5-pro',
      },
    ]);
  });

  it('falls back to the synthetic entry before models are discovered', () => {
    expect(opencodeChatUIConfig.getModelOptions({})).toEqual([
      { description: 'ACP runtime', label: 'OpenCode', value: 'opencode' },
    ]);
  });

  it('returns per-model thinking options from discovered variants', () => {
    const settings = {
      model: 'opencode:anthropic/claude-sonnet-4',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
            { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
            { label: 'Anthropic/Claude Sonnet 4 (max)', rawId: 'anthropic/claude-sonnet-4/max' },
          ],
          preferredThinkingByModel: {
            'anthropic/claude-sonnet-4': 'max',
          },
        },
      },
    };

    expect(opencodeChatUIConfig.getReasoningOptions(
      'opencode:anthropic/claude-sonnet-4',
      settings,
    )).toEqual([
      { label: 'Default', value: 'default' },
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
    ]);
    expect(opencodeChatUIConfig.getDefaultReasoningValue(
      'opencode:anthropic/claude-sonnet-4',
      settings,
    )).toBe('max');
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

  it('groups discovered models by provider label', () => {
    expect(groupOpencodeDiscoveredModels([
      { label: 'Google/Gemini 2.5 Flash', rawId: 'google/gemini-2.5-flash' },
      { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
      { label: 'Google/Gemini 2.5 Pro', rawId: 'google/gemini-2.5-pro' },
    ])).toEqual([
      {
        models: [
          { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
        ],
        providerKey: 'anthropic',
        providerLabel: 'Anthropic',
      },
      {
        models: [
          { label: 'Google/Gemini 2.5 Flash', rawId: 'google/gemini-2.5-flash' },
          { label: 'Google/Gemini 2.5 Pro', rawId: 'google/gemini-2.5-pro' },
        ],
        providerKey: 'google',
        providerLabel: 'Google',
      },
    ]);
  });
});
