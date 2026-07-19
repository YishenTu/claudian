export interface KimiProviderState {
  sessionId?: string;
  /**
   * Absolute Kimi home used when the session was created/updated.
   * Ensures history hydration matches the runtime even when KIMI_CODE_HOME is
   * only set in Claudian provider environment variables.
   */
  kimiCodeHome?: string;
}

export function getKimiState(
  providerState?: Record<string, unknown>,
): KimiProviderState {
  if (!providerState || typeof providerState !== 'object') {
    return {};
  }

  const sessionId = typeof providerState.sessionId === 'string' && providerState.sessionId.trim()
    ? providerState.sessionId.trim()
    : undefined;
  const kimiCodeHome = typeof providerState.kimiCodeHome === 'string'
    && providerState.kimiCodeHome.trim()
    ? providerState.kimiCodeHome.trim()
    : undefined;

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(kimiCodeHome ? { kimiCodeHome } : {}),
  };
}

export function resolveKimiSessionId(
  conversation: {
    sessionId?: string | null;
    providerState?: Record<string, unknown>;
  } | null | undefined,
): string | null {
  if (!conversation) {
    return null;
  }

  if (typeof conversation.sessionId === 'string' && conversation.sessionId.trim()) {
    return conversation.sessionId.trim();
  }

  return getKimiState(conversation.providerState).sessionId ?? null;
}
