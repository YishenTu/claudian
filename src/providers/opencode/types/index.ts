export interface OpencodeProviderState extends Record<string, unknown> {
  databasePath?: string;
  nativeVersion?: 1 | 2;
  sessionId?: string;
  nativeConversationContextEstablished?: boolean;
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
        key !== 'nativeVersion'
        && key !== 'sessionId'
        && key !== 'databasePath'
        && key !== 'nativeConversationContextEstablished'
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
  return parsed;
}
