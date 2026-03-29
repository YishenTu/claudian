import { calculateUsagePercentage, recalculateUsageForModel } from '@/features/chat/utils/usageInfo';

describe('usageInfo', () => {
  describe('calculateUsagePercentage', () => {
    it('rounds to the nearest integer and clamps to 0-100', () => {
      expect(calculateUsagePercentage(13623, 100000)).toBe(14);
      expect(calculateUsagePercentage(500000, 200000)).toBe(100);
      expect(calculateUsagePercentage(500, 0)).toBe(0);
    });
  });

  describe('recalculateUsageForModel', () => {
    it('preserves an authoritative context window for the same model', () => {
      const usage = {
        model: 'gpt-5.4',
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        contextTokens: 129200,
        percentage: 50,
      };

      expect(recalculateUsageForModel(usage, 'gpt-5.4', 200000)).toEqual({
        ...usage,
        model: 'gpt-5.4',
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        percentage: 50,
      });
    });

    it('falls back to the UI context window when the model changes', () => {
      const usage = {
        model: 'gpt-5.4',
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        contextTokens: 100000,
        percentage: 39,
      };

      expect(recalculateUsageForModel(usage, 'gpt-5.4-mini', 200000)).toEqual({
        ...usage,
        model: 'gpt-5.4-mini',
        contextWindow: 200000,
        contextWindowIsAuthoritative: false,
        percentage: 50,
      });
    });
  });
});
