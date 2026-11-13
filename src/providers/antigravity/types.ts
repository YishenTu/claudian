export interface AntigravityProviderState {
  /** Recovery-only locator of a retired native session; never a resume seed. */
  historySessionId?: string;
  /** False until a new native session accepts its first prompt; until then history is replayed inline. */
  nativeConversationContextEstablished?: boolean;
}

export const ANTIGRAVITY_PROVIDER_STATE_KEYS = ['historySessionId', 'nativeConversationContextEstablished'] as const;

export function parseAntigravityProviderState(value: unknown): AntigravityProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.historySessionId === 'string' && record.historySessionId.trim()
      ? { historySessionId: record.historySessionId.trim() }
      : {}),
    ...(typeof record.nativeConversationContextEstablished === 'boolean'
      ? { nativeConversationContextEstablished: record.nativeConversationContextEstablished }
      : {}),
  };
}

export function buildPersistedAntigravityProviderState(
  state: AntigravityProviderState,
): AntigravityProviderState | undefined {
  const persisted = parseAntigravityProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}
