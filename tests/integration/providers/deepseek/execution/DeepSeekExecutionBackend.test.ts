import '@/providers';

import { createHarness as createCoordinator } from '@test/helpers/ChatExecutionHarness';
import { createFixture } from '@test/helpers/ChatInputHarness';
import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { jobsOf, NativePeer, type NativePeerHostOptions, type NativePeerLifecycle, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { testDate } from '@test/helpers/testClock';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort, ProviderSessionConfig, ProviderSessionEvent } from '@/core/execution';
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
/** The native root whose follow stream receives `event` frames. */
let followed: string;
let port: ProviderInteractionPort;
const time = testDate().getTime();
const host = { settings: { locale: 'en', providerConfigs: { deepseek: { enabled: true, visibleModels: ['deepseek:native/model'], discoveredModels: [{ encodedId: 'deepseek:native/model', provider: 'native', id: 'model', label: 'Model', reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }] } } } } as unknown as ProviderHost;

function request(text = 'requested'): ProviderExecutionRequest {
  return { input: [{ type: 'text', text }], configuration: { systemInstructions: { kind: 'explicit', instructions: 'literal {prompt}' }, permissionMode: 'normal' }, toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal };
}
/** Appends one durable event to the claimed root's follow stream; subagent streams are driven separately. */
function event(type: string, data: unknown): void {
  peer.send('session/follow', { type: 'event', event: { type, seq: ++seq, time, data } }, rootFollow(followed));
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
  permission = 'workspace-write'; inbox = []; seq = 3; nativeTurn = 0; followed = 'root'; sessionEvents = [];
  port = { requestApproval: jest.fn(), askUserQuestion: jest.fn(), dismissInteraction: jest.fn() };
  peer = new NativePeer();
  const native = nativeDefaults({
    seq: () => seq, roster: () => ['root'], permission: () => permission, setPermission: (_id, value) => { permission = value; },
    commands: [{ name: 'permission' }, { name: 'compact', description: 'Compact history' }, { name: 'goal' }],
    skills: [{ name: 'review', description: 'Review changes', modelInvocable: true }],
    projections: () => ({ inbox: { 'next-turn': inbox } }),
  });
  peer.onCall = (method, args) => {
    if (method === 'session/create') return { sessionId: 'root', agentPreset: 'claudian' };
    if (method === 'session/updateQueue') {
      inbox = inbox.filter((item: any) => item.id !== args.request.itemId);
      peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'inbox', seq: ++seq, value: { 'next-turn': inbox } });
      return { removed: true };
    }
    if (method === 'session/cancel') { event('turn/end', { turn: nativeTurn, reason: { kind: 'cancelled' } }); return {}; }
    return native.call(method, args);
  };
  peer.onOpen = native.open;
  await peer.open();
  ({ deepseek, lifecycle } = peer.host());
});
afterEach(async () => { await session?.dispose(); await deepseek.dispose(); await peer.close(); });

function savedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, home: getDeepSeekHome(process.env), profile: 'web', preset: 'claudian', ...overrides };
}
function create(resume: boolean | NonNullable<ProviderSessionConfig['resumeSeed']> = false): void {
  const resumeSeed = resume === true ? { providerSessionId: 'root', providerState: savedState() } : resume || undefined;
  session = new DeepSeekExecutionBackend(host, () => deepseek).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: '/vault', interactionPort: port,
    ...(resumeSeed ? { resumeSeed } : {}),
  });
  session.onEvent(event => sessionEvents.push(event));
}
/** Binds the session through one requested turn that native claims and completes. */
async function completeRequest(text = 'requested'): Promise<void> {
  const run = session.execute(request(text)); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt' && c.args.request.requestId === run.executionId));
  begin(run.executionId); answer(`${text} done`); await done;
  expect(events.at(-1)?.type).toBe('turn_completed');
}
/** Announces a native subagent of root through the catalog, its descriptor and the roster. */
function announceChild(mode: 'continuable' | 'one-shot', running: boolean): void {
  peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'subagentCatalog', value: [{ id: 'child', mode, label: 'child task' }] });
  peer.send('session/control', { type: 'projection', sessionId: 'child', key: 'subagent', value: { mode, label: 'child task', seq: 0 } });
  peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'child', parentSessionId: 'root', origin: 'subagent', agentAvailable: true, running }] });
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

