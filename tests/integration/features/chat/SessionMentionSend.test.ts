import '@/providers';

import { createHarness, FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture, deferred, waitForCall } from '@test/helpers/ChatInputHarness';
import { testDate } from '@test/helpers/testClock';
import { Notice } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import { ConversationController } from '@/features/chat/controllers/ConversationController';
import { cancelSelectedDestinationTurn } from '@/features/chat/tabs/TabInputEvents';
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
    const capturedSelection = { mode: 'selection' as const, notePath: 'captured.md', selectedText: 'captured text' };
    fixture.deps.selectionController.getContext = () => capturedSelection;
    fixture.input.value = 'later plain follow-up';
    const second = fixture.controller.sendMessage();
    capturedSelection.selectedText = 'changed after capture';
    fixture.deps.selectionController.getContext = () => ({ mode: 'selection', notePath: 'later.md', selectedText: 'later text' });
    gate.resolve(source);
    await Promise.all([first, second]);
    expect(fixture.state.queuedMessage?.turnRequest?.selections).toEqual([{ kind: 'editor', selection: { mode: 'selection', notePath: 'captured.md', selectedText: 'captured text' } }]);
    expect(fixture.state.queuedMessage?.content).toBe('@"Current title"\n\nlater plain follow-up');
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});


it('withdraws an expired async answer waiting behind busy-main reference preparation', async () => {
  holdNativeTurns();
  const fixture = setup();
  fixture.deps.getTabProviderId = () => 'codex';
  const source = await fixture.plugin.getConversationById(id);
  const hydration = deferred<typeof source>();
  fixture.plugin.getConversationById.mockClear().mockReturnValue(hydration.promise);
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
  const active = fixture.controller.sendMessage({ content: 'Active work' });
  await until(() => fixture.native.backends.get('codex')!.sessions.some(session => session.requests.length > 0));
  const native = fixture.native.backends.get('codex')!.sessions[0];
  native.steerResult = false;
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: time, toolCalls: [tool] });
  fixture.input.value = token;
  const mention = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  fixture.input.value = 'Keep this draft';
  const send = jest.spyOn(fixture.controller, 'sendMessage');
  const abort = new AbortController();
  const answer = fixture.controller.answerQuestion(tool, { '0': 'History' }, 'conversation-1', abort.signal)
    .then(() => 'sent', () => 'not sent');
  await until(() => send.mock.calls.length === 1);
  abort.abort();
  tool.questionStatus = 'expired';
  hydration.resolve(source);
  try {
    await mention;
    const outcome = await answer;
    expect(fixture.state.queuedMessage?.turnRequest?.text).toBe('@"Current title"');
    expect(fixture.input.value).toBe('Keep this draft');
    expect(outcome).toBe('not sent');
    finishNativeTurn(native, 0);
    await active;
    await until(() => native.requests.length === 2);
    expect(native.requests[1].input)
      .toEqual([{ type: 'text', text: '@"Current title"' }]);
  } finally {
    fixture.controller.clearQueuedMessage();
    fixture.controller.cancelStreaming();
    native.runs.forEach(run => run.cancel());
    await active;
    await fixture.native.coordinator.dispose();
    await fixture.native.registry.dispose();
  }
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

it.each([false, true])('restores prepared drafts when rewind begins during hydration (plain follow-up: %s)', async followUp => {
  const fixture = setup();
  const hydration = deferred<any>();
  const initialization = deferred<boolean>();
  const source = await fixture.plugin.getConversationById(id);
  fixture.plugin.getConversationById.mockClear().mockReturnValue(hydration.promise);
  const session = new TabSession({ id: 'tab', conversationId: 'conversation-1', providerId: 'claude', draftModel: null, lifecycleState: 'warm' }, fixture.native.coordinator);
  const initialize = jest.fn().mockReturnValue(initialization.promise);
  const conversation = new ConversationController({
    ...fixture.deps,
    navigation: session,
    subagentManager: fixture.deps.getSubagentManager(),
    setWelcomeEl: jest.fn(),
    clearQueuedMessage: jest.fn(),
    ensureExecutionInitialized: initialize,
  });
  fixture.state.messages = [
    { id: 'previous-user', role: 'user', content: 'previous prompt', userMessageId: 'native-user', timestamp: time },
    { id: 'previous-assistant', role: 'assistant', content: 'previous answer', assistantMessageId: 'native-assistant', timestamp: time },
  ];
  fixture.state.isStreaming = true;
  fixture.input.value = token;
  const sending = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  let following: Promise<void> | undefined;
  if (followUp) {
    fixture.input.value = 'later plain follow-up';
    following = fixture.controller.sendMessage();
  }
  expect(fixture.input.value).toBe('');
  fixture.state.isStreaming = false;
  const rewinding = conversation.rewind('previous-user', 'conversation');
  try {
    await waitForCall(initialize);
    expect(fixture.state.isRewinding).toBe(true);
    hydration.resolve(source);
    await Promise.all([sending, following]);
    expect(fixture.native.backends.get('claude')!.sessions).toHaveLength(0);
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value.split('\n\n').sort()).toEqual(
      (followUp ? [token, 'later plain follow-up'] : [token]).sort(),
    );
  } finally {
    initialization.resolve(false);
    await rewinding;
    await fixture.native.coordinator.dispose();
    await fixture.native.registry.dispose();
  }
});

