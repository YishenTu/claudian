import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  extractOpencodeSessionModelState,
  groupOpencodeDiscoveredModels,
  isOpencodeModelSelectionId,
  OPENCODE_SYNTHETIC_MODEL_ID,
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
  it('prefers ACP config options so variant ids stay selectable', () => {
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

describe('opencodeChatUIConfig', () => {
  it('shows only curated visible models and keeps the saved model visible', () => {
    const options = opencodeChatUIConfig.getModelOptions({
      model: 'haiku',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
          ],
          visibleModels: [
            'openai/gpt-5',
          ],
        },
      },
      savedProviderModel: {
        opencode: 'opencode:anthropic/claude-sonnet-4',
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

  it('shows configured model ids even before discovery finishes', () => {
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
