import type { ForkSource } from '../../../core/types/chat';

export interface CodexProviderState {
  threadId?: string;
  sessionFilePath?: string;
  forkSource?: ForkSource;
}

export function getCodexState(
  providerState?: Record<string, unknown>,
): CodexProviderState {
  return (providerState ?? {}) as CodexProviderState;
}
