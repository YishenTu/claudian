import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { buildPersistedOctoAgentState, getOctoAgentState } from '../types';

export class OctoAgentConversationHistoryService implements ProviderConversationHistoryService {
  // octo-agent stores conversation history on the server. Claudian keeps the
  // session id in Conversation.providerState; the runtime re-subscribes to the
  // session and continues from there. We do not eagerly hydrate the full history
  // because the server is the source of truth and the client is owned by the runtime.
  async hydrateConversationHistory(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // No-op: history is server-resident and recovered through session continuity.
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // octo-agent session deletion is not exposed through the public API yet.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = getOctoAgentState(conversation?.providerState);
    return state.sessionId ?? conversation?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getOctoAgentState(conversation.providerState);
    return !!state.sessionId && !conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return buildPersistedOctoAgentState({ sessionId: sourceSessionId }) ?? {};
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return buildPersistedOctoAgentState(getOctoAgentState(conversation.providerState));
  }
}
