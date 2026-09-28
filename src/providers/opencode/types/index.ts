import type { ForkSource } from '@/core/types';

export interface OpencodeProviderState extends Record<string, unknown> {
  databasePath?: string;
  nativeVersion?: 1 | 2;
  sessionId?: string;
  forkSource?: ForkSource;
  nativeConversationContextEstablished?: boolean;
}

export function getOpencodeState(
  providerState?: unknown,
): OpencodeProviderState {
  if (
    providerState === null
    || typeof providerState !== 'object'
    || Array.isArray(providerState)
  ) {
    return {};
  }

  const record = providerState as Record<string, unknown>;
  const parsed = Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => (
        key !== 'forkSource'
        && key !== 'nativeVersion'
        && key !== 'sessionId'
        && key !== 'databasePath'
        && key !== 'nativeConversationContextEstablished'
        && value !== undefined
      ),
    ),
  ) as OpencodeProviderState;
  if (record.nativeVersion === 1 || record.nativeVersion === 2) parsed.nativeVersion = record.nativeVersion;
  const databasePath = typeof record.databasePath === 'string'
    ? record.databasePath.trim()
    : '';
  if (databasePath) parsed.databasePath = databasePath;
  if (typeof record.nativeConversationContextEstablished === 'boolean') {
    parsed.nativeConversationContextEstablished =
      record.nativeConversationContextEstablished;
  }
  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    parsed.sessionId = record.sessionId.trim();
  }
  const fork = record.forkSource;
  if (fork && typeof fork === 'object' && !Array.isArray(fork)) {
    const { sessionId, resumeAt } = fork as Record<string, unknown>;
    if (typeof sessionId === 'string' && sessionId.trim() && typeof resumeAt === 'string' && resumeAt.trim()) {
      parsed.forkSource = { sessionId, resumeAt };
    }
  }
  return parsed;
}
