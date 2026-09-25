import '@/providers';

import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { getEnabledProviderForModel, getProviderForModel } from '@/core/providers/modelRouting';

describe('getProviderForModel', () => {
  it('routes Claude default models to claude', () => {
    expect(getProviderForModel('haiku')).toBe('claude');
    expect(getProviderForModel('sonnet')).toBe('claude');
    expect(getProviderForModel('opus')).toBe('claude');
  });

  it('routes Claude extended models to claude', () => {
    expect(getProviderForModel('claude-sonnet-4-5-20250514')).toBe('claude');
    expect(getProviderForModel('claude-opus-4-6-20250616')).toBe('claude');
  });

  it('routes Codex default models to codex', () => {
    expect(getProviderForModel(TEST_CODEX_MODEL)).toBe('codex');
  });

  it('leaves unknown models unresolved', () => {
    expect(getProviderForModel('some-unknown-model')).toBeNull();
  });

  it('routes models starting with gpt- to codex', () => {
    expect(getProviderForModel('gpt-4o')).toBe('codex');
    expect(getProviderForModel('gpt-custom')).toBe('codex');
  });

  it('routes models starting with o prefix to codex', () => {
    expect(getProviderForModel('o3')).toBe('codex');
    expect(getProviderForModel('o4-mini')).toBe('codex');
  });

  it('does not claim a manual environment model', () => {
    const settings = { environmentVariables: 'OPENAI_MODEL=my-custom-model' };
    expect(getProviderForModel('my-custom-model', settings)).toBeNull();
  });

  it('routes provider-qualified custom model ids without raw name collisions', () => {
    const settings = {
      providerConfigs: {
        claude: {
          customModels: 'deepseek-v4-pro',
        },
        codex: {
          enabled: true,
          customModels: 'deepseek-v4-pro',
        },
      },
    };

    expect(getProviderForModel('claude-code/deepseek-v4-pro', settings)).toBe('claude');
    expect(getProviderForModel('openai-codex/deepseek-v4-pro', settings)).toBe('codex');
  });

  it('does not claim retired manual model configuration', () => {
    const settings = {
      providerConfigs: {
        codex: {
          enabled: true,
          customModels: 'my-custom-model',
        },
      },
    };

    expect(getProviderForModel('my-custom-model', settings)).toBeNull();
  });

  it('rejects ambiguous ownership and resolves within enabled providers only', () => {
    const settings = {
      settingsProvider: 'claude',
      providerConfigs: {
        claude: {
          environmentVariables: `ANTHROPIC_MODEL=${TEST_CODEX_MODEL}`,
        },
        codex: {
          enabled: false,
        },
      },
    };

    expect(getProviderForModel(TEST_CODEX_MODEL, settings)).toBeNull();
    expect(getEnabledProviderForModel(TEST_CODEX_MODEL, settings)).toBe('claude');
  });
});

it('leaves an unclaimed model unresolved instead of selecting the default provider', () => {
  expect(getProviderForModel('retired-endpoint-model', {
    providerConfigs: { claude: { enabled: true }, codex: { enabled: true, visibleModels: [] } },
  })).toBeNull();
});