function holdNativeTurns() {
  jest.restoreAllMocks();
  const execute = FakeSession.prototype.execute;
  return jest.spyOn(FakeSession.prototype, 'execute').mockImplementation(function (this: FakeSession, request) {
    const result = execute.call(this, request);
    const run = this.runs.at(-1)!;
    run.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(this, run, 1) });
    return result;
  });
}

function finishNativeTurn(session: FakeSession, index: number) {
  const run = session.runs[index];
  run.events.push({ type: 'turn_completed', scope: requestedScope(session, run, 2), reason: 'completed' });
  run.events.end();
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  expect(check()).toBe(true);
}

it('dispatches an older queued message before a newer mention still hydrating', async () => {
  const execute = holdNativeTurns();
  const fixture = setup();
  const source = await fixture.plugin.getConversationById(id);
  const hydration = deferred<any>();
  fixture.plugin.getConversationById.mockClear().mockReturnValue(hydration.promise);
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  fixture.input.value = 'active turn';
  const active = fixture.controller.sendMessage();
  await until(() => execute.mock.calls.length > 0);
  const session = fixture.native.backends.get('claude')!.sessions[0];
  fixture.input.value = 'older plain follow-up';
  await fixture.controller.sendMessage();
  fixture.input.value = token;
  const mention = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  try {
    finishNativeTurn(session, 0);
    await active;
    await until(() => session.requests.length === 2);
    expect(session.requests[1].input).toEqual([{ type: 'text', text: 'older plain follow-up' }]);
    hydration.resolve(source);
    await mention;
    expect(fixture.state.queuedMessage?.content).toBe('@"Current title"');
    finishNativeTurn(session, 1);
    await until(() => session.requests.length === 3);
    expect(session.requests[2].context?.sessionReferences?.[0].id).toBe(id);
    finishNativeTurn(session, 2);
    await until(() => !fixture.state.isStreaming);
  } finally {
    fixture.controller.cancelStreaming();
    hydration.resolve(source);
    session.runs.forEach(run => run.cancel());
    await Promise.allSettled([active, mention]);
    await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
  }
});

it.each([false, true])('releases preparation ordering at admission while the next turn is still running (mention fails: %s)', async fails => {
  const execute = holdNativeTurns();
  const fixture = setup();
  const source = await fixture.plugin.getConversationById(id);
  const hydration = deferred<any>();
  fixture.plugin.getConversationById.mockClear().mockReturnValue(hydration.promise);
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  fixture.input.value = 'active turn';
  const active = fixture.controller.sendMessage();
  await until(() => execute.mock.calls.length > 0);
  const session = fixture.native.backends.get('claude')!.sessions[0];
  fixture.input.value = token;
  const mention = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  fixture.input.value = 'later plain follow-up';
  const later = fixture.controller.sendMessage();
  fixture.input.value = 'last follow-up';
  const last = fixture.controller.sendMessage();
  try {
    finishNativeTurn(session, 0);
    await active;
    hydration.resolve(fails ? null : source);
    await until(() => session.requests.length === 2);
    expect(session.requests[1].input).toEqual([{ type: 'text', text: fails ? 'later plain follow-up' : '@"Current title"' }]);
    const queued = fails ? 'last follow-up' : 'later plain follow-up\n\nlast follow-up';
    await until(() => fixture.state.queuedMessage?.content === queued);
    fixture.controller.withdrawQueuedMessageToComposer();
    expect(fixture.input.value).toContain(queued);
    expect(fixture.input.value.includes(token)).toBe(fails);
    finishNativeTurn(session, 1);
    await Promise.all([mention, later, last]);
  } finally {
    fixture.controller.cancelStreaming();
    hydration.resolve(source);
    session.runs.forEach(run => run.cancel());
    await Promise.allSettled([active, mention, later, last]);
    await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
  }
});

