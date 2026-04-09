import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';

export class OpenCodeConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null
  ): Promise<void> {
    // OpenCode sessions are managed by the ACP protocol
    // No local history hydration needed - the session state is maintained by OpenCode
    if (!vaultPath) return;
    
    // Could load session history from OpenCode's storage if needed
    // ~/.opencode/sessions/ or similar
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null
  ): Promise<void> {
    if (!vaultPath || !conversation.sessionId) return;
    
    // Clean up OpenCode session if needed
    // OpenCode manages its own session lifecycle
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId || null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>
  ): Record<string, unknown> {
    return {};
  }
}
