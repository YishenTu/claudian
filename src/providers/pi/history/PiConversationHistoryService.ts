import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, Conversation } from '../../../core/types';
import {
  addPiPreviousSession,
  buildPersistedPiState,
  clearPiResumeState,
  getPiState,
  type PiPreviousSession,
} from '../types';
import {
  isPiSessionPathReference,
  resolvePiSessionFileHint,
} from './PiHistoryPathResolver';
import {
  parsePiSessionContent,
  parsePiSessionEntries,
  readPiSessionHeader,
} from './PiHistoryStore';

const PI_PROVIDER_STATE_KEYS = [
  'forkSource',
  'forkSourceSessionFile',
  'leafEntryId',
  'parentSession',
  'previousSessions',
  'sessionFile',
  'sessionId',
] as const;

export class PiConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = getPiState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = await this.resolvePreviousSessionFile(
        {
          leafEntryId: state.forkSource!.resumeAt,
          sessionFile: state.forkSourceSessionFile,
          sessionId: state.forkSource!.sessionId,
        },
        vaultPath,
        pathContext,
        true,
      );
      this.replaceResolvedPath(
        conversation,
        'forkSourceSessionFile',
        state.forkSourceSessionFile,
        sourceSessionFile,
      );
      if (conversation.messages.length > 0) {
        return;
      }
      if (!sourceSessionFile) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }

      try {
        const content = await fs.readFile(sourceSessionFile, 'utf-8');
        const messages = parsePiSessionContent(content, {
          leafEntryId: state.forkSource!.resumeAt,
          requireLeafEntryId: true,
          syntheticIdNamespace: sourceSessionFile,
        });
        if (messages.length === 0) {
          this.hydratedKeys.delete(conversation.id);
          return;
        }

        conversation.messages = messages;
        this.hydratedKeys.set(conversation.id, `fork::${sourceSessionFile}::${state.forkSource!.resumeAt}`);
      } catch {
        this.hydratedKeys.delete(conversation.id);
      }
      return;
    }

    const currentSession: PiPreviousSession = {
      ...(state.leafEntryId ? { leafEntryId: state.leafEntryId } : {}),
      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
      ...(state.sessionId ?? conversation.sessionId
        ? { sessionId: (state.sessionId ?? conversation.sessionId)! }
        : {}),
    };
    const sources = [
      ...(state.previousSessions ?? []).map((source, index) => ({
        index,
        kind: 'previous' as const,
        source,
      })),
      ...(currentSession.sessionFile || currentSession.sessionId
        ? [{ kind: 'current' as const, source: currentSession }]
        : []),
    ];
    if (sources.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const resolvedSources: Array<{
      index?: number;
      kind: 'current' | 'previous';
      leafEntryId?: string;
      persistedPath?: string;
      sessionFile: string;
    }> = [];
    for (const item of sources) {
      const sessionFile = item.kind === 'previous'
        ? await this.resolvePreviousSessionFile(
          item.source,
          vaultPath,
          pathContext,
        )
        : resolvePiSessionFileHint(
          item.source.sessionFile,
          item.source.sessionId,
          vaultPath,
          pathContext,
        );
      if (item.kind === 'current') {
        this.replaceResolvedPath(
          conversation,
          'sessionFile',
          item.source.sessionFile,
          sessionFile,
        );
      }
      if (sessionFile) {
        resolvedSources.push({
          ...(item.kind === 'previous' ? { index: item.index } : {}),
          kind: item.kind,
          ...(item.source.leafEntryId ? { leafEntryId: item.source.leafEntryId } : {}),
          ...(item.source.sessionFile ? { persistedPath: item.source.sessionFile } : {}),
          sessionFile,
        });
      }
    }
    if (resolvedSources.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = JSON.stringify(resolvedSources);
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    const messages: ChatMessage[] = [];
    for (const source of resolvedSources) {
      try {
        const content = await fs.readFile(source.sessionFile, 'utf-8');
        const sourceMessages = parsePiSessionContent(content, {
          leafEntryId: source.leafEntryId,
          requireLeafEntryId: source.kind === 'previous' && !!source.leafEntryId,
          syntheticIdNamespace: source.sessionFile,
        });
        messages.push(...sourceMessages);
        if (
          source.kind === 'previous'
          && sourceMessages.length > 0
          && source.index !== undefined
          && source.sessionFile !== source.persistedPath
        ) {
          this.replacePreviousSessionPath(
            conversation,
            source.index,
            source.sessionFile,
          );
        }
      } catch {
        // One unavailable segment must not hide the remaining replayable history.
      }
    }
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    conversation.messages = dedupeMessages(messages);
    this.hydratedKeys.set(conversation.id, hydrationKey);
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = getPiState(conversation?.providerState);
    return state.sessionFile
      ?? state.sessionId
      ?? conversation?.sessionId
      ?? state.forkSource?.sessionId
      ?? getLastPreviousSessionTarget(state.previousSessions)
      ?? null;
  }

  async resolveMissingConversationSession(
    conversation: Conversation,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<'delete' | 'reset' | 'preserve'> {
    const state = getPiState(conversation.providerState);
    const currentTarget = state.sessionFile
      ?? state.sessionId
      ?? conversation.sessionId
      ?? null;
    if (
      !missingProviderSessionId
      || !currentTarget
      || missingProviderSessionId !== currentTarget
    ) {
      return 'preserve';
    }

    const hasFallbackTarget = Boolean(
      (state.sessionFile && state.sessionFile !== currentTarget)
      || (state.sessionId && state.sessionId !== currentTarget)
      || (conversation.sessionId && conversation.sessionId !== currentTarget),
    );
    if (!hasFallbackTarget) {
      clearPiResumeState(conversation);
    } else {
      const providerState = { ...(conversation.providerState ?? {}) };
      providerState.previousSessions = addPiPreviousSession(
        state.previousSessions,
        {
          ...(state.leafEntryId ? { leafEntryId: state.leafEntryId } : {}),
          ...(state.sessionFile === currentTarget
            ? { sessionFile: state.sessionFile }
            : {}),
          ...(state.sessionId === currentTarget
            ? { sessionId: state.sessionId }
            : conversation.sessionId === currentTarget
              ? { sessionId: conversation.sessionId }
              : {}),
        },
      );
      if (state.sessionFile === currentTarget) delete providerState.sessionFile;
      if (state.sessionId === currentTarget) delete providerState.sessionId;
      if (conversation.sessionId === currentTarget) conversation.sessionId = null;
      conversation.providerState = Object.keys(providerState).length > 0
        ? providerState
        : undefined;
    }
    this.hydratedKeys.delete(conversation.id);
    return 'reset';
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    const state = getPiState(_conversation.providerState);
    return !!state.forkSource && !state.sessionId && !state.sessionFile && !_conversation.sessionId;
  }

  async buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
    vaultPath: string | null = null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<Record<string, unknown>> {
    const sourceState = getPiState(sourceProviderState);
    const candidates: PiForkSourceCandidate[] = [];
    const addCandidate = (source: PiPreviousSession, sessionFile: string | null): void => {
      if (!sessionFile) return;
      candidates.push({
        sessionFile,
        sessionId: source.sessionId ?? source.sessionFile ?? sourceSessionId,
      });
    };
    const currentSource: PiPreviousSession = {
      sessionFile: sourceState.sessionFile,
      sessionId: sourceState.sessionId ?? sourceSessionId,
    };
    addCandidate(
      currentSource,
      resolvePiSessionFileHint(
        currentSource.sessionFile,
        currentSource.sessionId,
        vaultPath,
        pathContext,
      ),
    );
    if (sourceState.forkSource) {
      const pendingSource: PiPreviousSession = {
        leafEntryId: sourceState.forkSource.resumeAt,
        sessionFile: sourceState.forkSourceSessionFile,
        sessionId: sourceState.forkSource.sessionId,
      };
      addCandidate(
        pendingSource,
        await this.resolvePreviousSessionFile(
          pendingSource,
          vaultPath,
          pathContext,
          true,
        ),
      );
    }
    for (const source of [...(sourceState.previousSessions ?? [])].reverse()) {
      addCandidate(
        source,
        await this.resolvePreviousSessionFile(source, vaultPath, pathContext),
      );
    }
    const dedupedCandidates = dedupeForkSources(candidates);
    const matchingSource = await findForkSourceContainingCheckpoint(dedupedCandidates, resumeAt)
      ?? dedupedCandidates[0]
      ?? { sessionId: sourceSessionId };
    return buildPersistedPiState({
      forkSource: { sessionId: matchingSource.sessionId, resumeAt },
      ...(matchingSource.sessionFile
        ? { forkSourceSessionFile: matchingSource.sessionFile }
        : {}),
    }) as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      PI_PROVIDER_STATE_KEYS,
      buildPersistedPiState(
        getPiState(conversation.providerState),
      ) as Record<string, unknown> | undefined,
    );
  }

  private replaceResolvedPath(
    conversation: Conversation,
    field: 'forkSourceSessionFile' | 'sessionFile',
    persistedPath: string | undefined,
    resolvedPath: string | null,
  ): void {
    if (!persistedPath || persistedPath === resolvedPath) {
      return;
    }

    const nextState = { ...getPiState(conversation.providerState) };
    if (resolvedPath) {
      nextState[field] = resolvedPath;
    } else {
      delete nextState[field];
    }
    conversation.providerState = mergePersistedProviderState(
      conversation.providerState,
      PI_PROVIDER_STATE_KEYS,
      buildPersistedPiState(nextState) as Record<string, unknown> | undefined,
    );
  }

  private async resolvePreviousSessionFile(
    source: PiPreviousSession,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
    preferResolvedPath = false,
  ): Promise<string | null> {
    const resolved = resolvePiSessionFileHint(
      source.sessionFile,
      source.sessionId,
      vaultPath,
      pathContext,
    );
    if (resolved === source.sessionFile) {
      return resolved;
    }
    if (
      preferResolvedPath
      && resolved
      && await isMatchingArchivedPiSession(resolved, source, vaultPath)
    ) {
      return resolved;
    }
    if (
      source.sessionFile
      && await isMatchingArchivedPiSession(source.sessionFile, source, vaultPath)
    ) {
      return source.sessionFile;
    }
    if (resolved && await isMatchingArchivedPiSession(resolved, source, vaultPath)) {
      return resolved;
    }
    return null;
  }

  private replacePreviousSessionPath(
    conversation: Conversation,
    index: number,
    sessionFile: string,
  ): void {
    const state = getPiState(conversation.providerState);
    if (!state.previousSessions?.[index]) {
      return;
    }
    const previousSessions = state.previousSessions.map((source, sourceIndex) => (
      sourceIndex === index ? { ...source, sessionFile } : source
    ));
    conversation.providerState = mergePersistedProviderState(
      conversation.providerState,
      PI_PROVIDER_STATE_KEYS,
      buildPersistedPiState({ ...state, previousSessions }) as Record<string, unknown> | undefined,
    );
  }
}