it.each(['withdraw', 'cancel', 'initialization'])('restores token text and refreshes references after %s', async recovery => {
  const fixture = setup();
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  try {
    fixture.state.isStreaming = recovery !== 'initialization';
    if (recovery === 'initialization') fixture.deps.ensureExecutionInitialized = async () => false;
    fixture.input.value = token;
    await fixture.controller.sendMessage();
    if (recovery !== 'initialization') {
      fixture.input.value = 'plain follow-up';
      await fixture.controller.sendMessage();
      if (recovery === 'withdraw') fixture.controller.withdrawQueuedMessageToComposer();
      else fixture.controller.cancelStreaming();
    }
    const suffix = recovery === 'initialization' ? '' : '\n\nplain follow-up';
    expect(fixture.input.value).toBe(token + suffix);
    fixture.state.isStreaming = false;
    fixture.deps.ensureExecutionInitialized = async () => true;
    await fixture.controller.sendMessage();
    expect(fixture.write).toHaveBeenCalledTimes(2);
    const request = fixture.native.backends.get('claude')!.sessions.flatMap(session => session.requests)[0];
    expect(request.input).toEqual([{ type: 'text', text: '@"Current title"' + suffix }]);
    expect(request.context?.sessionReferences?.[0].id).toBe(id);
  } finally { await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose(); }
});

it.each([false, true])('retains queued priority and captured selections through the timer gap (new selection: %s)', async different => {
  holdNativeTurns();
  jest.useFakeTimers();
  const fixture = setup();
  const writing = deferred<string>();
  fixture.write.mockReturnValue(writing.promise);
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  fixture.input.value = 'active turn';
  const active = fixture.controller.sendMessage();
  await jest.advanceTimersByTimeAsync(0);
  const session = fixture.native.backends.get('claude')!.sessions[0];
  const older = {
    editor: { mode: 'selection' as const, notePath: 'same.md', selectedText: 'older editor' },
    browser: { source: 'browser', selectedText: 'older browser' },
    canvas: { canvasPath: 'same.canvas', nodeIds: ['older-node'] },
  };
  const newer = {
    editor: { mode: 'selection' as const, notePath: 'same.md', selectedText: 'newer editor' },
    browser: { source: 'browser', selectedText: 'newer browser' },
    canvas: { canvasPath: 'same.canvas', nodeIds: ['newer-node'] },
  };
  const expected = [older, ...(different ? [newer] : [])].flatMap(value => [
    { kind: 'editor', selection: { ...value.editor } },
    { kind: 'browser', selection: { ...value.browser } },
    { kind: 'canvas', selection: { ...value.canvas, nodeIds: [...value.canvas.nodeIds] } },
  ]);
  fixture.deps.selectionController.getContext = () => older.editor;
  fixture.deps.browserSelectionController!.getContext = () => older.browser;
  fixture.deps.canvasSelectionController.getContext = () => older.canvas;
  fixture.input.value = 'older plain follow-up';
  await fixture.controller.sendMessage();
  fixture.deps.selectionController.getContext = () => different ? newer.editor : null;
  fixture.deps.browserSelectionController!.getContext = () => different ? newer.browser : null;
  fixture.deps.canvasSelectionController.getContext = () => different ? newer.canvas : null;
  fixture.input.value = token;
  const mention = fixture.controller.sendMessage();
  await waitForCall(fixture.write);
  older.editor.selectedText = newer.editor.selectedText = 'live editor changed';
  older.browser.selectedText = newer.browser.selectedText = 'live browser changed';
  older.canvas.nodeIds.push('live-node');
  newer.canvas.nodeIds.push('live-node');
  try {
    finishNativeTurn(session, 0);
    await active;
    writing.resolve('/tmp/claudian-sessions/snapshot.md');
    // Drain promise continuations while deliberately withholding the queued timer.
    for (let tick = 0; tick < 100; tick++) await Promise.resolve();
    expect(session.requests).toHaveLength(1);
    expect(fixture.state.queuedMessage?.content).toBe('older plain follow-up\n\n@"Current title"');
    await mention;
    await jest.advanceTimersByTimeAsync(0);
    expect(session.requests[1].input).toEqual([{ type: 'text', text: 'older plain follow-up\n\n@"Current title"' }]);
    expect(session.requests[1].context?.sessionReferences?.[0].id).toBe(id);
    expect(session.requests[1].context?.selections).toEqual(expected);
    expect(fixture.state.messages.filter(message => message.role === 'user').at(-1)
      ?.executionInput?.context).toEqual(session.requests[1].context);
    finishNativeTurn(session, 1);
    await jest.advanceTimersByTimeAsync(0);
  } finally {
    fixture.controller.cancelStreaming();
    fixture.controller.clearQueuedMessage();
    writing.resolve('/tmp/claudian-sessions/snapshot.md');
    session.runs.forEach(run => run.cancel());
    await Promise.allSettled([active, mention]);
    await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
    jest.useRealTimers();
  }
});

