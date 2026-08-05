import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getOpencodeState, type OpencodeProviderState } from '../types';
import { resolveOpencodeDatabasePathHint } from './OpencodeHistoryPathResolver';
import {
  isOpencodeSessionHydrationDiagnosticMessage,
  loadOpencodeSessionMessages,
  loadOpencodeSessionModel,
} from './OpencodeHistoryStore';

const OPENCODE_PROVIDER_STATE_KEYS = [
  'databasePath',
  'nativeConversationContextEstablished',
] as const;

export class OpencodeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  hasConversationModelRecoverySource(conversation: Conversation): boolean {
    return !!conversation.sessionId;
  }

  async recoverConversationModelSelection(
    conversation: Conversation,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null> {
    if (!conversation.sessionId) return null;
    const state = getOpencodeState(conversation.providerState);
    const databasePath = resolveOpencodeDatabasePathHint(state.databasePath, pathContext);
    if (!databasePath) return null;
    return loadOpencodeSessionModel(conversation.sessionId, { databasePath });
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = getOpencodeState(conversation.providerState);
    const databasePath = resolveOpencodeDatabasePathHint(state.databasePath, pathContext);
    if (state.databasePath && state.databasePath !== databasePath) {
      const providerState = { ...conversation.providerState };
      if (databasePath) {
        providerState.databasePath = databasePath;
      } else {
        delete providerState.databasePath;
      }
      conversation.providerState = Object.keys(providerState).length > 0
        ? providerState
        : undefined;
    }
    const sessionId = conversation.sessionId;
    if (!sessionId) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = `${sessionId}::${databasePath ?? ''}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      this.markNativeConversationContextEstablished(conversation);
      return;
    }

    const messages = await loadOpencodeSessionMessages(sessionId, { databasePath: databasePath ?? undefined });
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    conversation.messages = messages;
    if (
      messages.length === 1
      && isOpencodeSessionHydrationDiagnosticMessage(messages[0])
    ) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    this.hydratedKeys.set(conversation.id, hydrationKey);
    this.markNativeConversationContextEstablished(conversation);
  }

  async resolveMissingConversationSession(
    conversation: Conversation,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<'delete' | 'reset' | 'preserve'> {
    if (
      !conversation.sessionId
      || !missingProviderSessionId
      || conversation.sessionId !== missingProviderSessionId
    ) {
      return 'preserve';
    }

    conversation.sessionId = null;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: false,
    };
    this.hydratedKeys.delete(conversation.id);
    return 'reset';
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
    const state = getOpencodeState(conversation.providerState);
    const providerState: OpencodeProviderState = {
      ...(state.databasePath ? { databasePath: state.databasePath } : {}),
      ...(typeof state.nativeConversationContextEstablished === 'boolean'
        ? {
            nativeConversationContextEstablished:
              state.nativeConversationContextEstablished,
          }
        : {}),
    };

    return mergePersistedProviderState(
      conversation.providerState,
      OPENCODE_PROVIDER_STATE_KEYS,
      providerState,
    );
  }

  private markNativeConversationContextEstablished(
    conversation: Conversation,
  ): void {
    const state = getOpencodeState(conversation.providerState);
    if (state.nativeConversationContextEstablished !== false) return;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: true,
    };
  }
}
