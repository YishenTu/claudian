import '@/providers';

// @vitest-environment jsdom
import { createHarness as createExecutionHarness } from '@test/helpers/ChatExecutionHarness';
import { createFixture, deferred, requestedUserMessageStarted } from '@test/helpers/ChatInputHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { type ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { createQueuedMessage } from '@/features/chat/state/chatTurnRequest';
import { claudeProviderRegistration } from '@/providers/claude/registration';

const nativeCapabilities = ProviderRegistry.getCapabilities('claude');
beforeEach(() => {
  vi.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({ ...nativeCapabilities, supportsTurnSteer: true });
});
afterEach(() => vi.restoreAllMocks());


describe('TurnQueue', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      ...nativeCapabilities,
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    });

  });

  it('retains queued input when admission closes and allows its continuation to be rescheduled', async () => {
    let canStart = false;
    const fixture = (await createFixture({ canStartTurn: () => canStart }));
    vi.useFakeTimers();
    fixture.controller.queue.enqueue(createQueuedMessage('queued during close', { text: 'queued during close' }));

    expect(fixture.controller.queue.scheduleContinuation()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued during close' });

    canStart = true;
    fixture.controller.queue.scheduleContinuation();
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued during close' });
    await vi.advanceTimersByTimeAsync(0);
    await fixture.native.waitForRun();
    expect(fixture.state.queuedMessage).toBeNull();

    expect(fixture.native.requests).toHaveLength(1);
  });

  it('keeps queued input while execution-directory preparation has no active request to steer', async () => {
    const fixture = await createFixture();
    const projection = deferred<string>();
    const resolving = deferred<void>();
    ProviderRegistry.register('claude', { ...claudeProviderRegistration, resolveExecutionWorkingDirectory: () => {
      resolving.resolve();
      return projection.promise;
    } });
    onTestFinished(() => {
      projection.resolve('/vault');
      ProviderRegistry.register('claude', claudeProviderRegistration);
    });
    const started = fixture.controller.sendMessage({ content: 'First' });
    await resolving.promise;
    await fixture.controller.sendMessage({ content: 'Keep queued' });
    let failure: unknown;
    try { await fixture.controller.queue.steerNow(); } catch (error) { failure = error; }
    const retained = fixture.controller.queue.message?.content;
    projection.resolve('/vault');
    await started;
    expect({ failure, retained }).toEqual({ failure: undefined, retained: 'Keep queued' });
    expect(fixture.native.steerRequests).toHaveLength(0);
  });

  it('queues while streaming and steers through the coordinator', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = 'follow up';

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.native.steerRequests[0].input).toEqual([{ type: 'text', text: 'follow up' }]);
    expect(fixture.coordinator.getSteerSubmission(fixture.native.steerRequests[0].inputId!)?.rawDisplayText).toBe('follow up');
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it('restores a queued message only after definite steer rejection', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = 'definitely unsent';
    fixture.nativeSteer.mockResolvedValueOnce(false);

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.state.queuedMessage).toMatchObject({
      content: 'definitely unsent',
    });
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  it('restores a queued message after typed definite pre-handoff steer failure', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = 'staging failed';
    fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('ledger unavailable'));

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.state.queuedMessage).toMatchObject({ content: 'staging failed' });
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
    expect(Notice).toHaveBeenCalledWith(
      'Failed to steer the queued message. It is still available.',
    );
  });

  it('does not requeue an ambiguously delivered steer and retains provider correlation', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = 'possibly delivered';
    fixture.nativeSteer.mockRejectedValueOnce(new Error('transport closed'));

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    await fixture.controller.queue.steerNow();

    expect(fixture.native.steerRequests).toHaveLength(1);
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toBe('');
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
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
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = 'accepted before binding changed';
    fixture.nativeSteer.mockResolvedValueOnce(true);

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toBe('');
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        expectedProviderMessage: expect.objectContaining({
          displayContent: 'accepted before binding changed',
        }),
        providerDisposition: 'accepted-awaiting-correlation',
      });
  });

  it('does not restore an awaiting steer when cancellation races definite acceptance', async () => {
    const fixture = (await createFixture());
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    await fixture.holdResponse();
    fixture.input.value = 'accepted while cancelling';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    fixture.controller.cancelStreaming();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();

    nativeResult.resolve(true);
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        providerDisposition: 'accepted-awaiting-correlation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
  });

  it('restores an awaiting steer exactly once when cancellation races definite rejection', async () => {
    const fixture = (await createFixture());
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    await fixture.holdResponse();
    fixture.input.value = 'rejected while cancelling';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    fixture.controller.cancelStreaming();
    nativeResult.resolve(false);
    await steer;
    fixture.controller.cancelStreaming();

    expect(fixture.input.value).toBe('rejected while cancelling');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  it('does not restore an awaiting steer when cancellation races ambiguous rejection', async () => {
    const fixture = (await createFixture());
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    await fixture.holdResponse();
    fixture.input.value = 'unknown while cancelling';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    fixture.controller.cancelStreaming();
    nativeResult.reject(new Error('transport closed'));
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        providerDisposition: 'ambiguous-awaiting-reconciliation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
  });

  it('keeps stale definite acceptance non-retryable in its originating conversation', async () => {
    const fixture = (await createFixture());
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    await fixture.holdResponse();
    fixture.input.value = 'accepted before switch';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    fixture.state.currentConversationId = 'conversation-2';
    nativeResult.resolve(true);
    await steer;

    expect(fixture.linkedContentController.getSnapshot()).toEqual({ mode: 'auto-draft', path: null });
    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({
        providerDisposition: 'accepted-awaiting-correlation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-2'))
      .toBe(false);
  });

  it('parks stale definite rejection with conversation A until A is active again', async () => {
    const fixture = (await createFixture());
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    const releaseTurn = await fixture.holdResponse();
    fixture.input.value = 'conversation A retry';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    fixture.state.currentConversationId = 'conversation-2';
    await releaseTurn();
    fixture.input.value = 'conversation B draft';
    nativeResult.resolve(false);
    await steer;

    expect(fixture.input.value).toBe('conversation B draft');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({
        providerDisposition: 'definitely-unsent',
        retryState: 'parked',
      });

    fixture.state.currentConversationId = 'conversation-1';
    fixture.input.value = '';
    fixture.controller.onConversationActivated();
    fixture.controller.onConversationActivated();

    expect(fixture.input.value).toBe('conversation A retry');
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  it('keeps B queue independent while typed pre-handoff retry for A is parked', async () => {
    const fixture = (await createFixture());
    const releaseTurn = await fixture.holdResponse();
    const authority = fixture.holdNextAuthority();
    fixture.input.value = 'conversation A typed retry';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await authority.started;
    fixture.state.currentConversationId = 'conversation-2';
    fixture.input.value = 'conversation B queued';
    await fixture.controller.sendMessage();
    authority.reject(new Error('A cleanup failed'));
    await steer;

    expect(fixture.state.queuedMessage).toMatchObject({ content: 'conversation B queued' });
    expect(fixture.input.value).toBe('');
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    fixture.controller.cancelStreaming();
    expect(fixture.input.value).toBe('conversation B queued');
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
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
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    const nativeResult = deferred<boolean>();
    vi.useFakeTimers();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    fixture.input.value = `${_label} steer`;
    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();

    (await mainResult.started).complete();
    await mainTurn;
    if (steerOutcome.delivery === 'accepted') nativeResult.resolve(true);
    else if ('error' in steerOutcome) nativeResult.reject(steerOutcome.error);
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(fixture.native.requests).toHaveLength(1);
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  it('restores exactly once when turn completion races definite steer rejection', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    const nativeResult = deferred<boolean>();
    vi.useFakeTimers();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    fixture.input.value = 'definitely rejected steer';
    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    (await mainResult.started).complete();
    await mainTurn;
    nativeResult.resolve(false);
    await steer;

    expect(fixture.input.value).toBe('definitely rejected steer');
    expect(fixture.state.queuedMessage).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(fixture.native.requests).toHaveLength(1);
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  it('blocks queued steer B while ambiguous steer A still owns provider correlation', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = 'ambiguous A';
    fixture.nativeSteer.mockRejectedValueOnce(new Error('A response lost'));

    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    fixture.input.value = 'queued B';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.native.steerRequests).toHaveLength(1);
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued B' });
    expect(fixture.controller['steering']['pendingSteersByConversation'].get('conversation-1'))
      .toMatchObject({
        expectedProviderMessage: expect.objectContaining({ displayContent: 'ambiguous A' }),
        providerDisposition: 'ambiguous-awaiting-reconciliation',
      });
  });

  it('releases an ambiguous steer lane at the fenced turn boundary', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    fixture.nativeSteer.mockRejectedValueOnce(new Error('A response lost'));
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    fixture.input.value = 'ambiguous A';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();

    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(true);

    (await mainResult.started).complete();
    await mainTurn;

    expect(fixture.input.value).toBe('');
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);

    await fixture.holdResponse();
    fixture.input.value = 'later steer B';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    expect(fixture.native.steerRequests).toHaveLength(2);
  });

  it.each([true, false])(
    'keeps early live acceptance authoritative across delayed %s and cancellation',
    async (nativeAccepted) => {
      const fixture = (await createFixture());
      const mainResult = fixture.holdNextResponse();
      const nativeResult = deferred<boolean>();
        fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
      fixture.input.value = 'main turn';
      const mainTurn = fixture.controller.sendMessage();
      await fixture.native.waitForRun();
      await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
      fixture.input.value = 'early accepted steer';

      await fixture.controller.sendMessage();
      const steer = fixture.controller.queue.steerNow();
      await fixture.native.waitForSteer();
      const inputId = fixture.native.steerRequests[0].inputId!;
      await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
        'provider-formatted steer',
        2,
        'native-steer-user',
      ));
      fixture.controller.cancelStreaming();
      nativeResult.resolve(nativeAccepted);
      (await mainResult.started).complete();
      await steer;
      await mainTurn;
      expect(fixture.coordinator.getSteerSubmission(inputId)).toBeUndefined();
      expect(fixture.state.messages.filter(message => (
        message.role === 'user' && message.displayContent === 'early accepted steer'
      ))).toHaveLength(1);
      expect(fixture.state.messages.find(message => (
        message.role === 'user' && message.displayContent === 'early accepted steer'
      ))).toMatchObject({ userMessageId: 'native-steer-user' });
      expect(fixture.input.value).toBe('');
      expect(fixture.state.queuedMessage).toBeNull();
      expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
        .toBe(false);
      expect(fixture.coordinator.getSteerSubmission(inputId)).toBeUndefined();
    },
  );

  it('enriches ack-before-live persistence and canonical message identity', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    fixture.nativeSteer.mockResolvedValueOnce(true);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'acknowledged before live event';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    const inputId = fixture.native.steerRequests[0].inputId!;

    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
      'native-after-ack',
    ));
      expect(fixture.coordinator.getSteerSubmission(inputId)).toBeUndefined();
    expect(fixture.state.messages.find(message => (
      message.role === 'user' && message.displayContent === 'acknowledged before live event'
    ))).toMatchObject({
      content: 'acknowledged before live event',
      userMessageId: 'native-after-ack',
    });
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);

    (await mainResult.started).complete();
    await mainTurn;
  });

  it('releases the active lane while retaining acknowledged input for a late echo', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    fixture.nativeSteer.mockResolvedValueOnce(true);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    fixture.input.value = 'accepted without live event';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    const inputId = fixture.native.steerRequests[0].inputId!;

    (await mainResult.started).complete();
    await mainTurn;

    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
    expect(fixture.coordinator.getSteerSubmission(inputId)).toMatchObject({ canonicalText: 'accepted without live event' });
  });

  it.each([
    ['acknowledgement loss', new Error('acknowledgement lost')],
    ['native rejection', false],
  ])('does not let %s downgrade early acceptance after a stale binding', async (
    _label,
    nativeOutcome,
  ) => {
    let activeCoordinator: ChatExecutionCoordinator;
    const fixture = (await createFixture({
      getExecutionCoordinator: () => activeCoordinator,
    }));
    activeCoordinator = fixture.coordinator;
    const mainResult = fixture.holdNextResponse();
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';
    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'accepted before switch';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    const replacement = createExecutionHarness();
    const replacementCoordinator = replacement.coordinator;
    const originalInputId = fixture.native.steerRequests[0].inputId!;
    expect(fixture.coordinator.getSteerSubmission(originalInputId)).toBeDefined();
    onTestFinished(async () => { await replacementCoordinator.dispose(); await replacement.registry.dispose(); });
    activeCoordinator = replacementCoordinator;
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
    ));
    expect(fixture.coordinator.getSteerSubmission(originalInputId)).toBeUndefined();
    expect(replacementCoordinator.getSteerSubmission(originalInputId)).toBeUndefined();
    fixture.state.currentConversationId = 'conversation-2';
    fixture.input.value = 'conversation B draft';
    if (nativeOutcome instanceof Error) nativeResult.reject(nativeOutcome);
    else nativeResult.resolve(false);
    (await mainResult.started).complete();
    await steer;
    await mainTurn;

    expect(fixture.input.value).toBe('conversation B draft');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
    expect(Notice).not.toHaveBeenCalledWith(
      'Failed to steer the queued message. It is still available.',
    );
  });

  it('admits a later steer after terminal cleanup when an early-accepted result never settles', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer
      .mockReturnValueOnce(nativeResult.promise)
      .mockResolvedValueOnce(true);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'never-settling accepted steer';
    await fixture.controller.sendMessage();
    void fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
    ));

    (await mainResult.started).complete();
    await mainTurn;
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);

    await fixture.holdResponse();
    fixture.input.value = 'later steer';
    await fixture.controller.sendMessage();
    await fixture.controller.queue.steerNow();
    expect(fixture.native.steerRequests).toHaveLength(2);
  });

  it('renders accepted live input once and remains non-retryable when acceptance persistence fails', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    const nativeResult = deferred<boolean>();
    fixture.nativeSteer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';
    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.execution.repository.recordConversationActivity.mockRejectedValueOnce(new Error('accept save failed'));
    fixture.input.value = 'accepted despite save failure';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await fixture.native.waitForSteer();
    await expect(fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
      'native-steer-user',
    ))).rejects.toThrow('accept save failed');
    nativeResult.resolve(false);
    (await mainResult.started).complete();
    await steer;
    await mainTurn;

    expect(fixture.state.messages.filter(message => (
      message.role === 'user' && message.displayContent === 'accepted despite save failure'
    ))).toHaveLength(1);
    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  it('uses a matching live steer boundary before releasing its provider correlation', async () => {
    const fixture = (await createFixture());
    const mainResult = fixture.holdNextResponse();
    fixture.nativeSteer.mockRejectedValueOnce(new Error('steer acknowledgement lost'));
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await fixture.native.waitForRun();
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
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);

    (await mainResult.started).complete();
    await mainTurn;
  });

  it('restores once when a held authority check rejects after cancellation', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    const authority = fixture.holdNextAuthority();
    fixture.input.value = 'retry after cleanup failure';

    await fixture.controller.sendMessage();
    const steer = fixture.controller.queue.steerNow();
    await authority.started;
    fixture.controller.cancelStreaming();
    authority.reject(new Error('discard save failed'));
    await steer;
    fixture.controller.cancelStreaming();

    expect(fixture.native.steerRequests).toHaveLength(0);
    expect(fixture.input.value).toBe('retry after cleanup failure');
    expect(fixture.controller['steering']['pendingSteersByConversation'].has('conversation-1'))
      .toBe(false);
  });

  async function queueContinuation(fixture: Awaited<ReturnType<typeof createFixture>>) {
    vi.useFakeTimers();
    const response = fixture.holdNextResponse();
    const first = fixture.controller.sendMessage({ content: 'first turn' });
    const run = await response.started;
    await fixture.controller.sendMessage({ content: 'continue' });
    run.emit({ type: 'turn_completed', reason: 'completed', nativeUserMessageId: 'native-first', nativeAssistantId: 'native-answer' });
    await first;
    expect(fixture.controller.queue.message?.content).toBe('continue');
    expect(fixture.native.requests).toHaveLength(1);
  }

  it('reports deferred review when the queued continuation fails before handoff', async () => {
    const onReviewableSettlement = vi.fn();
    const fixture = await createFixture({ onReviewableSettlement });
    await queueContinuation(fixture);
    expect(onReviewableSettlement).not.toHaveBeenCalled();
    fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('continuation not handed off'));

    await vi.advanceTimersByTimeAsync(0);
    await fixture.session.turns.drain();

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
    expect(fixture.native.requests).toHaveLength(1);
    expect(fixture.input.value).toBe('continue');
    expect(fixture.controller.queue.message).toBeNull();
  });

  it('reports deferred review when queued continuation initialization fails', async () => {
    const onReviewableSettlement = vi.fn();
    const fixture = await createFixture({ onReviewableSettlement });
    await queueContinuation(fixture);
    expect(onReviewableSettlement).not.toHaveBeenCalled();
    vi.mocked(fixture.deps.ensureExecutionInitialized).mockResolvedValueOnce(false);

    await vi.advanceTimersByTimeAsync(0);
    await fixture.session.turns.drain();

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
    expect(fixture.native.requests).toHaveLength(1);
    expect(fixture.input.value).toBe('continue');
  });

  it('reports deferred review when a submission exits preflight during rewind', async () => {
    const onReviewableSettlement = vi.fn();
    const fixture = await createFixture({ onReviewableSettlement });
    await queueContinuation(fixture);
    expect(onReviewableSettlement).not.toHaveBeenCalled();
    const preview = deferred<{ canRewind: boolean }>();
    const entered = deferred<void>();
    vi.spyOn(fixture.native, 'previewRewind').mockImplementationOnce(() => {
      entered.resolve();
      return preview.promise;
    });
    const rewinding = fixture.deps.conversationController.rewind(fixture.state.messages[0].id);
    await entered.promise;
    expect(fixture.state.isRewinding).toBe(true);

    await fixture.controller.sendMessage({ content: 'continue' });

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
    expect(fixture.native.requests).toHaveLength(1);
    preview.resolve({ canRewind: false });
    await rewinding;
    expect(fixture.state.isRewinding).toBe(false);
  });
});