it('admits the next request sent from the previous request\'s terminal event', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method !== 'session/prompt') return ordinary(method, args);
    begin(args.request.requestId); answer(`answer ${peer.calls.filter(c => c.method === 'session/prompt').length}`);
    return { accepted: true };
  };
  create();
  const first = session.execute(request('first'));
  let next: ReturnType<ProviderExecutionSession['execute']> | undefined;
  let refused: unknown;
  for await (const e of first.events) {
    if (e.type !== 'turn_completed') continue;
    try { next = session.execute(request('second')); } catch (error) { refused = error; }
  }
  expect(refused).toBeUndefined();
  const events: ProviderExecutionEvent[] = [];
  await collect(next!.events, events);
  expect(events.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/prompt').map(c => c.args.request.requestId)).toEqual([first.executionId, next!.executionId]);
  await until(() => session.getStatus() === 'idle');
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
      peer.send('job/list', { type: 'rows', jobs }, jobsOf('root'));
      return { status: 'requested' };
    }
    return ordinaryCall(method, args);
  };
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  jobs = [{ id: 'job', owner: 'root', status: 'running' }, { id: 'foreign', status: 'running' }];
  peer.send('job/list', { type: 'rows', jobs }, jobsOf('root'));
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
  announceChild('continuable', true);
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

function enqueue(rpcId: string): void {
  inbox = [...inbox, { id: `item-${rpcId}`, source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'requested' }] }];
  peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'inbox', seq: ++seq, value: { 'next-turn': inbox } });
}
function failAutomatic(): void {
  event('turn/end', { turn: nativeTurn, reason: { kind: 'error', error: { message: 'Temporary model failure' } } });
}
async function queueBehindFailedAutomaticTurn(): Promise<{ run: ReturnType<ProviderExecutionSession['execute']>; events: ProviderExecutionEvent[]; done: Promise<void> }> {
  create();
  const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin();
  event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'automatic work' }] } });
  enqueue(run.executionId);
  await until(() => sessionEvents.some(e => e.type === 'background_turn_started'));
  return { run, events, done };
}

// rc.2 keeps the inbox after these endings, including another client's Stop of the automatic turn.
it.each(['error', 'blocked', 'aborted'])('withdraws a queued request retained after an automatic %s turn and keeps the binding', async kind => {
  const jobs = [{ id: 'job', owner: 'root', status: 'running' }];
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list' ? send({ type: 'rows', jobs }) : ordinaryOpen(endpoint, args, send);
  const { events, done } = await queueBehindFailedAutomaticTurn();
  event('turn/end', { turn: nativeTurn, reason: { kind, ...(kind === 'error' ? { error: { message: 'Temporary model failure' } } : {}) } });
  await done;
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true, message: expect.stringContaining('not sent') });
  expect(events.some(e => e.type === 'turn_started')).toBe(false);
  expect(peer.calls.filter(c => c.method === 'session/updateQueue')).toHaveLength(1);
  expect(inbox).toEqual([]);
  expect(peer.calls.some(c => c.method === 'session/cancel' || c.method === 'job/kill')).toBe(false);
  expect(sessionEvents.filter(e => e.type === 'background_turn_completed')).toHaveLength(1);
  await until(() => session.getStatus() === 'idle');
  expect(session.hasBackgroundWork?.()).toBe(true);
  const retry = session.execute(request('retry')); const retried: ProviderExecutionEvent[] = [];
  const retryDone = collect(retry.events, retried);
  await until(() => peer.calls.filter(c => c.method === 'session/prompt').length === 2);
  begin(retry.executionId); answer('recovered'); await retryDone;
  expect(retried.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
  expect(lifecycle.disposed).toBe(0);
});

/** Native claimed the item before removal; the claim frame is the last frame and arrives after the rejection. */
function claimBeforeRemoval(itemId: string): never {
  setTimeout(() => {
    const rpcId = itemId.slice('item-'.length);
    inbox = inbox.filter((item: any) => item.id !== itemId);
    peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'inbox', seq: ++seq, value: { 'next-turn': inbox } });
    nativeTurn++; event('turn/start', { turn: nativeTurn });
    event('user/message', { id: `user-${nativeTurn}`, content: [{ type: 'text', text: 'requested' }], source: { kind: 'user', rpcId } });
  }, 20);
  throw Object.assign(new Error('Queue item not found.'), { code: 'session/queue-item-not-found' });
}

it('lets a request claimed during recovery run, then stops it on a later Stop', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/updateQueue' ? claimBeforeRemoval(args.request.itemId) : ordinary(method, args);
  const { run, events, done } = await queueBehindFailedAutomaticTurn();
  failAutomatic();
  await until(() => events.some(e => e.type === 'turn_started'));
  // Recovery resumes on the applied claim frame; output from a later frame proves it yielded without ending the run.
  event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'claimed output' }] } });
  await until(() => events.some(e => e.type === 'text_delta'));
  expect(events.some(e => e.type === 'execution_error' || e.type === 'cancelled')).toBe(false);
  expect(peer.calls.some(c => c.method === 'session/cancel')).toBe(false);
  run.cancel();
  await until(() => peer.calls.some(c => c.method === 'session/cancel'));
  await done;
  expect(events.at(-1)?.type).toBe('cancelled');
  expect(peer.calls.filter(c => c.method === 'session/updateQueue')).toHaveLength(1);
  expect(session.getStatus()).toBe('idle');
});

