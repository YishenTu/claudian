import * as fs from 'node:fs/promises';

import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { buildPersistedPiState, getPiState } from '../types';
import { findPiSessionFile, parsePiSessionContent } from './PiHistoryStore';

export class PiConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const state = getPiState(conversation.providerState);
    const sessionTarget = state.sessionFile ?? state.sessionId ?? conversation.sessionId;
    if (!sessionTarget) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const sessionFile = state.sessionFile ?? findPiSessionFile(sessionTarget, vaultPath);
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

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // Never mutate Pi native history.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = getPiState(conversation?.providerState);
    return state.sessionId ?? conversation?.sessionId ?? null;
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
    return buildPersistedPiState(getPiState(conversation.providerState)) as Record<string, unknown> | undefined;
  }
}
