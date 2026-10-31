import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { PiNativeProcess } from '@test/helpers/providers/pi/PiNativeProcess';
import { testTime } from '@test/helpers/testClock';
import spawn from 'cross-spawn';

import { isSteerableExecutionSession,   type ProviderExecutionEvent,
type ProviderExecutionRequest, type ProviderExecutionSession,type ProviderInteractionPort,
  type ProviderSessionConfig, type ProviderSessionEvent } from '@/core/execution';
import type { Conversation } from '@/core/types';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const sessions: ProviderExecutionSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.mocked(spawn).mockReset();
});

async function createHost() {
  return (await createProviderHostFixture({
    overrides: { workingDirectory: '/vault',
    getResolvedProviderCliPath: vi.fn(async () => '/bin/pi') },
    settings: {
      effortLevel: 'off',
      mediaFolder: 'media',
      model: 'pi:anthropic/claude-sonnet-4',
      providerConfigs: {
        pi: {
          discoveredModels: [{
            encodedId: 'pi:anthropic/claude-sonnet-4',
            id: 'claude-sonnet-4',
            input: ['text', 'image'],
            label: 'Claude Sonnet 4',
            provider: 'anthropic',
            reasoning: true,
            thinkingLevels: ['off', 'high'],
          }],
          enabled: true,
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
      systemPrompt: '',
      userName: '',
    },
  })).host;
}

function createConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  return {
    interactionPort: createInteractionPort(),
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    workingDirectory: '/vault',
    ...overrides,
  };
}

function createInteractionPort(): ProviderInteractionPort {
  return {
    askUserQuestion: vi.fn(),
    dismissInteraction: vi.fn(),
    requestApproval: vi.fn(),
  };
}

function createRequest(
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    configuration: {
      model: 'pi:anthropic/claude-sonnet-4',
      reasoning: 'high',
      systemInstructions: { kind: 'main-agent' as const, instructions: 'Main Agent prompt.' },
    },
    input: [{ text: 'Hello Pi', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

async function collect(
  events: AsyncIterable<ProviderExecutionEvent>,
  observe: (event: ProviderExecutionEvent) => void = () => undefined,
): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    observe(event);
  }
  return collected;
}

function eventSignal(predicate: (event: ProviderExecutionEvent) => boolean) {
  let resolve!: () => void;
  const seen = new Promise<void>(done => { resolve = done; });
  return { seen, observe(event: ProviderExecutionEvent) { if (predicate(event)) resolve(); } };
}

function completeTurn(kernel: PiNativeProcess): void {
  kernel.emit({ type: 'agent_start' });
  kernel.emit({ type: 'agent_end' });
  kernel.emit({ type: 'agent_settled' });
}

function getPromptMessages(kernel: PiNativeProcess): string[] {
  return kernel.requests
    .filter(({ type }) => type === 'prompt')
    .map(({ payload }) => String(payload.message));
}

async function createHarness(
  config = createConfig(),
  onProcessCreated?: (native: PiNativeProcess, index: number) => void,
  requestHandler?: <T>(type: string, payload: Record<string, unknown>) => Promise<T>,
) {
  const host = await createHost();
  const processes: PiNativeProcess[] = [];
  let processReady!: (native: PiNativeProcess) => void;
  const started = new Promise<PiNativeProcess>(resolve => { processReady = resolve; });
  const responses = new Map<string, unknown>([
    ['get_session_stats', { contextWindow: 200_000, inputTokens: 10, outputTokens: 5 }],
    ['get_state', { leafEntryId: 'assistant-1', parentSession: 'parent-session',
      sessionFile: '/tmp/pi-session.jsonl', sessionId: 'pi-session-1' }],
    ['prompt', { disposition: 'started' }], ['set_model', {}], ['set_thinking_level', {}],
    ['steer', { disposition: 'queued' }],
  ]);
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    const native = new PiNativeProcess({ cwd: String(options?.cwd) }, responses, requestHandler);
    processes.push(native);
    processReady(native);
    onProcessCreated?.(native, processes.length - 1);
    return native.child;
  });
  const session = new PiExecutionBackend(host.getRuntimeHost('pi')).createSession(config);
  sessions.push(session);
  return { host, responses, processes, session,
    whenRequest: async (type: string) => (await started).whenRequest(type),
  };
}

