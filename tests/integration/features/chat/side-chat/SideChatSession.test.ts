import { deferred } from '@test/helpers/ChatInputHarness';
import { FakeSideBackend, waitFor } from '@test/helpers/features/chat/SideChatSessionHarness';

import { ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest, type ProviderSessionEvent } from '@/core/execution';
import { SideChatSession } from '@/features/chat/side-chat/SideChatSession';

function createSession(overrides: Partial<ConstructorParameters<typeof SideChatSession>[0]> = {}) {
  const backend = new FakeSideBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const buildChildResumeState = jest.fn(async () => ({ forkSource: { resumeAt: 'checkpoint-1', sessionId: 'main-session' } }));
  const requestedEvents: string[] = [];
  const sessionEvents: string[] = [];
  const session = new SideChatSession({
    buildChildResumeState,
    interactionPort: {
      askUserQuestion: async () => { throw new Error('unexpected'); },
      dismissInteraction: () => undefined,
      requestApproval: async () => { throw new Error('unexpected'); },
    },
    lifecycleRegistry,
    onRequestedEvent: event => { requestedEvents.push(event.type); },
    onSessionEvent: event => { sessionEvents.push(event.type); },
    providerId: 'claude',
    ephemeral: false,
    resolveBackend: () => backend,
    vaultWorkingDirectory: '/vault',
    ...overrides,
  });
  return { backend, buildChildResumeState, lifecycleRegistry, requestedEvents, session, sessionEvents };
}

function turn(text: string) {
  return {
    configuration: { systemInstructions: { kind: 'provider-default' as const } },
    images: [],
    text,
  };
}

