import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getCursorState, resolveCursorSessionId } from '../types';
import { cursorWorkspaceHash, loadCursorChatMessagesFromStore, resolveCursorStoreDbPath } from './cursorHistoryStore';

export class CursorConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const sessionId = resolveCursorSessionId(conversation);
    if (!sessionId || !vaultPath) {
      this.hydratedConversationKeys.delete(conversation.id);
      return;
    }

    const dbPath = resolveCursorStoreDbPath(vaultPath, sessionId);
    if (!dbPath) {
      this.hydratedConversationKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = `${sessionId}::${dbPath}`;
    if (
      conversation.messages.length > 0
      && this.hydratedConversationKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    const loaded = loadCursorChatMessagesFromStore(dbPath);
    if (loaded.length === 0) {
      this.hydratedConversationKeys.delete(conversation.id);
      return;
    }

    conversation.messages = loaded;
    this.hydratedConversationKeys.set(conversation.id, hydrationKey);
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const sessionId = resolveCursorSessionId(conversation);
    if (!sessionId || !vaultPath) {
      return;
    }

    const hash = cursorWorkspaceHash(vaultPath);
    const chatDir = path.join(os.homedir(), '.cursor', 'chats', hash, sessionId);
    if (!chatDir.startsWith(path.join(os.homedir(), '.cursor', 'chats'))) {
      return;
    }

    try {
      fs.rmSync(chatDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return resolveCursorSessionId(conversation);
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
    const state = getCursorState(conversation.providerState);
    const sid = state.chatSessionId ?? conversation.sessionId ?? undefined;
    const merged: Record<string, unknown> = { ...state };
    if (sid) {
      merged.chatSessionId = sid;
    }
    const entries = Object.entries(merged).filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
}
