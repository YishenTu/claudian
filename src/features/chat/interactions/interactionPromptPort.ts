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
      value: await getPrompts().requestApproval(request, signal),
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
