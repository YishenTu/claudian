import {
  resolveQoderContextUsage,
  resolveQoderUsageContextWindow,
} from '@/providers/qoder/runtime/QoderUsage';

describe('resolveQoderContextUsage', () => {
  it('prefers the completed-turn context ratio over per-request token counters', () => {
    expect(resolveQoderContextUsage({
      contextUsageRatio: 0.5,
      contextWindow: 180_000,
      reportedContextTokens: 12_345,
    })).toEqual({
      contextTokens: 90_000,
      percentage: 50,
    });
  });

  it('uses reported tokens when the context ratio is unavailable', () => {
    expect(resolveQoderContextUsage({
      contextWindow: 180_000,
      reportedContextTokens: 12_345,
    })).toEqual({
      contextTokens: 12_345,
      percentage: 7,
    });
  });

  it('derives context tokens from the Qoder ratio when token counters are empty', () => {
    expect(resolveQoderContextUsage({
      contextUsageRatio: 0.10443333333333334,
      contextWindow: 180_000,
      reportedContextTokens: 0,
    })).toEqual({
      contextTokens: 18_798,
      percentage: 10,
    });
  });

  it('clamps malformed ratios and handles an unknown context window', () => {
    expect(resolveQoderContextUsage({
      contextUsageRatio: 1.5,
      contextWindow: 100_000,
      reportedContextTokens: 0,
    })).toEqual({
      contextTokens: 100_000,
      percentage: 100,
    });
    expect(resolveQoderContextUsage({
      contextUsageRatio: 0.5,
      contextWindow: 0,
      reportedContextTokens: 0,
    })).toEqual({
      contextTokens: 0,
      percentage: 0,
    });
  });

  it('ignores the zero context-window placeholder returned by Qoder', () => {
    expect(resolveQoderUsageContextWindow(0, 200_000)).toBe(200_000);
    expect(resolveQoderUsageContextWindow(180_000, 200_000)).toBe(180_000);
  });
});
