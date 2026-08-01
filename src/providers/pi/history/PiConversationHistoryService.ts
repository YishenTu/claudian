import * as fs from 'node:fs/promises';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { buildPersistedPiState, getPiState } from '../types';
import { resolvePiSessionFileHint } from './PiHistoryPathResolver';
import { parsePiSessionContent } from './PiHistoryStore';

const PI_PROVIDER_STATE_KEYS = [
  'forkSource',
  'forkSourceSessionFile',
  'leafEntryId',
  'parentSession',
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
      const sourceSessionFile = resolvePiSessionFileHint(
        state.forkSourceSessionFile,
        state.forkSource!.sessionId,
        vaultPath,
        pathContext,
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

    const sessionTarget = state.sessionId ?? conversation.sessionId;
    if (!state.sessionFile && !sessionTarget) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const sessionFile = resolvePiSessionFileHint(
      state.sessionFile,
      sessionTarget,
      vaultPath,
      pathContext,
    );
    this.replaceResolvedPath(
      conversation,
      'sessionFile',
      state.sessionFile,
      sessionFile,
    );
    if (!sessionFile) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = `${sessionFile}::${state.leafEntryId ?? ''}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    try {
      const content = await fs.readFile(sessionFile, 'utf-8');
      const messages = parsePiSessionContent(content, {
        leafEntryId: state.leafEntryId,
      });
      if (messages.length === 0) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }

      conversation.messages = messages;
      this.hydratedKeys.set(conversation.id, hydrationKey);
    } catch {
      this.hydratedKeys.delete(conversation.id);
    }
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = getPiState(conversation?.providerState);
    return state.sessionFile
      ?? state.sessionId
      ?? conversation?.sessionId
      ?? state.forkSource?.sessionId
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

    const providerState = { ...(conversation.providerState ?? {}) };
    if (state.sessionFile === currentTarget) delete providerState.sessionFile;
    if (state.sessionId === currentTarget) delete providerState.sessionId;
    if (conversation.sessionId === currentTarget) conversation.sessionId = null;

    const remainingState = getPiState(providerState);
    if (
      !remainingState.sessionFile
      && !remainingState.sessionId
      && !conversation.sessionId
    ) {
      delete providerState.leafEntryId;
      delete providerState.parentSession;
    }
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    this.hydratedKeys.delete(conversation.id);
    return 'reset';
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    const state = getPiState(_conversation.providerState);
    return !!state.forkSource && !state.sessionId && !state.sessionFile && !_conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = getPiState(sourceProviderState);
    const sourceSessionFile = sourceState.sessionFile ?? sourceState.forkSourceSessionFile;
    return buildPersistedPiState({
      forkSource: { sessionId: sourceSessionId, resumeAt },
      ...(sourceSessionFile ? { forkSourceSessionFile: sourceSessionFile } : {}),
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
}
