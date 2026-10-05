import type { ChatExecutionCoordinator, ChatTurnSubmission } from '@/features/chat/execution/ChatExecutionCoordinator';
import { ChatExecutionPreHandoffError } from '@/features/chat/execution/ChatExecutionCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';
import type { QueuedMessage } from '@/features/chat/state/types';
import { TurnSteering } from '@/features/chat/turns/TurnSteering';

const FAILED_TO_STEER = 'Failed to steer the queued message. It is still available.';
const UNCONFIRMED = 'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.';

function createHarness() {
  const state = new ChatState({});
  state.currentConversationId = 'conversation-1';
  const coordinator = {
    steer: jest.fn(),
    acceptSteerFromProviderEvent: jest.fn().mockResolvedValue(true),
    releaseSteerCorrelation: jest.fn(),
  };
  const returnUnsent = jest.fn();
  const reportFailure = jest.fn();
  const steering = new TurnSteering({
    state,
    turns: { isResponding: true },
    getExecutionCoordinator: () => coordinator as unknown as ChatExecutionCoordinator,
    getCapabilities: () => ({ supportsTurnSteer: true }) as never,
    toQueuedChatTurn: message => ({ displayContent: message.content, request: { ...message.turnRequest } }),
    createSubmission: displayContent => ({
      submissionId: `submission-${displayContent}`,
      timestamp: 0,
      rawDisplayText: displayContent,
      canonicalText: displayContent,
      images: [],
      configuration: { model: 'model' } as ChatTurnSubmission['configuration'],
      toolPolicy: {} as ChatTurnSubmission['toolPolicy'],
    }),
    onVisibleSteerChanged: jest.fn(),
    returnUnsent,
  });
  const message: QueuedMessage = {
    content: 'follow up',
    onDelivery: jest.fn(),
    turnRequest: { text: 'follow up' } as QueuedMessage['turnRequest'],
  };
  return { coordinator, message, reportFailure, returnUnsent, steering };
}

describe('TurnSteering.steer', () => {
  it('marks an accepted steer as awaiting provider correlation without requeueing it', async () => {
    const { coordinator, message, reportFailure, steering } = createHarness();
    coordinator.steer.mockResolvedValue({ delivery: 'accepted' });

    const pending = await steering.steer(message, reportFailure);

    expect(pending).toMatchObject({
      providerDisposition: 'accepted-awaiting-correlation',
      correlationState: 'pending',
      uiState: 'cleared',
    });
    expect(message.onDelivery).toHaveBeenCalledWith(true);
    expect(steering.current).toBe(pending);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('treats a declined steer as definitely unsent without a failure notice', async () => {
    const { coordinator, message, reportFailure, steering } = createHarness();
    coordinator.steer.mockResolvedValue({ delivery: 'not-sent' });

    const pending = await steering.steer(message, reportFailure);

    expect(pending.providerDisposition).toBe('definitely-unsent');
    expect(pending.uiState).toBe('visible');
    expect(message.onDelivery).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('reports a failed pre-handoff steer as still available', async () => {
    const { coordinator, message, reportFailure, steering } = createHarness();
    coordinator.steer.mockResolvedValue({
      delivery: 'not-sent',
      error: new ChatExecutionPreHandoffError(new Error('ledger unavailable')),
    });

    const pending = await steering.steer(message, reportFailure);

    expect(pending.providerDisposition).toBe('definitely-unsent');
    expect(reportFailure).toHaveBeenCalledWith(FAILED_TO_STEER);
  });

  it('keeps an uncertain steer registered for provider reconciliation', async () => {
    const { coordinator, message, reportFailure, steering } = createHarness();
    coordinator.steer.mockResolvedValue({ delivery: 'uncertain', error: new Error('transport closed') });

    const pending = await steering.steer(message, reportFailure);

    expect(pending).toMatchObject({
      providerDisposition: 'ambiguous-awaiting-reconciliation',
      uiState: 'cleared',
    });
    expect(steering.current).toBe(pending);
    expect(coordinator.releaseSteerCorrelation).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(UNCONFIRMED);
    expect(reportFailure).not.toHaveBeenCalledWith(FAILED_TO_STEER);
  });

  it.each([
    ['not sent', { delivery: 'not-sent' }],
    ['failed before handoff', { delivery: 'not-sent', error: new ChatExecutionPreHandoffError('late cleanup failed') }],
    ['uncertain', { delivery: 'uncertain', error: new Error('acknowledgement lost') }],
  ])('does not let a %s result downgrade a provider echo received during the request', async (_label, outcome) => {
    const { coordinator, message, reportFailure, returnUnsent, steering } = createHarness();
    let resolveSteer!: (value: unknown) => void;
    coordinator.steer.mockReturnValue(new Promise(resolve => { resolveSteer = resolve; }));

    const steer = steering.steer(message, reportFailure);
    for (let attempt = 0; attempt < 10 && coordinator.steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(coordinator.steer).toHaveBeenCalledTimes(1);
    const claim = await steering.claimProviderEcho('native-user');
    resolveSteer(outcome);
    const pending = await steer;
    steering.restoreIfDefinitelyUnsent(pending);

    expect(claim.expected).toMatchObject({ displayContent: 'follow up' });
    expect(pending.providerDisposition).toBe('accepted-awaiting-correlation');
    expect(returnUnsent).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });
});
