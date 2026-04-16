import '@/providers';

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
    expect(getProviderForModel('gpt-5.4')).toBe('codex');
  });

  it('routes unknown models to claude (default)', () => {
    expect(getProviderForModel('some-unknown-model')).toBe('claude');
  });

  it('routes models starting with gpt- to codex', () => {
    expect(getProviderForModel('gpt-4o')).toBe('codex');
    expect(getProviderForModel('gpt-custom')).toBe('codex');
  });

  it('routes models starting with o prefix to codex', () => {
    expect(getProviderForModel('o3')).toBe('codex');
    expect(getProviderForModel('o4-mini')).toBe('codex');
  });

  it('routes custom OPENAI_MODEL to codex when settings are provided', () => {
    const settings = { environmentVariables: 'OPENAI_MODEL=my-custom-model' };
    expect(getProviderForModel('my-custom-model', settings)).toBe('codex');
  });

  it('routes custom OPENAI_MODEL to claude without settings (no context)', () => {
    expect(getProviderForModel('my-custom-model')).toBe('claude');
  });

  it('can resolve blank-tab routing within enabled providers only', () => {
    const settings = {
      settingsProvider: 'claude',
      providerConfigs: {
        claude: {
          environmentVariables: 'ANTHROPIC_MODEL=gpt-5.4',
        },
        codex: {
          enabled: false,
        },
      },
    };

    expect(getProviderForModel('gpt-5.4', settings)).toBe('codex');
    expect(getEnabledProviderForModel('gpt-5.4', settings)).toBe('claude');
  });
});