it('does not lose a cancel to native completion when a rejected steer settles afterwards', async () => {
  const fixture = (await createFixture());
  vi.useFakeTimers();
  const turn = fixture.holdNextResponse();
  const steerResult = deferred<boolean>();
  fixture.nativeSteer.mockReturnValueOnce(steerResult.promise);
  const active = fixture.controller.sendMessage({ content: 'Work' });
  await fixture.native.waitForRun();
  fixture.input.value = 'steer me';
  await fixture.controller.sendMessage();
  const steer = fixture.controller.queue.steerNow();
  await fixture.native.waitForSteer();

  const run = await turn.started;
  run.holdCancellation = true;
  fixture.controller.cancelStreaming();
  await run.cancelled;
  run.complete();
  await active;
  steerResult.resolve(false);
  await steer;
  await vi.runOnlyPendingTimersAsync();

  expect(fixture.native.requests).toHaveLength(1);
  expect(fixture.state.queuedMessage).toBeNull();
  expect(fixture.input.value).toBe('steer me');
});

it('queuing another input must retain the running turn drain handle', async () => {
  const fixture = (await createFixture());
  const gate = fixture.holdNextResponse();
  const first = fixture.controller.sendMessage({ content: 'first turn' });
  const run = await gate.started;
  run.holdCancellation = true;
  try {
    await fixture.controller.sendMessage({ content: 'queued follow-up' });
    expect(fixture.state.queuedMessage?.content).toBe('queued follow-up');
    expect(fixture.state.isStreaming).toBe(true);
    let cancellationDrainFinished = false;
    const drain = fixture.session.turns.drain().then(() => { cancellationDrainFinished = true; });
    fixture.controller.cancelStreaming();
    await run.cancelled;
    expect(cancellationDrainFinished).toBe(false);
    void drain;
  } finally {
    fixture.controller.queue.clear();
    run.complete();
    await first;
  }
});
