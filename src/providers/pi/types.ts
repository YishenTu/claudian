export interface PiProviderState {
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
  return {
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
    ...(state.leafEntryId ? { leafEntryId: state.leafEntryId } : {}),
    ...(state.parentSession ? { parentSession: state.parentSession } : {}),
    ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
  };

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}
