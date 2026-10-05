import type { FakeRun } from '@test/helpers/ChatExecutionHarness';
import { beginExecution, createHarness, createSubmission, deferred, FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { testDate } from '@test/helpers/testClock';

import { type ProviderExecutionEvent, type ProviderSessionSnapshot } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import { ChatExecutionInteractionStaleError, ChatExecutionPreHandoffError } from '@/features/chat/execution/ChatExecutionCoordinator';

const IDLE_MS = 30 * 60_000;

afterEach(() => jest.useRealTimers());

describe('ChatExecutionCoordinator', () => {
  it.each(['claude', 'codex'] as const)(
    'validates %s events without serializing resume history after an equivalent rebind',
    async (providerId) => {
      const harness = createHarness();
      const serializeHistory = jest.fn(() => ({ result: 'x'.repeat(1024 * 1024) }));
      const makeBinding = () => ({
        conversationId: 'conversation-1',
        providerId,
        resumeSeed: {
          providerSessionId: 'native-session',
          providerState: { history: { toJSON: serializeHistory } },
        },
      });
      await harness.coordinator.bindConversation(makeBinding());
      await harness.coordinator.prepare();
      await harness.coordinator.bindConversation(makeBinding());
      serializeHistory.mockClear();

      const backend = harness.backends.get(providerId)!;
      const session = backend.sessions[0];
      const execute = session.execute.bind(session);
      jest.spyOn(session, 'execute').mockImplementationOnce((request) => {
        const run = execute(request) as FakeRun;
        for (let sequence = 1; sequence <= 20; sequence++) {
          run.events.push({
            type: 'text_delta', scope: requestedScope(session, run, sequence), text: `${sequence}`,
          });
        }
        run.events.push({
          type: 'turn_completed', scope: requestedScope(session, run, 21), reason: 'completed',
        });
        run.events.end();
        return run;
      });
      session.emit({
        type: 'session_error', category: 'provider', message: 'background failure', recoverable: true,
        scope: { kind: 'session', sessionInstanceId: session.sessionInstanceId, sequence: 1 },
      });
      expect(harness.sessionEvents).toHaveLength(1);
      expect(harness.coordinator.isEventContextCurrent(harness.sessionEventContexts[0])).toBe(true);

      await expect(harness.coordinator.execute(createSubmission())).resolves.toMatchObject({
        status: 'completed',
      });
      expect(harness.requestedEvents.filter(event => event.type === 'text_delta').map(event => event.text))
        .toEqual(Array.from({ length: 20 }, (_, index) => `${index + 1}`));
      expect(backend.sessions).toHaveLength(1);
      expect(serializeHistory).not.toHaveBeenCalled();
      await harness.coordinator.dispose();
    },
  );

  it.each([
    { providerSessionId: 'replacement-session' },
    { resumeCheckpoint: 'earlier-message' },
    { providerState: { leafId: 'replacement-leaf' } },
  ])('replaces the session when resume configuration changes to %j', async (changedSeed) => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const resumeSeed = {
      providerSessionId: 'native-session',
      providerState: { leafId: 'leaf-1' },
      ...changedSeed,
    };
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1', providerId: 'claude', resumeSeed,
    });
    run.events.push({ type: 'text_delta', scope: requestedScope(session, run, 1), text: 'late' });
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
    expect(harness.requestedEvents).toHaveLength(0);
    expect(session.disposeCalls).toBe(1);
    await harness.coordinator.prepare();
    expect(harness.backends.get('claude')!.configs[1].resumeSeed).toEqual(resumeSeed);
    await harness.coordinator.dispose();
  });

  describe('idle session release', () => {
    beforeEach(() => jest.useFakeTimers());

    it('releases an idle session after 30 minutes and resumes it on the next turn', async () => {
      const harness = createHarness({ idleReleaseMs: IDLE_MS });
      const resumeSeed = { providerSessionId: 'native-session' };
      await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude', resumeSeed });
      await harness.coordinator.prepare();
      const backend = harness.backends.get('claude')!;
      const session = backend.sessions[0];

      await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(session.disposeCalls).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(session.disposeCalls).toBe(1);
      expect(harness.coordinator.state).toBe('absent');
      expect(harness.repository.releaseExecutionBinding).toHaveBeenCalledTimes(1);

      await harness.coordinator.prepare();
      expect(backend.sessions).toHaveLength(2);
      expect(backend.configs[1].resumeSeed).toEqual(resumeSeed);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });

    it('retries idle release after a snapshot persistence failure', async () => {
      const onError = jest.fn();
      const harness = createHarness({ idleReleaseMs: IDLE_MS, onError });
      await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
      await harness.coordinator.prepare();
      const session = harness.backends.get('claude')!.sessions[0];
      session.snapshot = { ...session.snapshot, revision: 1 };
      const error = new Error('Storage unavailable');
      harness.repository.persistExecutionSnapshot.mockRejectedValueOnce(error);

      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(onError).toHaveBeenCalledWith(error);
      expect(session.disposeCalls).toBe(0);
      expect(harness.repository.releaseExecutionBinding).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(session.disposeCalls).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(session.disposeCalls).toBe(1);
      expect(harness.repository.persistExecutionSnapshot).toHaveBeenLastCalledWith(
        'conversation-1', expect.any(String), expect.any(Number), session.snapshot,
      );
      expect(harness.repository.releaseExecutionBinding).toHaveBeenCalledTimes(1);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });

    it('honors a new idle period when background activity finishes during expiry persistence', async () => {
      const onIdleRelease = jest.fn();
      const harness = createHarness({ idleReleaseMs: IDLE_MS, onIdleRelease });
      await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
      await harness.coordinator.prepare();
      const session = harness.backends.get('claude')!.sessions[0];
      session.snapshot = { ...session.snapshot, revision: 1 };
      const persistence = deferred<boolean>();
      harness.repository.persistExecutionSnapshot.mockReturnValueOnce(persistence.promise);

      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledTimes(2);
      const scope = { kind: 'background' as const, sessionInstanceId: session.sessionInstanceId, turnId: 'background', sequence: 1 };
      session.emit({ type: 'background_turn_started', scope });
      session.emit({ type: 'background_turn_completed', scope: { ...scope, sequence: 2 }, reason: 'completed' });
      await jest.advanceTimersByTimeAsync(0);
      // Let part of the new idle period elapse before the old expiry save finishes.
      await jest.advanceTimersByTimeAsync(IDLE_MS / 2);
      persistence.resolve(true);
      await jest.advanceTimersByTimeAsync(0);
      expect(session.disposeCalls).toBe(0);
      expect(onIdleRelease).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(IDLE_MS / 2 - 1);
      expect(session.disposeCalls).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(session.disposeCalls).toBe(1);
      expect(onIdleRelease).toHaveBeenCalledTimes(1);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });

    it('restarts the idle period after each turn', async () => {
      const harness = createHarness({ idleReleaseMs: IDLE_MS });
      const { session, run, resultPromise } = await beginExecution(harness);
      await jest.advanceTimersByTimeAsync(IDLE_MS + 1);
      expect(session.disposeCalls).toBe(0);
      run.events.push({ type: 'turn_started', scope: requestedScope(session, run, 1), accepted: true });
      run.events.push({ type: 'turn_completed', scope: requestedScope(session, run, 2), reason: 'completed' });
      run.events.end();
      await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });

      await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(session.disposeCalls).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(session.disposeCalls).toBe(1);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });

    it('keeps a session with running children alive past the idle period', async () => {
      const harness = createHarness({ idleReleaseMs: IDLE_MS });
      await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
      await harness.coordinator.prepare();
      const session = harness.backends.get('codex')!.sessions[0];
      const hasBackgroundWork = jest.fn(() => true);
      Object.assign(session, { hasBackgroundWork });

      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(session.disposeCalls).toBe(0);
      hasBackgroundWork.mockReturnValue(false);
      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(session.disposeCalls).toBe(1);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });

    it('keeps a session alive while its owner is busy and reports the eventual release', async () => {
      let ownerIdle = false;
      const onIdleRelease = jest.fn();
      const harness = createHarness({ idleReleaseMs: IDLE_MS, isOwnerIdle: () => ownerIdle, onIdleRelease });
      await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
      await harness.coordinator.prepare();
      const session = harness.backends.get('claude')!.sessions[0];

      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(session.disposeCalls).toBe(0);
      expect(onIdleRelease).not.toHaveBeenCalled();
      ownerIdle = true;
      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(session.disposeCalls).toBe(1);
      expect(onIdleRelease).toHaveBeenCalledTimes(1);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });

    it('keeps a session alive until pending background event persistence settles', async () => {
      const eventWork = deferred<void>();
      const harness = createHarness({
        idleReleaseMs: IDLE_MS,
        onSessionEvent: event => event.type === 'background_turn_completed' ? eventWork.promise : undefined,
      });
      await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
      await harness.coordinator.prepare();
      const session = harness.backends.get('claude')!.sessions[0];
      const scope = { kind: 'background' as const, sessionInstanceId: session.sessionInstanceId, turnId: 'background', sequence: 1 };
      session.emit({ type: 'background_turn_started', scope });
      session.emit({ type: 'background_turn_completed', scope: { ...scope, sequence: 2 }, reason: 'completed' });

      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(session.disposeCalls).toBe(0);
      eventWork.resolve();
      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(session.disposeCalls).toBe(1);
      await harness.coordinator.dispose();
      await harness.registry.dispose();
    });
  });

  it('exposes commands only for the current conversation and provider binding', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({ conversationId: 'one', providerId: 'claude' });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    session.commands = [{ id: 'review', name: 'review', description: '', content: '' }];
    expect(harness.coordinator.getCommandSnapshot('one', 'claude')).toEqual(session.commands);
    expect(harness.coordinator.getCommandSnapshot('two', 'claude')).toBeUndefined();
    expect(harness.coordinator.getCommandSnapshot('one', 'codex')).toBeUndefined();
    await harness.coordinator.bindConversation({ conversationId: 'two', providerId: 'claude' });
    expect(harness.coordinator.getCommandSnapshot('two', 'claude')).toBeUndefined();
    await harness.coordinator.dispose();
  });

  it('binds cold and acquires a persistent execution session only on prepare or execute', async () => {
    const harness = createHarness();

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
      resumeSeed: { providerSessionId: 'native-session' },
    });

    expect(harness.backends.get('claude')!.sessions).toHaveLength(0);

    await harness.coordinator.prepare();

    const backend = harness.backends.get('claude')!;
    expect(backend.sessions).toHaveLength(1);
    expect(backend.configs[0]).toMatchObject({
      lifecycle: 'persistent',
      nativePersistence: 'enabled',
      resumeSeed: { providerSessionId: 'native-session' },
      vaultWorkingDirectory: '/vault',
    });
    expect(harness.repository.registerExecutionBinding).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
    );
  });

  it('normalizes synchronous session event handler rejections to errors', async () => {
    const onError = jest.fn();
    const harness = createHarness({
      onError,
      onSessionEvent: () => {
        throw 'session event callback failed';
      },
    });
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];

    session.emit({
      type: 'session_error',
      category: 'provider',
      message: 'Provider event',
      recoverable: true,
      scope: {
        kind: 'session',
        sessionInstanceId: session.sessionInstanceId,
        sequence: 1,
      },
    });
    for (let attempt = 0; attempt < 20 && onError.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0][0] as Error).message)
      .toBe('session event callback failed');

    await harness.coordinator.dispose();
    await harness.registry.dispose();
  });

  it('builds a neutral request and attaches native message IDs', async () => {
    const harness = createHarness();
    const image = {
      id: 'image-1',
      name: 'image.png',
      mediaType: 'image/png' as const,
      data: 'aGVsbG8=',
      size: 5,
      source: 'paste' as const,
    };
    const userMessage: ChatMessage = {
      id: 'user-1',
      role: 'user' as const,
      content: 'canonical input',
      timestamp: 123,
    };
    const assistantMessage: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: '',
      timestamp: 124,
    };
    const submission = createSubmission({
      configuration: {
        systemInstructions: { kind: 'explicit', instructions: 'Answer tersely.' },
      },
      images: [image],
      messages: { user: userMessage, assistant: assistantMessage },
    });
    const { session, run, resultPromise } = await beginExecution(harness, submission);
    expect(session.requests[0]).toMatchObject({
      input: [
        { type: 'text', text: 'canonical input' },
        { type: 'image', image },
      ],
      context: submission.context,
      conversationHistory: [],
      configuration: submission.configuration,
      toolPolicy: submission.toolPolicy,
    });
    expect(session.requests[0].signal).toBeInstanceOf(AbortSignal);

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: true,
      nativeUserMessageId: 'native-user',
    });
    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 2),
      reason: 'completed',
      nativeAssistantId: 'native-assistant',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed',
      accepted: true,
      nativeUserMessageId: 'native-user',
      nativeAssistantMessageId: 'native-assistant',
    });
    expect(userMessage.userMessageId).toBe('native-user');
    expect(assistantMessage.assistantMessageId).toBe('native-assistant');
  });

  it('attaches late native user and assistant identities without reloading history', async () => {
    const harness = createHarness();
    const user: ChatMessage = { id: 'user', role: 'user', content: 'Hello', timestamp: 1 };
    const assistant: ChatMessage = { id: 'assistant', role: 'assistant', content: '', timestamp: 2 };
    const { session, run, resultPromise } = await beginExecution(
      harness, createSubmission({ messages: { user, assistant } }),
    );
    run.events.push({ type: 'turn_started', scope: requestedScope(session, run, 1), accepted: true });
    run.events.push({
      type: 'assistant_message_started', scope: requestedScope(session, run, 2),
      nativeAssistantId: 'msg_item',
    });
    run.events.push({
      type: 'turn_completed', scope: requestedScope(session, run, 3), reason: 'completed',
      nativeAssistantId: 'turn-checkpoint', nativeCheckpointId: 'turn-checkpoint',
      nativeUserMessageId: 'late-native-user',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed', nativeAssistantMessageId: 'turn-checkpoint',
    });
    expect(assistant.assistantMessageId).toBe('turn-checkpoint');
    expect(user.userMessageId).toBe('late-native-user');
  });

  it('keeps the submitted pair bound to its own identities across a steer boundary', async () => {
    const harness = createHarness();
    const user: ChatMessage = { id: 'user', role: 'user', content: 'Hello', timestamp: 1 };
    const assistant: ChatMessage = { id: 'assistant', role: 'assistant', content: '', timestamp: 2 };
    const { session, run, resultPromise } = await beginExecution(
      harness, createSubmission({ messages: { user, assistant } }),
    );
    run.events.push({
      type: 'turn_started', scope: requestedScope(session, run, 1), accepted: true,
      nativeUserMessageId: 'native-user',
    });
    run.events.push({
      type: 'user_message_started', scope: requestedScope(session, run, 2),
      nativeUserMessageId: 'native-user',
    });
    run.events.push({
      type: 'assistant_message_started', scope: requestedScope(session, run, 3),
      nativeAssistantId: 'native-assistant',
    });
    run.events.push({
      type: 'user_message_started', scope: requestedScope(session, run, 4),
      content: 'Steer', nativeUserMessageId: 'steer-user',
    });
    run.events.push({
      type: 'assistant_message_started', scope: requestedScope(session, run, 5),
      nativeAssistantId: 'steer-assistant',
    });
    run.events.push({
      type: 'turn_completed', scope: requestedScope(session, run, 6), reason: 'completed',
      nativeAssistantId: 'steer-assistant', nativeUserMessageId: 'steer-user',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed',
      nativeUserMessageId: 'native-user',
      nativeAssistantMessageId: 'steer-assistant',
    });
    expect(user.userMessageId).toBe('native-user');
    expect(assistant.assistantMessageId).toBe('native-assistant');
  });

  it('revalidates conversation authority immediately before provider handoff', async () => {
    const harness = createHarness();
    const cause = new Error('conversation assigned to another device');
    const authorityCheck = (
      harness.repository as unknown as {
        assertConversationExecutionAuthority: jest.MockedFunction<
          (conversationId: string) => Promise<void>
        >;
      }
    ).assertConversationExecutionAuthority;
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    const execute = jest.spyOn(session, 'execute').mockImplementation(() => {
      throw new Error('provider handoff occurred');
    });
    authorityCheck.mockRejectedValueOnce(cause);

    await expect(harness.coordinator.execute(createSubmission())).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause,
    });
    expect(authorityCheck).toHaveBeenCalledWith('conversation-1', 'local-1', 0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('distinguishes definite pre-send failures from errors after provider handoff', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    session.execute = jest.fn(() => {
      throw new Error('not sent');
    });

    await expect(harness.coordinator.execute(createSubmission())).rejects.toBeInstanceOf(
      ChatExecutionPreHandoffError,
    );

    session.execute = FakeSession.prototype.execute.bind(session);
    const resultPromise = harness.coordinator.execute(
      createSubmission({ submissionId: 'input-2' }),
    );
    let run: FakeRun | undefined;
    for (let attempt = 0; attempt < 20 && !run; attempt += 1) {
      await Promise.resolve();
      run = session.runs[0];
    }
    if (!run) throw new Error('Execution did not start');
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'transport',
      message: 'ambiguous',
      recoverable: true,
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      accepted: false,
    });
  });

  it('classifies a definite asynchronous rejection as pre-handoff', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ submissionId: 'rejected-input' }),
    );

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: false,
    });
    const rejection: ProviderExecutionEvent = {
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'configuration',
      message: 'No enabled model is available.',
      recoverable: false,
    };
    run.events.push(rejection);
    run.events.end();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause: rejection,
    });
  });

  it('classifies a definite rejection before rethrowing its terminal event sink error', async () => {
    const sinkError = new Error('terminal sink failed');
    const harness = createHarness({
      onRequestedEvent: async (event) => {
        if (event.type === 'execution_error') throw sinkError;
      },
    });
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ submissionId: 'sink-failure-input' }),
    );

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: false,
    });
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'configuration',
      message: 'Unsupported tool policy.',
      recoverable: false,
    });
    run.events.end();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause: sinkError,
    });
  });

  it('reports acceptance when a later configuration error terminates the run', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ submissionId: 'accepted-input' }),
    );

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: true,
    });
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'configuration',
      message: 'Configuration changed after acceptance.',
      recoverable: true,
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      accepted: true,
    });
  });

  it('routes only current monotonically correlated requested events and persists snapshots', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 2,
      providerSessionId: 'native-2',
      status: 'executing',
    };

    run.events.push({
      type: 'text_delta',
      scope: requestedScope(session, run, 1),
      text: 'accepted',
    });
    run.events.push({
      type: 'text_delta',
      scope: requestedScope(session, run, 1),
      text: 'duplicate',
    });
    run.events.push({
      type: 'text_delta',
      scope: {
        ...requestedScope(session, run, 2),
        executionId: 'stale-execution',
      },
      text: 'stale',
    });
    run.events.push({
      type: 'session_state_changed',
      scope: requestedScope(session, run, 2),
      snapshot,
    });
    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 3),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;

    expect(harness.requestedEvents.map((event) => event.type)).toEqual([
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
      snapshot,
    );
  });

  it('honors queued native completion when cancellation arrives before it is consumed', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({ type: 'turn_started', scope: requestedScope(session, run, 1), accepted: true });
    run.events.push({ type: 'turn_completed', scope: requestedScope(session, run, 2), reason: 'completed' });
    run.events.end();
    harness.coordinator.cancel();
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed', accepted: true });
  });

  it('cancels only the active run and reports cancellation', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);

    harness.coordinator.cancel();

    expect(run.cancelCalls).toBe(1);
    expect(session.cancelCalls).toBe(0);
    expect(session.requests[0].signal.aborted).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('accepts steer input only when the current session supports and accepts it', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);

    await expect(harness.coordinator.steer(
      createSubmission({ submissionId: 'steer-1' }),
    )).resolves.toEqual({ delivery: 'accepted' });
    expect(session.steerRequests).toHaveLength(1);

    session.steerResult = false;
    await expect(harness.coordinator.steer(
      createSubmission({ submissionId: 'steer-2' }),
    )).resolves.toEqual({ delivery: 'not-sent' });

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('classifies steer authority failure as definitely pre-handoff', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const cause = new Error('conversation deleted');
    harness.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(cause);

    await expect(harness.coordinator.steer(createSubmission({
      submissionId: 'unstaged-steer',
    }))).resolves.toMatchObject({
      delivery: 'not-sent',
      error: { cause, name: 'ChatExecutionPreHandoffError' },
    });

    expect(session.steerRequests).toHaveLength(0);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('reports a rejected steer after the UI binding changes', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(
      nativeSteer.promise,
    );

    const steerResult = harness.coordinator.steer(createSubmission({
      submissionId: 'stale-rejected-steer',
    }));
    for (let attempt = 0; attempt < 10 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(steer).toHaveBeenCalledTimes(1);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    await harness.coordinator.prepare();
    expect(harness.coordinator.snapshot?.providerId).toBe('codex');

    nativeSteer.resolve(false);

    await expect(steerResult).resolves.toEqual({ delivery: 'not-sent' });
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('accepts a handed-off steer against its captured conversation even when the UI binding is stale', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(
      nativeSteer.promise,
    );

    const steerResult = harness.coordinator.steer(createSubmission({
      submissionId: 'stale-accepted-steer',
    }));
    for (let attempt = 0; attempt < 10 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(steer).toHaveBeenCalledTimes(1);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    await harness.coordinator.prepare();
    expect(harness.coordinator.snapshot?.providerId).toBe('codex');

    nativeSteer.resolve(true);

    await expect(steerResult).resolves.toEqual({ delivery: 'accepted' });
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('lets an early live provider event authoritatively accept a steer before delayed false', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      submissionId: 'event-before-false',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(steer).toHaveBeenCalledTimes(1);

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-false',
      'native-steer-user',
    )).resolves.toBe(true);
    nativeSteer.resolve(false);

    await expect(steerResult).resolves.toEqual({ delivery: 'accepted' });

    await harness.coordinator.bindConversation(null);
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('keeps event-before-true acceptance correlated and idempotent', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      submissionId: 'event-before-true',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-true',
      'native-event-first',
    )).resolves.toBe(true);
    nativeSteer.resolve(true);

    await expect(steerResult).resolves.toEqual({ delivery: 'accepted' });
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-true',
      'native-event-first',
    )).resolves.toBe(false);

    await harness.coordinator.bindConversation(null);
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('retains acknowledged steer correlation until the first live event', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);

    await expect(harness.coordinator.steer(createSubmission({
      submissionId: 'ack-before-event',
    }))).resolves.toEqual({ delivery: 'accepted' });

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'ack-before-event',
      'native-user-after-ack',
    )).resolves.toBe(true);
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'ack-before-event',
      'native-user-after-ack',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it.each(['bind', 'invalidation', 'dispose'] as const)(
    'clears retained acknowledged steer correlation on %s',
    async (boundary) => {
      const harness = createHarness();
      const { session, resultPromise } = await beginExecution(harness);
      jest.spyOn(session, 'steer').mockResolvedValueOnce(true);

      await expect(harness.coordinator.steer(createSubmission({
        submissionId: `accepted-before-${boundary}`,
      }))).resolves.toEqual({ delivery: 'accepted' });
      if (boundary === 'bind') {
        await harness.coordinator.bindConversation({
          conversationId: 'conversation-2',
          providerId: 'codex',
        });
      } else if (boundary === 'invalidation') {
        await harness.registry.runTransition(['claude'], async () => undefined);
      } else {
        await harness.coordinator.dispose();
      }

      await expect(harness.coordinator.acceptSteerFromProviderEvent(
        `accepted-before-${boundary}`,
        `native-after-${boundary}`,
      )).resolves.toBe(false);
      await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
    },
  );

  it('drops acknowledged correlation when terminal history delegation sees no live event', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);

    await expect(harness.coordinator.steer(createSubmission({
      submissionId: 'accepted-without-event',
    }))).resolves.toEqual({ delivery: 'accepted' });
    harness.coordinator.releaseSteerCorrelation('accepted-without-event');

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'accepted-without-event',
      'too-late-native-user',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('lets an early live provider event authoritatively accept a steer before delayed error', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      submissionId: 'event-before-error',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-error',
    )).resolves.toBe(true);
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    nativeSteer.reject(new Error('late transport failure'));

    await expect(steerResult).resolves.toEqual({ delivery: 'accepted' });
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('persists early live steer acceptance even when the native result never settles', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    void harness.coordinator.steer(createSubmission({
      submissionId: 'event-before-never',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-never',
      'native-never-user',
    )).resolves.toBe(true);
    expect(harness.repository.recordConversationActivity).toHaveBeenCalledTimes(1);
    expect(harness.repository.recordConversationActivity).toHaveBeenCalledWith(
      'conversation-1',
      123,
    );
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-never',
    )).resolves.toBe(false);
    expect(harness.repository.recordConversationActivity).toHaveBeenCalledTimes(1);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('upgrades an ambiguous native steer result when its exact live event arrives later', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const steerError = new Error('acknowledgement lost');
    jest.spyOn(session, 'steer').mockRejectedValueOnce(steerError);

    await expect(harness.coordinator.steer(createSubmission({
      submissionId: 'event-after-error',
    }))).resolves.toEqual({ delivery: 'uncertain', error: steerError });

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-after-error',
      'native-late-user',
    )).resolves.toBe(true);
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-after-error',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('drops ambiguous in-memory correlation when durable history takes ownership', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockRejectedValueOnce(new Error('acknowledgement lost'));

    await expect(harness.coordinator.steer(createSubmission({
      submissionId: 'delegated-ambiguous',
    }))).resolves.toMatchObject({ delivery: 'uncertain', error: new Error('acknowledgement lost') });
    harness.coordinator.releaseSteerCorrelation('delegated-ambiguous');

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'delegated-ambiguous',
      'too-late-user',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('does not leak event correlation when live acceptance persistence fails', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);
    harness.repository.recordConversationActivity.mockRejectedValueOnce(
      new Error('accept save failed'),
    );

    void harness.coordinator.steer(createSubmission({
      submissionId: 'accept-save-failure',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'accept-save-failure',
      'native-accepted-user',
    )).rejects.toThrow('accept save failed');
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'accept-save-failure',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('routes correlated background turns, persists their snapshots, and rejects stale output', async () => {
    const onBackgroundWorkChanged = jest.fn();
    const harness = createHarness({ onBackgroundWorkChanged });
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    const backgroundScope = {
      kind: 'background' as const,
      sessionInstanceId: session.sessionInstanceId,
      turnId: 'background-1',
      sequence: 1,
    };
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 3,
      status: 'idle',
      providerSessionId: 'native-background',
    };

    session.emit({ type: 'background_turn_started', scope: backgroundScope });
    expect(harness.coordinator.hasBackgroundWork).toBe(true);
    expect(onBackgroundWorkChanged).toHaveBeenLastCalledWith(true);
    harness.coordinator.cancel();
    expect(session.cancelCalls).toBe(1);
    session.emit({
      type: 'text_delta',
      scope: { ...backgroundScope, sequence: 2 },
      text: 'background',
    });
    session.emit({
      type: 'session_state_changed',
      scope: { ...backgroundScope, sequence: 3 },
      snapshot,
    });
    session.emit({
      type: 'background_turn_completed',
      scope: { ...backgroundScope, sequence: 4 },
      reason: 'completed',
    });
    expect(harness.coordinator.hasBackgroundWork).toBe(false);
    expect(onBackgroundWorkChanged).toHaveBeenLastCalledWith(false);
    session.emit({
      type: 'text_delta',
      scope: { ...backgroundScope, sequence: 5 },
      text: 'late',
    });
    await Promise.resolve();

    expect(harness.sessionEvents.map((event) => event.type)).toEqual([
      'background_turn_started',
      'text_delta',
      'session_state_changed',
      'background_turn_completed',
    ]);
    expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
      snapshot,
    );
  });

  it('publishes background work only when running children and background turns change it', async () => {
    const onBackgroundWorkChanged = jest.fn();
    const harness = createHarness({ onBackgroundWorkChanged });
    await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
    await harness.coordinator.prepare();
    const session = harness.backends.get('codex')!.sessions[0];
    let childrenRunning = false;
    Object.assign(session, { hasBackgroundWork: () => childrenRunning });
    let sessionSequence = 0;
    const subagentUpdate = (status: 'running' | 'completed') => session.emit({
      type: 'subagent_updated',
      scope: { kind: 'session', sessionInstanceId: session.sessionInstanceId, sequence: ++sessionSequence },
      subagent: { id: 'spawn', description: 'Helper', status, isExpanded: false, toolCalls: [] },
    });
    const backgroundScope = (sequence: number) => ({
      kind: 'background' as const, sessionInstanceId: session.sessionInstanceId, turnId: 'background-1', sequence,
    });

    childrenRunning = true;
    for (let index = 0; index < 5; index += 1) subagentUpdate('running');
    session.emit({ type: 'background_turn_started', scope: backgroundScope(1) });
    session.emit({ type: 'background_turn_completed', scope: backgroundScope(2), reason: 'completed' });
    expect(harness.coordinator.hasBackgroundWork).toBe(true);
    expect(onBackgroundWorkChanged.mock.calls).toEqual([[true]]);

    childrenRunning = false;
    subagentUpdate('completed');
    subagentUpdate('completed');
    expect(onBackgroundWorkChanged.mock.calls).toEqual([[true], [false]]);
    await harness.coordinator.dispose();
    await harness.registry.dispose();
  });

  it('exposes session-event context validity and fences it before binding release awaits', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];

    session.emit({
      type: 'session_error',
      category: 'provider',
      message: 'background failure',
      recoverable: true,
      scope: {
        kind: 'session',
        sessionInstanceId: session.sessionInstanceId,
        sequence: 1,
      },
    });

    const [context] = harness.sessionEventContexts;
    expect(context).toBeDefined();
    expect(harness.coordinator.isEventContextCurrent(context)).toBe(true);

    const switchPromise = harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });

    expect(harness.coordinator.isEventContextCurrent(context)).toBe(false);
    await switchPromise;
    expect(harness.coordinator.isEventContextCurrent(context)).toBe(false);

    await harness.coordinator.prepare();
    const replacementSession = harness.backends.get('codex')!.sessions[0];
    replacementSession.emit({
      type: 'session_error',
      category: 'provider',
      message: 'replacement failure',
      recoverable: true,
      scope: {
        kind: 'session',
        sessionInstanceId: replacementSession.sessionInstanceId,
        sequence: 1,
      },
    });
    const replacementContext = harness.sessionEventContexts[1];
    expect(harness.coordinator.isEventContextCurrent(replacementContext)).toBe(true);

    const transition = harness.registry.runTransition(['codex'], async () => undefined);
    for (
      let attempt = 0;
      attempt < 10 && harness.coordinator.isEventContextCurrent(replacementContext);
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(harness.coordinator.isEventContextCurrent(replacementContext)).toBe(false);
    await transition;
  });

  it('fences interaction requests by current session and active turn identity', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const port = harness.backends.get('claude')!.configs[0].interactionPort;

    await expect(port.requestApproval({
      kind: 'approval',
      interactionId: 'approval-1',
      sessionInstanceId: session.sessionInstanceId,
      turnId: run.turnId,
      toolName: 'Read',
      input: {},
      description: 'Read a file',
    }, new AbortController().signal)).resolves.toMatchObject({
      interactionId: 'approval-1',
    });
    await expect(port.askUserQuestion({
      kind: 'question',
      interactionId: 'question-stale',
      sessionInstanceId: session.sessionInstanceId,
      turnId: 'other-turn',
      input: {},
    }, new AbortController().signal)).rejects.toBeInstanceOf(
      ChatExecutionInteractionStaleError,
    );
    expect(harness.interactionPort.askUserQuestion).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('switches provider/conversation by immediately fencing and then releasing the old binding', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    run.events.push({
      type: 'text_delta',
      scope: requestedScope(session, run, 1),
      text: 'late',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
    expect(session.disposeCalls).toBe(1);
    expect(harness.repository.releaseExecutionBinding).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
    );
    expect(harness.requestedEvents).toHaveLength(0);

    await harness.coordinator.prepare();
    expect(harness.backends.get('codex')!.sessions).toHaveLength(1);
  });

  it('publishes a null binding before rejected lease release and cannot reacquire', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const backend = harness.backends.get('claude')!;
    const session = backend.sessions[0];
    const disposeError = new Error('provider cleanup failed');
    jest.spyOn(session, 'dispose').mockImplementationOnce(async () => {
      session.disposeCalls += 1;
      session.status = 'disposed';
      throw disposeError;
    });

    await expect(harness.coordinator.bindConversation(null)).rejects.toBe(
      disposeError,
    );

    const reacquire = jest.spyOn(backend, 'createSession').mockImplementationOnce(() => {
      throw new Error('provider was reacquired');
    });
    await expect(harness.coordinator.execute(createSubmission())).rejects.toThrow(
      'No conversation is bound for chat execution',
    );
    expect(reacquire).not.toHaveBeenCalled();
    expect(session.disposeCalls).toBe(1);
    expect(session.requests).toHaveLength(0);
  });

  it('handles missing provider sessions through the injected history boundary and releases the lease', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'missing-session',
      missingSessionResolution: 'reset',
    });
    expect(harness.missingSession).toHaveBeenCalledWith(
      'conversation-1',
      'missing-native',
    );
    expect(session.disposeCalls).toBe(1);

    await harness.coordinator.prepare();
    const backend = harness.backends.get('claude')!;
    expect(backend.sessions).toHaveLength(2);
    expect(backend.configs[1]?.resumeSeed).toBeUndefined();
  });

  it('clears the conversation binding after missing-session deletion', async () => {
    const harness = createHarness();
    harness.missingSession.mockResolvedValueOnce('deleted');
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'missing-session',
      accepted: false,
      missingSessionResolution: 'deleted',
    });
    expect(session.disposeCalls).toBe(1);
    await expect(harness.coordinator.prepare()).rejects.toThrow(
      'No conversation is bound for chat execution',
    );
  });

  it('does not apply a late missing-session reset to a replacement binding', async () => {
    const harness = createHarness();
    const resolution = deferred<'reset'>();
    harness.missingSession.mockReturnValueOnce(resolution.promise);
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();
    for (
      let attempt = 0;
      attempt < 20 && harness.missingSession.mock.calls.length === 0;
      attempt += 1
    ) {
      await Promise.resolve();
    }

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
      resumeSeed: { providerSessionId: 'codex-native' },
    });
    resolution.resolve('reset');

    await expect(resultPromise).resolves.toMatchObject({
      status: 'invalidated',
      accepted: false,
    });
    await harness.coordinator.prepare();
    expect(harness.backends.get('codex')!.configs[0]?.resumeSeed).toEqual({
      providerSessionId: 'codex-native',
    });
    expect(harness.backends.get('claude')!.sessions).toHaveLength(1);
    expect(session.disposeCalls).toBe(1);
  });

  it('reports acceptance when the provider reports its session missing', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ submissionId: 'accepted-missing-input' }),
    );
    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: true,
    });
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'provider-session-missing',
      message: 'missing after handoff',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'missing-session',
      accepted: true,
    });
  });

  it('recovers an unaccepted missing session before surfacing a retryable terminal sink failure', async () => {
    const sinkError = new Error('missing-session sink failed');
    const harness = createHarness({
      onRequestedEvent: async (event) => {
        if (event.type === 'execution_error') throw sinkError;
      },
    });
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ submissionId: 'missing-sink-input' }),
    );
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause: sinkError,
    });
    expect(harness.missingSession).toHaveBeenCalledWith(
      'conversation-1',
      'missing-native',
    );
    expect(session.disposeCalls).toBe(1);
  });

  it('routes rewind and fork helpers without reconstructing provider state in the feature', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    session.snapshot = {
      providerId: 'claude',
      revision: 4,
      status: 'idle',
      providerSessionId: 'native-current',
    };

    await expect(harness.coordinator.previewRewind(
      'user-1',
      'assistant-1',
      'conversation',
    )).resolves.toEqual({ canRewind: true });
    await expect(harness.coordinator.rewind(
      'user-1',
      'assistant-1',
      'conversation',
    )).resolves.toMatchObject({ canRewind: true });

    await expect(harness.coordinator.resolveForkSource(
      'assistant-1',
      async () => 'native-fallback',
    )).resolves.toEqual({
      sessionId: 'native-current',
      resumeAt: 'assistant-1',
    });
  });

  it('preserves the replacement binding when an old native rewind completes', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    const nativeRewind = deferred<typeof session.rewindResult>();
    const rewind = jest.spyOn(session, 'rewind').mockReturnValue(nativeRewind.promise);

    const resultPromise = harness.coordinator.rewind(
      'user-before-transition',
      'assistant-before-transition',
      'conversation',
    );
    for (let attempt = 0; attempt < 10 && rewind.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(rewind).toHaveBeenCalledTimes(1);

    await harness.registry.runTransition(['claude'], async () => undefined);
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    await harness.coordinator.prepare();
    harness.repository.persistExecutionSnapshot.mockClear();
    harness.repository.releaseExecutionBinding.mockClear();

    nativeRewind.resolve({
      canRewind: true,
      sessionStrategy: 'preserve-provider-session',
    });
    await expect(resultPromise).resolves.toEqual({
      canRewind: true,
      sessionStrategy: 'preserve-provider-session',
    });
    expect(harness.repository.persistExecutionSnapshot).not.toHaveBeenCalled();
    expect(harness.repository.releaseExecutionBinding).not.toHaveBeenCalled();
    expect(harness.coordinator.snapshot?.providerId).toBe('codex');
  });

  it('drops the session on lifecycle invalidation and recreates it at the new generation', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const first = harness.backends.get('claude')!.sessions[0];

    await harness.registry.runTransition(['claude'], async () => undefined);

    expect(first.disposeCalls).toBe(1);
    expect(harness.coordinator.state).toBe('stale');
    await harness.coordinator.prepare();
    expect(harness.backends.get('claude')!.sessions).toHaveLength(2);
    expect(harness.repository.registerExecutionBinding).toHaveBeenLastCalledWith(
      'conversation-1',
      'local-2',
      1,
    );
  });

  it('disposes idempotently and never acquires again', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();

    await Promise.all([
      harness.coordinator.dispose(),
      harness.coordinator.dispose(),
    ]);

    expect(harness.backends.get('claude')!.sessions[0].disposeCalls).toBe(1);
    await expect(harness.coordinator.prepare()).rejects.toThrow(
      'Chat execution coordinator is disposed',
    );
  });
});


