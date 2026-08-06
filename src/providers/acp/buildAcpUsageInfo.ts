import type { UsageInfo } from '../../core/types';
import type { AcpUsage, AcpUsageUpdate } from './types';

export interface BuildAcpUsageInfoParams {
  contextWindow?: AcpUsageUpdate | null;
  fallbackContextWindow?: number;
  model?: string;
  promptUsage?: AcpUsage | null;
}

export function buildAcpUsageInfo(params: BuildAcpUsageInfoParams): UsageInfo | null {
  const promptUsage = params.promptUsage ?? null;
  const contextWindow = params.contextWindow ?? null;

  if (!promptUsage && !contextWindow) {
    return null;
  }

  const contextTokens = contextWindow?.used ?? promptUsage?.totalTokens ?? 0;
  const contextWindowSize = contextWindow?.size ?? params.fallbackContextWindow ?? 0;

  return {
    cacheCreationInputTokens: promptUsage?.cachedWriteTokens ?? 0,
    cacheReadInputTokens: promptUsage?.cachedReadTokens ?? 0,
    contextTokens,
    contextWindow: contextWindowSize,
    // Only the contextWindow update speaks authoritatively about window size; falling back
    // to promptUsage alone is a best-effort approximation.
    contextWindowIsAuthoritative: Boolean(contextWindow),
    inputTokens: promptUsage?.inputTokens ?? 0,
    model: params.model,
    percentage: computePercentage(contextTokens, contextWindowSize),
  };
}

function computePercentage(used: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  const ratio = Math.round((used / total) * 100);
  return Math.min(100, Math.max(0, ratio));
}
