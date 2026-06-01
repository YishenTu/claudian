import type { UsageInfo } from '../../../core/types';

export function buildPiUsageInfo(
  response: unknown,
  model: string | null,
  fallbackContextWindow = 200_000,
): UsageInfo | null {
  const stats = getRecord(response);
  const contextUsage = getRecord(stats.contextUsage ?? stats.context_usage ?? stats);
  const providerContextWindow = getNumber(contextUsage.contextWindow)
    ?? getNumber(contextUsage.context_window)
    ?? getNumber(contextUsage.window);
  const contextWindow = providerContextWindow ?? fallbackContextWindow;
  const contextTokens = getNumber(contextUsage.contextTokens)
    ?? getNumber(contextUsage.context_tokens)
    ?? getNumber(contextUsage.tokens)
    ?? getNumber(contextUsage.used)
    ?? 0;
  const inputTokens = getNumber(contextUsage.inputTokens)
    ?? getNumber(contextUsage.input_tokens)
    ?? contextTokens;

  if (contextTokens === 0 && inputTokens === 0) {
    return null;
  }

  return {
    cacheCreationInputTokens: getNumber(contextUsage.cacheCreationInputTokens)
      ?? getNumber(contextUsage.cache_creation_input_tokens)
      ?? 0,
    cacheReadInputTokens: getNumber(contextUsage.cacheReadInputTokens)
      ?? getNumber(contextUsage.cache_read_input_tokens)
      ?? 0,
    contextTokens,
    contextWindow,
    contextWindowIsAuthoritative: providerContextWindow !== null,
    inputTokens,
    ...(model ? { model } : {}),
    percentage: normalizePiUsagePercentage(
      getNumber(contextUsage.percentage),
      contextTokens,
      contextWindow,
    ),
  };
}

function normalizePiUsagePercentage(
  providerPercentage: number | null,
  contextTokens: number,
  contextWindow: number,
): number {
  const rawPercentage = providerPercentage
    ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);
  const wholePercentage = providerPercentage !== null && rawPercentage >= 0 && rawPercentage <= 1
    ? rawPercentage * 100
    : rawPercentage;

  return Math.min(100, Math.max(0, Math.round(wholePercentage)));
}

function getRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
