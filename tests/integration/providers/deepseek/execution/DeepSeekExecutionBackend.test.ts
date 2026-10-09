import '@/providers';

import { createHarness as createCoordinator } from '@test/helpers/ChatExecutionHarness';
import { createFixture } from '@test/helpers/ChatInputHarness';
import { NativePeer, type NativePeerHostOptions, type NativePeerLifecycle } from '@test/helpers/deepseek/NativePeer';
import { testDate } from '@test/helpers/testClock';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort, ProviderSessionEvent } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ImageAttachment } from '@/core/types';
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

let peer: NativePeer;
let deepseek: DeepSeekHost;
let lifecycle: NativePeerLifecycle;
let session: ProviderExecutionSession;
let sessionEvents: ProviderSessionEvent[];
let permission: string;
let inbox: unknown[];
let seq: number;
let nativeTurn: number;
let port: ProviderInteractionPort;
const time = testDate().getTime();
const host = { settings: { providerConfigs: { deepseek: { enabled: true, visibleModels: ['deepseek:native/model'], discoveredModels: [{ encodedId: 'deepseek:native/model', provider: 'native', id: 'model', label: 'Model', reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }] } } } } as unknown as ProviderHost;

function request(text = 'requested'): ProviderExecutionRequest {
  return { input: [{ type: 'text', text }], configuration: { systemInstructions: { kind: 'explicit', instructions: 'literal {prompt}' }, permissionMode: 'normal' }, toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal };
}
function event(type: string, data: unknown): void {
  peer.send('session/follow', { type: 'event', event: { type, seq: ++seq, time, data } });
}
function begin(rpcId?: string, source = 'tool-jobs'): void {
  nativeTurn++;
  event('turn/start', { turn: nativeTurn });
  if (rpcId) event('user/message', { id: `user-${nativeTurn}`, content: [{ type: 'text', text: 'requested' }], source: { kind: 'user', rpcId } });
  else event('user/message', { id: `notice-${nativeTurn}`, content: [{ type: 'text', text: 'job finished' }], source: { kind: source } });
}
function answer(text: string, step = 0): void {
  event('assistant/message', { turn: nativeTurn, step, message: { content: [{ type: 'text', text }] } });
  event('turn/end', { turn: nativeTurn, reason: { kind: 'completed' } });
}
async function collect(events: AsyncIterable<ProviderExecutionEvent>, into: ProviderExecutionEvent[]): Promise<void> { for await (const event of events) into.push(event); }

beforeEach(async () => {
  permission = 'workspace-write'; inbox = []; seq = 3; nativeTurn = 0; sessionEvents = [];
  port = { requestApproval: jest.fn(), askUserQuestion: jest.fn(), dismissInteraction: jest.fn() };
  peer = new NativePeer();
  peer.onCall = (method, args) => {
    if (method === 'session/create') return { sessionId: 'root', agentPreset: 'claudian' };
    if (method === 'session/list') return { items: [{ sessionId: 'root', agentAvailable: true, running: false }] };
    if (method === 'permissionPresets/catalog') return { options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }] };
    if (method === 'commands/list') return [{ name: 'permission' }, { name: 'compact', description: 'Compact history' }, { name: 'goal' }];
    if (method === 'skills/list') return { skills: [{ name: 'review', description: 'Review changes', modelInvocable: true }] };
    if (method === 'commands/execute') { permission = args.line.split(' ')[1]; return { result: { kind: 'success' } }; }
    if (method === 'session/projections') return { asOfSeq: seq, values: { agentPreset: 'claudian', permissions: { currentValue: permission }, inbox: { 'next-turn': inbox } } };
    if (method === 'session/page') return { hasMore: false, records: [
      { type: 'event', event: { type: 'sandbox/mode', seq: 1, time, data: { mode: permission } } },
      { type: 'event', event: { type: 'approval/policy', seq: 2, time, data: { policy: permission === 'workspace-write' ? 'ask' : 'never' } } },
    ] };
    if (method === 'session/prompt') return { accepted: true };
    if (method === '$events/result') return {};
    if (method === 'session/updateQueue') {
      inbox = inbox.filter((item: any) => item.id !== args.request.itemId);
      peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'inbox', seq: ++seq, value: { 'next-turn': inbox } });
      return { removed: true };
    }
    if (method === 'session/cancel') { event('turn/end', { turn: nativeTurn, reason: { kind: 'cancelled' } }); return {}; }
    throw new Error(`Unexpected native call ${method}`);
  };
  peer.onOpen = (endpoint, _args, send) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: { root: { asOfSeq: seq, values: { inbox: { 'next-turn': inbox } } } } } });
    if (endpoint === 'session/follow') send({ type: 'snapshot', cursor: seq, records: [], header: { id: 'root', agentPreset: 'claudian' }, projections: { asOfSeq: seq, values: {} } });
    if (endpoint === 'job/list') send({ type: 'rows', jobs: [] });
  };
  await peer.open();
  ({ deepseek, lifecycle } = peer.host());
});
afterEach(async () => { await session?.dispose(); await deepseek.dispose(); await peer.close(); });

