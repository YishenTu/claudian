export interface OpencodeProviderState {
  databasePath?: string;
}

export function getOpencodeState(
  providerState?: Record<string, unknown>,
): OpencodeProviderState {
  return (providerState ?? {});
}
