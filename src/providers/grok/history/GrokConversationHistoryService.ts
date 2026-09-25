import { mergePersistedProviderState } from '../../../core/providers/providerState';
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

const GROK_PROVIDER_STATE_KEYS = [
  'forkSource',
  'forkSourceSessionDirectory',
  'nativeConversationContextEstablished',
  'sessionDirectory',
] as const;

export class GrokConversationHistoryService implements ProviderConversationHistoryService {
  // A discarded repository draft must not mark another projection hydrated.
  private readonly hydratedKeys = new WeakMap<Conversation, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = parseGrokProviderState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      if (!pathContext) {
        this.hydratedKeys.delete(conversation);
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
        conversation.providerState = mergePersistedProviderState(
          conversation.providerState,
          GROK_PROVIDER_STATE_KEYS,
          buildPersistedGrokProviderState({
            ...state,
            forkSourceSessionDirectory: sourceSessionDirectory ?? undefined,
          }) as Record<string, unknown> | undefined,
        );
      }
      if (conversation.messages.length > 0) return;
      if (!sourceSessionDirectory) {
        this.hydratedKeys.delete(conversation);
        return;
      }
      const hydrationKey = `fork::${sourceSessionDirectory}::${forkSource.resumeAt}`;
      const parsed = await loadGrokHistory(
        sourceSessionDirectory,
        forkSource.sessionId,
        forkSource.resumeAt,
      );
      if (parsed.messages.length === 0) {
        this.hydratedKeys.delete(conversation);
        return;
      }
      conversation.messages = parsed.messages;
      this.hydratedKeys.set(conversation, hydrationKey);
      return;
    }

    const sessionId = conversation.sessionId;
    if (!sessionId || !pathContext) {
      this.hydratedKeys.delete(conversation);
      return;
    }
    const sessionDirectory = resolveGrokSessionDirectory(
      state.sessionDirectory,
      sessionId,
      vaultPath,
      pathContext,
    );
    if (sessionDirectory !== state.sessionDirectory) {
      conversation.providerState = mergePersistedProviderState(
        conversation.providerState,
        GROK_PROVIDER_STATE_KEYS,
        buildPersistedGrokProviderState({
          ...state,
          sessionDirectory: sessionDirectory ?? undefined,
        }) as Record<string, unknown> | undefined,
      );
    }
    if (!sessionDirectory) {
      this.hydratedKeys.delete(conversation);
      return;
    }

    const hydrationKey = `${sessionId}::${sessionDirectory}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation) === hydrationKey
    ) {
      return;
    }
    const parsed = await loadGrokHistory(sessionDirectory, sessionId);
    if (parsed.messages.length === 0) {
      this.hydratedKeys.delete(conversation);
      return;
    }
    conversation.messages = parsed.messages;
    const hydratedState = parseGrokProviderState(conversation.providerState);
    if (hydratedState.nativeConversationContextEstablished === false) {
      conversation.providerState = mergePersistedProviderState(
        conversation.providerState,
        GROK_PROVIDER_STATE_KEYS,
        buildPersistedGrokProviderState({
          ...hydratedState,
          nativeConversationContextEstablished: true,
        }) as Record<string, unknown> | undefined,
      );
    }
    this.hydratedKeys.set(conversation, hydrationKey);
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = parseGrokProviderState(conversation?.providerState);
    return conversation?.sessionId ?? state.forkSource?.sessionId ?? null;
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

    const providerState = { ...conversation.providerState };
    for (const key of GROK_PROVIDER_STATE_KEYS) delete providerState[key];
    conversation.sessionId = null;
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    this.hydratedKeys.delete(conversation);
    return 'reset';
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
    return mergePersistedProviderState(
      conversation.providerState,
      GROK_PROVIDER_STATE_KEYS,
      buildPersistedGrokProviderState(
        parseGrokProviderState(conversation.providerState),
      ) as Record<string, unknown> | undefined,
    );
  }
}