function create(resume = false): void {
  session = new DeepSeekExecutionBackend(host, () => deepseek).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: '/vault', interactionPort: port,
    ...(resume ? { resumeSeed: { providerSessionId: 'root', providerState: { schemaVersion: 1, home: getDeepSeekHome(process.env), profile: 'web', preset: 'claudian' } } } : {}),
  });
  session.onEvent(event => sessionEvents.push(event));
}

it.each(['tool-jobs', 'subagent-settled'])('attributes only the matched native user turn to the requested stream after %s', async source => {
  create();
  const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  const prompt = peer.calls.find(c => c.method === 'session/prompt')!.args.request;
  expect(prompt).toMatchObject({ requestId: run.executionId, mode: 'queue' });
  expect(events.some(e => e.type === 'turn_started')).toBe(false);
  begin(undefined, source); answer('automatic answer');
  nativeTurn++; event('turn/start', { turn: nativeTurn });
  event('user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: 'runtime context' }] });
  event('user/message', { id: `user-${nativeTurn}`, source: { kind: 'user', rpcId: run.executionId }, content: [{ type: 'text', text: 'requested' }] });
  answer('requested answer');
  await done;
  expect(events.filter(e => e.type === 'text_delta')).toMatchObject([{ text: 'requested answer' }]);
  expect(events.some(e => e.type === 'task_notification')).toBe(false);
  expect(sessionEvents.filter(e => e.type === 'task_notification')).toMatchObject([{ content: 'job finished' }]);
  expect(events.filter(e => e.type === 'turn_started')).toMatchObject([{ accepted: true, nativeUserMessageId: 'user-2' }]);
  expect(events.filter(e => ['turn_completed', 'cancelled', 'execution_error'].includes(e.type))).toHaveLength(1);
  expect(sessionEvents.filter(e => e.type === 'text_delta')).toMatchObject([{ text: 'automatic answer', scope: { kind: 'background' } }]);
  expect(sessionEvents.filter(e => e.type === 'background_turn_started')).toHaveLength(1);
  expect(sessionEvents.filter(e => e.type === 'background_turn_completed')).toHaveLength(1);
  expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'root', providerState: { checkpointSeq: seq } });
});

it('removes only a cancelled queued request and preserves the automatic turn', async () => {
  create(); const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin();
  event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'working' }] } });
  inbox = [{ id: 'ours', source: { kind: 'user', rpcId: run.executionId }, content: [{ type: 'text', text: 'requested' }] }];
  peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'inbox', seq: ++seq, value: { 'next-turn': inbox } });
  run.cancel(); await done;
  expect(peer.calls.filter(c => c.method === 'session/updateQueue')).toMatchObject([{ args: { request: { itemId: 'ours' } } }]);
  expect(peer.calls.some(c => c.method === 'session/cancel')).toBe(false);
  expect(events.at(-1)?.type).toBe('cancelled');
  expect(session.hasBackgroundWork?.()).toBe(true);
  answer('still automatic', 1);
  await until(() => !session.hasBackgroundWork?.());
  expect(sessionEvents.filter(e => e.type === 'background_turn_completed')).toHaveLength(1);
});

