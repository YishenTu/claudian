import type { ChatMessage } from '../../core/types';

export interface RewindContext {
  prevAssistantUuid: string | undefined;
  hasResponse: boolean;
}

/**
 * Scans around a user message to find the previous assistant UUID (rewind target)
 * and whether a response with a UUID follows it (proving the SDK processed it).
 */
export function findRewindContext(messages: ChatMessage[], userIndex: number): RewindContext {
  let prevAssistantUuid: string | undefined;
  for (let i = userIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].assistantMessageId) {
      prevAssistantUuid = messages[i].assistantMessageId;
      break;
    }
  }

  let hasResponse = false;
  for (let i = userIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') break;
    if (messages[i].role === 'assistant' && messages[i].assistantMessageId) {
      hasResponse = true;
      break;
    }
  }

  return { prevAssistantUuid, hasResponse };
}
