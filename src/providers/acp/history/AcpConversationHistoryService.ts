import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';

/**
 * ACP conversation history service (stub for MVP).
 * In a full implementation, this would hydrate history from ACP agent storage.
 */
export class AcpConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // No-op in MVP - ACP agents manage their own history
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // No-op in MVP - ACP agents manage their own history
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const providerState = conversation.providerState as Record<string, unknown> | undefined;
    return (providerState?.sessionId as string) ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    // ACP doesn't support fork in MVP
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    // ACP doesn't support fork in MVP
    return {};
  }

  buildPersistedProviderState(_conversation: Conversation): Record<string, unknown> | undefined {
    // No additional persisted state for MVP
    return undefined;
  }
}