it('preserves restored user work and rejects a new send with recoverable Stop guidance', async () => {
  inbox = [{ id: 'old', source: { kind: 'user', rpcId: 'old-request' }, content: [{ type: 'text', text: 'old pending task' }] }];
  create(true); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  await collect(run.events, events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true, message: expect.stringMatching(/1 pending.*old pending task.*Stop/) });
  expect(peer.calls.some(c => c.method === 'session/prompt' || c.method === 'session/updateQueue')).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'root', status: 'idle' });
  expect(session.hasBackgroundWork?.()).toBe(true);
  session.cancel();
  await until(() => !session.hasBackgroundWork?.());
  expect(inbox).toEqual([]);
});

it('stops owned jobs after a requested turn and drains their automatic wakeup', async () => {
  let jobs: unknown[] = [];
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list' ? send({ type: 'rows', jobs }) : ordinaryOpen(endpoint, args, send);
  const ordinaryCall = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'job/kill') {
      begin();
      jobs = [{ id: 'job', owner: 'root', status: 'killed' }, { id: 'foreign', status: 'running' }];
      peer.send('job/list', { type: 'rows', jobs });
      return { status: 'requested' };
    }
    return ordinaryCall(method, args);
  };
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  jobs = [{ id: 'job', owner: 'root', status: 'running' }, { id: 'foreign', status: 'running' }];
  peer.send('job/list', { type: 'rows', jobs });
  answer('job started'); await done;
  expect(session.hasBackgroundWork?.()).toBe(true);
  session.cancel();
  await until(() => !session.hasBackgroundWork?.());
  expect(peer.calls.filter(c => c.method === 'job/kill')).toEqual([{ method: 'job/kill', args: { request: { sessionId: 'root', jobId: 'job' } } }]);
  expect(peer.calls.filter(c => c.method === 'session/cancel')).toHaveLength(1);
  expect(sessionEvents.filter(e => e.type === 'background_turn_completed')).toHaveLength(1);
  expect(session.getStatus()).toBe('idle');
});

it('routes automatic questions under their background turn and fences late answers', async () => {
  let reply!: (value: any) => void;
  port.askUserQuestion = jest.fn(() => new Promise(resolve => { reply = resolve; }));
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId); answer('requested done'); await done;
  begin();
  peer.send('$events', { type: 'waterfall', eventId: 'question', event: 'user-questions/request', agentId: 'root', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] } });
  await until(() => !!reply);
  const started = sessionEvents.find(e => e.type === 'background_turn_started')!;
  expect(port.askUserQuestion).toHaveBeenCalledWith(expect.objectContaining({ turnId: started.scope.kind === 'background' ? started.scope.turnId : undefined }), expect.any(AbortSignal));
  peer.send('$events', { type: 'cancel', eventId: 'question' });
  await until(() => (port.dismissInteraction as jest.Mock).mock.calls.length > 0);
  reply({ interactionId: 'question', answers: { q: 'Yes' } });
  answer('cancelled question');
  await until(() => !session.hasBackgroundWork?.());
  expect(peer.calls.some(c => c.method === '$events/result')).toBe(false);
  expect(port.dismissInteraction).toHaveBeenCalledTimes(1);
});

it('buffers an early child question until its native turn is observed while the root is idle', async () => {
  let reply!: (value: any) => void;
  port.askUserQuestion = jest.fn(() => new Promise(resolve => { reply = resolve; }));
  const ordinaryOpen = peer.onOpen;
  let childFollow!: (value: unknown) => void;
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/follow' && args.request.address.childSessionId === 'child') { childFollow = send; return; }
    ordinaryOpen(endpoint, args, send);
  };
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId); answer('root done'); await done;
  peer.send('$events', { type: 'waterfall', eventId: 'child-question', event: 'user-questions/request', agentId: 'child', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] } });
  peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'subagentCatalog', value: [{ id: 'child', mode: 'continuable', label: 'child task' }] });
  peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'child', parentSessionId: 'root', origin: 'subagent', agentAvailable: true, running: true }] });
  await until(() => !!childFollow);
  expect(port.askUserQuestion).not.toHaveBeenCalled();
  childFollow({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time, data: { turn: 0 } } }] });
  await until(() => !!reply);
  const started = sessionEvents.find(e => e.type === 'background_turn_started')!;
  expect(port.askUserQuestion).toHaveBeenCalledWith(expect.objectContaining({ turnId: started.scope.kind === 'background' ? started.scope.turnId : undefined }), expect.any(AbortSignal));
  reply({ interactionId: 'child-question', answers: { q: 'Yes' } });
  await until(() => peer.calls.some(c => c.method === '$events/result'));
  childFollow({ type: 'event', event: { type: 'turn/end', seq: 1, time, data: { turn: 0, reason: { kind: 'completed' } } } });
  await until(() => !session.hasBackgroundWork?.());
  expect(session.getStatus()).toBe('idle');
  expect(sessionEvents.filter(e => e.type === 'background_turn_completed')).toHaveLength(1);
});