it('completes a request claimed during recovery when Stop was not requested', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/updateQueue' ? claimBeforeRemoval(args.request.itemId) : ordinary(method, args);
  const { events, done } = await queueBehindFailedAutomaticTurn();
  failAutomatic();
  await until(() => events.some(e => e.type === 'turn_started'));
  answer('claimed answer'); await done;
  expect(events.at(-1)?.type).toBe('turn_completed');
  expect(events.filter(e => e.type === 'text_delta')).toMatchObject([{ text: 'claimed answer' }]);
  expect(peer.calls.some(c => c.method === 'session/cancel')).toBe(false);
});

it('shares one native removal between recovery and a concurrent Stop', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ordinary = peer.onCall;
  peer.onCall = async (method, args) => {
    if (method === 'session/updateQueue') await gate;
    return ordinary(method, args);
  };
  const { run, events, done } = await queueBehindFailedAutomaticTurn();
  failAutomatic();
  await until(() => peer.calls.some(c => c.method === 'session/updateQueue'));
  run.cancel();
  release(); await done;
  expect(events.at(-1)?.type).toBe('cancelled');
  expect(peer.calls.filter(c => c.method === 'session/updateQueue')).toHaveLength(1);
  expect(peer.calls.some(c => c.method === 'session/cancel')).toBe(false);
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

it.each(['completes', 'stops'])('keeps a native compaction slower than the RPC deadline valid until it %s', async outcome => {
  let respond: ((value: unknown) => void) | undefined;
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'commands/execute' && args.line === '/compact'
    ? new Promise(resolve => { respond = resolve; }) : ordinary(method, args);
  const settle = async (predicate: () => boolean) => { while (!predicate()) await new Promise(resolve => setImmediate(resolve)); };
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  let done: Promise<void>;
  const events: ProviderExecutionEvent[] = [];
  try {
    create();
    const run = session.execute(request('/compact'));
    done = collect(run.events, events);
    await settle(() => !!respond);
    jest.advanceTimersByTime(31_000);
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    expect(events.some(e => ['turn_completed', 'cancelled', 'execution_error'].includes(e.type))).toBe(false);
    if (outcome === 'completes') respond!({ result: { kind: 'success', text: 'Compacted.' } });
    else run.cancel();
  } finally { jest.useRealTimers(); }
  await done!;
  expect(events.at(-1)?.type).toBe(outcome === 'completes' ? 'turn_completed' : 'cancelled');
  expect(events.filter(e => e.type === 'text_delta').map(e => e.text)).toEqual(outcome === 'completes' ? ['Compacted.'] : []);
  // Stop aborts the native HTTP request, which is native's cancellation for the command.
  await until(() => outcome === 'completes' || peer.abandoned.includes('commands/execute'));
  expect(peer.abandoned.includes('commands/execute')).toBe(outcome === 'stops');
  expect(session.getStatus()).not.toBe('invalidated');
  expect(peer.calls.some(c => c.method === 'session/cancel' || c.method === 'job/kill')).toBe(false);
  const next = session.execute(request('after compaction')); const nextEvents: ProviderExecutionEvent[] = [];
  const nextDone = collect(next.events, nextEvents);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(next.executionId); answer('still bound'); await nextDone;
  expect(nextEvents.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
});

it('reads missed durable records beyond a reconnect snapshot without replaying input', async () => {
  create(); const run = session.execute(request()); const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, turn: nativeTurn, step: 0 } }, rootFollow('root'));
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } } }, rootFollow('root'));
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

