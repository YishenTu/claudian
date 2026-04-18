import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';

export interface OpencodeProviderState {
  sessionId?: string;
  forkSource?: { sessionId: string; resumeAt: string };
  transcriptRootPath?: string;
}

function getOpencodeState(providerState: Record<string, unknown> | undefined): OpencodeProviderState {
  return (providerState ?? {}) as OpencodeProviderState;
}

export class OpencodeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationIds = new Set<string>();

  async hydrateConversationHistory(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;

    const state = getOpencodeState(conversation.providerState);

    if (state.forkSource && !state.sessionId) {
      return state.forkSource.sessionId;
    }

    return state.sessionId ?? conversation.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getOpencodeState(conversation.providerState);
    return !!state.forkSource && !state.sessionId && !conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      forkSource: {
        sessionId: sourceSessionId,
        resumeAt,
      },
    };
  }

  buildPersistedProviderState(conversation: Conversation): Record<string, unknown> | undefined {
    const state = getOpencodeState(conversation.providerState);
    const entries = Object.entries(state).filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
}