it('publishes persisted native turn statistics at live completion', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-throughput-'));
  const sessionFile = path.join(tempDir, 'session.jsonl');
  const content = [
    { type: 'session', version: 3, id: 'pi-session-1', cwd: tempDir },
    { type: 'message', id: 'u', parentId: null, timestamp: testTime(), message: { role: 'user', content: 'Work' } },
    { type: 'message', id: 'a', parentId: 'u', timestamp: testTime({ milliseconds: 2500 }),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop', usage: { output: 125 } } },
  ].map(record => JSON.stringify(record)).join('\n');
  const harness = await createHarness(createConfig({ workingDirectory: tempDir }));
  harness.responses.set('get_state', { sessionId: 'pi-session-1', sessionFile });
  try {
    const eventsPromise = collect(harness.session.execute(createRequest()).events);
    await harness.whenRequest('prompt');
    await fs.writeFile(sessionFile, content);
    harness.processes[0].emit({ type: 'agent_start' });
    harness.processes[0].emit({ type: 'agent_end' });
    harness.processes[0].emit({ type: 'agent_settled' });
    expect((await eventsPromise).at(-1)).toMatchObject({ type: 'turn_completed',
      turnStats: { outputTokens: 125, durationMs: 2500 } });

    const answerCursor = harness.session.getSnapshot().providerState?.leafEntryId;
    expect(answerCursor).toBe('a');

    // A command consumed by an extension must not reuse the preceding answer's identity, checkpoint, or stats.
    harness.responses.set('prompt', { disposition: 'handled' });
    const handledEvents = await collect(harness.session.execute(createRequest()).events);
    expect(handledEvents.at(-1)).toMatchObject({
      type: 'turn_completed', nativeUserMessageId: undefined, nativeAssistantId: undefined,
    });
    expect(handledEvents.at(-1)).not.toHaveProperty('turnStats');
    expect(handledEvents.at(-1)).not.toHaveProperty('nativeCheckpointId');
    // The session cursor still tracks the native leaf for the next turn.
    expect(harness.session.getSnapshot().providerState?.leafEntryId).toBe(answerCursor);
  } finally {
    await harness.session.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

it.each([true, false])('advances the Pi assistant checkpoint (stored leaf: %s)', async storedLeaf => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-'));
  const sessionFile = path.join(tempDir, 'session.jsonl');
  const records = [
    { type: 'session', version: 3, id: 'pi-session-1', cwd: tempDir },
    { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'First' } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'First answer' } },
  ];
  await fs.writeFile(sessionFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const harness = await createHarness(createConfig({
    workingDirectory: tempDir,
    resumeSeed: { providerSessionId: 'pi-session-1', providerState: {
      sessionId: 'pi-session-1', sessionFile, ...(storedLeaf ? { leafEntryId: 'assistant-1' } : {}),
    } },
  }));
  // Pi's documented get_state has sessionId/sessionFile, but no leafEntryId.
  harness.responses.set('get_state', { sessionId: 'pi-session-1', sessionFile });
  try {
    const eventsPromise = collect(harness.session.execute(createRequest()).events);
    await harness.whenRequest('prompt');
    await fs.appendFile(sessionFile, [
      { type: 'message', id: 'user-2', parentId: 'assistant-1', message: { role: 'user', content: 'Second' } },
      { type: 'message', id: 'assistant-2', parentId: 'user-2', message: { role: 'assistant', content: 'Second answer' } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    harness.processes[0].emit({ type: 'agent_start' });
    harness.processes[0].emit({ type: 'agent_end' });
    harness.processes[0].emit({ type: 'agent_settled' });
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      type: 'turn_completed', nativeAssistantId: 'assistant-2', nativeCheckpointId: 'assistant-2',
    });
    expect(harness.session.getSnapshot().providerState).toMatchObject({ leafEntryId: 'assistant-2' });
  } finally {
    await harness.session.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

it('persists a stopped turn so reload replays its prompt and interrupted reply', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stop-'));
  const sessionFile = path.join(tempDir, 'session.jsonl');
  const records = [
    { type: 'session', version: 3, id: 'pi-session-1', cwd: tempDir },
    { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'First' } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'First answer' } },
  ];
  await fs.writeFile(sessionFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const harness = await createHarness(createConfig({
    workingDirectory: tempDir,
    resumeSeed: { providerSessionId: 'pi-session-1', providerState: {
      sessionId: 'pi-session-1', sessionFile, leafEntryId: 'assistant-1',
    } },
  }));
  harness.responses.set('get_state', { sessionId: 'pi-session-1', sessionFile });
  const sessionEvents: ProviderSessionEvent[] = [];
  let publishCursor!: () => void;
  const cursorPublished = new Promise<void>(resolve => { publishCursor = resolve; });
  harness.session.onEvent(event => {
    sessionEvents.push(event);
    if (event.type === 'session_state_changed' && event.snapshot.providerState?.leafEntryId === 'assistant-2') publishCursor();
  });
  try {
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await harness.whenRequest('prompt');
    harness.processes[0].emit({ type: 'agent_start' });
    await fs.appendFile(sessionFile, [
      { type: 'message', id: 'user-2', parentId: 'assistant-1', message: { role: 'user', content: 'Second' } },
      { type: 'message', id: 'assistant-2', parentId: 'user-2', message: {
        role: 'assistant', content: 'Partial', stopReason: 'aborted', errorMessage: 'Request was aborted',
      } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    run.cancel();
    expect((await eventsPromise).at(-1)).toMatchObject({ type: 'cancelled' });

    // Reload from the state announced for persistence, not the live session.
    const announced = () => sessionEvents.find(event => event.type === 'session_state_changed'
      && event.snapshot.providerState?.leafEntryId === 'assistant-2');
    await cursorPublished;
    const settled = announced()!;
    const conversation = {
      id: 'conversation-1', providerId: 'pi', title: 'Stopped', createdAt: 1, lastActivityAt: 1,
      sessionId: 'pi-session-1', messages: [],
      providerState: settled.type === 'session_state_changed' ? settled.snapshot.providerState : undefined,
    } as Conversation;
    const reloaded = await new PiConversationHistoryService().hydrateConversationHistory(conversation, tempDir);
    expect(reloaded.messages?.map(message => [message.content, message.isInterrupt === true])).toEqual([
      ['First', false], ['First answer', false], ['Second', false], ['Partial', true],
    ]);
  } finally {
    await harness.session.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

it('normalizes an acknowledged persistent turn and refreshes native state', async () => {
  const harness = await createHarness();
  const run = harness.session.execute(createRequest({
    input: [
      { text: 'Hello Pi', type: 'text' },
      {
        image: {
          data: 'base64-data',
          id: 'image-1',
          mediaType: 'image/png',
          name: 'diagram.png',
          size: 11,
          source: 'file',
        },
        type: 'image',
      },
    ],
  }));
  const eventsPromise = collect(run.events);
  await harness.whenRequest('prompt');

  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    assistantMessageEvent: { text_delta: 'Hello' },
    type: 'message_update',
  });
  kernel.emit({
    toolCall: { arguments: { path: 'note.md' }, id: 'tool-1', name: 'read' },
    type: 'tool_execution_start',
  });
  kernel.emit({
    id: 'tool-1',
    result: { content: 'note' },
    type: 'tool_execution_end',
  });
  kernel.emit({ type: 'agent_end' });
  kernel.emit({ type: 'agent_settled' });

  const events = await eventsPromise;
  expect(events.map(event => event.type)).toEqual([
    'session_state_changed',
    'turn_started',
    'user_message_started',
    'assistant_message_started',
    'text_delta',
    'tool_started',
    'tool_completed',
    'usage_updated',
    'session_state_changed',
    'turn_completed',
  ]);
  expect(kernel.requests).toContainEqual({
    payload: {
      images: [{ data: 'base64-data', mimeType: 'image/png', type: 'image' }],
      message: 'Hello Pi',
      streamingBehavior: 'followUp',
    },
    type: 'prompt',
  });
  expect(harness.session.getSnapshot()).toMatchObject({
    providerId: 'pi',
    providerSessionId: 'pi-session-1',
    providerState: {
      leafEntryId: 'assistant-1',
      parentSession: 'parent-session',
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-1',
    },
    status: 'idle',
  });
  expect(harness.session.getSnapshot().providerStateDeletes).toBeUndefined();
  expect(new Set(events.map(event => event.scope.sequence)).size).toBe(events.length);
});

it('completes extension-handled prompts without waiting for a model run', async () => {
  const harness = await createHarness();
  harness.responses.set('prompt', { disposition: 'handled' });
  harness.responses.set('get_state', { sessionId: 'pi-session-1' });
  const events: ProviderExecutionEvent[] = [];
  const run = harness.session.execute(createRequest());
  const consumption = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  try {
    await consumption;
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_completed' }));
    expect(events.some(event => event.type === 'assistant_message_started')).toBe(false);
    expect(harness.session.getSnapshot().status).toBe('idle');
  } finally {
    run.cancel();
    await consumption;
    await harness.session.dispose();
  }
});

it('keeps a handled command open for the run its extension starts', async () => {
  const harness: Awaited<ReturnType<typeof createHarness>> = await createHarness(createConfig(), undefined, async <T>(type: string) => {
    if (type === 'prompt') {
      const kernel = harness.processes[0];
      // A command calling sendUserMessage reports handled before its run starts.
      queueMicrotask(() => {
        kernel.emit({ type: 'agent_start' });
        kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Extension answer' } });
      });
      return { disposition: 'handled' } as T;
    }
    return harness.responses.get(type) as T;
  });
  harness.responses.set('get_state', { sessionId: 'pi-session-1' });
  const answer = eventSignal(event => event.type === 'text_delta' && event.text === 'Extension answer');
  const events: ProviderExecutionEvent[] = [];
  const run = harness.session.execute(createRequest({ input: [{ text: '/ask Question', type: 'text' }] }));
  const consumption = (async () => {
    for await (const event of run.events) { events.push(event); answer.observe(event); }
  })();
  try {
    await answer.seen;
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'Extension answer' }));
    expect(events.some(event => event.type === 'turn_completed')).toBe(false);
    expect(harness.session.getSnapshot().status).not.toBe('idle');

    harness.processes[0].emit({ type: 'agent_end', messages: [], willRetry: false });
    harness.processes[0].emit({ type: 'agent_settled' });
    await consumption;
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  } finally {
    run.cancel();
    await consumption;
    await harness.session.dispose();
  }
});

it.each(['started', 'queued'])('waits for settlement with prompt disposition %s', async disposition => {
  const harness = await createHarness();
  harness.responses.set('prompt', { disposition });
  harness.responses.set('get_state', { sessionId: 'pi-session-1' });
  const answer = eventSignal(event => event.type === 'text_delta' && event.text === 'Continued answer');
  const events: ProviderExecutionEvent[] = [];
  const run = harness.session.execute(createRequest());
  const consumption = (async () => {
    for await (const event of run.events) { events.push(event); answer.observe(event); }
  })();
  try {
    await harness.whenRequest('prompt');
    const kernel = harness.processes[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({ type: 'agent_end', messages: [], willRetry: false });

    // Pi may continue queued input after a low-level run ends without retrying.
    kernel.emit({ type: 'agent_start' });
    kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Continued answer' } });
    await answer.seen;
    expect(events.some(event => event.type === 'turn_completed')).toBe(false);
    kernel.emit({ type: 'agent_end', messages: [], willRetry: false });
    kernel.emit({ type: 'agent_settled' });
    await consumption;
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'Continued answer' }));
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  } finally {
    run.cancel();
    await consumption;
    await harness.session.dispose();
  }
});

it('settles pre-1.0 Pi runs on the final agent_end', async () => {
  const harness = await createHarness();
  harness.responses.set('prompt', {});
  const answer = eventSignal(event => event.type === 'text_delta' && event.text === 'Legacy answer');
  const events: ProviderExecutionEvent[] = [];
  const run = harness.session.execute(createRequest());
  const consumption = (async () => {
    for await (const event of run.events) { events.push(event); answer.observe(event); }
  })();
  try {
    await harness.whenRequest('prompt');
    const kernel = harness.processes[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({ type: 'agent_end', messages: [], willRetry: true });

    kernel.emit({ type: 'agent_start' });
    kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Legacy answer' } });
    await answer.seen;
    expect(events.some(event => event.type === 'turn_completed')).toBe(false);
    kernel.emit({ type: 'agent_end', messages: [], willRetry: false });
    await consumption;
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'Legacy answer' }));
  } finally {
    run.cancel();
    await consumption;
    await harness.session.dispose();
  }
});