interface PiForkSourceCandidate {
  sessionFile?: string;
  sessionId: string;
}

function dedupeForkSources(candidates: PiForkSourceCandidate[]): PiForkSourceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.sessionFile || seen.has(candidate.sessionFile)) {
      return false;
    }
    seen.add(candidate.sessionFile);
    return true;
  });
}

async function findForkSourceContainingCheckpoint(
  candidates: PiForkSourceCandidate[],
  resumeAt: string,
): Promise<PiForkSourceCandidate | null> {
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate.sessionFile!, 'utf-8');
      if (parsePiSessionEntries(content).entries.some(entry => entry.id === resumeAt)) {
        return candidate;
      }
    } catch {
      // An unavailable segment cannot contain a usable fork checkpoint.
    }
  }
  return null;
}

function getLastPreviousSessionTarget(
  sessions: PiPreviousSession[] | undefined,
): string | null {
  const session = sessions?.at(-1);
  return session?.sessionFile ?? session?.sessionId ?? null;
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}

async function isMatchingArchivedPiSession(
  sessionFile: string,
  source: PiPreviousSession,
  vaultPath: string | null,
): Promise<boolean> {
  const header = await readPiSessionHeader(sessionFile);
  if (!header) {
    return false;
  }

  const expectedSessionId = source.sessionId
    && !isPiSessionPathReference(source.sessionId)
    ? source.sessionId
    : null;
  if (
    expectedSessionId
    && (typeof header.id !== 'string' || header.id.trim() !== expectedSessionId)
  ) {
    return false;
  }
  if (!vaultPath) {
    return expectedSessionId !== null;
  }
  if (typeof header.cwd !== 'string' || !header.cwd.trim()) {
    return false;
  }

  return await resolveRealPath(header.cwd) === await resolveRealPath(vaultPath);
}

async function resolveRealPath(value: string): Promise<string> {
  try {
    return path.resolve(await fs.realpath(value));
  } catch {
    return path.resolve(value);
  }
}
