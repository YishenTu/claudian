import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  buildPersistedGrokProviderState,
  parseGrokProviderState,
} from '../types';
import { resolveGrokSessionDirectory } from './GrokHistoryPathResolver';
import { loadGrokHistory } from './GrokHistoryStore';

export class GrokConversationHistoryService implements ProviderConversationHistoryService {
  private readonly hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = parseGrokProviderState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      if (!pathContext) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }
      const forkSource = state.forkSource!;
      const sourceSessionDirectory = resolveGrokSessionDirectory(
        state.forkSourceSessionDirectory,
        forkSource.sessionId,
        vaultPath,
        pathContext,
      );
      if (sourceSessionDirectory !== state.forkSourceSessionDirectory) {
        conversation.providerState = buildPersistedGrokProviderState({
          ...state,
          forkSourceSessionDirectory: sourceSessionDirectory ?? undefined,
        }) as Record<string, unknown> | undefined;
      }
      if (conversation.messages.length > 0) return;
      if (!sourceSessionDirectory) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }
      const hydrationKey = `fork::${sourceSessionDirectory}::${forkSource.resumeAt}`;
      const parsed = await loadGrokHistory(sourceSessionDirectory, forkSource.sessionId);
      const checkpointIndex = parsed.messages.findIndex(message => (
        message.role === 'assistant' && message.assistantMessageId === forkSource.resumeAt
      ));
      if (checkpointIndex < 0) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }
      conversation.messages = parsed.messages.slice(0, checkpointIndex + 1);
      this.hydratedKeys.set(conversation.id, hydrationKey);
      return;
    }

    const sessionId = conversation.sessionId;
    if (!sessionId || !pathContext) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }
    const sessionDirectory = resolveGrokSessionDirectory(
      state.sessionDirectory,
      sessionId,
      vaultPath,
      pathContext,
    );
    if (sessionDirectory !== state.sessionDirectory) {
      conversation.providerState = buildPersistedGrokProviderState({
        ...state,
        sessionDirectory: sessionDirectory ?? undefined,
      }) as Record<string, unknown> | undefined;
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
    const state = parseGrokProviderState(conversation?.providerState);
    return conversation?.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = parseGrokProviderState(conversation.providerState);
    return Boolean(state.forkSource && !conversation.sessionId);
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = parseGrokProviderState(sourceProviderState);
    return (buildPersistedGrokProviderState({
      forkSource: { resumeAt, sessionId: sourceSessionId },
      ...(sourceState.sessionDirectory || sourceState.forkSourceSessionDirectory
        ? {
          forkSourceSessionDirectory: sourceState.sessionDirectory
            ?? sourceState.forkSourceSessionDirectory,
        }
        : {}),
    }) as Record<string, unknown> | undefined) ?? {};
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return buildPersistedGrokProviderState(
      parseGrokProviderState(conversation.providerState),
    ) as Record<string, unknown> | undefined;
  }
}
