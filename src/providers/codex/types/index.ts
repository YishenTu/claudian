export interface CodexProviderState {
  threadId?: string;
  sessionFilePath?: string;
}

export function getCodexState(
  providerState?: Record<string, unknown>,
): CodexProviderState {
  return (providerState ?? {}) as CodexProviderState;
}
