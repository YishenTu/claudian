export interface GeminiProviderState {
  databasePath?: string;
}

export function getGeminiState(
  providerState?: Record<string, unknown>,
): GeminiProviderState {
  return (providerState ?? {}) as GeminiProviderState;
}