test.each([undefined, 'provider-reported-model'])(
  'attributes requested and background usage to execution while preserving native model %s',
  async nativeModel => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const usage = { inputTokens: 20, contextTokens: 20, contextWindow: 100, percentage: 20,
      ...(nativeModel ? { model: nativeModel } : {}) };
    run.events.push({ type: 'usage_updated', scope: requestedScope(session, run, 1), usage });
    run.events.push({ type: 'turn_completed', scope: requestedScope(session, run, 2), reason: 'completed' });
    run.events.end();
    await resultPromise;
    const scope = { kind: 'background' as const, sessionInstanceId: session.sessionInstanceId,
      turnId: 'background-usage', sequence: 1 };
    session.emit({ type: 'background_turn_started', scope });
    session.emit({ type: 'usage_updated', scope: { ...scope, sequence: 2 }, usage });
    session.emit({ type: 'background_turn_completed', scope: { ...scope, sequence: 3 }, reason: 'completed' });
    for (const events of [harness.requestedEvents, harness.sessionEvents]) {
      expect(events.find(event => event.type === 'usage_updated')).toMatchObject({
        usage: { model: nativeModel ?? 'model-1' },
      });
    }
    expect(usage.model).toBe(nativeModel);
    await harness.coordinator.dispose();
  },
);

