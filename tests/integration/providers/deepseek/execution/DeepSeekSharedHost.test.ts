import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { jobsOf, NativePeer, type NativePeerLifecycle, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { testDate } from '@test/helpers/testClock';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import { DeepSeekRemoteError } from '@/providers/deepseek/remote/DeepSeekRemoteClient';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

const time = testDate().getTime();
// Fixture polling keeps the real clock while tests drive native deadlines on the fake one.
const realTimeout = setTimeout;
const realNow = Date.now;
const host = { settings: { locale: 'en', providerConfigs: { deepseek: { enabled: true } } } } as unknown as ProviderHost;
let peer: NativePeer;
let deepseek: DeepSeekHost;
let lifecycle: NativePeerLifecycle;
let sessions: ProviderExecutionSession[];
let created: string[];
let seq: number;
let jobs: Record<string, unknown[]>;
let createFailures: (sessionId: string) => Error | undefined;
let permissions: Record<string, string>;

beforeEach(async () => {
  sessions = []; created = []; seq = 3; jobs = {}; createFailures = () => undefined; permissions = {};
  peer = new NativePeer();
  const native = nativeDefaults({
    seq: () => seq, roster: () => created, jobs: sessionId => jobs[sessionId] ?? [],
    permission: sessionId => permissions[sessionId] ?? 'workspace-write', setPermission: (sessionId, value) => { permissions[sessionId] = value; },
  });
  peer.onCall = (method, args) => {
    if (method === 'session/create') {
      const resumed = args.request.sessionId as string | undefined;
      const failure = resumed ? createFailures(resumed) : undefined;
      if (failure) throw failure;
      const id = resumed ?? ['alpha', 'beta', 'gamma'][created.length];
      if (!created.includes(id)) created.push(id);
      // Native announces every activated session on the shared event stream.
      peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: id, agentAvailable: true, running: false }] });
      return { sessionId: id, agentPreset: args.request.agentPreset };
    }
    if (method === 'job/kill') {
      const sessionId = args.request.sessionId as string;
      jobs[sessionId] = [];
      peer.send('job/list', { type: 'rows', jobs: [] }, jobsOf(sessionId));
      return { status: 'requested' };
    }
    return native.call(method, args);
  };
  peer.onOpen = native.open;
  await peer.open();
  ({ deepseek, lifecycle } = peer.host());
});
afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(sessions.map(session => session.dispose()));
  await deepseek.dispose(); await peer.close();
});

function port(): ProviderInteractionPort & { askUserQuestion: jest.Mock } {
  return { requestApproval: jest.fn(), askUserQuestion: jest.fn(() => new Promise<never>(() => {})), dismissInteraction: jest.fn() };
}

function open(interactionPort = port(), resume?: string): ProviderExecutionSession {
  const config: ProviderSessionConfig = {
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: '/vault', interactionPort,
    ...(resume ? { resumeSeed: { providerSessionId: resume, providerState: { schemaVersion: 1, home: getDeepSeekHome(process.env), profile: 'web', preset: 'claudian' } } } : {}),
  };
  const session = new DeepSeekExecutionBackend(host, () => deepseek).createSession(config);
  sessions.push(session);
  return session;
}

function request(prompt: string, toolPolicy: ProviderExecutionRequest['toolPolicy'] = { kind: 'provider-default' }): ProviderExecutionRequest {
  return { input: [{ type: 'text', text: 'hello' }], configuration: { systemInstructions: { kind: 'explicit', instructions: prompt }, permissionMode: 'normal' }, toolPolicy, signal: new AbortController().signal };
}

function emit(sessionId: string, type: string, data: unknown): void {
  peer.send('session/follow', { type: 'event', event: { type, seq: ++seq, time, data } }, rootFollow(sessionId));
}

/** Native admits the prompt of one session and answers it on that session's stream only. */
function respond(sessionId: string, rpcId: string, text: string): void {
  emit(sessionId, 'turn/start', { turn: seq });
  emit(sessionId, 'user/message', { id: `user-${seq}`, content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId } });
  emit(sessionId, 'assistant/message', { turn: seq, step: 0, message: { content: [{ type: 'text', text }] } });
  emit(sessionId, 'turn/end', { turn: seq, reason: { kind: 'completed' } });
}

