import type { ProviderInteractionPort } from '@/core/execution';
import type { InlineInteractionPrompts } from '@/features/chat/interactions/InlineInteractionPrompts';
import type { ChatState } from '@/features/chat/state/ChatState';

type InteractionPrompts = Pick<InlineInteractionPrompts, 'requestApproval' | 'askUserQuestion' | 'dismiss'>;

/** Maps provider requests to prompts and retains attention for the current prompt instance. */
export function createInteractionPromptPort(
  state: ChatState,
  getPrompts: () => InteractionPrompts,
): ProviderInteractionPort {
  const pending = new Map<string, object>();
  const track = async <T>(id: string, show: (prompts: InteractionPrompts) => Promise<T>): Promise<T> => {
    const prompts = getPrompts();
    const token = {};
    pending.set(id, token);
    state.beginActionRequired(id);
    try {
      return await show(prompts);
    } finally {
      if (pending.get(id) === token) {
        pending.delete(id);
        state.endActionRequired(id);
      }
    }
  };
  return {
    requestApproval: (request, signal) => track(request.interactionId, async prompts => ({
      interactionId: request.interactionId,
      decision: await prompts.requestApproval(request.interactionId, request.toolName, { ...request.input }, request.description, {
        ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
        ...(request.blockedPath ? { blockedPath: request.blockedPath } : {}),
        ...(request.decisionOptions ? { decisionOptions: request.decisionOptions.map(option => ({ ...option })) } : {}),
      }, signal),
    })),
    askUserQuestion: (request, signal) => track(request.interactionId, async prompts => ({
      interactionId: request.interactionId,
      answers: await prompts.askUserQuestion(request.interactionId, { ...request.input }, signal),
    })),
    dismissInteraction: id => {
      getPrompts().dismiss(id);
      pending.delete(id);
      state.endActionRequired(id);
    },
  };
}
