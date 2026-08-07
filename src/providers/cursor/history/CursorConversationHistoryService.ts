import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '@/core/providers/types';
import type { Conversation } from '@/core/types';

import { loadCursorSessionMessages } from './CursorHistoryStore';

export class CursorConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
    context?: ProviderHistoryPathContext,
  ): Promise<void> {
    // Cursor keeps ACP transcripts in its local session store. Read them without
    // mutating the provider-owned database so persisted Oh My Claudian conversations
    // can be restored after reopening the vault.
    if (!conversation.sessionId || conversation.messages.length > 0) return;
    const messages = await loadCursorSessionMessages(conversation.sessionId, context);
    if (messages.length > 0) conversation.messages = messages;
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    return {};
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return conversation.providerState;
  }
}