it.each(['error', 'blocked'])('keeps native jobs and the Host alive after a requested %s turn', async kind => {
  const jobs = [{ id: 'job', owner: 'root', status: 'running' }];
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list' ? send({ type: 'rows', jobs }) : ordinaryOpen(endpoint, args, send);
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  event('turn/end', { turn: nativeTurn, reason: { kind, ...(kind === 'error' ? { error: { message: 'Model authentication failed', code: 'AUTH' } } : {}) } });
  await done;
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'provider', recoverable: true });
  expect(events.some(e => e.type === 'turn_completed')).toBe(false);
  expect(lifecycle.disposed).toBe(0);
  expect(session.hasBackgroundWork?.()).toBe(true);
  const retry = session.execute(request('retry')); const retried: ProviderExecutionEvent[] = [];
  const retryDone = collect(retry.events, retried);
  await until(() => peer.calls.filter(c => c.method === 'session/prompt').length === 2);
  begin(retry.executionId); answer('recovered'); await retryDone;
  expect(retried.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
  expect(lifecycle.disposed).toBe(0);
});

it('ends a failed automatic turn without rejecting the queued requested input', async () => {
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin();
  event('turn/end', { turn: nativeTurn, reason: { kind: 'error', error: { message: 'Temporary model failure' } } });
  await until(() => sessionEvents.some(e => e.type === 'session_error'));
  expect(sessionEvents.filter(e => e.type === 'background_turn_completed')).toMatchObject([{ reason: 'provider-ended' }]);
  expect(events.some(e => e.type === 'execution_error')).toBe(false);
  expect(lifecycle.disposed).toBe(0);
  begin(run.executionId); answer('queued input answered'); await done;
  expect(events.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(1);
});

it.each([
  undefined,
  { selections: [], sessionReferences: [], editorSelection: null, canvasSelection: null, browserSelection: null },
  { selections: [], editorSelection: { notePath: 'note.md', mode: 'selection' as const, selectedText: 'superseded' } },
])('publishes native commands and executes compact with empty effective context %j', async context => {
  const ordinaryCall = peer.onCall;
  peer.onCall = (method, args) => method === 'commands/execute' && args.line === '/compact'
    ? { result: { kind: 'success', text: 'No compactable history yet.' } } : ordinaryCall(method, args);
  create(); const run = session.execute({ ...request('/compact'), context }); const events: ProviderExecutionEvent[] = [];
  // The composer dropdown re-reads the snapshot only on this signal.
  const published: Array<string[] | undefined> = [];
  session.onEvent(event => { if (event.type === 'commands_changed') published.push(session.getCommandSnapshot?.()?.map(c => c.name)); });
  const done = collect(run.events, events);
  await until(() => events.some(e => e.type === 'turn_completed'));
  await done;
  expect(peer.calls.filter(c => c.method === 'commands/execute')).toMatchObject([{ args: { agentId: 'root', line: '/compact', submittedAttachments: [] } }]);
  expect(session.getCommandSnapshot?.()?.map(c => c.name)).toEqual(['compact', 'review']);
  expect(events.filter(e => e.type === 'text_delta')).toMatchObject([{ text: 'No compactable history yet.' }]);
  expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(false);
  expect(published).toEqual([['compact', 'review']]);
  await session.dispose();
  expect(published).toEqual([['compact', 'review'], undefined]);
});

it('reads missed durable records beyond a reconnect snapshot without replaying input', async () => {
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, turn: nativeTurn, step: 0 } });
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } } });
  await until(() => events.some(e => e.type === 'text_delta'));
  const commit = { type: 'event', event: { seq: 7, time, type: 'assistant/message', data: { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'Hello' }] } } } };
  const end = { type: 'event', event: { seq: 8, time, type: 'turn/end', data: { turn: nativeTurn, reason: { kind: 'completed' } } } };
  const ordinaryCall = peer.onCall; const ordinaryOpen = peer.onOpen;
  peer.onCall = (method, args) => method === 'session/page' && args.request.throughSeq === 8
    ? { records: [commit, end], hasMore: false } : ordinaryCall(method, args);
  peer.onOpen = (endpoint, args, send) => endpoint === 'session/follow'
    ? send({ type: 'snapshot', cursor: 8, records: [end] }) : ordinaryOpen(endpoint, args, send);
  for (const stream of peer.streams.values()) stream.socket.terminate();
  await done;
  expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe('Hello');
  expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(1);
});

