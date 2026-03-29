import type { UsageInfo } from '../../../core/types';

export function calculateUsagePercentage(contextTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : 0;
}

export function recalculateUsageForModel(
  usage: UsageInfo,
  model: string,
  fallbackContextWindow: number,
): UsageInfo {
  const preserveAuthoritativeWindow = usage.contextWindowIsAuthoritative === true
    && usage.contextWindow > 0
    && usage.model === model;
  const contextWindow = preserveAuthoritativeWindow ? usage.contextWindow : fallbackContextWindow;

  return {
    ...usage,
    model,
    contextWindow,
    contextWindowIsAuthoritative: preserveAuthoritativeWindow,
    percentage: calculateUsagePercentage(usage.contextTokens, contextWindow),
  };
}
