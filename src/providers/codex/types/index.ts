import type { ForkSource } from '../../../core/types/chat';

export interface CodexPendingForkTarget {
  threadId: string;
  sessionFilePath?: string;
}

export interface CodexProviderState {
  threadId?: string;
  nativeConversationContextEstablished?: boolean;
  sessionFilePath?: string;
  transcriptRootPath?: string;
  forkSourceSessionFilePath?: string;
  forkSourceTranscriptRootPath?: string;
  forkSource?: ForkSource;
  pendingForkTarget?: CodexPendingForkTarget;
  workspaceDependencyToolVersion?: number;
}

export function getCodexState(
  providerState?: Record<string, unknown>,
): CodexProviderState {
  return (providerState ?? {});
}
