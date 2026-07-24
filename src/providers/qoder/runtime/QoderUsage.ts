export interface QoderContextUsageInput {
  contextUsageRatio?: number;
  contextWindow: number;
  reportedContextTokens: number;
}

export interface QoderContextUsage {
  contextTokens: number;
  percentage: number;
}

export function resolveQoderUsageContextWindow(
  reportedContextWindow: number | undefined,
  fallbackContextWindow: number,
): number {
  return typeof reportedContextWindow === 'number'
    && Number.isFinite(reportedContextWindow)
    && reportedContextWindow > 0
    ? reportedContextWindow
    : fallbackContextWindow;
}

export function resolveQoderContextUsage(
  input: QoderContextUsageInput,
): QoderContextUsage {
  const contextWindow = normalizeNonNegativeNumber(input.contextWindow);
  const reportedContextTokens = normalizeNonNegativeNumber(input.reportedContextTokens);

  if (
    contextWindow > 0
    && typeof input.contextUsageRatio === 'number'
    && Number.isFinite(input.contextUsageRatio)
  ) {
    const ratio = Math.min(1, Math.max(0, input.contextUsageRatio));
    return {
      contextTokens: Math.round(contextWindow * ratio),
      percentage: Math.round(ratio * 100),
    };
  }

  return reportedContextTokens > 0
    ? {
      contextTokens: reportedContextTokens,
      percentage: calculatePercentage(reportedContextTokens, contextWindow),
    }
    : { contextTokens: 0, percentage: 0 };
}

function calculatePercentage(contextTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : 0;
}

function normalizeNonNegativeNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