it('keeps one execution open across native Pi retries and commits the recovered answer', async () => {
  const harness = await createHarness();
  const run = harness.session.execute(createRequest());
  let retryCount = 0;
  const retries = [1, 2].map(count => eventSignal(event => event.type === 'notice' && event.message === 'Pi is retrying the turn.' && retryCount === count));
  const eventsPromise = collect(run.events, event => {
    if (event.type === 'notice' && event.message === 'Pi is retrying the turn.') retryCount += 1;
    retries.forEach(signal => signal.observe(event));
  });
  let settled = false;
  void eventsPromise.then(() => {
    settled = true;
  });
  await harness.whenRequest('prompt');

  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    message: {
      content: [],
      errorMessage: 'OpenRouter rate limit (attempt 1)',
      role: 'assistant',
      stopReason: 'error',
    },
    type: 'message_end',
  });
  kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
  kernel.emit({ attempt: 1, type: 'auto_retry_start' });
  await retries[0].seen;
  expect(settled).toBe(false);

  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    message: {
      content: [],
      errorMessage: 'OpenRouter rate limit (attempt 2)',
      role: 'assistant',
      stopReason: 'error',
    },
    type: 'message_end',
  });
  kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
  kernel.emit({ attempt: 2, type: 'auto_retry_start' });
  await retries[1].seen;
  expect(settled).toBe(false);

  harness.responses.set('get_state', {
    leafEntryId: 'assistant-recovered',
    parentSession: 'parent-session',
    sessionFile: '/tmp/pi-session.jsonl',
    sessionId: 'pi-session-1',
  });
  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    assistantMessageEvent: { text_delta: 'Recovered answer' },
    type: 'message_update',
  });
  kernel.emit({
    message: {
      content: [{ text: 'Recovered answer', type: 'text' }],
      role: 'assistant',
      stopReason: 'stop',
    },
    type: 'message_end',
  });
  kernel.emit({ attempt: 2, success: true, type: 'auto_retry_end' });
  kernel.emit({ messages: [], type: 'agent_end', willRetry: false });
  kernel.emit({ type: 'agent_settled' });

  const events = await eventsPromise;
  expect(events.filter(event => event.type === 'text_delta')).toEqual([
    expect.objectContaining({ text: 'Recovered answer' }),
  ]);
  expect(events.filter(event => event.type === 'notice')).toEqual([
    expect.objectContaining({ message: 'Pi is retrying the turn.' }),
    expect.objectContaining({ message: 'Pi is retrying the turn.' }),
    expect.objectContaining({ message: 'Pi retry finished.' }),
  ]);
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'execution_error',
  }));
  expect(events.at(-1)).toMatchObject({
    nativeAssistantId: 'assistant-recovered',
    nativeCheckpointId: 'assistant-recovered',
    type: 'turn_completed',
  });
});