it.each(['cancel', 'withdraw', 'discard', 'pause', 'shutdown', 'replacement'] as const)(
  'retains scheduled queued input through %s without a stray handoff', async action => {
    jest.useFakeTimers();
    const fixture = setup();
    const session = new TabSession({ id: 'tab', conversationId: 'conversation-1', providerId: 'claude', draftModel: null, lifecycleState: 'warm' }, fixture.native.coordinator);
    fixture.deps.canStartTurn = () => session.acceptsIntents;
    await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
    try {
      fixture.state.isStreaming = true;
      fixture.input.value = token;
      await fixture.controller.sendMessage();
      fixture.state.isStreaming = false;
      fixture.controller.resumeQueuedTurnAfterIntentAdmission();
      switch (action) {
        case 'cancel': fixture.controller.cancelStreaming(); break;
        case 'withdraw': fixture.controller.withdrawQueuedMessageToComposer(); break;
        case 'discard': fixture.controller.clearQueuedMessage(); break;
        case 'pause': session.pauseIntentAdmission(); break;
        case 'replacement': fixture.state.currentConversationId = 'replacement'; break;
        case 'shutdown': await drainTabForShutdownSnapshot({ session, state: fixture.state,
          controllers: { inputController: fixture.controller }, executionCoordinator: fixture.native.coordinator } as never); break;
      }
      await jest.advanceTimersByTimeAsync(0);
      expect(fixture.native.backends.get('claude')!.sessions.flatMap(value => value.requests).length).toBe(0);
      expect(fixture.input.value).toBe(['cancel', 'withdraw', 'replacement'].includes(action) ? token : '');
      if (action === 'pause') {
        session.resumeIntentAdmission();
        fixture.controller.resumeQueuedTurnAfterIntentAdmission();
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(fixture.native.backends.get('claude')!.sessions.flatMap(value => value.requests)
        .map(request => request.context?.sessionReferences?.[0].id)).toEqual(action === 'pause' ? [id] : []);
    } finally {
      fixture.controller.clearQueuedMessage();
      await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
      jest.useRealTimers();
    }
  },
);

it('cancels a still-hydrating queued mention after the active turn completes', async () => {
  const execute = holdNativeTurns();
  const fixture = setup();
  const source = await fixture.plugin.getConversationById(id);
  const hydration = deferred<any>();
  fixture.plugin.getConversationById.mockClear().mockReturnValue(hydration.promise);
  await fixture.native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  fixture.input.value = 'active turn';
  const active = fixture.controller.sendMessage();
  await until(() => execute.mock.calls.length > 0);
  const session = fixture.native.backends.get('claude')!.sessions[0];
  fixture.input.value = token;
  const mention = fixture.controller.sendMessage();
  await waitForCall(fixture.plugin.getConversationById);
  finishNativeTurn(session, 0);
  await active;
  const cancelled = cancelSelectedDestinationTurn({
    state: fixture.state,
    controllers: { inputController: fixture.controller, sideChatController: { destination: 'main' } },
  } as never);
  hydration.resolve(source);
  for (let tick = 0; tick < 100; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  session.runs.forEach(run => run.cancel());
  await mention;
  await fixture.native.coordinator.dispose(); await fixture.native.registry.dispose();
  expect({ cancelled, submittedTurns: session.requests.length, draft: fixture.input.value })
    .toEqual({ cancelled: true, submittedTurns: 1, draft: token });
});