it('resolves native tool image references inside the owning session', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/attachment'
    ? { attachment: { attachmentId: args.request.attachmentId, mediaType: 'image/png' }, data: 'aW1hZ2U=' } : ordinary(method, args);
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  event('tool/call', { callId: 'image', name: 'read_image', arguments: '{"path":"pixel.png"}' });
  event('tool/result', { message: { toolCallId: 'image', content: [{ type: 'image', attachment: { attachmentId: 'image-data' } }] } });
  answer('seen'); await done;
  expect(events.find(e => e.type === 'tool_completed')).toMatchObject({ resultDetails: { resultImages: [{ kind: 'data', mediaType: 'image/png', data: 'aW1hZ2U=' }] } });
  expect(peer.calls.find(c => c.method === 'session/attachment')?.args).toEqual({ request: { sessionId: 'root', attachmentId: 'image-data' } });
});

it('recovers the saved native preset before resuming an unbound conversation', async () => {
  const ordinary = peer.onCall;
  peer.onCall = async (method, args) => {
    const value = await ordinary(method, args) as any;
    return method === 'session/projections' ? { ...value, values: { ...value.values, agentPreset: 'claudian-code' } } : value;
  };
  session = new DeepSeekExecutionBackend(host, () => deepseek).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: '/vault', interactionPort: port, resumeSeed: { providerSessionId: 'root' },
  });
  const run = session.execute(request()); const events: ProviderExecutionEvent[] = []; const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  expect(peer.calls.find(c => c.method === 'session/create')?.args.request.agentPreset).toBe('claudian-code');
  begin(run.executionId); answer('resumed'); await done;
  expect(session.getSnapshot().providerState).toMatchObject({ preset: 'claudian-code' });
});

it.each([undefined, null, 'low'])('honors reasoning semantics for %s', async reasoning => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/modelCatalog') return { groups: [{ id: 'native', models: [{ id: 'model', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }] };
    if (method === 'session/selectModel') return { selected: { provider: 'native', model: 'model', ...(args.request.reasoningEffort ? { reasoningEffort: args.request.reasoningEffort } : {}) } };
    return ordinary(method, args);
  };
  create(); const input = request();
  const run = session.execute({ ...input, configuration: { ...input.configuration, model: 'deepseek:native/model', reasoning } });
  const events: ProviderExecutionEvent[] = []; const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  expect(peer.calls.find(c => c.method === 'session/selectModel')?.args.request.reasoningEffort).toBe(reasoning === undefined ? 'high' : reasoning === null ? undefined : 'low');
  begin(run.executionId); answer('model selected'); await done;
});

it('cancels admission during shared Host startup without binding a native session', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await deepseek.dispose();
  ({ deepseek, lifecycle } = peer.host({ beforeStart: () => gate }));
  create();
  const run = session.execute(request()); const events: ProviderExecutionEvent[] = []; const done = collect(run.events, events);
  await until(() => lifecycle.starts === 1);
  run.cancel(); await done;
  expect(events.at(-1)?.type).toBe('cancelled');
  await until(() => session.getStatus() === 'idle');
  release();
  const retry = session.execute(request('replacement')); const retried: ProviderExecutionEvent[] = []; const retryDone = collect(retry.events, retried);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(retry.executionId); answer('bound once'); await retryDone;
  expect(lifecycle.starts).toBe(1);
  expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
});

