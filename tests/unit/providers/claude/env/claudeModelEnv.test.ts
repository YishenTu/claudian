import {
  getCustomModelIds,
} from '@/providers/claude/env/claudeModelEnv';

describe('getCustomModelIds', () => {
  it('should return empty set when no custom models configured', () => {
    const result = getCustomModelIds({});
    expect(result.size).toBe(0);
  });

  it('should extract ANTHROPIC_MODEL', () => {
    const result = getCustomModelIds({ ANTHROPIC_MODEL: 'custom-model' });
    expect(result.size).toBe(1);
    expect(result.has('custom-model')).toBe(true);
  });

  it('should extract model from default tier env vars', () => {
    const result = getCustomModelIds({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'my-fable',
    });
    expect(result.size).toBe(4);
    expect(result.has('my-opus')).toBe(true);
    expect(result.has('my-sonnet')).toBe(true);
    expect(result.has('my-haiku')).toBe(true);
    expect(result.has('my-fable')).toBe(true);
  });

  it('should deduplicate when multiple env vars point to same model', () => {
    const result = getCustomModelIds({
      ANTHROPIC_MODEL: 'shared-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-model',
    });
    expect(result.size).toBe(1);
    expect(result.has('shared-model')).toBe(true);
  });

  it('should ignore unrelated env vars', () => {
    const result = getCustomModelIds({
      ANTHROPIC_API_KEY: 'secret-key',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      OTHER_VAR: 'value',
    });
    expect(result.size).toBe(0);
  });

  it('should handle mixed relevant and irrelevant env vars', () => {
    const result = getCustomModelIds({
      ANTHROPIC_API_KEY: 'secret-key',
      ANTHROPIC_MODEL: 'custom-model',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    expect(result.size).toBe(1);
    expect(result.has('custom-model')).toBe(true);
  });

  it('should ignore empty string model values', () => {
    const result = getCustomModelIds({
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'valid-model',
    });
    expect(result.size).toBe(1);
    expect(result.has('')).toBe(false);
    expect(result.has('valid-model')).toBe(true);
  });
});