async function run(session: ProviderExecutionSession, input: ProviderExecutionRequest, answer?: string): Promise<ProviderExecutionEvent[]> {
  const execution = session.execute(input);
  const events: ProviderExecutionEvent[] = [];
  const done = (async () => { for await (const event of execution.events) events.push(event); })();
  if (answer !== undefined) {
    await until(() => peer.calls.some(c => c.method === 'session/prompt' && c.args.request.requestId === execution.executionId));
    const prompt = peer.calls.find(c => c.method === 'session/prompt' && c.args.request.requestId === execution.executionId)!;
    respond(prompt.args.request.sessionId, execution.executionId, answer);
  }
  await done;
  return events;
}

const texts = (events: ProviderExecutionEvent[]) => events.filter(e => e.type === 'text_delta').map(e => e.text).join('');

it('serves concurrent conversations and auxiliary tasks from one native process with per-preset prompts', async () => {
  const main = open(); const title = open();
  const [mainEvents, titleEvents] = await Promise.all([
    run(main, request('Main prompt {literal}'), 'main answer'),
    run(title, request('Title prompt', { kind: 'passive' }), 'title answer'),
  ]);
  expect(texts(mainEvents)).toBe('main answer');
  expect(texts(titleEvents)).toBe('title answer');
  expect(lifecycle.starts).toBe(1);
  expect(peer.calls.filter(c => c.method === 'session/create').map(c => c.args.request.agentPreset).sort()).toEqual(['claudian', 'claudian-passive']);
  expect(lifecycle.prompts).toEqual(expect.arrayContaining([
    { preset: 'claudian', text: 'Main prompt {literal}' }, { preset: 'claudian-passive', text: 'Title prompt' },
  ]));
});

it('applies a changed prompt on the next turn without restarting the shared process', async () => {
  const session = open();
  await run(session, request('First prompt'), 'one');
  await run(session, request('Edited prompt'), 'two');
  expect(lifecycle.prompts.filter(p => p.preset === 'claudian').map(p => p.text)).toEqual(['First prompt', 'Edited prompt']);
  expect(lifecycle.starts).toBe(1);
  expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
});

it('routes each native interaction only to the conversation that owns the agent', async () => {
  const alphaPort = port(); const betaPort = port();
  const alpha = open(alphaPort); const beta = open(betaPort);
  await run(alpha, request('Prompt'), 'alpha ready');
  await run(beta, request('Prompt'), 'beta ready');
  emit('beta', 'turn/start', { turn: seq });
  peer.send('$events', { type: 'waterfall', eventId: 'beta-question', event: 'user-questions/request', agentId: 'beta', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] } });
  await until(() => betaPort.askUserQuestion.mock.calls.length === 1);
  expect(alphaPort.askUserQuestion).not.toHaveBeenCalled();
  expect(beta.hasBackgroundWork?.()).toBe(true);
  expect(alpha.hasBackgroundWork?.()).toBe(false);
});

it('refuses a second live view of the same native conversation', async () => {
  const first = open(port(), 'alpha');
  await run(first, request('Prompt'), 'bound');
  const second = open(port(), 'alpha');
  const events = await run(second, request('Prompt'));
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', message: expect.stringContaining('already open in another Claudian view') });
  expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(1);
});

it('waits for a reloaded Host to release the writer, then names the other process', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const backoff = elapseWaitsUpTo(1_000);
  const held = new DeepSeekRemoteError('session "alpha" is already owned by an active write handle', 'session/writer-held');
  let attempts = 0;
  createFailures = () => (++attempts <= 2 ? held : undefined);
  const recovered = open(port(), 'alpha');
  expect(texts(await run(recovered, request('Prompt'), 'resumed after handoff'))).toBe('resumed after handoff');
  expect(attempts).toBe(3);
  await recovered.dispose();

  createFailures = () => held;
  const blocked = open(port(), 'alpha');
  const started = Date.now();
  const events = await run(blocked, request('Prompt'));
  backoff();
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true, message: expect.stringContaining('another DeepSeek Harness process') });
  // Backoff 100, 200, 400, 800, 1000, 1000, 1000 ms; the next 1000 ms wait would pass the 5 s handoff window.
  expect(Date.now() - started).toBe(4_500);
  expect(blocked.getStatus()).not.toBe('invalidated');
});

