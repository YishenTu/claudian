import { createFixture, deferred, requestedUserMessageStarted, waitForCall } from '@test/helpers/ChatInputHarness';
import { Notice } from 'obsidian';

import type { ProviderExecutionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ChatExecutionPreHandoffError, type ChatSteerOutcome, type ChatTurnSubmission } from '@/features/chat/execution/ChatExecutionCoordinator';
import { createQueuedMessage } from '@/features/chat/state/chatTurnRequest';

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    formatQuestionReply: jest.fn(),
    resolveTitleGenerationSelection: jest.fn().mockReturnValue(null),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    }),
  },
}));

describe('TurnQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    } as any);

  });

  it('reschedules an automatically queued turn after intent admission reopens', async () => {
    let canStart = false;
    const fixture = createFixture({ canStartTurn: () => canStart });
    const scheduled: Array<() => void> = [];
    const timeoutSpy = jest.spyOn(window, 'setTimeout').mockImplementation((callback: any) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof window.setTimeout>;
    });
    fixture.controller.queue.enqueue(createQueuedMessage('queued during close', { text: 'queued during close' }));

    expect(fixture.controller.queue.scheduleContinuation()).toBe(true);
    scheduled.shift()?.();
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued during close' });

    canStart = true;
    fixture.controller.resumeQueuedTurnAfterIntentAdmission();
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued during close' });
    scheduled.shift()?.();
    await waitForCall(fixture.coordinator.execute);
    expect(fixture.state.queuedMessage).toBeNull();

    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
    timeoutSpy.mockRestore();
  });

  it('queues while streaming and steers through the coordinator', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = 'follow up';

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.coordinator.steer.mock.calls[0][0]).toMatchObject({
      canonicalText: 'follow up',
      rawDisplayText: 'follow up',
    });
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it('restores a queued message only after definite steer rejection', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = 'definitely unsent';
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'not-sent' });

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.state.queuedMessage).toMatchObject({
      content: 'definitely unsent',
    });
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('restores a queued message after typed definite pre-handoff steer failure', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = 'staging failed';
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'not-sent', error: new ChatExecutionPreHandoffError(new Error('ledger unavailable')) });

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.state.queuedMessage).toMatchObject({ content: 'staging failed' });
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect(Notice).toHaveBeenCalledWith(
      'Failed to steer the queued message. It is still available.',
    );
  });

  it('does not requeue an ambiguously delivered steer and retains provider correlation', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = 'possibly delivered';
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'uncertain', error: new Error('transport closed') });

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    await fixture.controller.queue.steerNow();

    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        expectedProviderMessage: expect.objectContaining({ displayContent: 'possibly delivered' }),
        providerDisposition: 'ambiguous-awaiting-reconciliation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
    expect(Notice).toHaveBeenCalledWith(
      'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.',
    );
  });

  it('does not make a definitely accepted steer retryable while provider correlation is pending', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = 'accepted before binding changed';
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'accepted' });

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        expectedProviderMessage: expect.objectContaining({
          displayContent: 'accepted before binding changed',
        }),
        providerDisposition: 'accepted-awaiting-correlation',
      });
  });

  it('does not restore an awaiting steer when cancellation races definite acceptance', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.holdResponse();
    fixture.input.value = 'accepted while cancelling';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();

    nativeResult.resolve({ delivery: 'accepted' });
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        providerDisposition: 'accepted-awaiting-correlation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
  });

  it('restores an awaiting steer exactly once when cancellation races definite rejection', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.holdResponse();
    fixture.input.value = 'rejected while cancelling';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();
    nativeResult.resolve({ delivery: 'not-sent' });
    await steer;
    fixture.controller.cancelStreaming();

    expect(fixture.input.value).toBe('rejected while cancelling');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('does not restore an awaiting steer when cancellation races ambiguous rejection', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.holdResponse();
    fixture.input.value = 'unknown while cancelling';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();
    nativeResult.resolve({ delivery: 'uncertain', error: new Error('transport closed') });
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        providerDisposition: 'ambiguous-awaiting-reconciliation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
  });

  it('keeps stale definite acceptance non-retryable in its originating conversation', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.holdResponse();
    fixture.input.value = 'accepted before switch';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    nativeResult.resolve({ delivery: 'accepted' });
    await steer;

    expect(fixture.linkedContentController.beginSubmission).not.toHaveBeenCalled();
    expect(fixture.linkedContentController.commitSubmission).not.toHaveBeenCalled();
    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        providerDisposition: 'accepted-awaiting-correlation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-2'))
      .toBe(false);
  });

  it('parks stale definite rejection with conversation A until A is active again', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    const releaseTurn = fixture.holdResponse();
    fixture.input.value = 'conversation A retry';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    await releaseTurn();
    fixture.input.value = 'conversation B draft';
    nativeResult.resolve({ delivery: 'not-sent' });
    await steer;

    expect(fixture.input.value).toBe('conversation B draft');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        providerDisposition: 'definitely-unsent',
        retryState: 'parked',
      });

    fixture.state.currentConversationId = 'conversation-1';
    fixture.input.value = '';
    fixture.controller.onConversationActivated();
    fixture.controller.onConversationActivated();

    expect(fixture.input.value).toBe('conversation A retry');
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('parks a definite rejection that settles inside the conversation switch window', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    const releaseTurn = fixture.holdResponse();
    fixture.input.value = 'conversation A retry';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    jest.spyOn(fixture.state, 'isSwitchingConversation', 'get').mockReturnValue(true);
    nativeResult.resolve({ delivery: 'not-sent' });
    await steer;

    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    jest.spyOn(fixture.state, 'isSwitchingConversation', 'get').mockReturnValue(false);
    await releaseTurn();
    fixture.controller.onConversationActivated();
    fixture.controller.onConversationActivated();
    expect(fixture.input.value).toBe('conversation A retry');
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('keeps B queue independent while typed pre-handoff retry for A is parked', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    const releaseTurn = fixture.holdResponse();
    fixture.input.value = 'conversation A typed retry';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    fixture.input.value = 'conversation B queued';
    await fixture.controller.sendMessage();
    nativeResult.resolve({ delivery: 'not-sent', error: new ChatExecutionPreHandoffError(new Error('A cleanup failed')) });
    await steer;

    expect(fixture.state.queuedMessage).toMatchObject({ content: 'conversation B queued' });
    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    fixture.controller.cancelStreaming();
    expect(fixture.input.value).toBe('conversation B queued');
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    fixture.state.currentConversationId = 'conversation-1';
    await releaseTurn();
    fixture.input.value = '';
    fixture.controller.onConversationActivated();
    expect(fixture.input.value).toBe('conversation A typed retry');
  });

  it.each([
    ['accepted', { delivery: 'accepted' }],
    ['ambiguous', { delivery: 'uncertain', error: new Error('steer response lost') }],
  ])('does not schedule a retry when the main turn completes before a %s steer result', async (
    _label,
    steerOutcome,
  ) => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<ChatSteerOutcome>();
    const timeoutSpy = jest.spyOn(window, 'setTimeout').mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setTimeout>,
    );
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = `${_label} steer`;
    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);

    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;
    nativeResult.resolve(steerOutcome as ChatSteerOutcome);
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    timeoutSpy.mockRestore();
  });

  it('restores exactly once when turn completion races definite steer rejection', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<ChatSteerOutcome>();
    const timeoutSpy = jest.spyOn(window, 'setTimeout').mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setTimeout>,
    );
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = 'definitely rejected steer';
    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;
    nativeResult.resolve({ delivery: 'not-sent' });
    await steer;

    expect(fixture.input.value).toBe('definitely rejected steer');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    timeoutSpy.mockRestore();
  });

  it('blocks queued steer B while ambiguous steer A still owns provider correlation', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = 'ambiguous A';
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'uncertain', error: new Error('A response lost') });

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    fixture.input.value = 'queued B';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued B' });
    expect((fixture.controller as any).steering.pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        expectedProviderMessage: expect.objectContaining({ displayContent: 'ambiguous A' }),
        providerDisposition: 'ambiguous-awaiting-reconciliation',
      });
  });

  it('releases an ambiguous steer lane to durable history at the fenced turn boundary', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'uncertain', error: new Error('A response lost') });
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = 'ambiguous A';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(true);

    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;

    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    fixture.holdResponse();
    fixture.input.value = 'later steer B';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'keeps early live acceptance authoritative across delayed %s and cancellation',
    async (nativeAccepted) => {
      const fixture = createFixture();
      const mainResult = deferred<{
        accepted: boolean;
        status: 'completed';
      }>();
      const nativeResult = deferred<ChatSteerOutcome>();
      fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
      fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
      fixture.input.value = 'main turn';
      const mainTurn = fixture.controller.sendMessage();
      await waitForCall(fixture.coordinator.execute);
      await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
      fixture.input.value = 'early accepted steer';

      await fixture.controller.sendMessage();
      const steer = fixture.controller.queue.steerNow();
      await waitForCall(fixture.coordinator.steer);
      const submission = fixture.coordinator.steer.mock.calls[0][0] as ChatTurnSubmission;
      await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
        'provider-formatted steer',
        2,
        'native-steer-user',
      ));
      fixture.controller.cancelStreaming();
      nativeResult.resolve(nativeAccepted ? { delivery: 'accepted' } : { delivery: 'not-sent' });
      mainResult.resolve({ accepted: true, status: 'completed' });
      await steer;
      await mainTurn;

      expect(fixture.coordinator.acceptSteerFromProviderEvent).toHaveBeenCalledWith(
        submission.submissionId,
        'native-steer-user',
      );
      expect(fixture.state.messages.filter(message => (
        message.role === 'user' && message.displayContent === 'early accepted steer'
      ))).toHaveLength(1);
      expect(fixture.state.messages.find(message => (
        message.role === 'user' && message.displayContent === 'early accepted steer'
      ))).toMatchObject({ userMessageId: 'native-steer-user' });
      expect(fixture.input.value).toBe('');
      expect(fixture.state.queuedMessage).toBeNull();
      expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
        .toBe(false);
      expect(fixture.coordinator.releaseSteerCorrelation).toHaveBeenCalledWith(
        submission.submissionId,
      );
    },
  );

  it('enriches ack-before-live persistence and canonical message identity', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'accepted' });
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'acknowledged before live event';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    const submission = fixture.coordinator.steer.mock.calls[0][0] as ChatTurnSubmission;

    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
      'native-after-ack',
    ));

    expect(fixture.coordinator.acceptSteerFromProviderEvent).toHaveBeenCalledWith(
      submission.submissionId,
      'native-after-ack',
    );
    expect(fixture.state.messages.find(message => (
      message.role === 'user' && message.displayContent === 'acknowledged before live event'
    ))).toMatchObject({
      content: 'acknowledged before live event',
      userMessageId: 'native-after-ack',
    });
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;
  });

  it('releases ack-before-live correlation to history when no live event arrives', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'accepted' });
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = 'accepted without live event';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    const submission = fixture.coordinator.steer.mock.calls[0][0] as ChatTurnSubmission;

    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;

    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect(fixture.coordinator.releaseSteerCorrelation).toHaveBeenCalledWith(
      submission.submissionId,
    );
  });

  it.each([
    ['raw acknowledgement loss', { delivery: 'uncertain', error: new Error('acknowledgement lost') }],
    [
      'typed pre-handoff failure',
      { delivery: 'not-sent', error: new ChatExecutionPreHandoffError(new Error('late cleanup failed')) },
    ],
  ])('does not let %s downgrade early acceptance after a stale binding', async (
    _label,
    nativeOutcome,
  ) => {
    let activeCoordinator: ReturnType<typeof createFixture>['coordinator'];
    const fixture = createFixture({
      getExecutionCoordinator: () => activeCoordinator,
    });
    activeCoordinator = fixture.coordinator;
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';
    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'accepted before switch';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    const replacementCoordinator = {
      ...fixture.coordinator,
      acceptSteerFromProviderEvent: jest.fn().mockResolvedValue(true),
      releaseSteerCorrelation: jest.fn(),
    };
    activeCoordinator = replacementCoordinator;
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
    ));
    fixture.state.currentConversationId = 'conversation-2';
    fixture.input.value = 'conversation B draft';
    nativeResult.resolve(nativeOutcome as ChatSteerOutcome);
    mainResult.resolve({ accepted: true, status: 'completed' });
    await steer;
    await mainTurn;

    expect(fixture.input.value).toBe('conversation B draft');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect(fixture.coordinator.acceptSteerFromProviderEvent).toHaveBeenCalledTimes(1);
    expect(replacementCoordinator.acceptSteerFromProviderEvent).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalledWith(
      'Failed to steer the queued message. It is still available.',
    );
  });

  it('admits a later steer after terminal cleanup when an early-accepted result never settles', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer
      .mockReturnValueOnce(nativeResult.promise)
      .mockResolvedValueOnce({ delivery: 'accepted' });
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'never-settling accepted steer';
    await fixture.controller.sendMessage();
    void fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
    ));

    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    fixture.holdResponse();
    fixture.input.value = 'later steer';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(2);
  });

  it('renders accepted live input once and remains non-retryable when acceptance persistence fails', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.coordinator.acceptSteerFromProviderEvent.mockRejectedValueOnce(
      new Error('accept save failed'),
    );
    fixture.input.value = 'main turn';
    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'accepted despite save failure';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    await expect(fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
      'native-steer-user',
    ))).rejects.toThrow('accept save failed');
    nativeResult.resolve({ delivery: 'not-sent' });
    mainResult.resolve({ accepted: true, status: 'completed' });
    await steer;
    await mainTurn;

    expect(fixture.state.messages.filter(message => (
      message.role === 'user' && message.displayContent === 'accepted despite save failure'
    ))).toHaveLength(1);
    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('uses a matching live steer boundary before releasing its provider correlation', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'uncertain', error: new Error('steer acknowledgement lost') });
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent({
      content: 'main turn',
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sequence: 1,
        sessionInstanceId: 'session-1',
        turnId: 'turn-1',
      },
      type: 'user_message_started',
    });

    fixture.input.value = 'ambiguous live steer';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    await fixture.controller.handleExecutionEvent({
      content: 'provider-formatted steer',
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sequence: 2,
        sessionInstanceId: 'session-1',
        turnId: 'turn-1',
      },
      type: 'user_message_started',
    });

    expect(fixture.state.messages.filter(message => message.role === 'user').at(-1))
      .toMatchObject({
        content: 'ambiguous live steer',
        displayContent: 'ambiguous live steer',
      });
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    mainResult.resolve({ accepted: true, status: 'completed' });
    await mainTurn;
  });

  it('restores once and removes impossible correlation after typed rejected-steer cleanup failure', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<ChatSteerOutcome>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.holdResponse();
    fixture.input.value = 'retry after cleanup failure';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();
    nativeResult.resolve({ delivery: 'not-sent', error: new ChatExecutionPreHandoffError(new Error('discard save failed')) });
    await steer;
    fixture.controller.cancelStreaming();

    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.input.value).toBe('retry after cleanup failure');
    expect((fixture.controller as any).steering.pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('reports deferred review when the continuation fails before handoff', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    // The first turn settles while a continuation owns queued work.
    jest.spyOn(fixture.controller.queue, 'scheduleContinuation').mockReturnValueOnce(true);

    await fixture.controller.sendMessage({ content: 'first turn' });
    expect(onReviewableSettlement).not.toHaveBeenCalled();
    fixture.coordinator.execute.mockRejectedValueOnce(
      new ChatExecutionPreHandoffError('continuation not handed off'),
    );

    await fixture.controller.sendMessage({ content: 'continue' });

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('reports deferred review when continuation initialization fails', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    // The first turn settles while a continuation owns queued work.
    jest.spyOn(fixture.controller.queue, 'scheduleContinuation').mockReturnValueOnce(true);

    await fixture.controller.sendMessage({ content: 'first turn' });
    jest.mocked(fixture.deps.ensureExecutionInitialized!).mockResolvedValueOnce(false);

    await fixture.controller.sendMessage({ content: 'continue' });

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('reports deferred review when continuation exits during preflight', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    // The first turn settles while a continuation owns queued work.
    jest.spyOn(fixture.controller.queue, 'scheduleContinuation').mockReturnValueOnce(true);

    await fixture.controller.sendMessage({ content: 'first turn' });
    jest.spyOn(fixture.state, 'isRewinding', 'get').mockReturnValue(true);

    await fixture.controller.sendMessage({ content: 'continue' });

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });
});

