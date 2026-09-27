import { createHarness, deferred, FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture } from '@test/helpers/ChatInputHarness';

import { drainTabForShutdownSnapshot } from '@/features/chat/tabs/TabLifecycle';
import { TabSession } from '@/features/chat/tabs/TabSession';

beforeEach(() => {
  const execute = FakeSession.prototype.execute;
  jest.spyOn(FakeSession.prototype, 'execute').mockImplementation(function (this: FakeSession, request) {
    const result = execute.call(this, request);
    const run = this.runs[this.runs.length - 1];
    run.events.push({ type: 'turn_completed', scope: requestedScope(this, run, 1), reason: 'completed' });
    run.events.end();
    return result;
  });
});
afterEach(() => { jest.restoreAllMocks(); });

test.each(['execution initialization', 'dynamic configuration', 'handoff authority'] as const)(
  'Stop during %s prevents a later native handoff', async phase => {
    const native = createHarness();
    await native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
    const started = deferred<void>();
    const release = deferred<void>();
    if (phase === 'handoff authority') {
      native.repository.assertConversationExecutionAuthority.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
    }
    const input = createFixture({ getExecutionCoordinator: () => native.coordinator });
    if (phase === 'execution initialization') {
      input.deps.ensureExecutionInitialized = async () => {
        started.resolve();
        await release.promise;
        return true;
      };
    }
    if (phase === 'dynamic configuration') {
      Object.assign(input.plugin, { getMainAgentDynamicSystemPromptSections: async () => {
        started.resolve();
        await release.promise;
        return [];
      } });
    }
    const sending = input.controller.sendMessage({ content: 'Do not execute after Stop' });
    await started.promise;
    expect(input.state.isStreaming).toBe(true);
    let drained = false;
    const draining = input.controller.cancelStreamingAndWait().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(input.state.cancelRequested).toBe(true);
    release.resolve();
    await Promise.all([sending, draining]);
    expect(input.state.isStreaming).toBe(false);
    expect(input.input.value).toBe('Do not execute after Stop');
    expect(input.state.messages).toEqual([]);
    await native.coordinator.dispose();
    await native.registry.dispose();
    expect(native.backends.get('claude')!.sessions.flatMap(session => session.requests)).toHaveLength(0);
  },
);



test('shutdown cancels a preparing turn and retains its unsent input for the final snapshot', async () => {
  const native = createHarness();
  await native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  const session = new TabSession({
    id: 'tab-1', conversationId: 'conversation-1', providerId: 'claude', draftModel: null, lifecycleState: 'cold',
  }, native.coordinator);
  const started = deferred<void>();
  const release = deferred<void>();
  const input = createFixture({
    getExecutionCoordinator: () => native.coordinator,
    turnOwner: session.turns,
    isClosing: () => session.lifecycleState === 'closing',
    canStartTurn: () => session.acceptsIntents,
  });
  Object.assign(input.plugin, { getMainAgentDynamicSystemPromptSections: async () => {
    started.resolve();
    await release.promise;
    return [];
  } });
  const sending = input.controller.sendMessage({ content: 'Retain this unsent input' });
  await started.promise;
  session.pauseIntentAdmission();
  const draining = drainTabForShutdownSnapshot({
    session, state: input.state,
    controllers: { inputController: input.controller }, executionCoordinator: native.coordinator,
  } as any);
  // Draining pauses all admission synchronously, before awaiting interaction cleanup.
  release.resolve();
  await Promise.all([sending, draining]);
  await native.coordinator.dispose();
  await native.registry.dispose();
  expect(native.backends.get('claude')!.sessions.flatMap(value => value.requests)).toHaveLength(0);
  expect(input.state.messages).toEqual([expect.objectContaining({ role: 'user', content: 'Retain this unsent input' })]);
  expect(input.input.value).toBe('');
  expect(session.turns.isActive).toBe(false);
});