it('reports a failed shared Host startup as a request error and keeps the session bindable', async () => {
  await deepseek.dispose();
  const start = jest.fn(async () => {}).mockRejectedValueOnce(new Error('DeepSeek Harness CLI was not found.'));
  ({ deepseek, lifecycle } = peer.host({ beforeStart: start }));
  create();
  const sessionEvents: string[] = [];
  session.onEvent(event => sessionEvents.push(event.type));
  const events: ProviderExecutionEvent[] = [];
  await collect(session.execute(request()).events, events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', message: 'DeepSeek Harness CLI was not found.' });
  await until(() => session.getStatus() === 'idle');
  expect(sessionEvents).not.toContain('session_error');
  const retry = session.execute(request('replacement')); const retried: ProviderExecutionEvent[] = []; const retryDone = collect(retry.events, retried);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(retry.executionId); answer('bound after repair'); await retryDone;
  expect(retried.at(-1)?.type).toBe('turn_completed');
});

it('rejects an explicit model removed from the enabled selection', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/selectModel' ? { selected: { provider: 'native', model: 'removed' } } : ordinary(method, args);
  create(); const input = request(); const events: ProviderExecutionEvent[] = [];
  const run = session.execute({ ...input, configuration: { ...input.configuration, model: 'deepseek:native/removed', reasoning: null } });
  const done = collect(run.events, events);
  await until(() => events.some(e => e.type === 'execution_error'));
  await done;
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', message: expect.stringContaining('unavailable') });
  expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(false);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Native execution fixture timed out.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

it('rechecks the permission boundary after native catalog discovery', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ordinary = peer.onCall;
  peer.onCall = async (method, args) => {
    if (method === 'permissionPresets/catalog') await gate;
    return ordinary(method, args);
  };
  create();
  const input = request();
  const elevated = { ...input, configuration: { ...input.configuration, permissionMode: 'yolo' } };
  const events: ProviderExecutionEvent[] = [];
  const done = collect(session.execute(elevated).events, events);
  await until(() => peer.calls.some(c => c.method === 'permissionPresets/catalog'));
  begin();
  event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'automatic work' }] } });
  await until(() => sessionEvents.some(e => e.type === 'background_turn_started'));
  release();
  await until(() => events.some(e => e.type === 'execution_error') || peer.calls.some(c => c.method === 'commands/execute'));
  expect(peer.calls.some(c => c.method === 'commands/execute')).toBe(false);
  await done;
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true, message: expect.stringContaining('Stop') });
  expect(permission).toBe('workspace-write');
  answer('background remains live');
});

async function createMainChat(options: Omit<NativePeerHostOptions, 'beforeStart'> = {}) {
  const start = jest.fn(async (_signal: AbortSignal) => {});
  await deepseek.dispose();
  ({ deepseek, lifecycle } = peer.host({ ...options, beforeStart: start }));
  const coordinator = createCoordinator({
    resolveBackend: () => new DeepSeekExecutionBackend(host, () => deepseek),
    onRequestedEvent: event => fixture.controller.handleExecutionEvent(event),
  });
  const image: ImageAttachment = { id: 'image', name: 'pixel.png', mediaType: 'image/png', data: 'aW1hZ2U=', size: 5, source: 'paste' };
  let images: ImageAttachment[] = [];
  const fixture = createFixture({
    getTabProviderId: () => 'deepseek',
    getSettings: () => ({ model: '', permissionMode: 'normal' }),
    getExecutionCoordinator: () => coordinator.coordinator,
    getImageContextManager: () => ({
      clearImages: () => { images = []; }, getAttachedImages: () => images,
      hasImages: () => images.length > 0, setImages: (next: ImageAttachment[]) => { images = next; },
    }),
  });
  fixture.plugin.getConversationSync.mockReturnValue({ id: 'conversation-1', providerId: 'deepseek' });
  await coordinator.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'deepseek' });
  return { fixture, start, image, coordinator: coordinator.coordinator, sessionEvents: coordinator.sessionEvents, interactionPort: coordinator.interactionPort, getImages: () => images, clearImages: () => { images = []; }, attachImage: () => { images = [image]; },
    dispose: async () => { await coordinator.coordinator.dispose(); await coordinator.registry.dispose(); },
  };
}

it('executes compact from the actual main-chat submission with empty context', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'commands/execute' && args.line === '/compact'
    ? { result: { kind: 'success', text: 'Compacted.' } } : ordinary(method, args);
  const chat = await createMainChat();
  try {
    chat.fixture.input.value = '/compact';
    await chat.fixture.controller.sendMessage();
    expect(peer.calls.filter(c => c.method === 'commands/execute')).toMatchObject([{ args: { line: '/compact' } }]);
    expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(false);
    expect(chat.fixture.input.value).toBe('');
    expect(chat.fixture.deps.streamController.appendError).not.toHaveBeenCalled();
  } finally { await chat.dispose(); }
});