const requestedTurnCompleted: ProviderExecutionEvent = {
  type: 'turn_completed', reason: 'completed',
  scope: { kind: 'requested', executionId: 'e', turnId: 't', sessionInstanceId: 's', sequence: 1 },
};

it('does not lose a cancel to native completion when a rejected steer settles afterwards', async () => {
  const fixture = createFixture();
  const turn = deferred<{ accepted: boolean; status: string }>();
  const steerResult = deferred<ChatSteerOutcome>();
  fixture.coordinator.execute.mockReturnValueOnce(turn.promise);
  fixture.coordinator.steer.mockReturnValueOnce(steerResult.promise);
  const active = fixture.controller.sendMessage({ content: 'Work' });
  await waitForCall(fixture.coordinator.execute);
  fixture.input.value = 'steer me';
  await fixture.controller.sendMessage();
  const steer = fixture.controller.queue.steerNow();
  await waitForCall(fixture.coordinator.steer);

  fixture.controller.cancelStreaming();
  await fixture.controller.handleExecutionEvent(requestedTurnCompleted);
  steerResult.resolve({ delivery: 'not-sent' });
  await steer;
  turn.resolve({ accepted: true, status: 'completed' });
  await active;
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
  expect(fixture.state.queuedMessage).toBeNull();
  expect(fixture.input.value).toBe('steer me');
});

it('queuing another input must retain the running turn drain handle', async () => {
  const fixture = createFixture();
  const gate = deferred<{ accepted: boolean; status: string }>();
  fixture.coordinator.execute.mockImplementationOnce(() => gate.promise as any);
  const first = fixture.controller.sendMessage({ content: 'first turn' });
  await waitForCall(fixture.coordinator.execute);
  try {
    await fixture.controller.sendMessage({ content: 'queued follow-up' });
    expect(fixture.state.queuedMessage?.content).toBe('queued follow-up');
    expect(fixture.state.isStreaming).toBe(true);
    let cancellationDrainFinished = false;
    const drain = fixture.controller.cancelStreamingAndWait().then(() => { cancellationDrainFinished = true; });
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    expect(cancellationDrainFinished).toBe(false);
    void drain;
  } finally {
    fixture.controller.queue.clear();
    gate.resolve({ accepted: true, status: 'completed' });
    await first;
  }
});