it.each([
  { label: 'successful', outcome: { aborted: false, result: { summary: 'Summary', firstKeptEntryId: 'entry', tokensBefore: 1000 } }, boundaries: 1, notices: [] },
  { label: 'legacy successful', outcome: {}, boundaries: 1, notices: [] },
  { label: 'cancelled', outcome: { aborted: true, result: undefined }, boundaries: 0, notices: [] },
  { label: 'failed', outcome: { aborted: false, result: undefined, errorMessage: 'Auto-compaction failed: provider unavailable.' }, boundaries: 0,
    notices: [{ type: 'notice', message: 'Auto-compaction failed: provider unavailable.', level: 'warning' }] },
])('reports $label native compaction without inventing a successful boundary', async ({ outcome, boundaries, notices }) => {
  const harness = await createHarness();
  const eventsPromise = collect(harness.session.execute(createRequest()).events);
  await harness.whenRequest('prompt');
  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({ type: 'compaction_start', reason: 'threshold' });
  kernel.emit({ type: 'compaction_end', reason: 'threshold', willRetry: false, ...outcome });
  kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The ordinary reply continues.' } });
  kernel.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  kernel.emit({ type: 'agent_end', messages: [], willRetry: false });
  kernel.emit({ type: 'agent_settled' });
  const events = await eventsPromise;
  expect(events.filter(event => event.type === 'context_compacted')).toHaveLength(boundaries);
  expect(events.filter(event => event.type === 'notice').map(({ type, message, level }) => ({ type, message, level }))).toEqual(notices);
  expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'The ordinary reply continues.' }));
  expect(events.at(-1)?.type).toBe('turn_completed');
  expect(harness.session.getStatus()).toBe('idle');
  await harness.session.dispose();
});

