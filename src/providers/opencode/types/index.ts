import type { Conversation, ForkSource } from '@/core/types';

/** A retired native session that remains readable history but is never resumed. */
export interface OpencodePreviousSession {
  sessionId: string;
  databasePath?: string;
  nativeVersion?: 1 | 2;
}

export interface OpencodeProviderState extends Record<string, unknown> {
  databasePath?: string;
  nativeVersion?: 1 | 2;
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
        && key !== 'nativeVersion'
        && key !== 'sessionId'
        && key !== 'databasePath'
        && key !== 'nativeConversationContextEstablished'
        && key !== 'previousSessions'
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

/**
 * Retires the live native binding into history-only state. The next send starts
 * a fresh native session and replays Claudian history into it.
 */
export function clearOpencodeResumeState(
  conversation: Pick<Conversation, 'sessionId' | 'providerState'>,
  options: { releaseDatabase: boolean },
): boolean {
  const state = getOpencodeState(conversation.providerState);
  const sessionId = conversation.sessionId ?? state.sessionId;
  const releasesDatabase = options.releaseDatabase
    && (!!state.databasePath || !!state.nativeVersion);
  if (!sessionId && !state.forkSource && !releasesDatabase) return false;

  const previousSessions = [...(state.previousSessions ?? [])];
  // In-memory sessions leave no history to read.
  if (sessionId && state.databasePath !== ':memory:' && !previousSessions.some(previous => (
    previous.sessionId === sessionId && previous.databasePath === state.databasePath
  ))) {
    previousSessions.push({
      sessionId,
      ...(state.databasePath ? { databasePath: state.databasePath } : {}),
      ...(state.nativeVersion ? { nativeVersion: state.nativeVersion } : {}),
    });
  }

  const providerState: Record<string, unknown> = {
    ...conversation.providerState,
    nativeConversationContextEstablished: false,
  };
  delete providerState.sessionId;
  delete providerState.forkSource;
  if (options.releaseDatabase) {
    delete providerState.databasePath;
    delete providerState.nativeVersion;
  }
  if (previousSessions.length > 0) providerState.previousSessions = previousSessions;
  else delete providerState.previousSessions;
  conversation.sessionId = null;
  conversation.providerState = providerState;
  return true;
}

function getPreviousSessions(value: unknown): OpencodePreviousSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OpencodePreviousSession[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    if (!sessionId) return [];
    const databasePath = typeof record.databasePath === 'string' ? record.databasePath.trim() : '';
    const nativeVersion = record.nativeVersion === 1 || record.nativeVersion === 2
      ? record.nativeVersion
      : undefined;
    return [{
      sessionId,
      ...(databasePath ? { databasePath } : {}),
      ...(nativeVersion ? { nativeVersion } : {}),
    }];
  });
}
