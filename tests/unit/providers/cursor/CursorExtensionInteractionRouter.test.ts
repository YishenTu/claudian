import { CursorExtensionInteractionRouter } from '@/providers/cursor/execution/CursorExtensionInteractionRouter';

describe('CursorExtensionInteractionRouter', () => {
  it('maps Cursor questions to the shared interaction interface', async () => {
    const interactionPort = {
      askUserQuestion: jest.fn(async (request) => ({
        answers: { q1: 'plan' },
        interactionId: request.interactionId,
      })),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
      requestPlanDecision: jest.fn(),
    };
    const router = new CursorExtensionInteractionRouter(
      interactionPort as never,
      'session-instance',
      () => 'turn-1',
    );

    await expect(router.handle('cursor/ask_question', {
      questions: [{
        allowMultiple: false,
        id: 'q1',
        options: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }],
        prompt: 'Which mode?',
      }],
      toolCallId: 'call-1',
    })).resolves.toEqual({
      outcome: {
        answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }],
        outcome: 'answered',
      },
    });
  });

  it('returns the Cursor plan approval response shape', async () => {
    const interactionPort = {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
      requestPlanDecision: jest.fn(async (request) => ({
        decision: { type: 'approve' },
        interactionId: request.interactionId,
      })),
    };
    const router = new CursorExtensionInteractionRouter(
      interactionPort as never,
      'session-instance',
      () => 'turn-1',
    );

    await expect(router.handle('cursor/create_plan', {
      plan: '# Plan',
      todos: [],
      toolCallId: 'call-2',
    })).resolves.toEqual({ outcome: { outcome: 'accepted' } });
  });
});
