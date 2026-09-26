import type { UsageInfo } from '@/core/types';
import {
  calculateUsagePercentage,
  clearReportedContextWindowForModel,
  mergeReportedUsage,
  projectContextUsageDisplay,
} from '@/features/chat/utils/usageInfo';

function usage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    model: 'model-a',
    inputTokens: 50_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 0,
    contextTokens: 50_000,
    percentage: 0,
    ...overrides,
  };
}

describe('usageInfo', () => {
  describe('calculateUsagePercentage', () => {
    it('rounds to the nearest integer and clamps to 0-100', () => {
      expect(calculateUsagePercentage(13623, 100000)).toBe(14);
      expect(calculateUsagePercentage(500000, 200000)).toBe(100);
      expect(calculateUsagePercentage(500, 0)).toBe(0);
    });
  });

  describe('projectContextUsageDisplay', () => {
    const context = (customContextLimits: Record<string, number> = {}, model = 'model-a') => ({
      providerId: 'codex' as const,
      model,
      customContextLimits,
    });

    it('uses a reported window even when a custom limit exists', () => {
      const display = projectContextUsageDisplay(
        usage({ contextWindow: 200_000 }),
        context({ 'model-a': 100_000 }),
      );

      expect(display).toMatchObject({ contextWindow: 200_000, contextTokens: 50_000, percentage: 25 });
    });

    it('falls back to the custom limit without a reported window', () => {
      expect(projectContextUsageDisplay(usage(), context({ 'model-a': 100_000 })))
        .toMatchObject({ contextWindow: 100_000, percentage: 50 });
    });

    it('hides the meter without a reported window or custom limit', () => {
      expect(projectContextUsageDisplay(usage(), context())).toBeNull();
    });

    it('hides the meter without token usage', () => {
      expect(projectContextUsageDisplay(
        usage({ contextTokens: 0, contextWindow: 200_000 }),
        context({ 'model-a': 100_000 }),
      )).toBeNull();
      expect(projectContextUsageDisplay(null, context({ 'model-a': 100_000 }))).toBeNull();
    });

    it('matches custom limits by runtime model id for provider selection ids', () => {
      expect(projectContextUsageDisplay(
        usage({ model: 'openai-codex/model-a' }),
        context({ 'model-a': 100_000 }, 'openai-codex/model-a'),
      )).toMatchObject({ contextWindow: 100_000, percentage: 50 });
    });

    it('matches custom limits by an unambiguous case-insensitive runtime id', () => {
      const displayContext = {
        ...context({ 'MODEL-A': 100_000 }, 'openai-codex/model-a'),
      };

      expect(projectContextUsageDisplay(usage(), displayContext))
        .toMatchObject({ contextWindow: 100_000, percentage: 50 });
      expect(projectContextUsageDisplay(usage({ contextWindow: 200_000 }), displayContext))
        .toMatchObject({ contextWindow: 200_000, percentage: 25 });
    });

    it.each<Record<string, number>>([{}, { 'opencode:anthropic/claude-sonnet-5': 100_000 }])(
      'uses the native OpenCode report with its selected model ID and fallback %j',
      customContextLimits => {
        const raw = usage({ model: 'anthropic/claude-sonnet-5', contextWindow: 200_000 });
        const model = 'opencode:anthropic/claude-sonnet-5';
        expect(projectContextUsageDisplay(raw, { providerId: 'opencode', model, customContextLimits }))
          .toMatchObject({ contextWindow: 200_000, percentage: 25 });
        expect(clearReportedContextWindowForModel(raw, model, 'opencode')).toBe(raw);
        expect(projectContextUsageDisplay(raw, { providerId: 'opencode', model: 'opencode:other/model' }))
          .toBeNull();
      },
    );

    it('ignores invalid custom limits and reported windows', () => {
      for (const invalid of [0, -1, NaN, Infinity]) {
        expect(projectContextUsageDisplay(
          usage({ contextWindow: invalid }),
          context({ 'model-a': invalid }),
        )).toBeNull();
      }
    });

    it('does not apply another model’s reported window', () => {
      expect(projectContextUsageDisplay(
        usage({ contextWindow: 200_000 }),
        context({ 'model-b': 100_000 }, 'model-b'),
      )).toMatchObject({ contextWindow: 100_000, percentage: 50 });
      expect(projectContextUsageDisplay(usage({ contextWindow: 200_000 }), context({}, 'model-b')))
        .toBeNull();
    });

    it('keeps the raw usage unchanged', () => {
      const raw = usage();
      projectContextUsageDisplay(raw, context({ 'model-a': 100_000 }));
      expect(raw).toEqual(usage());
    });
  });

  describe('mergeReportedUsage', () => {
    it('retains a valid same-model window when a partial update omits it', () => {
      const merged = mergeReportedUsage(
        usage({ contextWindow: 200_000, percentage: 25 }),
        usage({ contextTokens: 100_000 }),
      );

      expect(merged).toMatchObject({ contextWindow: 200_000, contextTokens: 100_000, percentage: 50 });
    });

    it('replaces the window with a new valid report', () => {
      expect(mergeReportedUsage(
        usage({ contextWindow: 200_000 }),
        usage({ contextWindow: 400_000, percentage: 13 }),
      )).toMatchObject({ contextWindow: 400_000, percentage: 13 });
    });

    it('does not carry a window across models or from missing usage', () => {
      expect(mergeReportedUsage(
        usage({ contextWindow: 200_000 }),
        usage({ model: 'model-b' }),
      )).toMatchObject({ contextWindow: 0, percentage: 0 });
      expect(mergeReportedUsage(null, usage())).toMatchObject({ contextWindow: 0 });
    });

    it('normalizes invalid reported windows to zero', () => {
      expect(mergeReportedUsage(null, usage({ contextWindow: NaN, percentage: 50 })))
        .toMatchObject({ contextWindow: 0, percentage: 0 });
    });
  });

  describe('clearReportedContextWindowForModel', () => {
    it('clears the previous model’s reported window on a model change', () => {
      expect(clearReportedContextWindowForModel(
        usage({ contextWindow: 200_000, percentage: 25 }),
        'model-b',
      )).toEqual(usage({ model: 'model-b', contextWindow: 0, percentage: 0 }));
    });

    it('keeps usage for the same model', () => {
      const current = usage({ contextWindow: 200_000, percentage: 25 });
      expect(clearReportedContextWindowForModel(current, 'model-a')).toBe(current);
    });
  });
});
