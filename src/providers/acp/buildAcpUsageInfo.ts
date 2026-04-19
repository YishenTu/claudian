import type { UsageInfo } from '../../core/types';
import type { AcpUsage, AcpUsageUpdate } from './types';

export interface BuildAcpUsageInfoParams {
  contextWindow?: AcpUsageUpdate | null;
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
  const contextWindowSize = contextWindow?.size ?? 0;

  return {
    cacheCreationInputTokens: promptUsage?.cachedWriteTokens ?? 0,
    cacheReadInputTokens: promptUsage?.cachedReadTokens ?? 0,
    contextTokens,
    contextWindow: contextWindowSize,
    contextWindowIsAuthoritative: Boolean(contextWindow),
    inputTokens: promptUsage?.inputTokens ?? 0,
    model: params.model,
    percentage: contextWindowSize > 0
      ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindowSize) * 100)))
      : 0,
  };
}