it('protects branch navigation from idle release and concurrent input and persists the resulting native cursor', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const harness = createHarness({ idleReleaseMs: IDLE_MS });
  await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await harness.coordinator.prepare();
  const session = harness.backends.get('claude')!.sessions[0];
  const navigation = deferred<{ status: string; messages: ChatMessage[] }>();
  const navigate = jest.fn(() => navigation.promise);
  Object.assign(session, { navigateConversationBranch: navigate, getConversationBranches: async () => ({}),
    reconcileConversationBranch: async () => ({ status: 'committed', messages: [] }) });
  const request = { userMessageId: 'user', configuration: { systemInstructions: { kind: 'provider-default' as const } } };
  const pending = harness.coordinator.navigateConversationBranch(request);
  await new Promise(resolve => setImmediate(resolve));
  expect(navigate).toHaveBeenCalledWith({ ...request, signal: expect.any(AbortSignal) });
  await jest.advanceTimersByTimeAsync(IDLE_MS);
  expect(session.disposeCalls).toBe(0);
  await expect(harness.coordinator.execute(createSubmission())).rejects.toThrow('already active');
  navigation.resolve({ status: 'committed', messages: [] });
  await expect(pending).resolves.toEqual({ status: 'committed', messages: [] });
  await harness.coordinator.dispose();
});

