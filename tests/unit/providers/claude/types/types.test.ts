import { getClaudeProviderSettings } from '@/providers/claude/settings';
import {
CONTEXT_WINDOW_1M,
CONTEXT_WINDOW_STANDARD,
getContextWindowSize,
normalizeEffortLevel,
normalizeLegacyClaudeModelAlias,
resolveContextWindowSize,
supportsXHighEffort,
} from '@/providers/claude/types/models';
import {
createPermissionRule,
parseCCPermissionRule
} from '@/providers/claude/types/settings';

describe('types.ts', () => {

  describe('legacy provider settings', () => {

    it('should enable Claude by default for backward compatibility', () => {
      expect(getClaudeProviderSettings({ providerConfigs: { claude: {} } }).enabled).toBe(true);
    });
  });

  describe('Permission Conversion Utilities', () => {
    describe('parseCCPermissionRule', () => {
      it('should parse rule with pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('Bash(git status)'));
        expect(result.tool).toBe('Bash');
        expect(result.pattern).toBe('git status');
      });

      it('should parse rule with complex pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('WebFetch(domain:github.com)'));
        expect(result.tool).toBe('WebFetch');
        expect(result.pattern).toBe('domain:github.com');
      });

      it('should parse rule without pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('Read'));
        expect(result.tool).toBe('Read');
        expect(result.pattern).toBeUndefined();
      });

      it('should handle nested parentheses in pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('Bash(echo "hello (world)")'));
        expect(result.tool).toBe('Bash');
        expect(result.pattern).toBe('echo "hello (world)"');
      });

      it('should handle path patterns', () => {
        const result = parseCCPermissionRule(createPermissionRule('Read(/Users/test/vault/notes)'));
        expect(result.tool).toBe('Read');
        expect(result.pattern).toBe('/Users/test/vault/notes');
      });

      it('should return rule as tool for malformed input', () => {
        const result = parseCCPermissionRule(createPermissionRule('not-valid-format'));
        expect(result.tool).toBe('not-valid-format');
        expect(result.pattern).toBeUndefined();
      });
    });
  });

  describe('getContextWindowSize', () => {
    it('should use the current built-in model context windows by default', () => {
      expect(getContextWindowSize('sonnet')).toBe(CONTEXT_WINDOW_1M);
      expect(getContextWindowSize('opus')).toBe(CONTEXT_WINDOW_1M);
      expect(getContextWindowSize('haiku')).toBe(CONTEXT_WINDOW_STANDARD);
    });

    it('should recognize current and legacy versioned context windows', () => {
      expect(getContextWindowSize('claude-opus-4-6')).toBe(CONTEXT_WINDOW_1M);
      expect(getContextWindowSize('claude-opus-4-8')).toBe(CONTEXT_WINDOW_1M);
      expect(getContextWindowSize('claude-sonnet-4-6')).toBe(CONTEXT_WINDOW_1M);
      expect(getContextWindowSize('claude-sonnet-5')).toBe(CONTEXT_WINDOW_1M);
      expect(getContextWindowSize('claude-opus-4-5')).toBe(CONTEXT_WINDOW_STANDARD);
      expect(getContextWindowSize('claude-sonnet-4-5')).toBe(CONTEXT_WINDOW_STANDARD);
    });

    it('should use custom limits when provided', () => {
      const customLimits = { 'custom-model': 256000 };
      expect(getContextWindowSize('custom-model', customLimits)).toBe(256000);
    });

    it('should fall back to default when model not in custom limits', () => {
      const customLimits = { 'other-model': 256000 };
      expect(getContextWindowSize('sonnet', customLimits)).toBe(CONTEXT_WINDOW_1M);
    });

    it('should handle empty custom limits object', () => {
      expect(getContextWindowSize('sonnet', {})).toBe(CONTEXT_WINDOW_1M);
    });

    it('should handle undefined custom limits', () => {
      expect(getContextWindowSize('sonnet', undefined)).toBe(CONTEXT_WINDOW_1M);
    });

    describe('defensive validation for invalid custom limit values', () => {
      it('should fall back to default for NaN custom limit', () => {
        const customLimits = { 'custom-model': NaN };
        expect(getContextWindowSize('custom-model', customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should fall back to default for negative custom limit', () => {
        const customLimits = { 'custom-model': -100000 };
        expect(getContextWindowSize('custom-model', customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should fall back to default for zero custom limit', () => {
        const customLimits = { 'custom-model': 0 };
        expect(getContextWindowSize('custom-model', customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should fall back to default for Infinity custom limit', () => {
        const customLimits = { 'custom-model': Infinity };
        expect(getContextWindowSize('custom-model', customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should fall back to default for -Infinity custom limit', () => {
        const customLimits = { 'custom-model': -Infinity };
        expect(getContextWindowSize('custom-model', customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should accept valid positive custom limit', () => {
        const customLimits = { 'custom-model': 256000 };
        expect(getContextWindowSize('custom-model', customLimits)).toBe(256000);
      });
    });

    describe('[1m] suffix detection', () => {
      it('should return 1M context window for models with [1m] suffix', () => {
        expect(getContextWindowSize('opus[1m]')).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('sonnet[1m]')).toBe(CONTEXT_WINDOW_1M);
      });

      it('should treat [1M] and [1m] suffixes equivalently', () => {
        expect(getContextWindowSize('opus[1M]')).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('claude-opus-4-6[1M]')).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('claude-sonnet-4-6[1M]')).toBe(CONTEXT_WINDOW_1M);
      });

      it('should return 1M for full model IDs with [1m] suffix', () => {
        expect(getContextWindowSize('claude-opus-4-6[1m]')).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('claude-sonnet-4-6[1m]')).toBe(CONTEXT_WINDOW_1M);
      });

      it('should prefer custom limits over [1m] suffix', () => {
        const customLimits = { 'opus[1m]': 500000 };
        expect(getContextWindowSize('opus[1m]', customLimits)).toBe(500000);
      });

      it('should match custom limits case-insensitively for [1M] suffixes', () => {
        const customLimits = { 'claude-opus-4-6[1m]': 500000 };
        expect(getContextWindowSize('claude-opus-4-6[1M]', customLimits)).toBe(500000);
      });

      it('should keep retired 1M variants on their current standard window', () => {
        expect(getContextWindowSize('claude-opus-4-5[1m]')).toBe(CONTEXT_WINDOW_STANDARD);
        expect(getContextWindowSize('claude-sonnet-4-5[1m]')).toBe(CONTEXT_WINDOW_STANDARD);
      });
    });

    describe('fable models', () => {
      it('should default to 1M context window with no [1m] suffix needed', () => {
        expect(getContextWindowSize('fable')).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('claude-fable-5')).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('claude-fable-6')).toBe(CONTEXT_WINDOW_1M);
      });

      it('should prefer custom limits over the fable default', () => {
        const customLimits = { 'claude-fable-5': 500000 };
        expect(getContextWindowSize('claude-fable-5', customLimits)).toBe(500000);
      });

      it('should preserve legacy Fable custom limits after alias migration', () => {
        const customLimits = { 'claude-fable-5': 500000 };

        expect(getContextWindowSize('fable', customLimits)).toBe(500000);
        expect(resolveContextWindowSize('fable', customLimits, 1000000)).toEqual({
          contextWindow: 500000,
          source: 'custom',
        });
      });
    });

    describe('normalizeLegacyClaudeModelAlias', () => {
      it('should migrate legacy built-in variants to the current aliases', () => {
        expect(normalizeLegacyClaudeModelAlias('sonnet[1m]')).toBe('sonnet');
        expect(normalizeLegacyClaudeModelAlias('sonnet[1M]')).toBe('sonnet');
        expect(normalizeLegacyClaudeModelAlias('opus[1m]')).toBe('opus');
        expect(normalizeLegacyClaudeModelAlias('opus[1M]')).toBe('opus');
        expect(normalizeLegacyClaudeModelAlias('claude-fable-5')).toBe('fable');
      });

      it('should leave explicit and custom model ids unchanged', () => {
        expect(normalizeLegacyClaudeModelAlias('')).toBe('');
        expect(normalizeLegacyClaudeModelAlias('haiku')).toBe('haiku');
        expect(normalizeLegacyClaudeModelAlias('claude-opus-4-6[1m]')).toBe('claude-opus-4-6[1m]');
        expect(normalizeLegacyClaudeModelAlias('claude-fable-6')).toBe('claude-fable-6');
        expect(normalizeLegacyClaudeModelAlias('custom-model')).toBe('custom-model');
      });
    });
  });

  describe('supportsXHighEffort', () => {
    it('returns true for opaque custom model ids', () => {
      expect(supportsXHighEffort('custom-model')).toBe(true);
      expect(supportsXHighEffort('gateway/gpt-4.2')).toBe(true);
    });

    it('returns true for opus aliases and 4.7+ opus ids', () => {
      expect(supportsXHighEffort('opus')).toBe(true);
      expect(supportsXHighEffort('opus[1m]')).toBe(true);
      expect(supportsXHighEffort('opus[1M]')).toBe(true);
      expect(supportsXHighEffort('claude-opus-4-7')).toBe(true);
      expect(supportsXHighEffort('claude-opus-5')).toBe(true);
    });

    it('returns true for sonnet aliases and sonnet 5+ ids', () => {
      expect(supportsXHighEffort('sonnet')).toBe(true);
      expect(supportsXHighEffort('sonnet[1m]')).toBe(true);
      expect(supportsXHighEffort('claude-sonnet-5')).toBe(true);
      expect(supportsXHighEffort('claude-sonnet-5-20260101')).toBe(true);
      expect(supportsXHighEffort('claude-sonnet-6')).toBe(true);
    });

    it('returns false for non-opus/non-sonnet-5 models and older ids', () => {
      expect(supportsXHighEffort('haiku')).toBe(false);
      expect(supportsXHighEffort('claude-sonnet-4-5')).toBe(false);
      expect(supportsXHighEffort('claude-sonnet-4-6')).toBe(false);
      expect(supportsXHighEffort('claude-opus-4-6')).toBe(false);
    });

    it('returns true for fable models', () => {
      expect(supportsXHighEffort('fable')).toBe(true);
      expect(supportsXHighEffort('claude-fable-5')).toBe(true);
      expect(supportsXHighEffort('claude-fable-6')).toBe(true);
    });
  });

  describe('normalizeEffortLevel', () => {
    it('preserves supported effort levels', () => {
      expect(normalizeEffortLevel('claude-opus-4-7', 'xhigh')).toBe('xhigh');
      expect(normalizeEffortLevel('claude-sonnet-4-5', 'max')).toBe('max');
      expect(normalizeEffortLevel('custom-model', 'xhigh')).toBe('xhigh');
    });

    it('clamps unsupported xhigh values to the model default', () => {
      expect(normalizeEffortLevel('claude-sonnet-4-5', 'xhigh')).toBe('high');
      expect(normalizeEffortLevel('haiku', 'xhigh')).toBe('high');
    });

    it('falls back to high for unknown or missing effort values', () => {
      expect(normalizeEffortLevel('claude-sonnet-4-5', 'invalid')).toBe('high');
      expect(normalizeEffortLevel('claude-sonnet-4-5', undefined)).toBe('high');
    });
  });
});