it.each([
  { reasoning: undefined, saved: undefined, sent: 'high' },
  { reasoning: undefined, saved: 'low', sent: 'low' },
  // A stale saved preference is not a supported default; omitted reasoning falls back to High.
  { reasoning: undefined, saved: 'max', sent: 'high' },
  { reasoning: null, saved: 'low', sent: undefined },
  { reasoning: 'low', saved: 'high', sent: 'low' },
])('honors reasoning semantics for $reasoning with saved preference $saved', async ({ reasoning, saved, sent }) => {
  const config = (host.settings.providerConfigs as any).deepseek;
  config.preferredReasoningByModel = saved ? { 'deepseek:native/model': saved } : {};
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/modelCatalog') return { groups: [{ id: 'native', models: [{ id: 'model', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }] };
    if (method === 'session/selectModel') return { selected: { provider: 'native', model: 'model', ...(args.request.reasoningEffort ? { reasoningEffort: args.request.reasoningEffort } : {}) } };
    return ordinary(method, args);
  };
  try {
    create(); const input = request();
    const run = session.execute({ ...input, configuration: { ...input.configuration, model: 'deepseek:native/model', reasoning } });
    const events: ProviderExecutionEvent[] = []; const done = collect(run.events, events);
    await until(() => peer.calls.some(c => c.method === 'session/prompt'));
    expect(peer.calls.find(c => c.method === 'session/selectModel')?.args.request.reasoningEffort).toBe(sent);
    begin(run.executionId); answer('model selected'); await done;
  } finally { delete config.preferredReasoningByModel; }
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
  create(); const input = request(); const events: ProviderExecutionEvent[] = [];
  const run = session.execute({ ...input, configuration: { ...input.configuration, model: 'deepseek:native/removed', reasoning: null } });
  const done = collect(run.events, events);
  await until(() => events.some(e => e.type === 'execution_error'));
  await done;
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', message: expect.stringContaining('unavailable') });
  expect(peer.calls.some(c => c.method === 'session/selectModel' || c.method === 'session/prompt')).toBe(false);
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

async function createMainChat(options: Omit<NativePeerHostOptions, 'beforeStart'> = {}, settings: Record<string, unknown> = { model: '', permissionMode: 'normal' }) {
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
    getSettings: () => settings,
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

it('restores the draft after a definite model rejection and keeps the binding and its running job', async () => {
  const jobs = [{ id: 'job', owner: 'root', status: 'running' }];
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list' ? send({ type: 'rows', jobs }) : ordinaryOpen(endpoint, args, send);
  let reject = false;
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/selectModel') {
      if (reject) throw Object.assign(new Error('Reasoning effort "max" is not supported by native/model.'), { code: 'session/model-unavailable' });
      return { selected: { provider: 'native', model: 'model', reasoningEffort: args.request.reasoningEffort } };
    }
    if (method === 'session/prompt') { begin(args.request.requestId); answer('accepted'); return { accepted: true }; }
    return ordinary(method, args);
  };
  const chat = await createMainChat({}, { model: 'deepseek:native/model', reasoning: 'high', permissionMode: 'normal' });
  try {
    chat.fixture.input.value = 'start job'; await chat.fixture.controller.sendMessage();
    expect(chat.coordinator.hasBackgroundWork).toBe(true);
    reject = true;
    chat.fixture.input.value = 'rejected model'; await chat.fixture.controller.sendMessage();
    expect(chat.fixture.input.value).toBe('rejected model');
    expect(chat.fixture.state.messages.filter(m => m.role === 'user')).toHaveLength(1);
    // A failed binding reports its session error before the rejected run ends; its asynchronous stop is checked after the retry.
    expect(chat.sessionEvents.some(e => e.type === 'session_error')).toBe(false);
    expect(chat.coordinator.hasBackgroundWork).toBe(true);
    reject = false;
    await chat.fixture.controller.sendMessage();
    expect(chat.sessionEvents.some(e => e.type === 'session_error')).toBe(false);
    expect(chat.coordinator.hasBackgroundWork).toBe(true);
    expect(chat.fixture.input.value).toBe('');
    expect(chat.fixture.state.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
    expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(2);
    expect(peer.calls.some(c => c.method === 'job/kill' || c.method === 'session/cancel')).toBe(false);
    expect(lifecycle.disposed).toBe(0);
  } finally { await chat.dispose(); }
});

it('restores a queued draft withdrawn after a failed automatic turn and retries on the same binding', async () => {
  const ordinary = peer.onCall;
  let fail = true;
  peer.onCall = (method, args) => {
    if (method !== 'session/prompt') return ordinary(method, args);
    if (fail) {
      begin();
      event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'automatic work' }] } });
      enqueue(args.request.requestId); failAutomatic();
    }
    else { begin(args.request.requestId); answer('retry accepted'); }
    return { accepted: true };
  };
  const chat = await createMainChat();
  try {
    chat.fixture.input.value = 'queued behind failure'; await chat.fixture.controller.sendMessage();
    expect(chat.fixture.input.value).toBe('queued behind failure');
    expect(chat.fixture.state.messages).toEqual([]);
    expect(peer.calls.filter(c => c.method === 'session/updateQueue')).toHaveLength(1);
    fail = false;
    await chat.fixture.controller.sendMessage();
    expect(chat.fixture.input.value).toBe('');
    expect(chat.fixture.state.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
    expect(peer.calls.some(c => c.method === 'session/cancel')).toBe(false);
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
      announceChild('continuable', true);
      await until(() => !!childFollow);
      childFollow({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time, data: { turn: 0 } } }] });
      peer.send('$events', { type: 'waterfall', eventId: 'child-question', event: 'user-questions/request', agentId: 'child', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] } });
    }
    await until(() => chat.sessionEvents.some(e => e.type === 'background_turn_started'));
    expect(chat.coordinator.hasBackgroundWork).toBe(true);
    lifecycle.exit();
    await until(() => lifecycle.disposed === 1);
    expect(chat.sessionEvents.filter(e => e.type === 'background_turn_completed')).toMatchObject([{ reason: 'provider-ended' }]);
    const attach = jest.spyOn(deepseek, 'attach');
    chat.fixture.input.value = 'after restart'; const retry = chat.fixture.controller.sendMessage();
    // A replacement start follows an attachment request within microtasks unless the Host waits for teardown.
    await until(() => attach.mock.calls.length > 0);
    await new Promise(resolve => setImmediate(resolve));
    expect(chat.start).toHaveBeenCalledTimes(1);
    release(); await retry;
    expect(chat.start).toHaveBeenCalledTimes(2);
    await until(() => !chat.coordinator.hasBackgroundWork);
    expect(peer.calls.filter(c => c.method === 'session/create')).toMatchObject([{ args: { request: {} } }, { args: { request: { sessionId: 'root' } } }]);
    expect(chat.fixture.state.messages.filter(m => m.role === 'user')).toHaveLength(2);
  } finally { release(); await chat.dispose(); }
});


