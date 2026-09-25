import {
  decodeProviderModelSelectionId,
  encodeProviderModelSelectionId,
  isProviderModelSelectionId,
  toProviderRuntimeModelId,
} from '@/core/providers/modelSelection';

describe('model selection namespacing', () => {
  describe('encodeProviderModelSelectionId', () => {
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
      ['codex', 'openai-codex/', 'gpt-5'],
      ['opencode', 'opencode:', 'qwen-max'],
      ['opencode', 'opencode:', 'qwen'],
      ['pi', 'pi/', 'assistant-1'],
      ['pi', 'pi/', 'assistant'],
      ['grok', 'grok/', 'kimi-coding'],
    ] as const)('round-trips a %s model id through encode and toRuntimeModelId', (providerId, prefix, modelId) => {
      const encoded = encodeProviderModelSelectionId(providerId, modelId);
      expect(encoded).toBe(`${prefix}${modelId}`);
      expect(isProviderModelSelectionId(providerId, encoded)).toBe(true);
      // Stripping the runtime id must recover the original bare model id.
      expect(toProviderRuntimeModelId(providerId, encoded)).toBe(modelId);
      // Encoding is idempotent, so re-encoding never double-prefixes.
      expect(encodeProviderModelSelectionId(providerId, encoded)).toBe(encoded);
      // Decoding must attribute the id back to the owning provider.
      expect(decodeProviderModelSelectionId(encoded)).toEqual({ providerId, modelId });
    });
  });
});
