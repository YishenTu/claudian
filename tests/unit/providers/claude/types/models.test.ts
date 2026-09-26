import { getClaudeProviderSettings } from '@/providers/claude/settings';
import {
  normalizeLegacyClaudeModelAlias,
  resolveSupportedEffortLevel,
} from '@/providers/claude/types/models';

describe('types.ts', () => {

  describe('legacy provider settings', () => {

    it('should enable Claude by default for backward compatibility', () => {
      expect(getClaudeProviderSettings({ providerConfigs: { claude: {} } }).enabled).toBe(true);
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

  describe('resolveSupportedEffortLevel', () => {
    it('keeps a reported choice', () => {
      expect(resolveSupportedEffortLevel(['low', 'xhigh'], 'xhigh')).toBe('xhigh');
    });

    it('defaults to High for unsupported or missing choices', () => {
      expect(resolveSupportedEffortLevel(['low', 'high', 'max'], 'xhigh')).toBe('high');
      expect(resolveSupportedEffortLevel(['medium', 'max'], undefined)).toBe('high');
      expect(resolveSupportedEffortLevel(['medium', 'max'], 'invalid')).toBe('high');
    });

    it('has no explicit effort without reported levels', () => {
      expect(resolveSupportedEffortLevel([], 'high')).toBeNull();
    });
  });
});
