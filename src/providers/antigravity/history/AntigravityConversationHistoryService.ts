import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryEnvironment,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import {
  ANTIGRAVITY_PROVIDER_STATE_KEYS,
  buildPersistedAntigravityProviderState,
  parseAntigravityProviderState,
} from '../types';
import { resolveAntigravityNativeStore } from './AntigravityHistoryEnvironment';
import { loadAntigravityHistory, readAntigravityHistoryRevision } from './AntigravityHistoryStore';

/** Native history is agy's full transcript; ACP replay drops tool results. */
export class AntigravityConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment & Partial<ProviderHistoryPathContext>,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const sessionId = conversation.sessionId ?? parseAntigravityProviderState(conversation.providerState).historySessionId;
    if (!sessionId || !pathContext) return conversation;
    const store = await resolveAntigravityNativeStore({ ...pathContext, vaultPath });
    if (!store) return conversation;
    const messages = await loadAntigravityHistory(store.root, sessionId, store.pathMapper);
    if (messages.length === 0) return conversation;
    conversation.messages = messages;
    const state = parseAntigravityProviderState(conversation.providerState);
    // A transcript under the live binding proves agy holds the conversation context.
    if (conversation.sessionId && state.nativeConversationContextEstablished === false) {
      conversation.providerState = mergePersistedProviderState(
        conversation.providerState,
        ANTIGRAVITY_PROVIDER_STATE_KEYS,
        buildPersistedAntigravityProviderState({ ...state, nativeConversationContextEstablished: true }) as
          Record<string, unknown> | undefined,
      );
    }
    return conversation;
  }

  async readNativeHistoryRevision(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment & Partial<ProviderHistoryPathContext>,
  ): Promise<string | null> {
    // Only a live binding changes; a retired locator's history is frozen.
    if (!conversation.sessionId || !pathContext) return null;
    const store = await resolveAntigravityNativeStore({ ...pathContext, vaultPath });
    return store ? readAntigravityHistoryRevision(store.root, conversation.sessionId) : null;
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    throw new Error('Antigravity does not support forking conversations.');
  }

  buildPersistedProviderState(conversation: ProviderHistoryInput): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      ANTIGRAVITY_PROVIDER_STATE_KEYS,
      buildPersistedAntigravityProviderState(parseAntigravityProviderState(conversation.providerState)) as Record<string, unknown> | undefined,
    );
  }
}