it('restores text and images after definite native rejection and retries on the same binding', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method !== 'session/prompt') return ordinary(method, args);
    if (args.request.content.some((block: { type: string }) => block.type === 'image')) {
      throw Object.assign(new Error('This model does not support image input.'), { code: 'session/attachment-invalid' });
    }
    begin(args.request.requestId); answer('retry accepted');
    return { accepted: true };
  };
  const chat = await createMainChat();
  try {
    chat.attachImage(); chat.fixture.input.value = 'inspect this';
    await chat.fixture.controller.sendMessage();
    expect(chat.fixture.input.value).toBe('inspect this');
    expect(chat.getImages()).toEqual([chat.image]);
    expect(chat.fixture.state.messages).toEqual([]);
    expect(chat.fixture.deps.streamController.appendError).not.toHaveBeenCalled();
    chat.clearImages();
    await chat.fixture.controller.sendMessage();
    expect(chat.fixture.input.value).toBe('');
    expect(chat.fixture.state.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
    expect(chat.start).toHaveBeenCalledTimes(1);
    expect(chat.fixture.deps.streamController.appendError).not.toHaveBeenCalled();
  } finally { await chat.dispose(); }
});

it('keeps an unknown prompt failure ambiguous and invalidates the session', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/prompt') throw new Error('Connection ended after possible admission.');
    return ordinary(method, args);
  };
  create(); const events: ProviderExecutionEvent[] = [];
  await collect(session.execute(request()).events, events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'transport' });
  expect(session.getStatus()).toBe('invalidated');
});

it.each<Partial<ProviderExecutionRequest>>([
  { context: { linkedContent: { path: 'note.md' } } },
  { context: { sessionReferences: [{ id: 'other', title: 'Other', providerId: 'deepseek', updatedAt: testDate().toISOString(), snapshotPath: '/vault/other.json' }] } },
  { context: { selections: [{ kind: 'editor', selection: { notePath: 'note.md', mode: 'selection', selectedText: 'selected' } }] } },
  { input: [{ type: 'text', text: '/compact' }, { type: 'image', image: { id: 'i', name: 'i.png', mediaType: 'image/png', data: 'aW1hZ2U=', size: 5, source: 'paste' } }] },
])('keeps real context and images out of native compact commands: %j', async attachments => {
  create(); const events: ProviderExecutionEvent[] = [];
  await collect(session.execute({ ...request('/compact'), ...attachments }).events, events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', message: expect.stringContaining('attachments') });
  expect(peer.calls.some(c => c.method === 'commands/execute' || c.method === 'session/prompt')).toBe(false);
});


it('restores the draft and retries a corrected startup on the same chat binding', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method !== 'session/prompt') return ordinary(method, args);
    begin(args.request.requestId); answer('started after repair'); return { accepted: true };
  };
  const chat = await createMainChat();
  chat.start.mockRejectedValueOnce(new Error('DeepSeek Web profile is unavailable.'));
  try {
    chat.fixture.input.value = 'start this';
    await chat.fixture.controller.sendMessage();
    expect(chat.fixture.input.value).toBe('start this');
    expect(chat.fixture.state.messages).toEqual([]);
    await chat.fixture.controller.sendMessage();
    expect(chat.start).toHaveBeenCalledTimes(2);
    expect(chat.fixture.input.value).toBe('');
    expect(chat.fixture.state.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  } finally { await chat.dispose(); }
});

