export interface OctoAgentProviderState {
  sessionId?: string;
}

export function getOctoAgentState(
  providerState: Record<string, unknown> | undefined,
): OctoAgentProviderState {
  if (!providerState || typeof providerState !== 'object' || Array.isArray(providerState)) {
    return {};
  }

  const state = providerState as OctoAgentProviderState;
  return {
    sessionId: typeof state.sessionId === 'string' ? state.sessionId : undefined,
  };
}

export function buildPersistedOctoAgentState(
  state: OctoAgentProviderState,
): Record<string, unknown> | undefined {
  if (!state.sessionId) {
    return undefined;
  }
  return { sessionId: state.sessionId } as Record<string, unknown>;
}
