import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryResult,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
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

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const state = parseGrokProviderState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      if (!pathContext) {
        return conversation;
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
      if (conversation.messages.length > 0) return conversation;
      if (!sourceSessionDirectory) {
        return conversation;
      }
      const parsed = await loadGrokHistory(
        sourceSessionDirectory,
        forkSource.sessionId,
        forkSource.resumeAt,
      );
      if (parsed.messages.length === 0) {
        return conversation;
      }
      conversation.messages = parsed.messages;
      return conversation;
    }

    const sessionId = conversation.sessionId;
    if (!sessionId || !pathContext) {
      return conversation;
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
      return conversation;
    }


    const parsed = await loadGrokHistory(sessionDirectory, sessionId);
    if (parsed.messages.length === 0) {
      return conversation;
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
    return conversation;
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    const state = parseGrokProviderState(conversation?.providerState);
    return conversation?.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  async resolveMissingConversationSession(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>> {
    const conversation = copyProviderHistoryState(input);
    if (
      !conversation.sessionId
      || !missingProviderSessionId
      || conversation.sessionId !== missingProviderSessionId
    ) {
      return { outcome: 'preserve' };
    }

    const providerState = { ...conversation.providerState };
    for (const key of GROK_PROVIDER_STATE_KEYS) delete providerState[key];
    conversation.sessionId = null;
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    return { outcome: 'reset', changes: conversation };
  }

  isPendingForkConversation(conversation: ProviderHistoryInput): boolean {
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
    conversation: ProviderHistoryInput,
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
