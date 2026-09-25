import type { ACPUsage } from '../../acp';

export function parseGrokUsage(value: unknown): ACPUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = tokenCount(record.inputTokens);
  const outputTokens = tokenCount(record.outputTokens);
  const totalTokens = tokenCount(record.totalTokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return null;
  return {
    inputTokens, outputTokens, totalTokens,
    cachedReadTokens: tokenCount(record.cachedReadTokens),
    cachedWriteTokens: tokenCount(record.cachedWriteTokens),
    thoughtTokens: tokenCount(record.reasoningTokens ?? record.thoughtTokens),
  };
}

export function parseGrokPromptUsage(response: unknown): ACPUsage | null {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const metadata = record._meta;
  return parseGrokUsage(record.usage)
    ?? parseGrokUsage(metadata)
    ?? (metadata && typeof metadata === 'object'
      ? parseGrokUsage((metadata as Record<string, unknown>).usage)
      : null);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
