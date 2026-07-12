import * as fs from 'node:fs/promises';

import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import type { CodexProviderState } from '../types';
import { getCodexState } from '../types';
import {
  CODEX_HISTORY_LOOKUP_TIMEOUT_MS,
  resolveCodexSessionFileHint,
  resolveCodexTranscriptRootHint,
} from './CodexHistoryPathResolver';
import {
  type CodexParsedTurn,
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFileAsync,
  parseCodexSessionFileAsync,
  parseCodexSessionTurns,
} from './CodexHistoryStore';

async function readSessionTurns(sessionFilePath: string): Promise<CodexParsedTurn[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const content = await fs.readFile(sessionFilePath, {
      encoding: 'utf-8',
      signal: controller.signal,
    });
    return parseCodexSessionTurns(content);
  } catch {
    return [];
  } finally {
    window.clearTimeout(timer);
  }
}

export class CodexConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationPaths = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const lookupDeadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS;
    const state = getCodexState(conversation.providerState);
    const transcriptRootPath = resolveCodexTranscriptRootHint(
      state.transcriptRootPath ?? deriveCodexSessionsRootFromSessionPath(state.sessionFilePath),
      pathContext,
    );

    // Pending fork with existing in-memory messages: keep them as-is
    if (this.isPendingForkConversation(conversation) && conversation.messages.length > 0) {
      return;
    }

    // Pending fork without messages: hydrate from source transcript truncated at resumeAt
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = await this.resolveSourceSessionFile(
        state,
        pathContext,
        lookupDeadline,
      );
      if (!sourceSessionFile) return;

      const turns = await readSessionTurns(sourceSessionFile);
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
      const sourceSessionFile = await this.resolveSourceSessionFile(
        state,
        pathContext,
        lookupDeadline,
      );
      const forkSessionFile = await resolveCodexSessionFileHint(
        state.sessionFilePath,
        state.threadId,
        pathContext,
        lookupDeadline,
      ) ?? (state.threadId && transcriptRootPath
        ? await findCodexSessionFileAsync(
            state.threadId,
            transcriptRootPath,
            Math.max(0, lookupDeadline - Date.now()),
          )
        : null);

      if (sourceSessionFile && forkSessionFile) {
        const sourceTurns = await readSessionTurns(sourceSessionFile);
        const forkTurns = await readSessionTurns(forkSessionFile);

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
    const sessionFilePath = await resolveCodexSessionFileHint(
      state.sessionFilePath,
      threadId,
      pathContext,
      lookupDeadline,
    ) ?? (threadId && transcriptRootPath
      ? await findCodexSessionFileAsync(
          threadId,
          transcriptRootPath,
          Math.max(0, lookupDeadline - Date.now()),
        )
      : null);
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

    const sdkMessages = await parseCodexSessionFileAsync(sessionFilePath);
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

  private async resolveSourceSessionFile(
    state: CodexProviderState,
    pathContext?: ProviderHistoryPathContext,
    lookupDeadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS,
  ): Promise<string | null> {
    if (!state.forkSource) return null;
    const sourceTranscriptRootPath = resolveCodexTranscriptRootHint(
      state.forkSourceTranscriptRootPath
        ?? deriveCodexSessionsRootFromSessionPath(state.forkSourceSessionFilePath),
      pathContext,
    );
    return await resolveCodexSessionFileHint(
      state.forkSourceSessionFilePath,
      state.forkSource.sessionId,
      pathContext,
      lookupDeadline,
    ) ?? (sourceTranscriptRootPath
      ? findCodexSessionFileAsync(
          state.forkSource.sessionId,
          sourceTranscriptRootPath,
          Math.max(0, lookupDeadline - Date.now()),
        )
      : null);
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
