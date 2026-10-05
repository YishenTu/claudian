import type { ProviderExecutionEvent } from '@/core/execution';
import type { ChatTurnMessageBinding, ChatTurnSubmission } from '@/features/chat/execution/ChatExecutionCoordinator';

/** Native identity a requested turn learns from its provider events. */
export interface RequestedTurnIdentity {
  readonly accepted: boolean;
  readonly nativeUserMessageId?: string;
  readonly nativeAssistantMessageId?: string;
  readonly nativeCheckpointId?: string;
  /** The submitted user message was echoed; a later echo starts a steered exchange. */
  readonly sawSubmittedUserMessage: boolean;
  /** Cleared at a steer boundary: later messages belong to the steered exchange, not this submission's pair. */
  readonly bindsSubmittedMessages: boolean;
}

export const INITIAL_REQUESTED_TURN_IDENTITY: RequestedTurnIdentity = {
  accepted: false,
  sawSubmittedUserMessage: false,
  bindsSubmittedMessages: true,
};

/** Returns the identity after an event; events that carry no identity return the same object. */
export function reduceRequestedTurnIdentity(
  identity: RequestedTurnIdentity,
  event: ProviderExecutionEvent,
): RequestedTurnIdentity {
  switch (event.type) {
    case 'turn_started':
      if (!event.accepted) return identity;
      return {
        ...identity,
        accepted: true,
        nativeUserMessageId: event.nativeUserMessageId ?? identity.nativeUserMessageId,
      };
    case 'user_message_started':
      if (!identity.accepted) return identity;
      if (identity.sawSubmittedUserMessage) return { ...identity, bindsSubmittedMessages: false };
      return {
        ...identity,
        sawSubmittedUserMessage: true,
        nativeUserMessageId: event.nativeUserMessageId ?? identity.nativeUserMessageId,
      };
    case 'assistant_message_started':
      return {
        ...identity,
        nativeAssistantMessageId: event.nativeAssistantId ?? identity.nativeAssistantMessageId,
      };
    case 'turn_completed':
      return {
        ...identity,
        ...(identity.bindsSubmittedMessages
          ? { nativeUserMessageId: event.nativeUserMessageId ?? identity.nativeUserMessageId }
          : {}),
        nativeAssistantMessageId: event.nativeAssistantId ?? identity.nativeAssistantMessageId,
        nativeCheckpointId: event.nativeCheckpointId ?? identity.nativeCheckpointId,
      };
    default:
      return identity;
  }
}

/** Writes the identity learned so far onto the submitted pair while the turn still owns it. */
export function attachRequestedTurnIdentity(
  messages: ChatTurnMessageBinding | undefined,
  identity: RequestedTurnIdentity,
): void {
  if (!messages || !identity.bindsSubmittedMessages) return;
  if (identity.nativeUserMessageId) messages.user.userMessageId = identity.nativeUserMessageId;
  // A provider without assistant message ids anchors the response at its checkpoint.
  const assistantId = identity.nativeAssistantMessageId ?? identity.nativeCheckpointId;
  if (assistantId) messages.assistant.assistantMessageId = assistantId;
}

/** Records what an accepted submission sent on its user message, with its native id once known. */
export function attachAcceptedSubmission(
  submission: ChatTurnSubmission,
  nativeUserMessageId: string | undefined,
): void {
  const user = submission.messages?.user;
  if (!user) return;
  user.displayContent = submission.rawDisplayText;
  user.images = [...submission.images];
  user.executionInput = {
    schemaVersion: 1,
    canonicalText: submission.canonicalText,
    ...(submission.context ? { context: submission.context } : {}),
  };
  if (nativeUserMessageId) user.userMessageId = nativeUserMessageId;
}