it('completes a recovered context overflow after compaction starts another run', async () => {
  const harness = await createHarness();
  const eventsPromise = collect(harness.session.execute(createRequest()).events);
  await harness.whenRequest('prompt');
  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'error', errorMessage: 'Context window exceeded',
  } });
  // Pi treats context overflow separately from its rate-limit/server-error retry policy.
  kernel.emit({ type: 'agent_end', messages: [], willRetry: false });
  kernel.emit({ type: 'compaction_start', reason: 'overflow' });
  kernel.emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true });
  kernel.emit({ type: 'agent_start' });
  kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Recovered' } });
  kernel.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  kernel.emit({ type: 'agent_end', messages: [], willRetry: false });
  kernel.emit({ type: 'agent_settled' });
  const events = await eventsPromise;
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'execution_error' }));
  expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  await harness.session.dispose();
});

it('surfaces a native Pi terminal error after settlement', async () => {
  const harness = await createHarness();
  const run = harness.session.execute(createRequest());
  const eventsPromise = collect(run.events);
  await harness.whenRequest('prompt');

  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    message: {
      content: [],
      errorMessage: 'OpenRouter retry budget exhausted',
      role: 'assistant',
      stopReason: 'error',
    },
    type: 'message_end',
  });
  kernel.emit({ messages: [], type: 'agent_end', willRetry: false });
  kernel.emit({ type: 'agent_settled' });

  const events = await eventsPromise;
  expect(events.at(-1)).toMatchObject({
    message: 'OpenRouter retry budget exhausted',
    type: 'execution_error',
  });
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'turn_completed',
  }));
  const retry = collect(harness.session.execute(createRequest()).events);
  await kernel.whenRequest('prompt', 2);
  completeTurn(kernel);
  expect((await retry).at(-1)).toMatchObject({ type: 'turn_completed' });
  expect(harness.processes).toHaveLength(1);
  expect(kernel.child.exitCode).toBeNull();
  await harness.session.dispose();
});

