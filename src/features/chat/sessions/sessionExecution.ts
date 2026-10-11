import type { Conversation } from '@/core/types';

export function createConversationExecutionBinding(conversation: Conversation) {
  return {
    conversationId: conversation.id,
    providerId: conversation.providerId,
    resumeSeed: {
      ...(conversation.sessionId ? { providerSessionId: conversation.sessionId } : {}),
      ...(conversation.providerState ? { providerState: conversation.providerState } : {}),
      ...(conversation.resumeAtMessageId
        ? { resumeCheckpoint: conversation.resumeAtMessageId }
        : {}),
    },
  };
}
