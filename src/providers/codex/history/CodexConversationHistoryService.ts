import * as fs from 'node:fs/promises';

import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryResult,
  ProviderHistoryState,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import type { ChatMessage } from '../../../core/types';
import { encodeCodexModelSelectionId } from '../modelSelection';
import type { CodexProviderState } from '../types';
import { getCodexState } from '../types';
import {
  CODEX_HISTORY_LOOKUP_TIMEOUT_MS,
  getCodexArchivedTranscriptRoots,
  resolveCodexSessionFileHint,
  resolveCodexTranscriptRootHint,
} from './CodexHistoryPathResolver';
import {
  type CodexParsedTurn,
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFileAsync,
  parseCodexSessionFileAsync,
  parseCodexSessionRecords,
  parseCodexSessionTurns,
  readCodexSessionModel,
} from './CodexHistoryStore';
import { hydrateCodexSubagentHistory } from './CodexSubagentHistory';

async function readSessionContent(sessionFilePath: string): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    return await fs.readFile(sessionFilePath, {
      encoding: 'utf-8',
      signal: controller.signal,
    });
  } catch {
    return '';
  } finally {
    window.clearTimeout(timer);
  }
}

async function readSessionModel(
  sessionFilePath: string | null,
  resumeAtTurnId?: string,
): Promise<string | null> {
  if (!sessionFilePath) return null;
  try {
    return await readCodexSessionModel(sessionFilePath, resumeAtTurnId);
  } catch {
    return null;
  }
}

export class CodexConversationHistoryService implements ProviderConversationHistoryService {

  hasConversationModelRecoverySource(conversation: ProviderHistoryInput): boolean {
    const state = getCodexState(conversation.providerState);
    return !!(
      state.threadId
      || conversation.sessionId
      || state.sessionFilePath
      || state.forkSource?.sessionId
      || state.forkSourceSessionFilePath
    );
  }

  async recoverConversationModelSelection(
    conversation: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null> {
    const state = getCodexState(conversation.providerState);
    const isPendingFork = this.isPendingForkConversation(conversation);
    const threadId = isPendingFork
      ? state.forkSource!.sessionId
      : (state.threadId ?? conversation.sessionId);
    const persistedPath = isPendingFork
      ? state.forkSourceSessionFilePath
      : state.sessionFilePath;
    const transcriptRootPath = resolveCodexTranscriptRootHint(
      isPendingFork
        ? state.forkSourceTranscriptRootPath
          ?? deriveCodexSessionsRootFromSessionPath(persistedPath)
        : state.transcriptRootPath
          ?? deriveCodexSessionsRootFromSessionPath(persistedPath),
      pathContext,
    );
    const deadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS;
    if (!isPendingFork && state.forkSource && state.threadId) {
      const sourceSessionFile = await this.#resolveSourceSessionFile(
        state,
        pathContext,
        deadline,
      );
      if (
        !sourceSessionFile
        || !await readSessionModel(sourceSessionFile, state.forkSource.resumeAt)
      ) {
        return null;
      }
    }
    const resolvedPath = await resolveCodexSessionFileHint(
      persistedPath,
      threadId,
      pathContext,
      deadline,
    );
    const resumeAt = isPendingFork
      ? state.forkSource!.resumeAt
      : conversation.resumeAtMessageId;
    let model = await readSessionModel(resolvedPath, resumeAt);

    if (!model && threadId) {
      const archivedRoots = getCodexArchivedTranscriptRoots(
        pathContext,
        transcriptRootPath ? [transcriptRootPath] : [],
      );
      for (const archivedRoot of archivedRoots) {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (remainingMs === 0) break;
        const historicalPath = await findCodexSessionFileAsync(
          threadId,
          archivedRoot,
          remainingMs,
        );
        if (historicalPath && historicalPath !== resolvedPath) {
          model = await readSessionModel(historicalPath, resumeAt);
        }
        if (model) break;
      }
    }

    return model ? encodeCodexModelSelectionId(model) : null;
  }

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const lookupDeadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS;
    const state = getCodexState(conversation.providerState);
    const transcriptRootPath = resolveCodexTranscriptRootHint(
      state.transcriptRootPath ?? deriveCodexSessionsRootFromSessionPath(state.sessionFilePath),
      pathContext,
    );

    // Pending fork with existing in-memory messages: keep them as-is
    if (this.isPendingForkConversation(conversation) && conversation.messages.length > 0) {
      return conversation;
    }

