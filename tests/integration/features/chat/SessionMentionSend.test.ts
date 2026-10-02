import '@/providers';

import { createHarness, FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture, deferred, waitForCall } from '@test/helpers/ChatInputHarness';
import { testDate } from '@test/helpers/testClock';
import { Notice } from 'obsidian';

import { drainTabForShutdownSnapshot } from '@/features/chat/tabs/TabLifecycle';
import { TabSession } from '@/features/chat/tabs/TabSession';

const id = 'conv-1-source';
const token = `@[Old title](claudian-session:${id})`;
const time = testDate().getTime();

function setup() {
  const native = createHarness();
  const fixture = createFixture({ getExecutionCoordinator: () => native.coordinator });
  const write = jest.fn().mockResolvedValue('/tmp/claudian-sessions/snapshot.md');
  Object.assign(fixture.plugin, {
    writeSessionSnapshot: write,
    getSessionSnapshotDirectory: () => '/tmp/claudian-sessions',
    findConversationAcrossViews: () => null,
  });
  fixture.plugin.getConversationById.mockResolvedValue({
    id, title: 'Current title', providerId: 'codex', createdAt: time, lastActivityAt: time,
    sessionId: 'native-source', messages: [
      { id: 'u', role: 'user', content: 'verbatim prompt', timestamp: time },
      { id: 'a', role: 'assistant', content: 'final answer', timestamp: time },
    ],
  } as never);
  return { ...fixture, native, write };
}

