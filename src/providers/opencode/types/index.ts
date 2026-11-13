import type { ForkSource } from '@/core/types';

/** A retired native session that remains readable history but is never resumed. */
export interface OpencodePreviousSession {
  sessionId: string;
  databasePath?: string;
}

export interface OpencodeProviderState extends Record<string, unknown> {
  databasePath?: string;
  sessionId?: string;
  forkSource?: ForkSource;
  nativeConversationContextEstablished?: boolean;
  /** Oldest first; recovery-only history locators. */
  previousSessions?: OpencodePreviousSession[];
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
        && key !== 'sessionId'
        && key !== 'databasePath'
        && key !== 'nativeConversationContextEstablished'
        && key !== 'previousSessions'
        && value !== undefined
      ),
    ),
  ) as OpencodeProviderState;
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
  const previousSessions = getPreviousSessions(record.previousSessions);
  if (previousSessions.length > 0) parsed.previousSessions = previousSessions;
  const fork = record.forkSource;
  if (fork && typeof fork === 'object' && !Array.isArray(fork)) {
    const { sessionId, resumeAt } = fork as Record<string, unknown>;
    if (typeof sessionId === 'string' && sessionId.trim() && typeof resumeAt === 'string' && resumeAt.trim()) {
      parsed.forkSource = { sessionId, resumeAt };
    }
  }
  return parsed;
}

function getPreviousSessions(value: unknown): OpencodePreviousSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OpencodePreviousSession[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    if (!sessionId) return [];
    const databasePath = typeof record.databasePath === 'string' ? record.databasePath.trim() : '';
    return [{
      sessionId,
      ...(databasePath ? { databasePath } : {}),
    }];
  });
}