    // Pending fork without messages: hydrate from source transcript truncated at resumeAt
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = await this.#resolveSourceSessionFile(
        state,
        pathContext,
        lookupDeadline,
      );
      if (!sourceSessionFile) return conversation;

      const turns = parseCodexSessionTurns(await readSessionContent(sourceSessionFile), state.forkSource!.resumeAt);
      const resumeAt = state.forkSource!.resumeAt;
      const truncated = this.#truncateTurnsAtCheckpoint(turns, resumeAt);
      if (!truncated) {
        return conversation;
      }
      conversation.messages = truncated.flatMap(t => t.messages);
      await this.#hydrateSubagents(conversation.messages, sourceSessionFile, state.forkSourceTranscriptRootPath, pathContext);
      return conversation;
    }

    // Established fork: source prefix + fork-only turns
    if (state.forkSource && state.threadId) {
      const sourceSessionFile = await this.#resolveSourceSessionFile(
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
        const sourceContent = parseCodexSessionRecords(await readSessionContent(sourceSessionFile));
        const sourceTurns = parseCodexSessionTurns(sourceContent);
        const forkTurns = parseCodexSessionTurns(await readSessionContent(forkSessionFile));

        const resumeAt = state.forkSource.resumeAt;
        const sourcePrefix = this.#truncateTurnsAtCheckpoint(parseCodexSessionTurns(sourceContent, resumeAt), resumeAt);
        if (!sourcePrefix) {
          return conversation;
        }
        const sourceTurnIds = new Set(sourceTurns.map(t => t.turnId).filter(Boolean));
        const forkOnlyTurns = forkTurns.filter(t => !t.turnId || !sourceTurnIds.has(t.turnId));

        const sourceMessages = sourcePrefix.flatMap(t => t.messages);
        const forkMessages = forkOnlyTurns.flatMap(t => t.messages);
        const messages = [...sourceMessages, ...forkMessages];

        if (messages.length === 0) {
          return conversation;
        }

        await this.#hydrateSubagents(sourceMessages, sourceSessionFile, state.forkSourceTranscriptRootPath, pathContext);
        await this.#hydrateSubagents(forkMessages, forkSessionFile, transcriptRootPath, pathContext);
        conversation.messages = messages;
        this.#markNativeConversationContextEstablished(conversation);
        return conversation;
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
      return conversation;
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
      return conversation;
    }

    await this.#hydrateSubagents(sdkMessages, sessionFilePath, resolvedTranscriptRootPath, pathContext);
    conversation.messages = sdkMessages;
    this.#markNativeConversationContextEstablished(conversation);
    return conversation;
  }

  async #hydrateSubagents(
    messages: ChatMessage[], sessionFilePath: string, rootHint: string | null | undefined,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const root = resolveCodexTranscriptRootHint(rootHint ?? deriveCodexSessionsRootFromSessionPath(sessionFilePath), pathContext);
    await hydrateCodexSubagentHistory(messages, [
      ...(root ? [root] : []), ...getCodexArchivedTranscriptRoots(pathContext, root ? [root] : []),
    ], Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS);
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    if (!conversation) return null;
    const state = getCodexState(conversation.providerState);
    return state.threadId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  async resolveMissingConversationSession(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>> {
    const conversation = copyProviderHistoryState(input);
    const state = getCodexState(conversation.providerState);
    const currentSessionId = state.pendingForkTarget?.threadId
      ?? state.threadId
      ?? conversation.sessionId
      ?? null;
    const liveSessionIds = [
      state.pendingForkTarget?.threadId,
      state.threadId,
      conversation.sessionId,
    ]
      .filter((value): value is string => Boolean(value));
    if (
      !missingProviderSessionId
      || !currentSessionId
      || missingProviderSessionId !== currentSessionId
      || liveSessionIds.some(sessionId => sessionId !== currentSessionId)
    ) {
      return { outcome: 'preserve' };
    }

    const providerState = { ...(conversation.providerState ?? {}) };
    delete providerState.threadId;
    delete providerState.nativeConversationContextEstablished;
    delete providerState.pendingForkTarget;
    conversation.sessionId = null;
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    return { outcome: 'reset', changes: conversation };
  }

  isPendingForkConversation(conversation: ProviderHistoryInput): boolean {
    const state = getCodexState(conversation.providerState);
    return !!state.forkSource && !state.threadId && !conversation.sessionId;
  }

  #markNativeConversationContextEstablished(
    conversation: ProviderHistoryState,
  ): void {
    const state = getCodexState(conversation.providerState);
    if (state.nativeConversationContextEstablished !== false) return;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: true,
    };
  }

  async buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
    _vaultPath?: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<Record<string, unknown>> {
    const sourceState = getCodexState(sourceProviderState);
    const sourceTranscriptRootPath = sourceState.transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(sourceState.sessionFilePath);
    const providerState: CodexProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt },
      ...(
        sourceState.workspaceDependencyToolVersion !== undefined
          ? { workspaceDependencyToolVersion: sourceState.workspaceDependencyToolVersion }
          : {}
      ),
      ...(sourceState.sessionFilePath ? { forkSourceSessionFilePath: sourceState.sessionFilePath } : {}),
      ...(
        sourceTranscriptRootPath
          ? { forkSourceTranscriptRootPath: sourceTranscriptRootPath }
          : {}
      ),
    };
    const deadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS;
    let sourcePath = await this.#resolveSourceSessionFile(providerState, pathContext, deadline);
    let turns = sourcePath ? parseCodexSessionTurns(await readSessionContent(sourcePath)) : [];
    if (turns.length === 0) {
      const trustedRoot = resolveCodexTranscriptRootHint(sourceTranscriptRootPath, pathContext);
      const roots = [
        ...(trustedRoot ? [trustedRoot] : []),
        ...getCodexArchivedTranscriptRoots(pathContext, trustedRoot ? [trustedRoot] : []),
      ];
      for (const root of roots) {
        const candidate = await findCodexSessionFileAsync(
          sourceSessionId, root, Math.max(0, deadline - Date.now()),
        );
        if (!candidate || candidate === sourcePath) continue;
        sourcePath = candidate;
        turns = parseCodexSessionTurns(await readSessionContent(candidate));
        if (turns.length > 0) break;
      }
    }
    if (!sourcePath || !turns.some(turn => turn.turnId === resumeAt)) {
      throw new Error(`Fork checkpoint not found: ${resumeAt}. Reload the source conversation and choose an available checkpoint.`);
    }
    providerState.forkSourceSessionFilePath = sourcePath;
    return providerState as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    const entries = Object.entries(getCodexState(conversation.providerState))
      .filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #resolveSourceSessionFile(
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

  #truncateTurnsAtCheckpoint(
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