it('preserves a pending native Pi error when the process exits before agent end', async () => {
  const harness = await createHarness();
  const run = harness.session.execute(createRequest());
  const eventsPromise = collect(run.events);
  await harness.whenRequest('prompt');

  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    message: {
      content: [],
      errorMessage: 'OpenRouter quota exceeded',
      role: 'assistant',
      stopReason: 'error',
    },
    type: 'message_end',
  });
  kernel.close();

  const events = await eventsPromise;
  expect(events.at(-1)).toMatchObject({
    category: 'process-exited',
    message: 'OpenRouter quota exceeded',
    type: 'execution_error',
  });
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'turn_completed',
  }));
});

it('can cancel while native Pi is waiting to retry and fences later events', async () => {
  const harness = await createHarness();
  const run = harness.session.execute(createRequest());
  let retryCount = 0;
  const retries = [1, 2].map(count => eventSignal(event => event.type === 'notice' && event.message === 'Pi is retrying the turn.' && retryCount === count));
  const eventsPromise = collect(run.events, event => {
    if (event.type === 'notice' && event.message === 'Pi is retrying the turn.') retryCount += 1;
    retries.forEach(signal => signal.observe(event));
  });
  let settled = false;
  void eventsPromise.then(() => {
    settled = true;
  });
  await harness.whenRequest('prompt');

  const kernel = harness.processes[0];
  kernel.emit({ type: 'agent_start' });
  kernel.emit({
    message: {
      content: [],
      errorMessage: 'OpenRouter rate limit',
      role: 'assistant',
      stopReason: 'error',
    },
    type: 'message_end',
  });
  kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
  kernel.emit({ attempt: 1, type: 'auto_retry_start' });
  await retries[0].seen;
  expect(settled).toBe(false);

  run.cancel();
  kernel.emit({
    assistantMessageEvent: { text_delta: 'late recovered answer' },
    type: 'message_update',
  });
  kernel.emit({ messages: [], type: 'agent_end', willRetry: false });
  kernel.emit({ type: 'agent_settled' });

  const events = await eventsPromise;
  expect(events.filter(event => (
    event.type === 'cancelled'
    || event.type === 'execution_error'
    || event.type === 'turn_completed'
  ))).toEqual([expect.objectContaining({ type: 'cancelled' })]);
  expect(events).not.toContainEqual(expect.objectContaining({
    text: 'late recovered answer',
    type: 'text_delta',
  }));
});

