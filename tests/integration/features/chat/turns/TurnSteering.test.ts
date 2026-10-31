import { createHarness as createExecutionHarness, createSubmission, deferred } from '@test/helpers/ChatExecutionHarness';

import { ChatState } from '@/features/chat/state/ChatState';
import type { QueuedMessage } from '@/features/chat/state/types';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { TurnSteering } from '@/features/chat/turns/TurnSteering';
import { claudeProviderRegistration } from '@/providers/claude/registration';

const FAILED_TO_STEER = 'Failed to steer the queued message. It is still available.';
const UNCONFIRMED = 'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.';

async function createHarness() {
  const execution = createExecutionHarness();
  const coordinator = execution.coordinator;
  const turns = new TurnCoordinator();
  const state = new ChatState({}, undefined, turns);
  state.currentConversationId = 'conversation-1';
  await coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await coordinator.prepare();
  const native = execution.backends.get('claude')!.sessions[0];
  const active = turns.run(async signal => {
    turns.beginResponse();
    await coordinator.execute(createSubmission(), signal);
  });
  await native.waitForRun();
  onTestFinished(async () => {
    coordinator.cancel();
    await active;
    await coordinator.dispose();
    await execution.registry.dispose();
  });
  const returnUnsent = vi.fn();
  const reportFailure = vi.fn();
  const steering = new TurnSteering({
    state, turns,
    getExecutionCoordinator: () => coordinator,
    getCapabilities: () => ({ ...claudeProviderRegistration.capabilities, supportsTurnSteer: true }),
    toQueuedChatTurn: message => ({ displayContent: message.content, request: { ...message.turnRequest } }),
    createSubmission: (displayContent, request) => createSubmission({
      submissionId: `submission-${displayContent}`,
      rawDisplayText: displayContent,
      canonicalText: request.text,
      images: request.images ?? [],
      configuration: { model: 'model', systemInstructions: coordinator.systemInstructions! },
    }),
    onVisibleSteerChanged: vi.fn(), returnUnsent,
  });
  const message: QueuedMessage = {
    content: 'follow up', onDelivery: vi.fn(), turnRequest: { text: 'follow up' },
  };
  expect(steering.canSteer).toBe(true);
  return { coordinator, execution, native, message, reportFailure, returnUnsent, steering };
}

describe('TurnSteering.steer', () => {
  it('captures submitted input synchronously when its echo precedes the acknowledgement', async () => {
    const { coordinator, native, message, returnUnsent, steering } = await createHarness();
    const acknowledgement = deferred<boolean>();
    native.steerResponse.mockReturnValueOnce(acknowledgement.promise);
    const image = { id: 'image', name: 'pixel.png', mediaType: 'image/png' as const, data: 'aW1hZ2U=', size: 5, source: 'paste' as const };
    message.turnRequest = { text: 'expanded submitted text', images: [image] };
    const steeringResult = steering.steer(message);
    message.turnRequest.text = 'Edited after submission';
    await native.waitForSteer();
    steering.finishTurn('conversation-1');
    const claim = steering.claimProviderEcho('late-user');
    expect(claim.expected).toMatchObject({ displayContent: 'follow up', persistedContent: 'expanded submitted text', images: [image] });
    acknowledgement.resolve(true);
    const pending = await steeringResult;
    await claim.acceptance;
    claim.settle();
    steering.restoreIfDefinitelyUnsent(pending);
    expect(steering.current).toBeNull();
    expect(returnUnsent).not.toHaveBeenCalled();
    expect(coordinator.getSteerSubmission('submission-follow up')).toBeUndefined();
    expect(native.steerRequests[0].input).toEqual([{ type: 'text', text: 'expanded submitted text' }, { type: 'image', image }]);
  });

  it('marks an accepted steer as awaiting provider correlation without requeueing it', async () => {
    const { native, message, reportFailure, steering } = await createHarness();
    native.steerResponse.mockResolvedValueOnce(true);

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
    const { native, message, reportFailure, steering } = await createHarness();
    native.steerResponse.mockResolvedValueOnce(false);

    const pending = await steering.steer(message, reportFailure);

    expect(pending.providerDisposition).toBe('definitely-unsent');
    expect(pending.uiState).toBe('visible');
    expect(message.onDelivery).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('reports a failed pre-handoff steer as still available', async () => {
    const { execution, message, reportFailure, steering } = await createHarness();
    execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('ledger unavailable'));

    const pending = await steering.steer(message, reportFailure);

    expect(pending.providerDisposition).toBe('definitely-unsent');
    expect(reportFailure).toHaveBeenCalledWith(FAILED_TO_STEER);
  });

  it('keeps an uncertain steer registered for provider reconciliation', async () => {
    const { coordinator, native, message, reportFailure, steering } = await createHarness();
    native.steerResponse.mockRejectedValueOnce(new Error('transport closed'));

    const pending = await steering.steer(message, reportFailure);

    expect(pending).toMatchObject({
      providerDisposition: 'ambiguous-awaiting-reconciliation',
      uiState: 'cleared',
    });
    expect(steering.current).toBe(pending);
    expect(coordinator.getSteerSubmission('submission-follow up')).toMatchObject({ canonicalText: 'follow up' });
    expect(reportFailure).toHaveBeenCalledWith(UNCONFIRMED);
    expect(reportFailure).not.toHaveBeenCalledWith(FAILED_TO_STEER);
  });

  it.each([
    ['not sent', false],
    ['uncertain', new Error('acknowledgement lost')],
  ])('does not let a %s result downgrade a provider echo received during the request', async (_label, outcome) => {
    const { native, message, reportFailure, returnUnsent, steering } = await createHarness();
    const acknowledgement = deferred<boolean>();
    native.steerResponse.mockReturnValueOnce(acknowledgement.promise);

    const steer = steering.steer(message, reportFailure);
    await native.waitForSteer();
    const claim = steering.claimProviderEcho('native-user');
    await claim.acceptance;
    if (outcome instanceof Error) acknowledgement.reject(outcome);
    else acknowledgement.resolve(false);
    const pending = await steer;
    steering.restoreIfDefinitelyUnsent(pending);

    expect(claim.expected).toMatchObject({ displayContent: 'follow up' });
    expect(pending.providerDisposition).toBe('accepted-awaiting-correlation');
    expect(returnUnsent).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });
});
