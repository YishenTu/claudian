import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getCodexState } from '../types';
import { findCodexSessionFile, parseCodexSessionFile } from './CodexHistoryStore';

export class CodexConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationIds = new Set<string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    if (this.hydratedConversationIds.has(conversation.id)) {
      return;
    }

    const state = getCodexState(conversation.providerState);
    const threadId = state.threadId ?? conversation.sessionId ?? null;
    const sessionFilePath = state.sessionFilePath ?? (threadId ? findCodexSessionFile(threadId) : null);

    if (!sessionFilePath) {
      return;
    }

    if (sessionFilePath !== state.sessionFilePath) {
      conversation.providerState = {
        ...(conversation.providerState ?? {}),
        ...(threadId ? { threadId } : {}),
        sessionFilePath,
      };
    }

    const sdkMessages = parseCodexSessionFile(sessionFilePath);
    if (sdkMessages.length > 0) {
      conversation.messages = sdkMessages;
    }

    this.hydratedConversationIds.add(conversation.id);
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // Never delete ~/.codex transcripts
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getCodexState(conversation.providerState);
    return state.threadId ?? conversation.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
  ): Record<string, unknown> {
    return {};
  }
}
