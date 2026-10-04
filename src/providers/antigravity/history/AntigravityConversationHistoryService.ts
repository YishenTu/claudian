import { copyProviderHistoryState } from '@/core/providers/providerHistory';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryResult,
  ProviderHistoryUpdate,
} from '@/core/providers/types';

import { encodeAntigravityModelId } from '../models';
import { getAntigravityState } from '../types';

export class AntigravityConversationHistoryService implements ProviderConversationHistoryService {
  hasConversationModelRecoverySource(conversation: ProviderHistoryInput): boolean {
    return Boolean(this.resolveSessionIdForConversation(conversation));
  }

  async recoverConversationModelSelection(
    conversation: ProviderHistoryInput,
  ): Promise<string | null> {
    const state = getAntigravityState(conversation.providerState);
    if (state.currentModelId) {
      return encodeAntigravityModelId(state.currentModelId);
    }
    return null;
  }

  hasConversationHydrationSource(conversation: ProviderHistoryInput): boolean {
    return Boolean(this.resolveSessionIdForConversation(conversation));
  }

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    return conversation;
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    if (conversation?.sessionId?.trim()) {
      return conversation.sessionId.trim();
    }
    const state = getAntigravityState(conversation?.providerState);
    return state.sessionId ?? null;
  }

  isPendingForkConversation(conversation: ProviderHistoryInput): boolean {
    const state = getAntigravityState(conversation.providerState);
    return Boolean(state.forkSource && !conversation.sessionId);
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
  ): Record<string, unknown> {
    return {
      forkSource: { sessionId: sourceSessionId, resumeAt },
    };
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

    conversation.sessionId = null;
    const providerState = { ...(conversation.providerState ?? {}) };
    delete providerState.sessionId;
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    return { outcome: 'reset', changes: conversation };
  }
}
