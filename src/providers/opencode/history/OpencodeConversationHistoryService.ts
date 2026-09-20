import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderForkOptions,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getEnhancedPath } from '../../../utils/env';
import { OpencodeCliResolver } from '../runtime/OpencodeCliResolver';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { getOpencodeState, type OpencodeProviderState } from '../types';
import { resolveOpencodeDatabasePathHint } from './OpencodeHistoryPathResolver';
import {
  isOpencodeSessionHydrationDiagnosticMessage,
  loadOpencodeSessionMessages,
  loadOpencodeSessionModel,
} from './OpencodeHistoryStore';
import { forkOpencodeSession } from './OpencodeSessionFork';

const OPENCODE_PROVIDER_STATE_KEYS = [
  'databasePath',
  'sessionId',
  'nativeConversationContextEstablished',
] as const;

export class OpencodeConversationHistoryService implements ProviderConversationHistoryService {
  // A discarded repository draft must not mark another projection hydrated.
  private hydratedKeys = new WeakMap<Conversation, string>();

  hasConversationModelRecoverySource(conversation: Conversation): boolean {
    return !!this.resolveSessionIdForConversation(conversation);
  }

  async recoverConversationModelSelection(
    conversation: Conversation,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId) return null;
    const state = getOpencodeState(conversation.providerState);
    const databasePath = resolveOpencodeDatabasePathHint(state.databasePath, pathContext);
    if (!databasePath) return null;
    return loadOpencodeSessionModel(sessionId, { databasePath }, pathContext?.environment);
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
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId) {
      this.hydratedKeys.delete(conversation);
      return;
    }

    const hydrationKey = `${sessionId}::${databasePath ?? ''}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation) === hydrationKey
    ) {
      this.#markNativeConversationContextEstablished(conversation);
      return;
    }

    const messages = await loadOpencodeSessionMessages(
      sessionId,
      { databasePath: databasePath ?? undefined },
      pathContext?.environment,
    );
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation);
      return;
    }

    conversation.messages = messages;
    if (
      messages.length === 1
      && isOpencodeSessionHydrationDiagnosticMessage(messages[0])
    ) {
      this.hydratedKeys.delete(conversation);
      return;
    }

    this.hydratedKeys.set(conversation, hydrationKey);
    this.#markNativeConversationContextEstablished(conversation);
  }

  async resolveMissingConversationSession(
    conversation: Conversation,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<'delete' | 'reset' | 'preserve'> {
    if (
      !this.resolveSessionIdForConversation(conversation)
      || !missingProviderSessionId
      || this.resolveSessionIdForConversation(conversation) !== missingProviderSessionId
    ) {
      return 'preserve';
    }

    conversation.sessionId = null;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: false,
    };
    delete conversation.providerState.sessionId;
    this.hydratedKeys.delete(conversation);
    return 'reset';
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? getOpencodeState(conversation?.providerState).sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  async buildForkProviderState(
    sourceSessionId: string,
    _resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
    vaultPath?: string | null,
    pathContext?: ProviderHistoryPathContext,
    options?: ProviderForkOptions,
  ): Promise<Record<string, unknown>> {
    // Native forks stay in the source database. Memory children bootstrap once from captured context.
    if (options?.ephemeral) return {};
    const cwd = vaultPath ?? pathContext?.vaultPath;
    if (!cwd) throw new Error('OpenCode fork requires a workspace directory.');
    const source = getOpencodeState(sourceProviderState);
    const databasePath = resolveOpencodeDatabasePathHint(source.databasePath, pathContext);
    if (!databasePath || databasePath === ':memory:') {
      throw new Error('OpenCode fork requires a persistent native database.');
    }
    const settings = pathContext?.settings ?? {};
    const cliPath = new OpencodeCliResolver().resolveFromSettings(settings) ?? 'opencode';
    const environment: NodeJS.ProcessEnv = {
      ...buildOpencodeRuntimeEnv(settings, cliPath, databasePath),
      ...pathContext?.environment,
      OPENCODE_DB: databasePath,
    };
    environment.PATH = getEnhancedPath(environment.PATH, cliPath);
    const sessionId = await forkOpencodeSession({
      cliPath,
      cwd,
      environment,
      sourceSessionId,
    });
    return { sessionId, databasePath, nativeConversationContextEstablished: true };
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const state = getOpencodeState(conversation.providerState);
    const providerState: OpencodeProviderState = {
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
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

  #markNativeConversationContextEstablished(
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