it.each(['root', 'child'])('closes %s background scope on process exit and waits for teardown before retrying', async owner => {
  let release!: () => void;
  const retirement = new Promise<void>(resolve => { release = resolve; });
  const chat = await createMainChat({ onDispose: () => retirement });
  chat.interactionPort.askUserQuestion.mockImplementation(() => new Promise(() => {}));
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method !== 'session/prompt') return ordinary(method, args);
    begin(args.request.requestId); answer('answer'); return { accepted: true };
  };
  let childFollow!: (value: unknown) => void;
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/follow' && args.request.address.childSessionId === 'child') { childFollow = send; return; }
    ordinaryOpen(endpoint, args, send);
  };
  try {
    chat.fixture.input.value = 'first'; await chat.fixture.controller.sendMessage();
    if (owner === 'root') {
      begin();
      event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'background work' }] } });
    } else {
      peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'subagentCatalog', value: [{ id: 'child', mode: 'continuable', label: 'child task' }] });
      peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'child', parentSessionId: 'root', origin: 'subagent', agentAvailable: true, running: true }] });
      await until(() => !!childFollow);
      childFollow({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time, data: { turn: 0 } } }] });
      peer.send('$events', { type: 'waterfall', eventId: 'child-question', event: 'user-questions/request', agentId: 'child', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] } });
    }
    await until(() => chat.sessionEvents.some(e => e.type === 'background_turn_started'));
    expect(chat.coordinator.hasBackgroundWork).toBe(true);
    lifecycle.exit();
    await until(() => lifecycle.disposed === 1);
    expect(chat.sessionEvents.filter(e => e.type === 'background_turn_completed')).toMatchObject([{ reason: 'provider-ended' }]);
    chat.fixture.input.value = 'after restart'; const retry = chat.fixture.controller.sendMessage();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(chat.start).toHaveBeenCalledTimes(1);
    release(); await retry;
    expect(chat.start).toHaveBeenCalledTimes(2);
    await until(() => !chat.coordinator.hasBackgroundWork);
    expect(peer.calls.filter(c => c.method === 'session/create')).toMatchObject([{ args: { request: {} } }, { args: { request: { sessionId: 'root' } } }]);
    expect(chat.fixture.state.messages.filter(m => m.role === 'user')).toHaveLength(2);
  } finally { release(); await chat.dispose(); }
});


it('keeps reload guidance after transcript divergence instead of rebinding or resending', async () => {
  create(); const events: ProviderExecutionEvent[] = [];
  const run = session.execute(request()); const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, turn: nativeTurn, step: 0 } });
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'Partial answer' } } });
  event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'Contradictory answer' }] } });
  await done;
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringMatching(/reload.*reopen/i) });
  await until(() => session.getStatus() === 'invalidated');
  // The shared Host stays up for other conversations.
  expect(lifecycle.disposed).toBe(0);
  const retry: ProviderExecutionEvent[] = [];
  await collect(session.execute(request('try again')).events, retry);
  expect(retry.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', message: expect.stringMatching(/reload.*reopen/i) });
  expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(1);
  expect(session.getStatus()).toBe('invalidated');
});

it('verifies permission once per binding and after mode changes rather than reading history on every turn', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method !== 'session/prompt') return ordinary(method, args);
    begin(args.request.requestId); answer('done'); return { accepted: true };
  };
  create();
  const execute = async (mode: string) => {
    const input = request(); const events: ProviderExecutionEvent[] = [];
    await collect(session.execute({ ...input, configuration: { ...input.configuration, permissionMode: mode } }).events, events);
    expect(events.at(-1)?.type).toBe('turn_completed');
    await until(() => !session.hasBackgroundWork?.());
  };
  await execute('normal');
  const initialPages = peer.calls.filter(c => c.method === 'session/page').length;
  expect(initialPages).toBeGreaterThan(0);
  await execute('normal');
  expect(peer.calls.filter(c => c.method === 'session/page')).toHaveLength(initialPages);
  await execute('yolo');
  const changedPages = peer.calls.filter(c => c.method === 'session/page').length;
  expect(changedPages).toBeGreaterThan(initialPages);
  expect(peer.calls.filter(c => c.method === 'commands/execute')).toMatchObject([{ args: { line: '/permission danger-full-access' } }]);
  await execute('yolo');
  expect(peer.calls.filter(c => c.method === 'session/page')).toHaveLength(changedPages);
  // Native policy changes invalidate the cached proof even within this binding.
  permission = 'workspace-write';
  event('sandbox/mode', { mode: permission }); event('approval/policy', { policy: 'ask' });
  const policySeq = seq;
  await new Promise(resolve => setTimeout(resolve, 10));
  await execute('yolo');
  expect(peer.calls.filter(c => c.method === 'commands/execute')).toHaveLength(2);
  expect(peer.calls.filter(c => c.method === 'session/page').some(c => c.args.request.throughSeq >= policySeq)).toBe(true);
});
