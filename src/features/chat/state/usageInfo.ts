import type { UsageInfo } from '@/core/types';

export function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function calculateUsagePercentage(contextTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : 0;
}

function withContextWindow(usage: UsageInfo, contextWindow: number): UsageInfo {
  return {
    ...usage,
    contextWindow,
    percentage: calculateUsagePercentage(usage.contextTokens, contextWindow),
  };
}

/**
 * Projects raw provider usage into the context meter's display value. Only a valid
 * provider-reported window is shown; returns null when the meter should stay hidden.
 */
export function projectContextUsageDisplay(usage: UsageInfo | null): UsageInfo | null {
  if (!usage || usage.contextTokens <= 0 || !isValidContextWindow(usage.contextWindow)) return null;
  return withContextWindow(usage, usage.contextWindow);
}

/**
 * Applies a raw usage update. A partial update without a valid window keeps the
 * last reported window of the same model. For a different model, keep the whole
 * previous report until a complete report arrives, so counts and windows agree.
 */
export function mergeReportedUsage(previous: UsageInfo | null, next: UsageInfo): UsageInfo {
  if (isValidContextWindow(next.contextWindow)) return next;

  if (previous && previous.model !== next.model && isValidContextWindow(previous.contextWindow)) {
    return previous;
  }

  const retainedWindow = previous
    && previous.model === next.model
    && isValidContextWindow(previous.contextWindow)
    ? previous.contextWindow
    : 0;
  return withContextWindow(next, retainedWindow);
}
