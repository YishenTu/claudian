import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import type { CodexProviderState } from '../types';
import { getCodexState } from '../types';
import {
  type CodexParsedTurn,
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFile,
  parseCodexSessionFile,
  parseCodexSessionTurns,
} from './CodexHistoryStore';

function readSessionTurns(sessionFilePath: string): CodexParsedTurn[] {
  let content: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    content = require('fs').readFileSync(sessionFilePath, 'utf-8');
  } catch {
    return [];
  }
  return parseCodexSessionTurns(content);
}

export class CodexConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationPaths = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    const state = getCodexState(conversation.providerState);
    const transcriptRootPath = state.transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(state.sessionFilePath);

    // Pending fork with existing in-memory messages: keep them as-is
    if (this.isPendingForkConversation(conversation) && conversation.messages.length > 0) {
      return;
    }

    // Pending fork without messages: hydrate from source transcript truncated at resumeAt
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = this.resolveSourceSessionFile(state);
      if (!sourceSessionFile) return;

      const turns = readSessionTurns(sourceSessionFile);
      const resumeAt = state.forkSource!.resumeAt;
      const truncated = this.truncateTurnsAtCheckpoint(turns, resumeAt);
      if (!truncated) {
        this.hydratedConversationPaths.delete(conversation.id);
        return;
      }
      conversation.messages = truncated.flatMap(t => t.messages);
      return;
    }

    // Established fork: source prefix + fork-only turns
    if (state.forkSource && state.threadId) {
      const sourceSessionFile = this.resolveSourceSessionFile(state);
      const forkSessionFile = state.sessionFilePath ?? (
        state.threadId
          ? findCodexSessionFile(state.threadId, transcriptRootPath ?? undefined)
          : null
      );

      if (sourceSessionFile && forkSessionFile) {
        const sourceTurns = readSessionTurns(sourceSessionFile);
        const forkTurns = readSessionTurns(forkSessionFile);

        const resumeAt = state.forkSource.resumeAt;
        const sourcePrefix = this.truncateTurnsAtCheckpoint(sourceTurns, resumeAt);
        if (!sourcePrefix) {
          this.hydratedConversationPaths.delete(conversation.id);
          return;
        }
        const sourceTurnIds = new Set(sourceTurns.map(t => t.turnId).filter(Boolean));
        const forkOnlyTurns = forkTurns.filter(t => !t.turnId || !sourceTurnIds.has(t.turnId));

        const messages = [
          ...sourcePrefix.flatMap(t => t.messages),
          ...forkOnlyTurns.flatMap(t => t.messages),
        ];

        if (messages.length === 0) {
          this.hydratedConversationPaths.delete(conversation.id);
          return;
        }

        conversation.messages = messages;
        this.hydratedConversationPaths.set(conversation.id, `fork::${state.threadId}`);
        return;
      }
    }

    // Normal hydration
    const threadId = state.threadId ?? conversation.sessionId ?? null;
    const sessionFilePath = state.sessionFilePath ?? (
      threadId
        ? findCodexSessionFile(threadId, transcriptRootPath ?? undefined)
        : null
    );
    const resolvedTranscriptRootPath = transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(sessionFilePath);

    if (!sessionFilePath) {
      this.hydratedConversationPaths.delete(conversation.id);
      return;
    }

    const hydrationKey = `${threadId ?? ''}::${sessionFilePath}`;
    if (
      conversation.messages.length > 0
      && this.hydratedConversationPaths.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    if (sessionFilePath !== state.sessionFilePath) {
      conversation.providerState = {
        ...(conversation.providerState ?? {}),
        ...(threadId ? { threadId } : {}),
        sessionFilePath,
        ...(resolvedTranscriptRootPath ? { transcriptRootPath: resolvedTranscriptRootPath } : {}),
      };
    } else if (resolvedTranscriptRootPath && resolvedTranscriptRootPath !== state.transcriptRootPath) {
      conversation.providerState = {
        ...(conversation.providerState ?? {}),
        ...(threadId ? { threadId } : {}),
        transcriptRootPath: resolvedTranscriptRootPath,
      };
    }

    const sdkMessages = parseCodexSessionFile(sessionFilePath);
    if (sdkMessages.length === 0) {
      this.hydratedConversationPaths.delete(conversation.id);
      return;
    }

    conversation.messages = sdkMessages;
    this.hydratedConversationPaths.set(conversation.id, hydrationKey);
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
    return state.threadId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getCodexState(conversation.providerState);
    return !!state.forkSource && !state.threadId && !conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = getCodexState(sourceProviderState);
    const sourceTranscriptRootPath = sourceState.transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(sourceState.sessionFilePath);
    const providerState: CodexProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt },
      ...(sourceState.sessionFilePath ? { forkSourceSessionFilePath: sourceState.sessionFilePath } : {}),
      ...(
        sourceTranscriptRootPath
          ? { forkSourceTranscriptRootPath: sourceTranscriptRootPath }
          : {}
      ),
    };
    return providerState as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const entries = Object.entries(getCodexState(conversation.providerState))
      .filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveSourceSessionFile(state: CodexProviderState): string | null {
    if (!state.forkSource) return null;
    const sourceTranscriptRootPath = state.forkSourceTranscriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(state.forkSourceSessionFilePath);
    return state.forkSourceSessionFilePath
      ?? findCodexSessionFile(state.forkSource.sessionId, sourceTranscriptRootPath ?? undefined);
  }

  private truncateTurnsAtCheckpoint(
    turns: CodexParsedTurn[],
    resumeAt: string,
  ): CodexParsedTurn[] | null {
    const checkpointIndex = turns.findIndex(turn => turn.turnId === resumeAt);
    if (checkpointIndex < 0) {
      return null;
    }

    return turns.slice(0, checkpointIndex + 1);
  }
}
