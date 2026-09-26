import { FakeSideBackend, waitFor } from '@test/helpers/features/chat/SideChatSessionHarness';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { WarmExecutionCapacityError, WarmExecutionPool } from '@/features/chat/execution/WarmExecutionPool';
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

  it('resumes the normalized child snapshot after idle cooling instead of reforking the parent', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const harness = createSession({ warmExecution: { ownerId: 'side-1', pool } });
    const first = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    harness.backend.latest.establishChild('child-session', { childKey: 'value' });
    harness.backend.latest.complete();
    await first;

    expect(harness.session.canCool()).toBe(true);
    await harness.session.cool();
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

  it('retains newer child state when snapshot revisions restart after cooling', async () => {
    const harness = createSession();
    for (const [index, value] of ['first', 'second'].entries()) {
      const running = harness.session.execute(turn('Continue'));
      await waitFor(() => harness.backend.sessions.length === index + 1);
      harness.backend.latest.establishChild('child-session', { childKey: value });
      harness.backend.latest.complete();
      await running;
      await harness.session.cool();
    }
    const resumed = harness.session.execute(turn('Continue'));
    await waitFor(() => harness.backend.sessions.length === 3);
    expect(harness.backend.latest.config.resumeSeed?.providerState).toMatchObject({ childKey: 'second' });
    harness.backend.latest.complete();
    await resumed;
    await harness.session.dispose();
  });

  it('protects an executing owner from cooling and reports capacity errors without losing the turn', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const harness = createSession({ warmExecution: { ownerId: 'side-1', pool } });
    const running = harness.session.execute(turn('Explore B'));
    await waitFor(() => harness.backend.sessions.length === 1);
    expect(harness.session.canCool()).toBe(false);
    await expect(harness.session.cool()).rejects.toThrow(/busy/i);
    harness.backend.latest.complete();
    await running;

    // A child without a verified native identity stays protected from eviction.
    expect(harness.session.canCool()).toBe(false);
    const established = harness.session.execute(turn('Establish'));
    await waitFor(() => harness.backend.latest.requests.length === 2);
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.complete();
    await established;
    expect(harness.session.canCool()).toBe(true);

    const blockers = Array.from({ length: 5 }, (_unused, index) => ({
      canCool: () => false,
      cool: async () => undefined,
      id: `blocker-${index}`,
    }));
    await harness.session.cool();
    for (const blocker of blockers) await pool.acquire(blocker);
    await expect(harness.session.execute(turn('Blocked'))).rejects.toBeInstanceOf(WarmExecutionCapacityError);
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
    expect(harness.session.canCool()).toBe(false);
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