it('reports recovery after native branching succeeds but snapshot persistence fails', async () => {
  jest.useFakeTimers();
  const harness = createHarness({ idleReleaseMs: IDLE_MS });
  await harness.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await harness.coordinator.prepare();
  const session = harness.backends.get('claude')!.sessions[0];
  const messages: ChatMessage[] = [{ id: 'selected', role: 'user', content: 'Selected branch', timestamp: testDate().getTime() }];
  Object.assign(session, {
    getConversationBranches: async () => ({}),
    navigateConversationBranch: async () => {
      session.snapshot = { ...session.snapshot, revision: 1, providerState: { leaf: 'selected' } };
      return { status: 'committed', messages };
    },
    reconcileConversationBranch: async () => ({ status: 'committed', messages }),
  });
  harness.repository.persistExecutionSnapshot.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(harness.coordinator.navigateConversationBranch({ userMessageId: 'old', configuration: { systemInstructions: { kind: 'provider-default' } } }))
    .resolves.toMatchObject({ status: 'recovery-required', messages });
  await jest.advanceTimersByTimeAsync(IDLE_MS);
  expect(session.disposeCalls).toBe(0);
  await expect(harness.coordinator.execute(createSubmission())).rejects.toThrow('recovery must finish');
  await expect(harness.coordinator.reconcileConversationBranch({ configuration: { systemInstructions: { kind: 'provider-default' } } }))
    .resolves.toEqual({ status: 'committed', messages });
  expect(harness.repository.persistExecutionSnapshot).toHaveBeenLastCalledWith(
    'conversation-1', expect.any(String), expect.any(Number), expect.objectContaining({ revision: 1 }),
  );
  await harness.coordinator.dispose();
});
