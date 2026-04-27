import type { Conversation } from '../../core/types';

export interface CursorProviderState {
  /** Cursor Agent chat / session id (folder name under ~/.cursor/chats/<workspaceHash>/). */
  chatSessionId?: string;
}

export function getCursorState(providerState: Record<string, unknown> | undefined): CursorProviderState {
  if (!providerState) {
    return {};
  }
  const chatSessionId = providerState.chatSessionId;
  return {
    ...(typeof chatSessionId === 'string' && chatSessionId.trim()
      ? { chatSessionId: chatSessionId.trim() }
      : {}),
  };
}

export function resolveCursorSessionId(
  conversation: Pick<Conversation, 'sessionId' | 'providerState'> | null,
): string | null {
  if (!conversation) {
    return null;
  }
  const fromState = getCursorState(conversation.providerState).chatSessionId;
  if (fromState) {
    return fromState;
  }
  return conversation.sessionId;
}
