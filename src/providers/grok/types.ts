export interface GrokProviderState {
  sessionId?: string;
  /**
   * Absolute Grok home used when the session was created/updated.
   * Ensures history hydration matches the runtime even when GROK_HOME is only
   * set in Claudian provider environment variables.
   */
  grokHome?: string;
}

export function getGrokState(
  providerState?: Record<string, unknown>,
): GrokProviderState {
  if (!providerState || typeof providerState !== 'object') {
    return {};
  }

  const sessionId = typeof providerState.sessionId === 'string' && providerState.sessionId.trim()
    ? providerState.sessionId.trim()
    : undefined;
  const grokHome = typeof providerState.grokHome === 'string' && providerState.grokHome.trim()
    ? providerState.grokHome.trim()
    : undefined;

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(grokHome ? { grokHome } : {}),
  };
}

export function resolveGrokSessionId(
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

  return getGrokState(conversation.providerState).sessionId ?? null;
}
