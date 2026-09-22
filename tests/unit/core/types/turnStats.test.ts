import { createTurnStats } from '@/core/types';

it.each([
  [125, 0], [NaN, 2500], [-1, 2500], [1.5, 2500], [Infinity, 2500],
  [125, Infinity], [125, -1], [undefined, 2500], [125, undefined],
])('omits throughput with invalid native counts or timing (%s, %s)', (tokens, duration) => {
  expect(createTurnStats(tokens, duration)).toBeUndefined();
});

it('preserves a valid zero count and subsecond native precision', () => {
  expect(createTurnStats(0, 125.5)).toEqual({ outputTokens: 0, durationMs: 125.5 });
});