it('stops a closed conversation\'s native work while other conversations keep the process', async () => {
  const alpha = open(); const beta = open();
  await run(alpha, request('Prompt'), 'alpha ready');
  await run(beta, request('Prompt'), 'beta ready');
  jobs.alpha = [{ id: 'job-1', owner: 'alpha', status: 'running' }];
  jobs.beta = [{ id: 'job-2', owner: 'beta', status: 'running' }];
  // Native refreshes job rows asynchronously after each turn; closing may land inside that window.
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => endpoint === 'job/list'
    ? void setTimeout(() => send({ type: 'rows', jobs: jobs[args.request.sessionId] ?? [] }), 30)
    : ordinaryOpen(endpoint, args, send);
  await run(alpha, request('Prompt'), 'job started');
  await run(beta, request('Prompt'), 'job started');
  await alpha.dispose();
  expect(peer.calls.filter(c => c.method === 'job/kill')).toEqual([{ method: 'job/kill', args: { request: { sessionId: 'alpha', jobId: 'job-1' } } }]);
  expect(lifecycle.disposed).toBe(0);
  await until(() => !!beta.hasBackgroundWork?.());
  expect(texts(await run(beta, request('Prompt'), 'beta still served'))).toBe('beta still served');
});

it.each([
  ['the shared process exits', () => lifecycle.exit()],
  ['the shared transport fails', () => peer.send('session/control', { type: 'unknown' })],
])('fails every attached conversation when %s, then restarts on demand', async (_case, lose) => {
  const alpha = open(); const beta = open();
  await run(alpha, request('Prompt'), 'alpha ready');
  await run(beta, request('Prompt'), 'beta ready');
  lose();
  await until(() => alpha.getStatus() === 'invalidated' && beta.getStatus() === 'invalidated');
  await until(() => lifecycle.disposed === 1);
  // Retiring the process ends all native work; nothing is left to stop before a retry can rebind.
  await until(() => !alpha.hasBackgroundWork?.() && !beta.hasBackgroundWork?.());
  const replacement = open(port(), 'alpha');
  expect(texts(await run(replacement, request('Prompt'), 'restarted'))).toBe('restarted');
  expect(lifecycle.starts).toBe(2);
});

it.each([
  { name: 'fails the conversation when an unclassified interaction reaches its deadline', reconnect: false, status: 'invalidated' },
  { name: 'voids unclassified interactions on reconnect instead of failing the conversation at their deadline', reconnect: true, status: 'idle' },
])('$name', async ({ reconnect, status }) => {
  const alpha = open();
  await run(alpha, request('Prompt'), 'ready');
  // The ownership deadline is the only timer armed on the fake clock.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  // Routed by the roster, but no native turn is followed yet to own it.
  peer.send('$events', { type: 'waterfall', eventId: 'early', event: 'approval/request', agentId: 'alpha', request: {} });
  await until(() => jest.getTimerCount() === 1);
  if (reconnect) {
    const reconnected = peer.calls.filter(c => c.method === 'session/list').length + 1;
    for (const stream of peer.streams.values()) stream.socket.terminate();
    await until(() => peer.calls.filter(c => c.method === 'session/list').length === reconnected);
  }
  jest.advanceTimersByTime(10_000);
  expect(alpha.getStatus()).toBe(status);
});

it('stops the idle process after its last attachment and history read', async () => {
  await deepseek.dispose();
  ({ deepseek, lifecycle } = peer.host({ idleMs: 20 }));
  const session = open();
  await run(session, request('Prompt'), 'done');
  await deepseek.read(reader => reader.call('session/projections', { request: { sessionId: 'alpha' } }));
  await session.dispose();
  await until(() => lifecycle.disposed === 1);
  await expect(deepseek.read(reader => reader.call('session/prompt', {}))).rejects.toThrow(/cannot call session\/prompt/);
  expect(lifecycle.starts).toBe(2);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = realNow() + 2500;
  while (!predicate()) { if (realNow() > deadline) throw new Error('Shared Host fixture timed out.'); await new Promise(resolve => realTimeout(resolve, 5)); }
}

/** Advances the fake clock through each scheduled wait of at most `limit` ms, never through in-flight RPC deadlines. */
function elapseWaitsUpTo(limit: number): () => void {
  const timers = jest.spyOn(window, 'setTimeout');
  let seen = 0;
  let active = true;
  void (async () => {
    while (active) {
      for (; seen < timers.mock.calls.length; seen++) {
        const ms = timers.mock.calls[seen][1];
        if (typeof ms === 'number' && ms <= limit) jest.advanceTimersByTime(ms);
      }
      await new Promise(resolve => realTimeout(resolve, 1));
    }
  })();
  return () => { active = false; timers.mockRestore(); };
}