it('stops owned work promptly when a follow failure races a pending child snapshot', async () => {
  const ordinaryOpen = peer.onOpen;
  let childFollow: ((value: unknown) => void) | undefined;
  let childJobs: ((value: unknown) => void) | undefined;
  const rootJobs = [{ id: 'job', owner: 'root', status: 'running' }];
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/follow' && args.request.address.childSessionId === 'child') { childFollow = send; return; }
    // Hold only the child's first jobs anchor; its turn-end rebaseline answers at once.
    if (endpoint === 'job/list' && args.request.sessionId === 'child' && !childJobs) { childJobs = send; return; }
    if (endpoint === 'job/list') { send({ type: 'rows', jobs: args.request.sessionId === 'root' ? rootJobs : [] }); return; }
    ordinaryOpen(endpoint, args, send);
  };
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'job/kill') {
      rootJobs.length = 0;
      peer.send('job/list', { type: 'rows', jobs: rootJobs }, jobsOf('root'));
      return {};
    }
    if (method === 'subagents/interruptByParent') {
      childFollow!({ type: 'event', event: { type: 'turn/end', seq: 1, time, data: { turn: 0, reason: { kind: 'cancelled' } } } });
      return {};
    }
    return ordinary(method, args);
  };
  create(); await completeRequest();
  announceChild('continuable', true);
  await until(() => !!childFollow && !!childJobs);
  // The child's jobs precede the failing root frames on the shared stream, so only its snapshot remains to make it ready.
  childJobs!({ type: 'rows', jobs: [] });
  // Root frame processing fails (overlapping turns) while the child's snapshot is still in flight.
  nativeTurn++; event('turn/start', { turn: nativeTurn }); event('turn/start', { turn: nativeTurn + 1 });
  await until(() => session.getStatus() === 'invalidated');
  childFollow!({ type: 'snapshot', cursor: 0, records: [] });
  // Readiness waiters must wake on applied frames even while the failed queue is detaching.
  await until(() => peer.calls.some(c => c.method === 'job/kill'));
  expect(peer.calls.filter(c => c.method === 'job/kill')).toMatchObject([{ args: { request: { sessionId: 'root', jobId: 'job' } } }]);
  expect(peer.calls.filter(c => c.method === 'subagents/interruptByParent')).toMatchObject([{ args: { childSessionId: 'child', parentSessionId: 'root', mode: 'continuable' } }]);
});

it('keeps reload guidance after transcript divergence instead of rebinding or resending', async () => {
  create(); const events: ProviderExecutionEvent[] = [];
  const run = session.execute(request()); const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId);
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, turn: nativeTurn, step: 0 } }, rootFollow('root'));
  peer.send('session/follow', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'Partial answer' } } }, rootFollow('root'));
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
  // A later automatic turn on the same stream proves the policy events were applied before the next admission.
  begin(); answer('policy observed');
  await until(() => sessionEvents.some(e => e.type === 'background_turn_completed'));
  await execute('yolo');
  expect(peer.calls.filter(c => c.method === 'commands/execute')).toHaveLength(2);
  expect(peer.calls.filter(c => c.method === 'session/page').some(c => c.args.request.throughSeq >= policySeq)).toBe(true);
});

