import {
  getCurrentModelFromEnvironment,
  getCustomModelIds,
  getModelsFromEnvironment,
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
    });
    expect(result.size).toBe(3);
    expect(result.has('my-opus')).toBe(true);
    expect(result.has('my-sonnet')).toBe(true);
    expect(result.has('my-haiku')).toBe(true);
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

  it('should ignore whitespace-only model values', () => {
    const result = getCustomModelIds({
      ANTHROPIC_MODEL: '   ',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
    });
    expect(result.has('my-haiku')).toBe(true);
  });
});

describe('getModelsFromEnvironment', () => {
  it('returns empty array when no custom models configured', () => {
    const result = getModelsFromEnvironment({});
    expect(result).toEqual([]);
  });

  it('returns model for ANTHROPIC_MODEL', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'custom-model-v1' });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('custom-model-v1');
    expect(result[0].description).toContain('model');
  });

  it('formats label from hyphenated model name', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'claude-3-opus' });
    expect(result[0].label).toBe('Claude 3 Opus');
  });

  it('formats versioned Claude model ids into friendly labels', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'claude-opus-4-6[1m]' });
    expect(result[0].label).toBe('Opus 4.6 (1M)');
  });

  it('formats uppercase 1M suffixes into friendly labels', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'claude-opus-4-6[1M]' });
    expect(result[0].label).toBe('Opus 4.6 (1M)');
  });

  it('formats label from slash-separated model name', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'org/custom-model' });
    expect(result[0].label).toBe('custom-model');
  });

  it('formats provider-qualified Claude model ids into friendly labels', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4-6' });
    expect(result[0].label).toBe('Sonnet 4.6');
  });

  it('formats dated Claude model ids with shortened date tags', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'claude-opus-4-5-20251101' });
    expect(result[0].label).toBe('Opus 4.5 (2511)');
  });

  it('returns models for tier-specific env vars', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
    });
    expect(result).toHaveLength(3);
    expect(result.map(m => m.value)).toContain('my-opus');
    expect(result.map(m => m.value)).toContain('my-sonnet');
    expect(result.map(m => m.value)).toContain('my-haiku');
  });

  it('deduplicates when multiple env vars point to same model', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_MODEL: 'shared-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-model',
    });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('shared-model');
    expect(result[0].description).toContain('model');
    expect(result[0].description).toContain('sonnet');
  });

  it('sorts by type priority (model > haiku > sonnet > opus)', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-v1',
      ANTHROPIC_MODEL: 'main-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-v1',
    });
    expect(result[0].value).toBe('main-model');
    expect(result[1].value).toBe('haiku-v1');
    expect(result[2].value).toBe('opus-v1');
  });

  it('ignores unrelated env vars', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_API_KEY: 'sk-key',
      OTHER_VAR: 'value',
    });
    expect(result).toEqual([]);
  });

  it('ignores empty model values', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'valid-model',
    });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('valid-model');
  });
});

describe('getCurrentModelFromEnvironment', () => {
  it('returns null when no model env vars set', () => {
    expect(getCurrentModelFromEnvironment({})).toBeNull();
  });

  it('returns ANTHROPIC_MODEL when set', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_MODEL: 'custom-model',
    })).toBe('custom-model');
  });

  it('prefers ANTHROPIC_MODEL over tier-specific vars', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_MODEL: 'main-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
    })).toBe('main-model');
  });

  it('falls back to ANTHROPIC_DEFAULT_HAIKU_MODEL', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
    })).toBe('haiku-model');
  });

  it('falls back to ANTHROPIC_DEFAULT_SONNET_MODEL', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
    })).toBe('sonnet-model');
  });

  it('falls back to ANTHROPIC_DEFAULT_OPUS_MODEL', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
    })).toBe('opus-model');
  });

  it('returns null when only unrelated vars set', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_API_KEY: 'sk-key',
      OTHER_VAR: 'value',
    })).toBeNull();
  });
});
