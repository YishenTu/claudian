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
import type { CodexPreviousSegment, CodexProviderState } from '../types';
import { clearCodexResumeState, getCodexState } from '../types';
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
  parseCodexSessionTurns,
  readCodexSessionModel,
  readCodexSessionRecords,
} from './CodexHistoryStore';
import { hydrateCodexSubagentHistory } from './CodexSubagentHistory';

/** Parsed transcript turns; a missing file has none, and other read failures reject. */
async function readSessionTurns(sessionFilePath: string, throughTurnId?: string): Promise<CodexParsedTurn[]> {
  return parseCodexSessionTurns(await readCodexSessionRecords(sessionFilePath) ?? [], throughTurnId);
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

/**
 * Earlier segments are display-only: unique ids across segments, and no native checkpoint ids,
 * so fork and rewind are offered only where the live thread can honor them.
 */
function toHistoryOnlyMessage(message: ChatMessage, segmentIndex: number): ChatMessage {
  const { assistantMessageId: _assistant, userMessageId: _user, ...visible } = message;
  return { ...visible, id: `codex-segment-${segmentIndex}:${message.id}` };
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

    // Pending fork with existing in-memory messages: keep them as-is
    if (this.isPendingForkConversation(conversation) && conversation.messages.length > 0) {
      return conversation;
    }

    // The live thread is read first so unavailable earlier segments cannot exhaust its lookup budget.
    const currentMessages = await this.#hydrateCurrentSegment(
      conversation,
      state,
      pathContext,
      lookupDeadline,
    );
    const previousDeadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS;
    const previousMessages: ChatMessage[] = [];
    const liveThreadId = state.threadId ?? conversation.sessionId;
    for (const [index, segment] of (state.previousSegments ?? []).entries()) {
      // The live thread already contains a segment that was rebound; render it once.
      if (segment.threadId && segment.threadId === liveThreadId) continue;
      const messages = await this.#readPreviousSegment(segment, pathContext, previousDeadline);
      previousMessages.push(...messages.map(message => toHistoryOnlyMessage(message, index)));
    }
    if (previousMessages.length === 0 && !currentMessages) {
      return conversation;
    }

    conversation.messages = [...previousMessages, ...(currentMessages ?? [])];
    if (currentMessages && !this.isPendingForkConversation(conversation)) {
      this.#markNativeConversationContextEstablished(conversation);
    }
    return conversation;
  }

  /**
   * Visible history of the live binding; null when it has no readable transcript. Path
   * corrections for the live thread are written back to the conversation's provider state.
   */
  async #hydrateCurrentSegment(
    conversation: ProviderHistoryState,
    state: CodexProviderState,
    pathContext: ProviderHistoryPathContext | undefined,
    lookupDeadline: number,
  ): Promise<ChatMessage[] | null> {
    const transcriptRootPath = resolveCodexTranscriptRootHint(
      state.transcriptRootPath ?? deriveCodexSessionsRootFromSessionPath(state.sessionFilePath),
      pathContext,
    );

    // Pending fork without messages: hydrate from source transcript truncated at resumeAt
    if (this.isPendingForkConversation(conversation)) {
      return await this.#readPendingForkSegment(state, pathContext, lookupDeadline);
    }

    // Established fork: source prefix + fork-only turns
    if (state.forkSource && state.threadId) {
      const sourceSessionFile = await this.#resolveSourceSessionFile(
        state,
        pathContext,
        lookupDeadline,
      );
      const forkSessionFile = await this.#resolveThreadSessionFile(
        state.sessionFilePath,
        state.threadId,
        transcriptRootPath,
        pathContext,
        lookupDeadline,
      );

      if (sourceSessionFile && forkSessionFile) {
        const messages = await this.#readEstablishedForkMessages(
          state,
          sourceSessionFile,
          forkSessionFile,
          await readSessionTurns(forkSessionFile),
          transcriptRootPath,
          pathContext,
        );
        return messages && messages.length > 0 ? messages : null;
      }
    }

    // Normal hydration
    const threadId = state.threadId ?? conversation.sessionId ?? null;
    const sessionFilePath = await this.#resolveThreadSessionFile(
      state.sessionFilePath,
      threadId,
      transcriptRootPath,
      pathContext,
      lookupDeadline,
    );
    const resolvedTranscriptRootPath = transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(sessionFilePath);

    if (!sessionFilePath) {
      return null;
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
      return null;
    }

    await this.#hydrateSubagents(sdkMessages, sessionFilePath, resolvedTranscriptRootPath, pathContext);
    return sdkMessages;
  }

  /**
   * Rebuilds an invalidated segment as its live hydration would have shown it. Previous
   * segments are best-effort: a missing or unreadable transcript contributes nothing.
   */
  async #readPreviousSegment(
    segment: CodexPreviousSegment,
    pathContext: ProviderHistoryPathContext | undefined,
    lookupDeadline: number,
  ): Promise<ChatMessage[]> {
    try {
      if (segment.forkSource && !segment.threadId) {
        return await this.#readPendingForkSegment(segment, pathContext, lookupDeadline) ?? [];
      }
      const transcriptRootPath = resolveCodexTranscriptRootHint(
        segment.transcriptRootPath ?? deriveCodexSessionsRootFromSessionPath(segment.sessionFilePath),
        pathContext,
      );
      const thread = await this.#readPreviousSegmentThread(
        segment,
        transcriptRootPath,
        pathContext,
        lookupDeadline,
      );
      if (!thread) {
        // A fork whose own transcript is gone still shows its source prefix, as live hydration did.
        return segment.forkSource
          ? await this.#readPendingForkSegment(segment, pathContext, lookupDeadline) ?? []
          : [];
      }
      const { sessionFile, turns } = thread;
      if (segment.forkSource) {
        const sourceSessionFile = await this.#resolveSourceSessionFile(
          segment,
          pathContext,
          lookupDeadline,
        );
        if (sourceSessionFile) {
          return await this.#readEstablishedForkMessages(
            segment,
            sourceSessionFile,
            sessionFile,
            turns,
            transcriptRootPath,
            pathContext,
          ) ?? [];
        }
      }
      const messages = turns.flatMap(turn => turn.messages);
      await this.#hydrateSubagents(messages, sessionFile, transcriptRootPath, pathContext);
      return messages;
    } catch {
      return [];
    }
  }

  async #readPendingForkSegment(
    state: CodexPreviousSegment,
    pathContext: ProviderHistoryPathContext | undefined,
    lookupDeadline: number,
  ): Promise<ChatMessage[] | null> {
    const sourceSessionFile = await this.#resolveSourceSessionFile(
      state,
      pathContext,
      lookupDeadline,
    );
    if (!sourceSessionFile) return null;

    const resumeAt = state.forkSource!.resumeAt;
    const turns = await readSessionTurns(sourceSessionFile, resumeAt);
    const truncated = this.#truncateTurnsAtCheckpoint(turns, resumeAt);
    if (!truncated) {
      return null;
    }
    const messages = truncated.flatMap(t => t.messages);
    await this.#hydrateSubagents(messages, sourceSessionFile, state.forkSourceTranscriptRootPath, pathContext);
    return messages;
  }

  /** Source prefix through the checkpoint plus fork-only turns; null when the checkpoint is missing. */
  async #readEstablishedForkMessages(
    state: CodexPreviousSegment,
    sourceSessionFile: string,
    forkSessionFile: string,
    forkTurns: CodexParsedTurn[],
    transcriptRootPath: string | null,
    pathContext: ProviderHistoryPathContext | undefined,
  ): Promise<ChatMessage[] | null> {
    const sourceRecords = await readCodexSessionRecords(sourceSessionFile) ?? [];
    const sourceTurns = parseCodexSessionTurns(sourceRecords);

    const resumeAt = state.forkSource!.resumeAt;
    const sourcePrefix = this.#truncateTurnsAtCheckpoint(parseCodexSessionTurns(sourceRecords, resumeAt), resumeAt);
    if (!sourcePrefix) {
      return null;
    }
    const sourceTurnIds = new Set(sourceTurns.map(t => t.turnId).filter(Boolean));
    const forkOnlyTurns = forkTurns.filter(t => !t.turnId || !sourceTurnIds.has(t.turnId));

    const sourceMessages = sourcePrefix.flatMap(t => t.messages);
    const forkMessages = forkOnlyTurns.flatMap(t => t.messages);

    await this.#hydrateSubagents(sourceMessages, sourceSessionFile, state.forkSourceTranscriptRootPath, pathContext);
    await this.#hydrateSubagents(forkMessages, forkSessionFile, transcriptRootPath, pathContext);
    return [...sourceMessages, ...forkMessages];
  }

  async #resolveThreadSessionFile(
    persistedPath: string | undefined,
    threadId: string | null,
    transcriptRootPath: string | null,
    pathContext: ProviderHistoryPathContext | undefined,
    lookupDeadline: number,
  ): Promise<string | null> {
    return await resolveCodexSessionFileHint(
      persistedPath,
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
  }

  /**
   * The segment's own thread turns. A saved path can go stale when Codex archives the rollout,
   * so a missing or empty transcript falls back to the archived roots.
   */
  async #readPreviousSegmentThread(
    segment: CodexPreviousSegment,
    transcriptRootPath: string | null,
    pathContext: ProviderHistoryPathContext | undefined,
    lookupDeadline: number,
  ): Promise<{ sessionFile: string; turns: CodexParsedTurn[] } | null> {
    const resolved = await this.#resolveThreadSessionFile(
      segment.sessionFilePath,
      segment.threadId ?? null,
      transcriptRootPath,
      pathContext,
      lookupDeadline,
    );
    const resolvedTurns = resolved ? await readSessionTurns(resolved) : [];
    if (resolved && resolvedTurns.length > 0) return { sessionFile: resolved, turns: resolvedTurns };
    if (!segment.threadId) return null;

    for (const root of getCodexArchivedTranscriptRoots(
      pathContext,
      transcriptRootPath ? [transcriptRootPath] : [],
    )) {
      const remainingMs = Math.max(0, lookupDeadline - Date.now());
      if (remainingMs === 0) break;
      const archived = await findCodexSessionFileAsync(segment.threadId, root, remainingMs);
      if (!archived || archived === resolved) continue;
      const turns = await readSessionTurns(archived);
      if (turns.length > 0) return { sessionFile: archived, turns };
    }
    return null;
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

    clearCodexResumeState(conversation);
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
      // Earlier segments stay history-only; the fork shows them before its source prefix.
      ...(sourceState.previousSegments?.length
        ? { previousSegments: sourceState.previousSegments.map(segment => ({ ...segment })) }
        : {}),
      ...(sourceState.sessionToolVersion !== undefined ? { sessionToolVersion: sourceState.sessionToolVersion } : {}),
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
    let turns = sourcePath ? await readSessionTurns(sourcePath) : [];
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
        turns = await readSessionTurns(candidate);
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
    state: CodexPreviousSegment,
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
