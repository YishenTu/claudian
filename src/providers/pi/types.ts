export interface PiForkSource {
  resumeAt: string;
  sessionId: string;
}

export interface PiProviderState {
  forkSource?: PiForkSource;
  forkSourceSessionFile?: string;
  leafEntryId?: string;
  parentSession?: string;
  sessionFile?: string;
  sessionId?: string;
}

export function getPiState(value: unknown): PiProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const forkSource = getPiForkSource(record.forkSource);
  return {
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
    ...(state.forkSource ? { forkSource: state.forkSource } : {}),
    ...(state.forkSourceSessionFile ? { forkSourceSessionFile: state.forkSourceSessionFile } : {}),
    ...(state.leafEntryId ? { leafEntryId: state.leafEntryId } : {}),
    ...(state.parentSession ? { parentSession: state.parentSession } : {}),
    ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
  };

  return Object.keys(persisted).length > 0 ? persisted : undefined;
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