const nativeError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
/** Native sends that would start model work: requested prompts and compaction commands. */
const nativeSends = (): number => peer.calls.filter(c => c.method === 'session/prompt' || (c.method === 'commands/execute' && c.args.line === '/compact')).length;

interface AdmissionCase {
  readonly name: string;
  readonly resume?: NonNullable<ProviderSessionConfig['resumeSeed']>;
  /** Native overrides; each receives the ordinary fixture handler. */
  readonly native?: Record<string, (args: Record<string, any>, ordinary: () => unknown) => unknown>;
  /** Runs on the created session before the rejected request. */
  readonly prepare?: () => Promise<void>;
  readonly input: (input: ProviderExecutionRequest) => ProviderExecutionRequest;
  readonly error: Record<string, unknown>;
  /** Native sends made by the rejected request itself. */
  readonly sends: number;
  readonly status: 'idle' | 'invalidated';
}
const withConfiguration = (configuration: Partial<ProviderExecutionRequest['configuration']>) => (input: ProviderExecutionRequest): ProviderExecutionRequest =>
  ({ ...input, configuration: { ...input.configuration, ...configuration } });
const resumedProjection = (values: Record<string, unknown>) => (_args: Record<string, any>, ordinary: () => unknown) =>
  Promise.resolve(ordinary()).then((value: any) => ({ ...value, values: { ...value.values, ...values } }));

it.each<AdmissionCase>([
  { name: 'an arbitrary tool allow-list', input: input => ({ ...input, toolPolicy: { kind: 'allow-list', names: ['Read'] } }),
    error: { category: 'configuration', message: expect.stringContaining('allow-lists') }, sends: 0, status: 'idle' },
  { name: 'an unsupported permission mode', input: withConfiguration({ permissionMode: 'plan' }),
    error: { category: 'configuration', message: expect.stringContaining('Unsupported DeepSeek permission mode') }, sends: 0, status: 'idle' },
  { name: 'reasoning without a model', input: withConfiguration({ reasoning: 'high' }),
    error: { category: 'configuration', message: expect.stringContaining('Select a DeepSeek model') }, sends: 0, status: 'idle' },
  { name: 'a model selection native did not honor', input: withConfiguration({ model: 'deepseek:native/model', reasoning: 'high' }),
    native: { 'session/selectModel': () => ({ selected: { provider: 'native', model: 'fallback', reasoningEffort: 'high' } }) },
    error: { category: 'configuration', message: expect.stringContaining('could not honor') }, sends: 0, status: 'idle' },
  { name: 'a tool policy change within the session', prepare: () => completeRequest(), input: input => ({ ...input, toolPolicy: { kind: 'read-only' } }),
    error: { category: 'configuration', message: expect.stringContaining('cannot change within a session') }, sends: 0, status: 'idle' },
  { name: 'compaction while a background turn runs', input: input => ({ ...input, input: [{ type: 'text', text: '/compact' }] }),
    prepare: async () => {
      await completeRequest();
      begin(); event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'automatic work' }] } });
      await until(() => sessionEvents.some(e => e.type === 'background_turn_started'));
    },
    error: { category: 'configuration', message: expect.stringContaining('Use Stop before compacting') }, sends: 0, status: 'idle' },
  { name: 'a compaction native reports as failed', input: input => ({ ...input, input: [{ type: 'text', text: '/compact' }] }),
    native: { 'commands/execute': (args, ordinary) => args.line === '/compact' ? { result: { kind: 'error', text: 'Nothing to compact.' } } : ordinary() },
    error: { category: 'provider', message: 'Nothing to compact.' }, sends: 1, status: 'idle' },
  { name: 'a resume from a different native store', resume: { providerSessionId: 'root', providerState: savedState({ home: '/elsewhere/.deepseek' }) }, input: input => input,
    error: { category: 'configuration', message: expect.stringContaining('different store') }, sends: 0, status: 'idle' },
  { name: 'a resumed session without a native preset', resume: { providerSessionId: 'root', providerState: savedState() }, input: input => input,
    native: { 'session/projections': resumedProjection({ agentPreset: undefined }) },
    error: { category: 'configuration', message: expect.stringContaining('preset is missing') }, sends: 0, status: 'invalidated' },
  { name: 'a native preset that differs from the saved binding', resume: { providerSessionId: 'root', providerState: savedState({ preset: 'claudian-code' }) }, input: input => input,
    error: { category: 'configuration', message: expect.stringContaining('differs from the saved conversation binding') }, sends: 0, status: 'invalidated' },
  { name: 'a native tool policy that differs from the request', resume: { providerSessionId: 'root', providerState: savedState({ preset: 'claudian-passive' }) }, input: input => input,
    native: { 'session/projections': resumedProjection({ agentPreset: 'claudian-passive' }) },
    error: { category: 'configuration', message: expect.stringContaining('tool policy differs') }, sends: 0, status: 'invalidated' },
  { name: 'a resumed native session that no longer exists', resume: { providerSessionId: 'root', providerState: savedState() }, input: input => input,
    native: { 'session/create': () => { throw nativeError('session/missing', 'Session root was not found.'); } },
    error: { category: 'provider-session-missing', missingProviderSessionId: 'root' }, sends: 0, status: 'invalidated' },
  { name: 'a prompt native did not acknowledge', input: input => input, native: { 'session/prompt': () => ({ accepted: false }) },
    error: { category: 'transport', message: expect.stringContaining('did not acknowledge') }, sends: 1, status: 'invalidated' },
])('rejects $name with its recoverable error and no unintended native send', async ({ resume, native = {}, prepare, input, error, sends, status }) => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    const override = native[method];
    if (override) return override(args, () => ordinary(method, args));
    // A request that slips past its guard completes normally, so the fault surfaces as a wrong result rather than a hang.
    if (method === 'session/prompt') { begin(args.request.requestId); answer('sent'); return { accepted: true }; }
    return ordinary(method, args);
  };
  create(resume ?? false);
  await prepare?.();
  const before = nativeSends();
  const events: ProviderExecutionEvent[] = [];
  await collect(session.execute(input(request())).events, events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', recoverable: true, ...error });
  expect(nativeSends() - before).toBe(sends);
  await until(() => session.getStatus() === status);
});

