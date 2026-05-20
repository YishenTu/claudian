import {
  extractAcpSessionModelState,
  extractAcpSessionModeState,
  extractAcpSessionThoughtLevelState,
  flattenAcpSessionConfigSelectOptions,
} from '../../../../src/providers/acp';

describe('AcpSessionConfig', () => {
  it('flattens grouped select options', () => {
    expect(flattenAcpSessionConfigSelectOptions([
      {
        group: 'Anthropic',
        name: 'Anthropic',
        options: [
          { name: 'Claude Sonnet 4', value: 'anthropic/claude-sonnet-4' },
        ],
      },
      {
        group: 'OpenAI',
        name: 'OpenAI',
        options: [
          { name: 'GPT-5', value: 'openai/gpt-5' },
        ],
      },
    ])).toEqual([
      { name: 'Claude Sonnet 4', value: 'anthropic/claude-sonnet-4' },
      { name: 'GPT-5', value: 'openai/gpt-5' },
    ]);
  });

  it('prefers ACP config model options over session model metadata', () => {
    expect(extractAcpSessionModelState({
      configOptions: [
        {
          category: 'model',
          currentValue: 'anthropic/claude-sonnet-4/high',
          id: 'selected_model',
          name: 'Model',
          options: [
            { name: 'Anthropic/Claude Sonnet 4', value: 'anthropic/claude-sonnet-4' },
            { name: 'Anthropic/Claude Sonnet 4 (high)', value: 'anthropic/claude-sonnet-4/high' },
          ],
          type: 'select',
        },
      ],
      models: {
        availableModels: [
          { id: 'openai/gpt-5', name: 'OpenAI/GPT-5' },
        ],
        currentModelId: 'openai/gpt-5',
      },
    })).toEqual({
      availableModels: [
        { id: 'anthropic/claude-sonnet-4', name: 'Anthropic/Claude Sonnet 4' },
        { id: 'anthropic/claude-sonnet-4/high', name: 'Anthropic/Claude Sonnet 4 (high)' },
      ],
      currentModelId: 'anthropic/claude-sonnet-4/high',
    });
  });

  it('falls back to the legacy model id when category is unavailable', () => {
    expect(extractAcpSessionModelState({
      configOptions: [
        {
          currentValue: 'openai/gpt-5',
          id: 'model',
          name: 'Model',
          options: [
            { name: 'OpenAI/GPT-5', value: 'openai/gpt-5' },
          ],
          type: 'select',
        },
      ],
    })).toEqual({
      availableModels: [
        { id: 'openai/gpt-5', name: 'OpenAI/GPT-5' },
      ],
      currentModelId: 'openai/gpt-5',
    });
  });

  it('falls back to ACP session model metadata when config options are unavailable', () => {
    expect(extractAcpSessionModelState({
      models: {
        availableModels: [
          { description: 'Fast', id: 'openai/gpt-5-mini', name: 'OpenAI/GPT-5 Mini' },
        ],
        currentModelId: 'openai/gpt-5-mini',
      },
    })).toEqual({
      availableModels: [
        { description: 'Fast', id: 'openai/gpt-5-mini', name: 'OpenAI/GPT-5 Mini' },
      ],
      currentModelId: 'openai/gpt-5-mini',
    });
  });

  it('falls back to ACP session model metadata when the config option has no discovered entries', () => {
    expect(extractAcpSessionModelState({
      configOptions: [
        {
          category: 'model',
          currentValue: 'anthropic/claude-sonnet-4/high',
          id: 'selected_model',
          name: 'Model',
          options: [],
          type: 'select',
        },
      ],
      models: {
        availableModels: [
          { description: 'Fast', id: 'openai/gpt-5-mini', name: 'OpenAI/GPT-5 Mini' },
        ],
        currentModelId: 'openai/gpt-5-mini',
      },
    })).toEqual({
      availableModels: [
        { description: 'Fast', id: 'openai/gpt-5-mini', name: 'OpenAI/GPT-5 Mini' },
      ],
      currentModelId: 'openai/gpt-5-mini',
    });
  });

  it('prefers ACP config mode options over session mode metadata', () => {
    expect(extractAcpSessionModeState({
      configOptions: [
        {
          category: 'mode',
          currentValue: 'plan',
          id: 'session_mode',
          name: 'Mode',
          options: [
            { description: 'Default editing agent', name: 'Build', value: 'build' },
            { description: 'Planning-first agent', name: 'Plan', value: 'plan' },
          ],
          type: 'select',
        },
      ],
      modes: {
        availableModes: [
          { id: 'summary', name: 'Summary' },
        ],
        currentModeId: 'summary',
      },
    })).toEqual({
      availableModes: [
        { description: 'Default editing agent', id: 'build', name: 'Build' },
        { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'plan',
    });
  });

  it('falls back to the legacy mode id when category is unavailable', () => {
    expect(extractAcpSessionModeState({
      configOptions: [
        {
          currentValue: 'build',
          id: 'mode',
          name: 'Mode',
          options: [
            { description: 'Default editing agent', name: 'Build', value: 'build' },
          ],
          type: 'select',
        },
      ],
    })).toEqual({
      availableModes: [
        { description: 'Default editing agent', id: 'build', name: 'Build' },
      ],
      currentModeId: 'build',
    });
  });

  it('falls back to ACP session mode metadata when config options are unavailable', () => {
    expect(extractAcpSessionModeState({
      modes: {
        availableModes: [
          { id: 'build', name: 'Build' },
          { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
        ],
        currentModeId: 'build',
      },
    })).toEqual({
      availableModes: [
        { id: 'build', name: 'Build' },
        { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'build',
    });
  });

  it('falls back to ACP session mode metadata when the config option has no discovered entries', () => {
    expect(extractAcpSessionModeState({
      configOptions: [
        {
          category: 'mode',
          currentValue: 'plan',
          id: 'session_mode',
          name: 'Mode',
          options: [],
          type: 'select',
        },
      ],
      modes: {
        availableModes: [
          { id: 'build', name: 'Build' },
          { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
        ],
        currentModeId: 'build',
      },
    })).toEqual({
      availableModes: [
        { id: 'build', name: 'Build' },
        { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'build',
    });
  });

  it('extracts detached thought-level options from ACP config options', () => {
    expect(extractAcpSessionThoughtLevelState({
      configOptions: [
        {
          category: 'thought_level',
          currentValue: 'low',
          id: 'effort',
          name: 'Effort',
          options: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high' },
          ],
          type: 'select',
        },
      ],
    })).toEqual({
      availableLevels: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      configId: 'effort',
      currentLevel: 'low',
    });
  });
});
