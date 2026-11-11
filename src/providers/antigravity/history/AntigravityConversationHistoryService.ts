import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryEnvironment,
  ProviderHistoryInput,
  ProviderHistoryResult,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import {
  ANTIGRAVITY_PROVIDER_STATE_KEYS,
  buildPersistedAntigravityProviderState,
  clearAntigravityResumeState,
  parseAntigravityProviderState,
} from '../types';
import { resolveAntigravityStoreRoot } from './AntigravityHistoryPaths';
import { loadAntigravityHistory, readAntigravityHistoryRevision } from './AntigravityHistoryStore';

/** Native history is agy's full transcript; ACP replay drops tool results. */
export class AntigravityConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const sessionId = conversation.sessionId ?? parseAntigravityProviderState(conversation.providerState).historySessionId;
    const storeRoot = pathContext ? resolveAntigravityStoreRoot(pathContext.environment, pathContext.hostPlatform) : null;
    if (!sessionId || !storeRoot) return conversation;
    const messages = await loadAntigravityHistory(storeRoot, sessionId);
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
    _vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment,
  ): Promise<string | null> {
    // Only a live binding changes; a retired locator's history is frozen.
    if (!conversation.sessionId || !pathContext) return null;
    const storeRoot = resolveAntigravityStoreRoot(pathContext.environment, pathContext.hostPlatform);
    return storeRoot ? readAntigravityHistoryRevision(storeRoot, conversation.sessionId) : null;
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? null;
  }

  async resolveMissingConversationSession(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>> {
    const conversation = copyProviderHistoryState(input);
    if (!conversation.sessionId || conversation.sessionId !== missingProviderSessionId) return { outcome: 'preserve' };
    // agy keeps transcripts apart from the session database; keep the locator so surviving history still hydrates.
    clearAntigravityResumeState(conversation);
    return { changes: conversation, outcome: 'reset' };
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