it('refuses a second requested execution while the first is admitting', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/prompt') { begin(args.request.requestId); answer('first only'); return { accepted: true }; }
    return ordinary(method, args);
  };
  create();
  const first = session.execute(request('first')); const events: ProviderExecutionEvent[] = [];
  expect(() => session.execute(request('second'))).toThrow('DeepSeek already has a requested execution.');
  await collect(first.events, events);
  expect(events.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/prompt').map(c => c.args.request.requestId)).toEqual([first.executionId]);
});

it('rejects a send while background Stop is running and admits after Stop settles', async () => {
  let jobs = [{ id: 'job', owner: 'root', status: 'running' }];
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list' ? send({ type: 'rows', jobs }) : ordinaryOpen(endpoint, args, send);
  let release!: () => void;
  const killing = new Promise<void>(resolve => { release = resolve; });
  const ordinary = peer.onCall;
  peer.onCall = async (method, args) => {
    if (method === 'job/kill') {
      await killing;
      jobs = [{ id: 'job', owner: 'root', status: 'killed' }];
      peer.send('job/list', { type: 'rows', jobs }, jobsOf('root'));
      return { status: 'requested' };
    }
    if (method === 'session/prompt') {
      begin(args.request.requestId); answer('sent');
      // Native streams are ordered independently of RPC replies: the turn can end before its prompt is acknowledged.
      if (args.request.requestId === first?.executionId) await acknowledged;
      return { accepted: true };
    }
    return ordinary(method, args);
  };
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  create();
  const first = session.execute(request('first'));
  // Stop pressed once the turn has ended but before its prompt is acknowledged still stops the job it started.
  for await (const e of first.events) if (e.type === 'turn_completed') session.cancel();
  acknowledge();
  await until(() => peer.calls.some(c => c.method === 'job/kill'));
  await until(() => session.getStatus() !== 'executing');
  expect(session.getStatus()).toBe('cancelling');
  const events: ProviderExecutionEvent[] = [];
  await collect(session.execute(request('during stop')).events, events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true, message: expect.stringContaining('Wait for Stop to finish') });
  expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(1);
  expect(session.getStatus()).toBe('cancelling');
  release();
  await until(() => !session.hasBackgroundWork?.());
  await completeRequest('after stop');
  expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(2);
});

