import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { copyProviderHistoryState } from '@/core/providers/providerHistory';
import { readFileRevision } from '@/utils/fileRevision';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryState,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import type { ChatMessage } from '../../../core/types';
import { piHostPath } from '../runtime/piTargetPaths';
import {
  buildPersistedPiState,
  getPiState,
  type PiPreviousSession,
} from '../types';
import { PiHistoryContextResolver } from './PiHistoryContextResolver';
import {
  isPiSessionPathReference,
  type PiHistoryPathContext,
  resolvePiHistoryTarget,
  resolvePiSessionFileHint,
} from './PiHistoryPathResolver';
import {
  followPiLeafAppends,
  type ParsedPiSessionEntries,
  parsePiSessionContent,
  parsePiSessionModel,
  readPiSessionEntries,
  readPiSessionHeader,
  resolvePiTreeCursor,
} from './PiHistoryStore';

const PI_PROVIDER_STATE_KEYS = [
  'bindingRetired', // Retired marker written by earlier versions; dropped on the next write.
  'treeCursor',
  'treeSelections',
  'forkSource',
  'forkSourceSessionFile',
  'leafEntryId',
  'parentSession',
  'previousSessions',
  'sessionFile',
  'sessionId',
] as const;

export class PiConversationHistoryService implements ProviderConversationHistoryService {
  private readonly contextResolver = new PiHistoryContextResolver();

  hasConversationModelRecoverySource(conversation: ProviderHistoryInput): boolean {
    const state = getPiState(conversation.providerState);
    return !!(
      state.sessionFile
      || state.sessionId
      || conversation.sessionId
      || state.forkSource?.sessionId
      || state.forkSourceSessionFile
    );
  }

