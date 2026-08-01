export interface OpencodeProviderState extends Record<string, unknown> {
  databasePath?: string;
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
      ([key, value]) => key !== 'databasePath' && value !== undefined,
    ),
  ) as OpencodeProviderState;
  const databasePath = typeof record.databasePath === 'string'
    ? record.databasePath.trim()
    : '';
  if (databasePath) parsed.databasePath = databasePath;
  return parsed;
}