it('forks a saved checkpoint on first send and binds the fork without resuming its source', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/fork') return { sessionId: 'fork' };
    if (method === 'session/projections') return resumedProjection({ agentPreset: 'claudian-code' })(args, () => ordinary(method, args));
    if (method === 'session/list') return { items: [{ sessionId: 'root', agentAvailable: true, running: false }, { sessionId: 'fork', agentAvailable: true, running: false }] };
    return ordinary(method, args);
  };
  create({ providerState: savedState({ preset: 'claudian-code', pendingFork: { sessionId: 'root', atSeq: 2 } }) });
  followed = 'fork';
  const run = session.execute(request()); const events: ProviderExecutionEvent[] = []; const done = collect(run.events, events);
  await until(() => peer.calls.some(c => c.method === 'session/prompt'));
  begin(run.executionId); answer('forked answer'); await done;
  expect(events.at(-1)?.type).toBe('turn_completed');
  expect(peer.calls.filter(c => c.method === 'session/fork')).toEqual([{ method: 'session/fork', args: { request: { sessionId: 'root', atSeq: 2 } } }]);
  expect(peer.calls.some(c => c.method === 'session/create')).toBe(false);
  expect(peer.calls.find(c => c.method === 'session/prompt')?.args.request.sessionId).toBe('fork');
  const snapshot = session.getSnapshot();
  expect(snapshot).toMatchObject({ providerSessionId: 'fork', providerState: { preset: 'claudian-code' } });
  expect(snapshot.providerState).not.toHaveProperty('pendingFork');
});

it.each(['continuable', 'one-shot'] as const)('stops a running %s child through the native owner of its lifetime', async mode => {
  let childFollow: ((value: unknown) => void) | undefined;
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/follow' && args.request.address.childSessionId === 'child') { childFollow = send; return; }
    ordinaryOpen(endpoint, args, send);
  };
  const endChild = (): void => childFollow!({ type: 'event', event: { type: 'turn/end', seq: 1, time, data: { turn: 0, reason: { kind: 'cancelled' } } } });
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'subagents/interruptByParent') { endChild(); return {}; }
    // Cancelling the parent turn also ends the one-shot children it is waiting on.
    if (method === 'session/cancel') endChild();
    return ordinary(method, args);
  };
  create(); await completeRequest();
  // A one-shot child runs inside its parent's turn; a continuable child outlives it.
  if (mode === 'one-shot') {
    begin(); event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text: 'delegating' }] } });
    await until(() => sessionEvents.some(e => e.type === 'background_turn_started'));
  }
  announceChild(mode, true);
  await until(() => !!childFollow);
  childFollow!({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time, data: { turn: 0 } } }] });
  session.cancel();
  await until(() => !session.hasBackgroundWork?.());
  expect(peer.calls.filter(c => c.method === 'subagents/interruptByParent')).toEqual(mode === 'continuable'
    ? [{ method: 'subagents/interruptByParent', args: { childSessionId: 'child', parentSessionId: 'root', mode: 'continuable' } }] : []);
  expect(peer.calls.filter(c => c.method === 'session/cancel')).toHaveLength(mode === 'one-shot' ? 1 : 0);
  expect(session.getStatus()).toBe('idle');
});

it('fails the session recoverably when background Stop does not settle before its deadline', async () => {
  let jobs = [{ id: 'job', owner: 'root', status: 'running' }];
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list' ? send({ type: 'rows', jobs }) : ordinaryOpen(endpoint, args, send);
  const ordinary = peer.onCall;
  // Native accepts the kill but the job never reports an ending.
  peer.onCall = (method, args) => method === 'job/kill' ? { status: 'requested' } : ordinary(method, args);
  create(); await completeRequest();
  expect(session.hasBackgroundWork?.()).toBe(true);
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  try {
    session.cancel();
    await flush();
    jest.advanceTimersByTime(9_000); await flush();
    expect(session.getStatus()).toBe('cancelling');
    for (let i = 0; i < 40 && session.getStatus() !== 'invalidated'; i++) { jest.advanceTimersByTime(100); await flush(); }
    expect(session.getStatus()).toBe('invalidated');
    expect(sessionEvents.filter(e => e.type === 'session_error')).toMatchObject([{ category: 'transport', recoverable: true, message: expect.stringContaining('did not settle') }]);
    // The job ends natively; the failed binding's own stop then settles and releases the Host.
    jobs = [{ id: 'job', owner: 'root', status: 'killed' }];
    peer.send('job/list', { type: 'rows', jobs }, jobsOf('root'));
    for (let i = 0; i < 40 && session.hasBackgroundWork?.(); i++) { jest.advanceTimersByTime(100); await flush(); }
    expect(session.hasBackgroundWork?.()).toBe(false);
  } finally { jest.useRealTimers(); }
  expect(peer.calls.filter(c => c.method === 'job/kill').length).toBeGreaterThanOrEqual(1);
  expect(lifecycle.disposed).toBe(0);
});