  async recoverConversationModelSelection(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: PiHistoryPathContext,
  ): Promise<string | null> {
    if (pathContext) pathContext = await this.contextResolver.resolve(vaultPath, pathContext);
    const state = getPiState(conversation.providerState);
    const isPendingFork = this.isPendingForkConversation(conversation);
    const sessionId = isPendingFork
      ? state.forkSource!.sessionId
      : (state.sessionId ?? conversation.sessionId);
    const sessionFile = resolvePiSessionFileHint(
      isPendingFork ? state.forkSourceSessionFile : state.sessionFile,
      sessionId,
      vaultPath,
      pathContext,
    );
    if (!sessionFile) return null;

    try {
      const content = await readPiSessionEntries(sessionFile);
      const cursor = state.treeCursor ? resolvePiTreeCursor(content.entries, state.treeCursor) : undefined;
      // The same leaf hydration shows: a turn leaf follows turns other Pi clients appended to it.
      const leafEntryId = cursor ? cursor.leafId
        : state.leafEntryId ? followPiLeafAppends(content.entries, state.leafEntryId) : state.leafEntryId;
      return parsePiSessionModel(content, isPendingFork ? state.forkSource!.resumeAt : leafEntryId);
    } catch {
      return null;
    }
  }

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: PiHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const state = getPiState(conversation.providerState);
    if (!state.sessionId && !conversation.sessionId && !state.sessionFile && !state.forkSource && !state.previousSessions?.length) return conversation;
    if (pathContext) pathContext = await this.contextResolver.resolve(vaultPath, pathContext);
    const executionTarget = pathContext ? resolvePiHistoryTarget(vaultPath, pathContext) : undefined;
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = await this.#resolvePreviousSessionFile(
        {
          leafEntryId: state.forkSource!.resumeAt,
          sessionFile: state.forkSourceSessionFile,
          sessionId: state.forkSource!.sessionId,
        },
        vaultPath,
        pathContext,
        true,
      );
      this.#replaceResolvedPath(
        conversation,
        'forkSourceSessionFile',
        state.forkSourceSessionFile,
        sourceSessionFile,
        executionTarget,
      );
      if (conversation.messages.length > 0) {
        return conversation;
      }
      if (!sourceSessionFile) {
        return conversation;
      }

      try {
        const content = await readPiSessionEntries(sourceSessionFile);
        const messages = parsePiSessionContent(content, {
          leafEntryId: state.forkSource!.resumeAt,
          requireLeafEntryId: true,
          syntheticIdNamespace: sourceSessionFile,
        });
        if (messages.length === 0) {
          return conversation;
        }

        conversation.messages = messages;
      } catch {
        // Retain the existing history when a native transcript cannot be read.
      }
      return conversation;
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
      return conversation;
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
        ? await this.#resolvePreviousSessionFile(
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
        this.#replaceResolvedPath(
          conversation,
          'sessionFile',
          item.source.sessionFile,
          sessionFile,
          executionTarget,
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
      return conversation;
    }



    const messages: ChatMessage[] = [];
    let readCurrent = false;
    for (const source of resolvedSources) {
      let content: ParsedPiSessionEntries;
      try {
        content = await readPiSessionEntries(source.sessionFile);
      } catch (error) {
        // Previous segments may be unavailable; an unreadable current transcript must surface.
        if (source.kind === 'current' && !isMissingFileError(error)) throw error;
        continue;
      }
      try {
        const cursor = source.kind === 'current' && state.treeCursor
          ? resolvePiTreeCursor(content.entries, state.treeCursor) : undefined;
        // An explicit branch selection keeps its cursor rules; a turn leaf follows turns other Pi clients append.
        const leafEntryId = !cursor && source.kind === 'current' && source.leafEntryId
          ? followPiLeafAppends(content.entries, source.leafEntryId) : source.leafEntryId;
        const sourceMessages = parsePiSessionContent(content, {
          leafEntryId: cursor ? cursor.leafId : leafEntryId,
          includeBranches: source.kind === 'current',
          requireLeafEntryId: !!source.leafEntryId || !!state.treeCursor,
          syntheticIdNamespace: source.sessionFile,
        });
        if (source.kind === 'current') readCurrent = true;
        if (leafEntryId !== source.leafEntryId) {
          conversation.providerState = { ...conversation.providerState, leafEntryId };
        }
        if (cursor) {
          conversation.providerState = { ...conversation.providerState, treeCursor: cursor };
          if (cursor.leafId === null) delete conversation.providerState.leafEntryId;
          else conversation.providerState.leafEntryId = cursor.leafId;
        }
        messages.push(...sourceMessages);
        if (
          source.kind === 'previous'
          && sourceMessages.length > 0
          && source.index !== undefined
          && source.sessionFile !== source.persistedPath
        ) {
          this.#replacePreviousSessionPath(
            conversation,
            source.index,
            source.sessionFile,
          );
        }
      } catch {
        // One unavailable segment must not hide the remaining replayable history.
      }
    }
    if (messages.length === 0 && !readCurrent) {
      return conversation;
    }

    conversation.messages = dedupeMessages(messages);
    return conversation;
  }

  /** Revision of the live session file; previous sessions are frozen and pending forks have none. */
  async readNativeHistoryRevision(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: PiHistoryPathContext,
  ): Promise<string | null> {
    if (this.isPendingForkConversation(conversation)) return null;
    const state = getPiState(conversation.providerState);
    const sessionId = state.sessionId ?? conversation.sessionId;
    if (!state.sessionFile && !sessionId) return null;
    try {
      if (pathContext) pathContext = await this.contextResolver.resolve(vaultPath, pathContext);
      const sessionFile = resolvePiSessionFileHint(state.sessionFile, sessionId, vaultPath, pathContext);
      return sessionFile ? await readFileRevision(sessionFile) : null;
    } catch {
      return null;
    }
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    const state = getPiState(conversation?.providerState);
    return state.sessionFile
      ?? state.sessionId
      ?? conversation?.sessionId
      ?? state.forkSource?.sessionId
      ?? getLastPreviousSessionTarget(state.previousSessions)
      ?? null;
  }

  isPendingForkConversation(_conversation: ProviderHistoryInput): boolean {
    const state = getPiState(_conversation.providerState);
    return !!state.forkSource && !state.sessionId && !state.sessionFile && !_conversation.sessionId;
  }

  async buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
    vaultPath: string | null = null,
    pathContext?: PiHistoryPathContext,
  ): Promise<Record<string, unknown>> {
    if (pathContext) pathContext = await this.contextResolver.resolve(vaultPath, pathContext);
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
        await this.#resolvePreviousSessionFile(
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
        await this.#resolvePreviousSessionFile(source, vaultPath, pathContext),
      );
    }
    const dedupedCandidates = dedupeForkSources(candidates);
    if (dedupedCandidates.length === 0 && pathContext && resolvePiHistoryTarget(vaultPath, pathContext).method === 'wsl') {
      throw new Error('Cannot fork Pi session: the source file is unavailable in the current WSL store.');
    }
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
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      PI_PROVIDER_STATE_KEYS,
      buildPersistedPiState(
        getPiState(conversation.providerState),
      ) as Record<string, unknown> | undefined,
    );
  }

  #replaceResolvedPath(
    conversation: ProviderHistoryState,
    field: 'forkSourceSessionFile' | 'sessionFile',
    persistedPath: string | undefined,
    resolvedPath: string | null,
    executionTarget?: ExecutionTarget,
  ): void {
    // An unresolved path stays recorded: history reads never change the binding.
    if (!persistedPath || !resolvedPath || persistedPath === resolvedPath) {
      return;
    }
    const nextState = { ...getPiState(conversation.providerState), [field]: resolvedPath };
    conversation.providerState = mergePersistedProviderState(
      conversation.providerState,
      PI_PROVIDER_STATE_KEYS,
      buildPersistedPiState(nextState) as Record<string, unknown> | undefined,
    );
  }

  async #resolvePreviousSessionFile(
    source: PiPreviousSession,
    vaultPath: string | null,
    pathContext?: PiHistoryPathContext,
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
      && await isMatchingArchivedPiSession(resolved, source, vaultPath, pathContext)
    ) {
      return resolved;
    }
    if (
      (!pathContext || resolvePiHistoryTarget(vaultPath, pathContext).method !== 'wsl')
      && source.sessionFile
      && await isMatchingArchivedPiSession(source.sessionFile, source, vaultPath, pathContext)
    ) {
      return source.sessionFile;
    }
    if (resolved && await isMatchingArchivedPiSession(resolved, source, vaultPath, pathContext)) {
      return resolved;
    }
    return null;
  }

  #replacePreviousSessionPath(
    conversation: ProviderHistoryState,
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
      const content = await readPiSessionEntries(candidate.sessionFile!);
      if (content.entries.some(entry => entry.id === resumeAt)) {
        return candidate;
      }
    } catch {
      // An unavailable segment cannot contain a usable fork checkpoint.
    }
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
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
  pathContext?: PiHistoryPathContext,
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

  const target = pathContext ? resolvePiHistoryTarget(vaultPath, pathContext) : undefined;
  return await resolveRealPath(piHostPath(header.cwd, target)) === await resolveRealPath(vaultPath);
}

async function resolveRealPath(value: string): Promise<string> {
  try {
    return path.resolve(await fs.realpath(value));
  } catch {
    return path.resolve(value);
  }
}
