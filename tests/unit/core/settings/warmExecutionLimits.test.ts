import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { normalizeWarmExecutionLimit } from '@/core/settings/warmExecutionLimits';

it.each([
  [undefined, 5], [NaN, 5], [Infinity, 5], ['8', 5], [3, 5], [5, 5], [7.9, 7], [10, 10], [100, 10],
])('normalizes a warm limit of %p to %p', (configured, expected) => {
  expect(normalizeWarmExecutionLimit(configured)).toBe(expected);
});

it('uses the same fallback as new settings', () => {
  expect(normalizeWarmExecutionLimit(undefined)).toBe(DEFAULT_CLAUDIAN_SETTINGS.maxWarmAgentProcesses);
});
