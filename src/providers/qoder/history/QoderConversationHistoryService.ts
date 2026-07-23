import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  buildPersistedQoderProviderState,
  parseQoderProviderState,
} from '../types';

export class QoderConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(): Promise<void> {}

  async deleteConversationSession(_conversation: Conversation): Promise<void> {}

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = parseQoderProviderState(conversation?.providerState);
    return state.sessionId ?? conversation?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    return Boolean(parseQoderProviderState(conversation.providerState).forkSource);
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const state = parseQoderProviderState(sourceProviderState);
    return buildPersistedQoderProviderState({
      ...state,
      forkSource: {
        resumeAt,
        sessionId: sourceSessionId,
      },
    }) as Record<string, unknown> | undefined ?? {};
  }

  buildPersistedProviderState(conversation: Conversation): Record<string, unknown> | undefined {
    return buildPersistedQoderProviderState(
      parseQoderProviderState(conversation.providerState),
    ) as Record<string, unknown> | undefined;
  }
}