describe('SideChatSession', () => {
  it('rejects duplicate, out-of-order, foreign, and completed background events before publishing them', async () => {
    const events: ProviderSessionEvent[] = [];
    const harness = createSession({ onSessionEvent: event => { events.push(event); } });
    const running = harness.session.execute(turn('Explore'));
    await waitFor(() => harness.backend.sessions.length === 1);
    const native = harness.backend.latest;
    native.establishChild('child-session');
    native.complete();
    await running;
    const sessionScope = { kind: 'session' as const, sessionInstanceId: native.sessionInstanceId, sequence: 2 };
    native.emitRawSessionEvent({ type: 'task_notification', content: 'Current', scope: sessionScope });
    native.emitRawSessionEvent({ type: 'task_notification', content: 'Duplicate', scope: sessionScope });
    native.emitRawSessionEvent({ type: 'task_notification', content: 'Old', scope: { ...sessionScope, sequence: 1 } });
    native.emitRawSessionEvent({ type: 'task_notification', content: 'Foreign', scope: { ...sessionScope, sessionInstanceId: 'other', sequence: 3 } });
    const scope = { kind: 'background' as const, sessionInstanceId: native.sessionInstanceId, turnId: 'background', sequence: 1 };
    native.emitRawSessionEvent({ type: 'text_delta', text: 'Before start', scope });
    native.emitRawSessionEvent({ type: 'background_turn_started', scope });
    native.emitRawSessionEvent({ type: 'background_turn_started', scope: { ...scope, sequence: 2 } });
    native.emitRawSessionEvent({ type: 'text_delta', text: 'Current output', scope: { ...scope, sequence: 3 } });
    native.emitRawSessionEvent({ type: 'text_delta', text: 'Duplicate output', scope: { ...scope, sequence: 3 } });
    native.emitRawSessionEvent({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 4 } });
    native.emitRawSessionEvent({ type: 'background_turn_started', scope: { ...scope, sequence: 5 } });
    native.emitRawSessionEvent({ type: 'text_delta', text: 'After completion', scope: { ...scope, sequence: 6 } });
    await waitFor(() => !harness.session.hasBackgroundWork || events.length > 4);
    expect(events.map(event => event.type)).toEqual(['task_notification', 'background_turn_started', 'text_delta', 'background_turn_completed']);
    await harness.session.dispose();
  });

  it('keeps a replacement interaction pending when a dismissed request with the same id settles late', async () => {
    const firstReply = deferred<{ interactionId: string; decision: 'allow' }>();
    const nextReply = deferred<{ interactionId: string; decision: 'allow' }>();
    const requestApproval = jest.fn().mockReturnValueOnce(firstReply.promise).mockReturnValueOnce(nextReply.promise);
    const harness = createSession({ interactionPort: {
      askUserQuestion: async () => { throw new Error('unexpected'); }, dismissInteraction: jest.fn(), requestApproval,
    } });
    const running = harness.session.execute(turn('Explore'));
    await waitFor(() => harness.backend.sessions.length === 1);
    const native = harness.backend.latest;
    const port = native.config.interactionPort;
    const request = { kind: 'approval' as const, interactionId: 'reused', sessionInstanceId: native.sessionInstanceId,
      turnId: native.activeTurnId, toolName: 'Read', input: {}, description: 'Read note' };
    const first = port.requestApproval(request, new AbortController().signal);
    port.dismissInteraction(request.interactionId, 'superseded');
    const next = port.requestApproval(request, new AbortController().signal);
    firstReply.resolve({ interactionId: 'reused', decision: 'allow' });
    await expect(first).rejects.toThrow(/stale/i);
    expect(harness.session.hasPendingInteractions).toBe(true);
    nextReply.resolve({ interactionId: 'reused', decision: 'allow' });
    await expect(next).resolves.toMatchObject({ decision: 'allow' });
    expect(harness.session.hasPendingInteractions).toBe(false);
    native.complete();
    await running;
    await harness.session.dispose();
  });

  it('steers only the live child execution and carries its cancellation signal and configuration', async () => {
    const harness = createSession();
    expect(await harness.session.steer('Before execution')).toBe(false);
    expect(harness.backend.sessions).toHaveLength(0);
    const request = { ...turn('Explore'), configuration: { ...turn('Explore').configuration, model: 'active-model', reasoning: 'high' } };
    const running = harness.session.execute(request);
    await waitFor(() => harness.backend.sessions.length === 1);
    const native = harness.backend.latest;
    const steer = jest.fn(async (_request: ProviderExecutionRequest) => true);
    Object.assign(native, { steer });
    expect(await harness.session.steer('Answer')).toBe(true);
    const submitted = steer.mock.calls[0][0];
    expect(submitted).toMatchObject({
      configuration: request.configuration, input: [{ type: 'text', text: 'Answer' }], toolPolicy: { kind: 'provider-default' },
    });
    expect(submitted.signal.aborted).toBe(false);
    harness.session.cancel();
    expect(submitted.signal.aborted).toBe(true);
    await running;
    expect(await harness.session.steer('After cancellation')).toBe(false);
    await harness.session.dispose();
    expect(await harness.session.steer('After disposal')).toBe(false);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(native.requests).toHaveLength(1);
  });

  it('seeds the child with fork state only and keeps both turns on the same native child', async () => {
    const harness = createSession();
    const first = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.backend.latest.establishChild('child-session', { childKey: 'value' });
    harness.backend.latest.complete('side-assistant-1');
    const firstResult = await first;

    expect(harness.backend.latest.config.resumeSeed).toEqual({
      providerState: { forkSource: { resumeAt: 'checkpoint-1', sessionId: 'main-session' } },
    });
    expect(harness.backend.latest.config.lifecycle).toBe('persistent');
    expect(harness.backend.latest.config.nativePersistence).toBe('enabled');
    expect(firstResult).toMatchObject({ accepted: true, checkpointId: 'side-assistant-1', status: 'completed' });
    expect(harness.session.providerSessionId).toBe('child-session');

    const second = harness.session.execute(turn('Use A and B'));
    await waitFor(() => harness.backend.latest.requests.length === 2);
    harness.backend.latest.complete('side-assistant-2');
    await second;
    expect(harness.backend.sessions).toHaveLength(1);
    expect(harness.buildChildResumeState).toHaveBeenCalledTimes(1);
    await harness.session.dispose();
  });

  it('ends an ephemeral child when a provider transition replaces its session', async () => {
    const harness = createSession({ ephemeral: true });
    const first = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.backend.latest.complete();
    await first;
    await harness.lifecycleRegistry.runTransition(['claude'], async () => undefined);
    let outcome: unknown;
    const continuation = harness.session.execute(turn('Continue')).then(result => { outcome = result; }, error => { outcome = error; });
    await waitFor(() => outcome !== undefined || harness.backend.sessions.length > 1);
    if (harness.backend.sessions.length > 1) harness.backend.latest.complete();
    await continuation;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/start a new side chat/i);
    await harness.session.dispose();
  });

  it('resumes the normalized child snapshot after a provider transition instead of reforking the parent', async () => {
    const harness = createSession();
    const first = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.backend.latest.establishChild('child-session', { childKey: 'value' });
    harness.backend.latest.complete();
    await first;

    await harness.lifecycleRegistry.runTransition(['claude'], async () => undefined);
    expect(harness.backend.sessions[0].disposeCalls).toBe(1);

    const second = harness.session.execute(turn('Continue'));
    await waitFor(() => harness.backend.sessions.length === 2);
    expect(harness.backend.latest.config.resumeSeed).toEqual({
      providerSessionId: 'child-session',
      providerState: { childKey: 'value', forkSource: { resumeAt: 'checkpoint-1', sessionId: 'main-session' } },
    });
    expect(harness.buildChildResumeState).toHaveBeenCalledTimes(1);
    harness.backend.latest.complete();
    await second;
    await harness.session.dispose();
  });

  it('retains newer child state when snapshot revisions restart after a provider transition', async () => {
    const harness = createSession();
    for (const [index, value] of ['first', 'second'].entries()) {
      const running = harness.session.execute(turn('Continue'));
      await waitFor(() => harness.backend.sessions.length === index + 1);
      harness.backend.latest.establishChild('child-session', { childKey: value });
      harness.backend.latest.complete();
      await running;
      await harness.lifecycleRegistry.runTransition(['claude'], async () => undefined);
    }
    const resumed = harness.session.execute(turn('Continue'));
    await waitFor(() => harness.backend.sessions.length === 3);
    expect(harness.backend.latest.config.resumeSeed?.providerState).toMatchObject({ childKey: 'second' });
    harness.backend.latest.complete();
    await resumed;
    await harness.session.dispose();
  });

  it('cancels only its own turn and keeps the child usable afterwards', async () => {
    const harness = createSession();
    const running = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.session.cancel();
    expect(await running).toMatchObject({ status: 'cancelled' });
    expect(harness.backend.latest.cancelCalls).toBe(1);

    const next = harness.session.execute(turn('Retry'));
    await waitFor(() => harness.backend.latest.requests.length === 2);
    harness.backend.latest.complete();
    expect(await next).toMatchObject({ status: 'completed' });
    await harness.session.dispose();
  });

  it('cancels pending fork preparation before native handoff and permits an explicit retry', async () => {
    let finishPreparation!: (state: Record<string, unknown>) => void;
    let preparationStarted = false;
    const preparation = new Promise<Record<string, unknown>>(resolve => {
      finishPreparation = resolve;
    });
    const harness = createSession({
      buildChildResumeState: () => {
        preparationStarted = true;
        return preparation;
      },
    });
    const running = harness.session.execute(turn('Cancelled tool work'));
    await waitFor(() => preparationStarted);
    harness.session.cancel();
    finishPreparation({ forkSource: { resumeAt: 'checkpoint-1', sessionId: 'main-session' } });
    // Observe either terminal cancellation or the erroneous native handoff without
    // leaving an executing boundary fixture behind when the regression fails.
    let settled = false;
    void running.finally(() => { settled = true; });
    await waitFor(() => settled || harness.backend.sessions.length > 0);
    const requests = harness.backend.sessions.flatMap(session => session.requests);
    if (harness.backend.sessions.length > 0) harness.backend.latest.complete();
    expect(await running).toMatchObject({ accepted: false, status: 'cancelled' });
    expect(requests).toEqual([]);

    const retry = harness.session.execute(turn('Explicit retry'));
    await waitFor(() => harness.backend.sessions.length === 1);
    expect(harness.backend.latest.requests[0].input).toEqual([
      { text: 'Explicit retry', type: 'text' },
    ]);
    harness.backend.latest.complete();
    await retry;
    await harness.session.dispose();
  });

  it('surfaces missing child history as an error without falling back to the parent session', async () => {
    const harness = createSession();
    const running = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.fail('Child history is gone', 'provider-session-missing');
    const result = await running;
    expect(result).toMatchObject({ status: 'missing-session' });
    expect(harness.session.providerSessionId).toBe('child-session');
    expect(harness.buildChildResumeState).toHaveBeenCalledTimes(1);
    await harness.session.dispose();
  });

  it('routes requested and session-level events separately and stops after disposal', async () => {
    const harness = createSession();
    const running = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.backend.latest.emitText('partial');
    harness.backend.latest.emitSessionEvent({ type: 'commands_changed' });
    harness.backend.latest.complete();
    await running;
    await waitFor(() => harness.requestedEvents.includes('turn_completed'));
    expect(harness.requestedEvents).toEqual(['turn_started', 'text_delta', 'turn_completed']);
    expect(harness.sessionEvents).toEqual(['commands_changed']);

    const session = harness.backend.latest;
    await harness.session.dispose();
    await harness.session.dispose();
    expect(session.disposeCalls).toBe(1);
    session.emitSessionEvent({ type: 'commands_changed' });
    expect(harness.sessionEvents).toEqual(['commands_changed']);
    await expect(harness.session.execute(turn('After disposal'))).rejects.toThrow(/disposed/i);
  });

  it('keeps the side prompt recoverable when native startup fails before acceptance', async () => {
    const harness = createSession({
      buildChildResumeState: jest.fn(async () => { throw new Error('Fork checkpoint not found'); }),
    });
    await expect(harness.session.execute(turn('Explore B'))).rejects.toThrow(/checkpoint not found/i);
    expect(harness.backend.sessions).toHaveLength(0);
    expect(harness.session.providerSessionId).toBeUndefined();
    await harness.session.dispose();
  });

  it('resolves its own approvals and dismisses them when its turn is cancelled', async () => {
    const dismissals: Array<{ interactionId: string; reason: string }> = [];
    let resolveApproval: ((value: { decision: 'allow'; interactionId: string }) => void) | null = null;
    const harness = createSession({
      interactionPort: {
        askUserQuestion: async () => { throw new Error('unexpected'); },
        dismissInteraction: (interactionId, reason) => { dismissals.push({ interactionId, reason }); },
        requestApproval: request => new Promise(resolve => {
          resolveApproval = () => resolve({ decision: 'allow', interactionId: request.interactionId });
        }),
      },
    });
    const running = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    const native = harness.backend.latest;
    const port = native.config.interactionPort;
    const approval = port.requestApproval({
      description: 'Write a note', input: {}, interactionId: 'side-approval-1',
      kind: 'approval', sessionInstanceId: native.sessionInstanceId,
      toolName: 'Write', turnId: native.activeTurnId,
    }, new AbortController().signal);
    await waitFor(() => resolveApproval !== null);
    expect(harness.session.hasPendingInteractions).toBe(true);
    resolveApproval!({ decision: 'allow', interactionId: 'side-approval-1' });
    await expect(approval).resolves.toMatchObject({ decision: 'allow' });

    const pending = port.requestApproval({
      description: 'Write another note', input: {}, interactionId: 'side-approval-2',
      kind: 'approval', sessionInstanceId: native.sessionInstanceId, toolName: 'Write',
      turnId: native.activeTurnId,
    }, new AbortController().signal);
    await waitFor(() => harness.session.hasPendingInteractions);
    harness.session.cancel();
    await running;
    expect(dismissals).toEqual([{ interactionId: 'side-approval-2', reason: 'cancelled' }]);
    resolveApproval!({ decision: 'allow', interactionId: 'side-approval-2' });
    await expect(pending).rejects.toThrow(/stale/i);
    await harness.session.dispose();
  });
});