beforeEach(() => {
  const execute = FakeSession.prototype.execute;
  jest.spyOn(FakeSession.prototype, 'execute').mockImplementation(function (this: FakeSession, request) {
    const result = execute.call(this, request);
    const run = this.runs.at(-1)!;
    run.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(this, run, 1) });
    run.events.push({ type: 'turn_completed', scope: requestedScope(this, run, 2), reason: 'completed' });
    run.events.end();
    return result;
  });
});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('resolves current titles once and carries snapshots through real handoff (queued: %s)', async queued => {
  const fixture = setup();
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  try {
    fixture.state.isStreaming = queued;
    fixture.input.value = `Use ${token} and ${token}`;
    await fixture.controller.sendMessage();
    if (queued) {
      fixture.state.isStreaming = false;
      fixture.controller.resumeQueuedTurnAfterIntentAdmission();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const request = fixture.native.backends.get('claude')!.sessions.flatMap(session => session.requests)[0];
    expect(request.input).toEqual([{ type: 'text', text: 'Use @"Current title" and @"Current title"' }]);
    expect(request.context?.sessionReferences).toEqual([{
      id, title: 'Current title', providerId: 'codex', updatedAt: new Date(time).toISOString(), snapshotPath: '/tmp/claudian-sessions/snapshot.md',
    }]);
    expect(request.configuration.readableRoots).toEqual(['/tmp/claudian-sessions']);
    expect(fixture.write).toHaveBeenCalledTimes(1);
    expect(fixture.write.mock.calls[0][1]).toContain('## T1 user\nverbatim prompt\n\n## T1 assistant\nfinal answer');
    const user = fixture.state.messages.find(message => message.role === 'user');
    expect(user?.displayContent).toBe('Use @"Current title" and @"Current title"');
    expect(user?.executionInput?.context?.sessionReferences).toEqual(request.context?.sessionReferences);
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});

it.each(['hydrate', 'write'])('preserves the original token draft when %s fails', async failure => {
  const fixture = setup();
  try {
    if (failure === 'hydrate') fixture.plugin.getConversationById.mockResolvedValue(null);
    else fixture.write.mockRejectedValue(new Error('disk full'));
    fixture.input.value = token;
    await fixture.controller.sendMessage();
    expect(fixture.input.value).toBe(token);
    expect(fixture.state.messages).toEqual([]);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Old title'));
    expect(fixture.native.backends.get('claude')!.sessions).toHaveLength(0);
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});

it('does not send to a replaced conversation while hydration is pending', async () => {
  const fixture = setup();
  const gate = deferred<never>();
  fixture.plugin.getConversationById.mockReturnValue(gate.promise);
  fixture.input.value = token;
  const sending = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  fixture.state.currentConversationId = 'replacement';
  gate.resolve(null as never);
  await sending;
  expect(fixture.input.value).toBe(token);
  expect(fixture.native.backends.get('claude')!.sessions).toHaveLength(0);
  await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
});

it('uses hydrated repository history while an open source tab is still loading', async () => {
  const fixture = setup();
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  Object.assign(fixture.plugin, { findConversationAcrossViews: () => ({ tabId: 'source-tab', view: {
    getTabManager: () => ({ getTab: () => ({ conversationId: id, hydrationState: 'loading', state: { messages: [], isStreaming: false } }) }),
  } }) });
  try {
    fixture.input.value = token;
    await fixture.controller.sendMessage();
    expect(fixture.write.mock.calls[0][1]).toContain('## T1 user\nverbatim prompt');
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});

it('restores a plain follow-up queued during failed snapshot preparation', async () => {
  const fixture = setup();
  const gate = deferred<never>();
  fixture.plugin.getConversationById.mockReturnValue(gate.promise);
  try {
    fixture.input.value = token;
    const sending = fixture.controller.sendMessage();
    await waitForCall(fixture.plugin.getConversationById);
    fixture.input.value = 'plain follow-up';
    await fixture.controller.sendMessage();
    expect(fixture.state.queuedMessage?.content).toBe('plain follow-up');
    gate.reject(new Error('history missing'));
    await sending;
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toContain(token);
    expect(fixture.input.value).toContain('plain follow-up');
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});

it('preserves submission order when a busy-main mention hydrates more slowly than a later plain send', async () => {
  const fixture = setup();
  const gate = deferred<any>();
  const source = await fixture.plugin.getConversationById(id);
  fixture.plugin.getConversationById.mockClear().mockReturnValue(gate.promise);
  fixture.state.isStreaming = true;
  try {
    fixture.input.value = token;
    const first = fixture.controller.sendMessage();
    await waitForCall(fixture.plugin.getConversationById);
    fixture.deps.selectionController.getContext = () => ({ mode: 'selection', notePath: 'captured.md', selectedText: 'captured text' });
    fixture.input.value = 'later plain follow-up';
    const second = fixture.controller.sendMessage();
    fixture.deps.selectionController.getContext = () => ({ mode: 'selection', notePath: 'later.md', selectedText: 'later text' });
    gate.resolve(source);
    await Promise.all([first, second]);
    expect(fixture.state.queuedMessage?.turnRequest?.editorSelection).toEqual({ mode: 'selection', notePath: 'captured.md', selectedText: 'captured text' });
    expect(fixture.state.queuedMessage?.content).toBe('@"Current title"\n\nlater plain follow-up');
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});


it('cancels and drains queued snapshot preparation before tab shutdown finishes', async () => {
  const fixture = setup();
  const session = new TabSession({ id: 'tab', conversationId: 'conversation-1', providerId: 'claude', draftModel: null, lifecycleState: 'warm' }, fixture.native.coordinator);
  const gate = deferred<any>();
  const source = await fixture.plugin.getConversationById(id);
  fixture.plugin.getConversationById.mockClear().mockReturnValue(gate.promise);
  fixture.state.isStreaming = true;
  fixture.input.value = token;
  const sending = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  let stopped = false;
  const draining = drainTabForShutdownSnapshot({ session, state: fixture.state,
    controllers: { inputController: fixture.controller }, executionCoordinator: fixture.native.coordinator } as never)
    .then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(stopped).toBe(false);
  gate.resolve(source);
  await Promise.all([sending, draining]);
  expect(fixture.write).not.toHaveBeenCalled();
  expect(fixture.state.queuedMessage).toBeNull();
  expect(fixture.input.value).toBe(token);
  await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
});
