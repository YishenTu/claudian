import type { TurnStats } from './chat';

/** Missing or invalid native evidence must never become an estimated rate. */
export function createTurnStats(outputTokens: unknown, durationMs: unknown): TurnStats | undefined {
  if (!isTokenCount(outputTokens)
    || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  return { outputTokens, durationMs };
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
