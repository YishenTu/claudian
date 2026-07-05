import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getGeminiState, type GeminiProviderState } from '../types';
import { deleteGeminiSession, loadGeminiSessionMessages } from './GeminiHistoryStore';

export class GeminiConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId || !vaultPath) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const state = getGeminiState(conversation.providerState);
    const hydrationKey = `${sessionId}`;
    
    // Simple caching check: if already loaded and key matches, skip
    if (
      conversation.messages.length > 0 &&
      this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    const messages = await loadGeminiSessionMessages(vaultPath, sessionId);
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    conversation.messages = messages;
    this.hydratedKeys.set(conversation.id, hydrationKey);
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (sessionId && vaultPath) {
      await deleteGeminiSession(vaultPath, sessionId);
    }
    this.hydratedKeys.delete(conversation.id);
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = getGeminiState(conversation?.providerState);
    return state.sessionId ?? conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false; // Forks not fully implemented for gemini yet
  }

  buildForkProviderState(
    sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return { sessionId: sourceSessionId }; // Minimal implementation
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const state = getGeminiState(conversation.providerState);
    const providerState: GeminiProviderState = {
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
    };

    return Object.keys(providerState).length > 0
      ? providerState as Record<string, unknown>
      : undefined;
  }
}