it.each([
  { text: '/skill:review', context: undefined, expected: '/skill:review' },
  {
    text: '/skill:review', context: { linkedContent: { path: 'note.md' } },
    expected: '/skill:review \n\n<linked_content path="note.md" />',
  },
  {
    text: '/skill:review', context: capturedSelections,
    expected: '/skill:review \n\n' + capturedSelectionPrompt,
  },
  {
    text: '/skill:review',
    context: { sessionReferences: [{ id: 'ref', title: 'Review', providerId: 'pi', updatedAt: 'updated' }] },
    expected: '/skill:review \n\n<context_sessions>\n<context_session title="Review" id="ref" provider="pi" updated="updated" />\n</context_sessions>',
  },
  {
    text: '/skill:review task', context: { linkedContent: { path: 'note.md' } },
    expected: '/skill:review task\n\n<linked_content path="note.md" />',
  },
  {
    text: 'Please /skill:review', context: { linkedContent: { path: 'note.md' } },
    expected: 'Please /skill:review\n\n<linked_content path="note.md" />',
  },
  {
    text: '/skill:review\nuser arguments', context: { linkedContent: { path: 'note.md' } },
    expected: '/skill:review\nuser arguments\n\n<linked_content path="note.md" />',
  },
])('preserves Pi skill syntax when attaching context to prompts and steers: $text', async ({ text, context, expected }) => {
  const { session, processes, whenRequest } = await createHarness();
  if (!isSteerableExecutionSession(session)) throw new Error('Pi must expose steering');
  const request = createRequest({ input: [{ type: 'text', text }], context });
  const run = session.execute(request);
  const events = collect(run.events);
  try {
    await whenRequest('prompt');
    expect(await session.steer(request)).toBe(true);
    completeTurn(processes[0]);
    await events;
    expect(processes[0].requests.filter(request => request.type === 'prompt' || request.type === 'steer')
      .map(({ type, payload }) => ({ type, message: payload.message }))).toEqual([
      { type: 'prompt', message: expected },
      { type: 'steer', message: expected },
    ]);
  } finally {
    run.cancel();
    await events;
    await session.dispose();
  }
});

it('encodes path-only Linked content without changing the Vault-root process CWD', async () => {
  const harness = await createHarness();
  const run = harness.session.execute(createRequest({
    context: { ...capturedSelections, sessionReferences: [{ id: 'conv-1-ref', title: 'Review', providerId: 'codex', updatedAt: 'updated' }], linkedContent: { path: 'Projects/Research' } },
    input: [{ text: 'Inspect linked content', type: 'text' }],
  }));
  const eventsPromise = collect(run.events);
  await harness.whenRequest('prompt');
  completeTurn(harness.processes[0]);
  await eventsPromise;

  expect(harness.processes[0].launchSpec.cwd).toBe('/vault');
  expect(getPromptMessages(harness.processes[0])).toEqual([
    'Inspect linked content\n\n<linked_content path="Projects/Research" />\n\n' + capturedSelectionPrompt + '\n\n<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" />\n</context_sessions>',
  ]);
  expect(getPromptMessages(harness.processes[0])[0]).not.toMatch(
    /<(?:linked_note|current_note)\b/,
  );
});
