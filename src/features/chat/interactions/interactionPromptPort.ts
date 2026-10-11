import type { ProviderInteractionPort } from '@/core/execution';
import type { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';

type InteractionPrompts = Pick<SessionInteractions, 'requestApproval' | 'askUserQuestion' | 'dismiss'>;

/** Adapts provider payloads; pending requests and attention belong to the session store. */
export function createInteractionPromptPort(
  getPrompts: () => InteractionPrompts,
): ProviderInteractionPort {
  return {
    requestApproval: async (request, signal) => ({
      interactionId: request.interactionId,
      decision: await getPrompts().requestApproval(request.interactionId, request.toolName, { ...request.input }, request.description, {
        ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
        ...(request.blockedPath ? { blockedPath: request.blockedPath } : {}),
        ...(request.decisionOptions ? { decisionOptions: request.decisionOptions.map(option => ({ ...option })) } : {}),
      }, signal),
    }),
    askUserQuestion: async (request, signal) => ({
      interactionId: request.interactionId,
      answers: await getPrompts().askUserQuestion(request.interactionId, { ...request.input }, signal),
    }),
    dismissInteraction: id => {
      getPrompts().dismiss(id);
    },
  };
}
