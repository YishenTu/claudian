import type { Conversation } from '../../core/types';

export interface PiForkSource {
  resumeAt: string;
  sessionId: string;
}

export interface PiPreviousSession {
  leafEntryId?: string;
  sessionFile?: string;
  sessionId?: string;
}

export interface PiProviderState {
  treeCursor?: PiTreeCursor;
  treeSelections?: Record<string, PiTreeCursor>;
  forkSource?: PiForkSource;
  forkSourceSessionFile?: string;
  leafEntryId?: string;
  parentSession?: string;
  previousSessions?: PiPreviousSession[];
  sessionFile?: string;
  sessionId?: string;
}

export interface PiTreeCursor {
  targetId: string;
  leafId: string | null;
  /** Last append observed when this cursor was selected, including other branches. */
  appendId?: string;
}

function getTreeCursor(value: unknown): PiTreeCursor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.targetId === 'string' && record.targetId.length > 0
    && (record.leafId === null || (typeof record.leafId === 'string' && record.leafId.length > 0))
    ? { targetId: record.targetId, leafId: record.leafId,
      ...(typeof record.appendId === 'string' ? { appendId: record.appendId } : {}) } : undefined;
}

export function getPiState(value: unknown): PiProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const forkSource = getPiForkSource(record.forkSource);
  const previousSessions = getPiPreviousSessions(record.previousSessions);
  const treeCursor = getTreeCursor(record.treeCursor);
  const treeSelections = record.treeSelections && typeof record.treeSelections === 'object'
    ? Object.fromEntries(Object.entries(record.treeSelections).flatMap(([id, value]) => {
      const cursor = getTreeCursor(value);
      return cursor ? [[id, cursor]] : [];
    })) : undefined;
  return {
    ...(treeCursor ? { treeCursor } : {}),
    ...(treeSelections ? { treeSelections } : {}),
    ...(forkSource ? { forkSource } : {}),
    ...(typeof record.forkSourceSessionFile === 'string' && record.forkSourceSessionFile.trim()
      ? { forkSourceSessionFile: record.forkSourceSessionFile.trim() }
      : {}),
    ...(typeof record.leafEntryId === 'string' && record.leafEntryId.trim()
      ? { leafEntryId: record.leafEntryId.trim() }
      : {}),
    ...(typeof record.parentSession === 'string' && record.parentSession.trim()
      ? { parentSession: record.parentSession.trim() }
      : {}),
    ...(previousSessions.length > 0 ? { previousSessions } : {}),
    ...(typeof record.sessionFile === 'string' && record.sessionFile.trim()
      ? { sessionFile: record.sessionFile.trim() }
      : {}),
    ...(typeof record.sessionId === 'string' && record.sessionId.trim()
      ? { sessionId: record.sessionId.trim() }
      : {}),
  };
}

export function buildPersistedPiState(state: PiProviderState): PiProviderState | undefined {
  const persisted: PiProviderState = {
    ...(state.treeCursor ? { treeCursor: state.treeCursor } : {}),
    ...(state.treeSelections ? { treeSelections: state.treeSelections } : {}),
    ...(state.forkSource ? { forkSource: state.forkSource } : {}),
    ...(state.forkSourceSessionFile ? { forkSourceSessionFile: state.forkSourceSessionFile } : {}),
    ...(state.leafEntryId ? { leafEntryId: state.leafEntryId } : {}),
    ...(state.parentSession ? { parentSession: state.parentSession } : {}),
    ...(state.previousSessions && state.previousSessions.length > 0
      ? { previousSessions: state.previousSessions.map(session => ({ ...session })) }
      : {}),
    ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
  };

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

export function clearPiResumeState(conversation: Pick<Conversation, 'sessionId' | 'providerState'>): boolean {
  const state = getPiState(conversation.providerState);
  const hasResumeState = conversation.sessionId != null
    || !!state.sessionId
    || !!state.sessionFile
    || !!state.forkSource;
  if (!hasResumeState) {
    return false;
  }

  const currentSession = state.forkSource && !state.sessionId && !state.sessionFile
    ? {
      leafEntryId: state.forkSource.resumeAt,
      sessionFile: state.forkSourceSessionFile,
      sessionId: state.forkSource.sessionId,
    }
    : {
      leafEntryId: state.leafEntryId,
      sessionFile: state.sessionFile,
      sessionId: state.sessionId ?? conversation.sessionId ?? undefined,
    };
  const previousSessions = addPiPreviousSession(
    state.previousSessions,
    currentSession,
  );

  const providerState = { ...(conversation.providerState ?? {}) };
  delete providerState.forkSource;
  delete providerState.forkSourceSessionFile;
  delete providerState.leafEntryId;
  delete providerState.treeCursor;
  delete providerState.treeSelections;
  delete providerState.parentSession;
  delete providerState.sessionFile;
  delete providerState.sessionId;
  if (previousSessions.length > 0) {
    providerState.previousSessions = previousSessions;
  } else {
    delete providerState.previousSessions;
  }

  conversation.sessionId = null;
  conversation.providerState = Object.keys(providerState).length > 0
    ? providerState
    : undefined;
  return true;
}

function getPiForkSource(value: unknown): PiForkSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  const resumeAt = typeof record.resumeAt === 'string' ? record.resumeAt.trim() : '';
  return sessionId && resumeAt ? { resumeAt, sessionId } : undefined;
}

function getPiPreviousSessions(value: unknown): PiPreviousSession[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): PiPreviousSession[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const sessionFile = getNonEmptyString(record.sessionFile);
    const sessionId = getNonEmptyString(record.sessionId);
    if (!sessionFile && !sessionId) {
      return [];
    }
    const leafEntryId = getNonEmptyString(record.leafEntryId);
    return [{
      ...(leafEntryId ? { leafEntryId } : {}),
      ...(sessionFile ? { sessionFile } : {}),
      ...(sessionId ? { sessionId } : {}),
    }];
  });
}

export function addPiPreviousSession(
  sessions: readonly PiPreviousSession[] | undefined,
  candidate: PiPreviousSession,
): PiPreviousSession[] {
  const nextSessions = (sessions ?? []).map(session => ({ ...session }));
  if (!candidate.sessionFile && !candidate.sessionId) {
    return nextSessions;
  }
  if (nextSessions.some(session => (
    session.leafEntryId === candidate.leafEntryId
    && session.sessionFile === candidate.sessionFile
    && session.sessionId === candidate.sessionId
  ))) {
    return nextSessions;
  }
  nextSessions.push({
    ...(candidate.leafEntryId ? { leafEntryId: candidate.leafEntryId } : {}),
    ...(candidate.sessionFile ? { sessionFile: candidate.sessionFile } : {}),
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
  });
  return nextSessions;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}
