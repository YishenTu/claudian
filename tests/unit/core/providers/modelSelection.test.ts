import {
  decodeProviderModelSelectionId,
  encodeProviderModelSelectionId,
  getProviderModelSelectionPrefix,
  isProviderModelSelectionId,
  toProviderRuntimeModelId,
} from '@/core/providers/modelSelection';

describe('model selection namespacing', () => {
  describe('getProviderModelSelectionPrefix', () => {
    it('returns the registered prefix for each known provider', () => {
      expect(getProviderModelSelectionPrefix('claude')).toBe('claude-code/');
      expect(getProviderModelSelectionPrefix('codex')).toBe('openai-codex/');
      expect(getProviderModelSelectionPrefix('opencode')).toBe('opencode/');
      expect(getProviderModelSelectionPrefix('pi')).toBe('pi/');
      expect(getProviderModelSelectionPrefix('grok')).toBe('grok/');
    });

    it('returns null for a provider with no registered prefix', () => {
      expect(getProviderModelSelectionPrefix('unknown-provider')).toBeNull();
    });
  });

  describe('encodeProviderModelSelectionId', () => {
    it('prefixes a bare model id with the provider namespace', () => {
      expect(encodeProviderModelSelectionId('claude', 'deepseek-v4-pro')).toBe('claude-code/deepseek-v4-pro');
      expect(encodeProviderModelSelectionId('codex', 'gpt-5-custom')).toBe('openai-codex/gpt-5-custom');
    });

    it('is idempotent: an already-namespaced id is returned unchanged', () => {
      const namespaced = 'claude-code/deepseek-v4-pro';
      expect(encodeProviderModelSelectionId('claude', namespaced)).toBe(namespaced);
    });

    it('trims surrounding whitespace before prefixing', () => {
      expect(encodeProviderModelSelectionId('claude', '  deepseek-v4-pro  ')).toBe('claude-code/deepseek-v4-pro');
    });

    it('returns an empty string for empty or whitespace-only input', () => {
      expect(encodeProviderModelSelectionId('claude', '')).toBe('');
      expect(encodeProviderModelSelectionId('claude', '   ')).toBe('');
    });

    // encode only guards against its OWN prefix, so a value that already carries a
    // different provider's namespace is treated as opaque and re-prefixed. This is
    // acceptable because callers only ever encode bare ids they own.
    it('re-prefixes a value that carries another provider namespace', () => {
      expect(encodeProviderModelSelectionId('claude', 'openai-codex/gpt-5')).toBe('claude-code/openai-codex/gpt-5');
    });

    it('leaves the id untouched when the provider has no registered prefix', () => {
      expect(encodeProviderModelSelectionId('unknown-provider', 'deepseek-v4-pro')).toBe('deepseek-v4-pro');
    });
  });

  describe('decodeProviderModelSelectionId', () => {
    it('decodes a namespaced id into its provider and model id', () => {
      expect(decodeProviderModelSelectionId('claude-code/deepseek-v4-pro')).toEqual({
        providerId: 'claude',
        modelId: 'deepseek-v4-pro',
      });
      expect(decodeProviderModelSelectionId('openai-codex/gpt-5')).toEqual({
        providerId: 'codex',
        modelId: 'gpt-5',
      });
      expect(decodeProviderModelSelectionId('opencode/qwen')).toEqual({
        providerId: 'opencode',
        modelId: 'qwen',
      });
      expect(decodeProviderModelSelectionId('pi/assistant')).toEqual({
        providerId: 'pi',
        modelId: 'assistant',
      });
      expect(decodeProviderModelSelectionId('grok/kimi-coding')).toEqual({
        providerId: 'grok',
        modelId: 'kimi-coding',
      });
    });

    it('returns null for empty or whitespace-only input', () => {
      expect(decodeProviderModelSelectionId('')).toBeNull();
      expect(decodeProviderModelSelectionId('   ')).toBeNull();
    });

    it('returns null for a non-namespaced model id', () => {
      expect(decodeProviderModelSelectionId('deepseek-v4-pro')).toBeNull();
      expect(decodeProviderModelSelectionId('sonnet')).toBeNull();
    });

    it('returns null when only the prefix is present (no model id)', () => {
      expect(decodeProviderModelSelectionId('claude-code/')).toBeNull();
      expect(decodeProviderModelSelectionId('openai-codex/   ')).toBeNull();
    });

    it('trims surrounding whitespace before decoding', () => {
      expect(decodeProviderModelSelectionId('  claude-code/deepseek-v4-pro  ')).toEqual({
        providerId: 'claude',
        modelId: 'deepseek-v4-pro',
      });
    });
  });

  describe('isProviderModelSelectionId', () => {
    it('is true for a value carrying the given provider namespace', () => {
      expect(isProviderModelSelectionId('claude', 'claude-code/deepseek-v4-pro')).toBe(true);
      expect(isProviderModelSelectionId('codex', 'openai-codex/gpt-5')).toBe(true);
    });

    // The cross-provider check is the core invariant that lets identically-named
    // custom models coexist: a claude-namespaced id must NOT be claimed by codex.
    it('is false for a value carrying a different provider namespace', () => {
      expect(isProviderModelSelectionId('codex', 'claude-code/deepseek-v4-pro')).toBe(false);
      expect(isProviderModelSelectionId('claude', 'openai-codex/gpt-5')).toBe(false);
    });

    it('is false for a bare model id and for empty input', () => {
      expect(isProviderModelSelectionId('claude', 'deepseek-v4-pro')).toBe(false);
      expect(isProviderModelSelectionId('claude', '')).toBe(false);
    });
  });

  describe('toProviderRuntimeModelId', () => {
    it('strips the namespace when the value belongs to the given provider', () => {
      expect(toProviderRuntimeModelId('claude', 'claude-code/deepseek-v4-pro')).toBe('deepseek-v4-pro');
      expect(toProviderRuntimeModelId('codex', 'openai-codex/gpt-5')).toBe('gpt-5');
    });

    it('leaves a bare model id unchanged', () => {
      expect(toProviderRuntimeModelId('claude', 'deepseek-v4-pro')).toBe('deepseek-v4-pro');
    });

    // Never strip another provider's namespace: handing it through verbatim is what
    // keeps a stray cross-provider id from being misrouted at the runtime seam.
    it('leaves a value unchanged when it carries another provider namespace', () => {
      expect(toProviderRuntimeModelId('codex', 'claude-code/deepseek-v4-pro')).toBe('claude-code/deepseek-v4-pro');
    });

    it('returns an empty string unchanged', () => {
      expect(toProviderRuntimeModelId('claude', '')).toBe('');
    });
  });

  describe('encode/decode round-trip', () => {
    it.each([
      ['claude', 'claude-code/', 'deepseek-v4-pro'],
      ['codex', 'openai-codex/', 'gpt-5-custom'],
      ['opencode', 'opencode/', 'qwen-max'],
      ['pi', 'pi/', 'assistant-1'],
      ['grok', 'grok/', 'kimi-coding'],
    ] as const)('round-trips a %s model id through encode and toRuntimeModelId', (providerId, prefix, modelId) => {
      const encoded = encodeProviderModelSelectionId(providerId, modelId);
      expect(encoded).toBe(`${prefix}${modelId}`);
      // Stripping the runtime id must recover the original bare model id.
      expect(toProviderRuntimeModelId(providerId, encoded)).toBe(modelId);
      // Encoding is idempotent, so re-encoding never double-prefixes.
      expect(encodeProviderModelSelectionId(providerId, encoded)).toBe(encoded);
      // Decoding must attribute the id back to the owning provider.
      expect(decodeProviderModelSelectionId(encoded)).toEqual({ providerId, modelId });
    });
  });
});
