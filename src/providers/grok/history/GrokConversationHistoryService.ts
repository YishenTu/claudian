import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { buildGrokProviderState, parseGrokProviderState } from '../types';
import { resolveGrokSessionDirectory } from './GrokHistoryPathResolver';
import { loadGrokHistory } from './GrokHistoryStore';

export class GrokConversationHistoryService implements ProviderConversationHistoryService {
  private readonly hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const sessionId = conversation.sessionId;
    if (!sessionId || !pathContext) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }
    const state = parseGrokProviderState(conversation.providerState);
    const sessionDirectory = resolveGrokSessionDirectory(
      state.sessionDirectory,
      sessionId,
      vaultPath,
      pathContext,
    );
    if (sessionDirectory !== state.sessionDirectory) {
      conversation.providerState = buildGrokProviderState(sessionDirectory) as
        | Record<string, unknown>
        | undefined;
    }
    if (!sessionDirectory) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = `${sessionId}::${sessionDirectory}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }
    const parsed = await loadGrokHistory(sessionDirectory, sessionId);
    if (parsed.messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }
    conversation.messages = parsed.messages;
    this.hydratedKeys.set(conversation.id, hydrationKey);
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    // Grok-native history is read-only from Claudian.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {};
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return buildGrokProviderState(
      parseGrokProviderState(conversation.providerState).sessionDirectory,
    ) as Record<string, unknown> | undefined;
  }
}
