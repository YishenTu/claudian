import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';

export class CodeBuddyConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(_conversation: Conversation, _vaultPath: string | null): Promise<void> {}

  async deleteConversationSession(_conversation: Conversation, _vaultPath: string | null): Promise<void> {}

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(_sourceSessionId: string, _resumeAt: string): Record<string, unknown> {
    return {};
  }
}
