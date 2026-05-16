export interface CursorProviderState {
  threadId?: string;
}

export function getCursorState(
  providerState?: Record<string, unknown>,
): CursorProviderState {
  return (providerState ?? {}) as CursorProviderState;
}
