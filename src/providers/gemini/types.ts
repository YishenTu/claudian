export interface GeminiProviderState {
  sessionId?: string;
  sessionFile?: string;
}

export function getGeminiState(value: unknown): GeminiProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.sessionFile === 'string' && record.sessionFile.trim()
      ? { sessionFile: record.sessionFile.trim() }
      : {}),
    ...(typeof record.sessionId === 'string' && record.sessionId.trim()
      ? { sessionId: record.sessionId.trim() }
      : {}),
  };
}

export function buildPersistedGeminiState(state: GeminiProviderState): GeminiProviderState | undefined {
  const persisted: GeminiProviderState = {
    ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
  };

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}
