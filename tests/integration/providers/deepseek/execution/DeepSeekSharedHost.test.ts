import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { childFollow, jobsOf, NativePeer, type NativePeerLifecycle, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';
import type { Mock } from 'vitest';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SessionToolRoute,SessionToolRoutedCallHandler } from '@/core/session-tools/SessionToolEndpoint';
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import { DeepSeekRemoteError } from '@/providers/deepseek/remote/DeepSeekRemoteClient';
import { DEEPSEEK_EPHEMERAL_PREFIX } from '@/providers/deepseek/runtime/DeepSeekCompatibility';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHome';
import { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';
import { type DeepSeekLaunchArtifacts, prepareDeepSeekLaunchArtifacts } from '@/providers/deepseek/runtime/DeepSeekLaunchArtifacts';

const time = testDate().getTime();
// Fixture polling keeps the real clock while tests drive native deadlines on the fake one.
const realTimeout = setTimeout;
const realNow = Date.now;
let host: ProviderHost;
let peer: NativePeer;
let deepseek: DeepSeekHost;
let lifecycle: NativePeerLifecycle;
let sessions: ProviderExecutionSession[];
let created: string[];
/** Saved conversations native lists before any activation. */
let stored: string[];
let seq: number;
let jobs: Record<string, unknown[]>;
/**
 * Native refusal to activate a session: `session/create` (`sessionId` absent for a new session) or the first addressed
 * call to a saved one (`agentPreset` absent: native resumes its stored preset).
 */
let activationFailures: (sessionId: string | undefined, agentPreset: string | undefined) => Error | undefined;
let permissions: Record<string, string>;

beforeEach(async () => {
  ({ host } = await createProviderHostFixture({ settings: { locale: 'en', providerConfigs: { deepseek: { enabled: true } } } }));
  sessions = []; created = []; stored = []; seq = 3; jobs = {}; activationFailures = () => undefined; permissions = {};
  peer = new NativePeer();
  const native = nativeDefaults({
    seq: () => seq, roster: () => [...new Set([...stored, ...created])], jobs: sessionId => jobs[sessionId] ?? [],
    permission: sessionId => permissions[sessionId] ?? 'workspace-write', setPermission: (sessionId, value) => { permissions[sessionId] = value; },
  });
  const activate = (id: string): void => {
    if (!created.includes(id)) created.push(id);
    // Native announces every activated session on the shared event stream.
    peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: id, agentAvailable: true, running: false }] });
  };
  peer.onCall = (method, args) => {
    if (method === 'session/create') {
      const named = args.request.sessionId as string | undefined;
      const failure = activationFailures(named, args.request.agentPreset);
      if (failure) throw failure;
      // Native reuses a named session only while no turn has started: a fresh ephemeral identity, never a saved conversation.
      const id = named?.startsWith(DEEPSEEK_EPHEMERAL_PREFIX) ? named : named ? `minted-${created.length}` : ['alpha', 'beta', 'gamma'][created.length];
      activate(id);
      return { sessionId: id, agentPreset: args.request.agentPreset };
    }
    if (method === 'commands/list' && !created.includes(args.agentId)) {
      // Any call addressing a saved session resumes it.
      const failure = activationFailures(args.agentId, undefined);
      if (failure) throw failure;
      activate(args.agentId);
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
  vi.useRealTimers();
  await Promise.all(sessions.map(session => session.dispose()));
  await deepseek.dispose(); await peer.close();
});

function port(): ProviderInteractionPort & { askUserQuestion: Mock } {
  return { requestApproval: vi.fn(), askUserQuestion: vi.fn(() => new Promise<never>(() => {})), dismissInteraction: vi.fn() };
}

function open(interactionPort = port(), resume?: string, lifecycle: ProviderSessionConfig['lifecycle'] = 'persistent', sessionTools?: ProviderSessionConfig['sessionTools']): ProviderExecutionSession {
  if (resume && !stored.includes(resume)) stored.push(resume);
  const config: ProviderSessionConfig = {
    sessionTools, lifecycle, nativePersistence: lifecycle === 'ephemeral' ? 'disabled-if-supported' : 'enabled', workingDirectory: '/vault', interactionPort,
    ...(resume ? { resumeSeed: { providerSessionId: resume, providerState: { schemaVersion: 1, home: getDeepSeekHome(process.env, process.cwd()), profile: 'web', preset: 'claudian' } } } : {}),
  };
  const session = new DeepSeekExecutionBackend(host.getRuntimeHost('deepseek'), () => deepseek).createSession(config);
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

it('serves concurrent conversations and auxiliary tasks from one native process with per-session prompts', async () => {
  const main = open(); const title = open();
  const [mainEvents, titleEvents] = await Promise.all([
    run(main, request('Main prompt {literal}'), 'main answer'),
    run(title, request('Title prompt', { kind: 'passive' }), 'title answer'),
  ]);
  expect(texts(mainEvents)).toBe('main answer');
  expect(texts(titleEvents)).toBe('title answer');
  expect(lifecycle.starts).toBe(1);
  const creates = peer.calls.filter(c => c.method === 'session/create').map(c => c.args.request.agentPreset);
  expect([...creates].sort()).toEqual(['claudian', 'claudian-passive']);
  const native = Object.fromEntries(creates.map((preset, index) => [preset, created[index]]));
  expect(lifecycle.prompts).toEqual(expect.arrayContaining([
    { sessionId: native.claudian, text: 'Main prompt {literal}' }, { sessionId: native['claudian-passive'], text: 'Title prompt' },
  ]));
});

it.each([true, false])('keeps an auxiliary task in native memory only when the ephemeral plugin is ready (%s)', async ready => {
  await deepseek.dispose();
  ({ deepseek, lifecycle } = peer.host({ ephemeralReady: ready }));
  const title = open(port(), undefined, 'ephemeral');
  const main = open();
  expect(texts(await run(title, request('Title prompt', { kind: 'passive' }), 'title'))).toBe('title');
  expect(texts(await run(main, request('Main prompt'), 'main'))).toBe('main');
  const creates = peer.calls.filter(c => c.method === 'session/create').map(c => c.args.request);
  // The prefixed identity is what the bundled plugin keeps in memory; without it native stores the task as before.
  const titleId = creates.find(r => r.agentPreset === 'claudian-passive').sessionId;
  expect(/^claudian-ephemeral-[0-9a-f-]{36}$/.test(titleId ?? '')).toBe(ready);
  expect(titleId === undefined).toBe(!ready);
  expect(creates.find(r => r.agentPreset === 'claudian')).not.toHaveProperty('sessionId');
});

it('ends an ephemeral auxiliary task with the process that held it instead of rebinding', async () => {
  const task = open(port(), undefined, 'ephemeral');
  await run(task, request('Inline edit prompt', { kind: 'read-only' }), 'first edit');
  const [{ args: { request: { sessionId } } }] = peer.calls.filter(c => c.method === 'session/create');
  lifecycle.exit();
  await until(() => task.getStatus() === 'invalidated' && lifecycle.disposed === 1);
  const calls = peer.calls.length;
  const events = await run(task, request('Inline edit prompt', { kind: 'read-only' }));
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', recoverable: true, message: expect.stringMatching(/temporary DeepSeek session ended when DeepSeek restarted/) });
  // Nothing native is touched for the lost session: no resume, projections, unarchive or prompt.
  expect(peer.calls.slice(calls).filter(c => c.args?.request?.sessionId === sessionId || c.method === 'session/create')).toEqual([]);
  // An ordinary conversation still rebinds on the replacement process.
  expect(texts(await run(open(), request('Prompt'), 'served'))).toBe('served');
});

/**
 * Applies the chat preset's bundled compatibility plugin as native composes it, in its own process. Each call assembles
 * one model step of a native session at its current turn and returns the persona text.
 */
async function nativePersona(artifacts: DeepSeekLaunchArtifacts) {
  const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
  const row = patch.find((entry: any) => entry.insert).insert.find((entry: any) => entry.config?.id === 'claudian')
    .config.plugins.find((plugin: any) => plugin.id === 'claudian-compatibility');
  const script = String.raw`
    import { createInterface } from 'node:readline';
    const plugin = await import(process.argv[1]);
    const sections = [], sessions = new Map(), turns = new Map();
    plugin.apply({
      effect: fn => fn(), on: () => () => {},
      systemPrompt: { section: section => { sections.push(section); return () => {}; }, getSectionOrder: name => name },
      sessionProjections: { stateOf: (session, key) => key === 'turnBoundary' ? { lastTurn: turns.get(session) } : undefined },
    }, JSON.parse(process.argv[2]));
    const persona = sections.find(section => section.name === 'deployment:persona-prefix');
    for await (const line of createInterface({ input: process.stdin })) {
      const step = JSON.parse(line);
      if (!sessions.has(step.session)) sessions.set(step.session, { id: step.session, header: { id: step.session, ...(step.parent ? { parentSession: step.parent } : {}) } });
      const session = sessions.get(step.session);
      turns.set(session, step.turn);
      const agent = { id: session.id, session };
      process.stdout.write(JSON.stringify(typeof persona.text === 'function' ? persona.text({ agent, scope: agent }) : persona.text) + '\n');
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, row.name, JSON.stringify(row.config)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies: Array<(text: string) => void> = [];
  createInterface({ input: child.stdout }).on('line', line => replies.shift()?.(JSON.parse(line)));
  child.once('exit', code => { for (const reply of replies.splice(0)) reply(`native plugin exited with ${code}`); });
  return {
    assemble: (session: string, turn: number, parent?: string) => new Promise<string>(resolve => {
      replies.push(resolve);
      child.stdin.write(`${JSON.stringify({ session, turn, parent })}\n`);
    }),
    close: () => { child.stdin.end(); },
  };
}

it('gives each conversation on the shared process its own prompt and applies an edit at its next native turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek session prompts '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  await deepseek.dispose();
  ({ deepseek, lifecycle } = peer.host({ launchArtifacts: artifacts }));
  const native = await nativePersona(artifacts);
  try {
    const alpha = open(), beta = open();
    await run(alpha, request('Alpha prompt'), 'one');
    await run(beta, request('Beta prompt'), 'two');
    expect(created).toEqual(['alpha', 'beta']);
    expect(await native.assemble('alpha', 1)).toBe('Alpha prompt');
    expect(await native.assemble('beta', 1)).toBe('Beta prompt');
    // A subagent runs on its parent's instructions.
    expect(await native.assemble('alpha-child', 1, 'alpha')).toBe('Alpha prompt');

    await run(alpha, request('Alpha edited'), 'three');
    // The running turn keeps its prompt; the edit applies from the conversation's next native turn.
    expect(await native.assemble('alpha', 1)).toBe('Alpha prompt');
    expect(await native.assemble('alpha', 2)).toBe('Alpha edited');
    expect(await native.assemble('alpha-child', 2, 'alpha')).toBe('Alpha edited');
    expect(await native.assemble('beta', 2)).toBe('Beta prompt');
    // Prompt edits never restart the shared process or recreate a conversation's native session.
    expect(lifecycle.starts).toBe(1);
    expect(peer.calls.filter(c => c.method === 'session/create')).toHaveLength(2);

    // Closing a conversation removes its prompt; native keeps a turn already running.
    await beta.dispose();
    await until(() => lifecycle.prompts.some(p => p.sessionId === 'beta' && p.text === null));
    expect(await native.assemble('beta', 2)).toBe('Beta prompt');
    expect(await native.assemble('beta', 3)).toBe('');
  } finally { native.close(); await artifacts.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('writes the Main Agent instructions verbatim into the session prompt and rewrites it when they change', async () => {
  const session = open();
  const withInstructions = (instructions: string): ProviderExecutionRequest => ({
    ...request(''), configuration: { systemInstructions: { kind: 'main-agent', instructions }, permissionMode: 'normal' },
  });
  await run(session, withInstructions('Main Agent prompt Alpha'), 'one');
  await run(session, withInstructions('Main Agent prompt Beta'), 'two');
  const written = lifecycle.prompts.filter(p => p.sessionId === 'alpha').map(p => p.text ?? '');
  expect(written[0]).toBe('Main Agent prompt Alpha');
  expect(written.at(-1)).toBe('Main Agent prompt Beta');
  expect(lifecycle.starts).toBe(1);
});

it('applies a changed code-mode preference on the next turn of the same conversation and preset', async () => {
  const config = (host.settings as any).providerConfigs.deepseek;
  config.codeMode = true;
  try {
    const session = open();
    await run(session, request('Prompt'), 'one');
    // The title task runs on its fixed auxiliary policy and never touches the chat preference.
    await run(open(), request('Title prompt', { kind: 'passive' }), 'title');
    config.codeMode = false;
    await run(session, request('Prompt'), 'two');
    expect(lifecycle.codeModes).toEqual([{ enabled: true, promptsSent: 0 }, { enabled: false, promptsSent: 2 }]);
    expect(peer.calls.filter(c => c.method === 'session/create').map(c => c.args.request.agentPreset)).toEqual(['claudian', 'claudian-passive']);
    expect(lifecycle.starts).toBe(1);
  } finally { delete config.codeMode; }
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
  expect(peer.calls.filter(c => c.method === 'session/prompt')).toHaveLength(1);
});

it('waits for a reloaded Host to release the writer, then names the other process', async () => {
  vi.useFakeTimers({ toNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const backoff = elapseWaitsUpTo(1_000);
  const held = new DeepSeekRemoteError('session "alpha" is already owned by an active write handle', 'session/writer-held');
  let attempts = 0;
  activationFailures = id => (id && ++attempts <= 2 ? held : undefined);
  const recovered = open(port(), 'alpha');
  expect(texts(await run(recovered, request('Prompt'), 'resumed after handoff'))).toBe('resumed after handoff');
  expect(attempts).toBe(3);
  await recovered.dispose();

  // A process other than this Host holds a different saved conversation.
  activationFailures = id => (id ? held : undefined);
  const blocked = open(port(), 'beta');
  const started = Date.now();
  const events = await run(blocked, request('Prompt'));
  backoff();
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true, message: expect.stringContaining('another DeepSeek Harness process') });
  // Backoff 100, 200, 400, 800, 1000, 1000, 1000 ms; the next 1000 ms wait would pass the 5 s handoff window.
  expect(Date.now() - started).toBe(4_500);
  expect(blocked.getStatus()).not.toBe('invalidated');
});

it('points a chat preset that native cannot mount at the additional preset plugins setting', async () => {
  const config = (host.settings as any).providerConfigs.deepseek;
  config.presetPlugins = '[{ "id": "nope", "name": "@example/missing" }]';
  activationFailures = (_id, preset) => preset === 'claudian' ? new DeepSeekRemoteError('nope (@example/missing): never started', 'agent-preset/invalid') : undefined;
  try {
    const chat = open();
    const events = await run(chat, request('Prompt'));
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'configuration', recoverable: true,
      message: expect.stringMatching(/nope \(@example\/missing\): never started.*Additional preset plugins/) });
    expect(chat.getStatus()).not.toBe('invalidated');
    expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(false);
    // Auxiliary tasks never mount the user's rows, so they keep working.
    expect(texts(await run(open(), request('Title prompt', { kind: 'passive' }), 'title'))).toBe('title');
  } finally { delete config.presetPlugins; }
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
  vi.useFakeTimers({ toNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  // Routed by the roster, but no native turn is followed yet to own it.
  peer.send('$events', { type: 'waterfall', eventId: 'early', event: 'approval/request', agentId: 'alpha', request: {} });
  await until(() => vi.getTimerCount() === 1);
  if (reconnect) {
    const reconnected = peer.calls.filter(c => c.method === 'session/list').length + 1;
    for (const stream of peer.streams.values()) stream.socket.terminate();
    await until(() => peer.calls.filter(c => c.method === 'session/list').length === reconnected);
  }
  vi.advanceTimersByTime(10_000);
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
  const timers = vi.spyOn(window, 'setTimeout');
  let seen = 0;
  let active = true;
  void (async () => {
    while (active) {
      for (; seen < timers.mock.calls.length; seen++) {
        const ms = timers.mock.calls[seen][1];
        if (typeof ms === 'number' && ms <= limit) vi.advanceTimersByTime(ms);
      }
      await new Promise(resolve => realTimeout(resolve, 1));
    }
  })();
  return () => { active = false; timers.mockRestore(); };
}

/** Keep the production Host, roster and execution session; replace only the native process and endpoint port. */
function sessionToolEndpoint() {
  let handler: SessionToolRoutedCallHandler | undefined;
  const route: SessionToolRoute = { url: 'http://127.0.0.1:1234/call', routeId: 'host-route', headers: { 'X-Claudian-Route': 'host-route' }, dispose: vi.fn() };
  const registerCallRoute = vi.fn(async (call: SessionToolRoutedCallHandler) => { handler = call; return route; });
  const starts = vi.fn();
  deepseek = new DeepSeekHost(async () => ({ cliPath: '/dsh', cwd: '/vault', environment: process.env }), async options => {
    starts(options);
    const client = await peer.connect();
    return { client, profile: 'web', onExit: () => () => {}, dispose: async () => client.dispose(),
      writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {}, readEphemeralReady: async () => false,
      offerEphemeralFork: async () => async () => {},
    };
  }, undefined, { registerCallRoute, registerMCPRoute: vi.fn() });
  return { route, registerCallRoute, starts, call: (callerNativeId: string, name = 'claudian_list_destinations', args: unknown = {}, signal = new AbortController().signal) => {
    expect(handler).toBeDefined();
    return handler!({ name, args, callerNativeId, signal });
  } };
}

async function startSessionToolTurn(session: ProviderExecutionSession, nativeId: string, input = request('Prompt')) {
  const execution = session.execute(input);
  const events: ProviderExecutionEvent[] = [];
  const done = (async () => { for await (const event of execution.events) events.push(event); })();
  await until(() => peer.calls.some(call => call.method === 'session/prompt' && call.args.request.requestId === execution.executionId));
  emit(nativeId, 'turn/start', { turn: seq });
  emit(nativeId, 'user/message', { source: { kind: 'user', rpcId: execution.executionId }, content: [{ type: 'text', text: 'hello' }] });
  emit(nativeId, 'tool/call', { callId: 'session-call', name: 'claudian_list_destinations', arguments: '{}' });
  await until(() => events.some(event => event.type === 'tool_started'));
  return { execution, events, done };
}

it('routes session tools through one Host route to the claimed root, denying unknown and unported callers', async () => {
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const send = vi.fn(async () => ({ sessionId: 'target', title: 'Review', provider: 'codex', status: 'queued' as const }));
  const alpha = open(port(), undefined, 'persistent', { list, send, read: vi.fn() });
  const a = await startSessionToolTurn(alpha, 'alpha');
  const b = await startSessionToolTurn(open(), 'beta');
  expect(endpoint.registerCallRoute).toHaveBeenCalledTimes(1);
  expect(endpoint.starts).toHaveBeenCalledWith(expect.objectContaining({ sessionToolRoute: endpoint.route }));
  const unknown = new AbortController();
  const unknownCall = endpoint.call('stranger', 'claudian_list_destinations', {}, unknown.signal);
  unknown.abort();
  expect(await unknownCall).toMatchObject({ isError: true });
  expect(await endpoint.call('beta')).toMatchObject({ isError: true });
  // One invocation arrives before even the child's roster identity is available.
  const pendingChild = endpoint.call('child', 'claudian_send_message', { sessionId: 'target', text: 'review' });
  peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'child', parentSessionId: 'alpha', origin: 'subagent', agentAvailable: true, running: true }] });
  peer.send('session/control', { type: 'projection', sessionId: 'alpha', key: 'subagentCatalog', value: [{ id: 'child', mode: 'continuable' }] });
  peer.send('session/control', { type: 'projection', sessionId: 'child', key: 'subagent', value: { parentSessionId: 'alpha', mode: 'continuable' } });
  await until(() => [...peer.streams.values()].some(stream => stream.endpoint === 'session/follow' && childFollow('child')(stream.args)));
  emit('alpha', 'subagent/catalog', { childId: 'child', mode: 'continuable' });
  peer.send('session/follow', { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 2, type: 'tool/call', data: { callId: 'session-call', name: 'claudian_send_message', arguments: '{"sessionId":"target","text":"review"}' } } }, childFollow('child'));
  const childResult = await pendingChild;
  expect(childResult).toEqual({ isError: false, text: '{"sessionId":"target","title":"Review","provider":"codex","status":"queued"}' });
  expect(send).toHaveBeenCalledWith({ sessionId: 'target', text: 'review' }, expect.any(AbortSignal));
  expect(await endpoint.call('alpha')).toEqual({ isError: false, text: '{"sessions":[]}' });
  expect(list).toHaveBeenCalledTimes(1);
  emit('alpha', 'tool/call', { callId: 'send-call', name: 'claudian_send_message', arguments: '{"sessionId":"target","text":"review"}' });
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  emit('beta', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await Promise.all([a.done, b.done]);
  expect(a.events).toContainEqual(expect.objectContaining({ type: 'tool_started', name: 'claudian_send_message', input: { sessionId: 'target', text: 'review' }, providerPayload: { rawName: 'claudian_send_message' } }));
  const next = await startSessionToolTurn(alpha, 'alpha');
  expect(await endpoint.call('child', 'claudian_send_message', { text: 'late' })).toMatchObject({ isError: true });
  expect(send).toHaveBeenCalledTimes(1);
  peer.send('session/follow', { type: 'event', event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 4, type: 'turn/start', data: { turn: 2 } } }, childFollow('child'));
  // A root event behind the child frames observes the real session's follow queue, not fixture timing.
  emit('alpha', 'tool/call', { callId: 'barrier', name: 'read', arguments: '{}' });
  await until(() => next.events.some(event => event.type === 'tool_started' && event.toolCallId === 'barrier'));
  expect(await endpoint.call('child', 'claudian_send_message', { text: 'automatic second child turn' })).toMatchObject({ isError: true });
  peer.send('session/follow', { type: 'snapshot', cursor: 4, records: [
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 3, type: 'turn/end', data: { turn: 1 } } },
    { event: { seq: 4, type: 'turn/start', data: { turn: 2 } } },
  ] }, childFollow('child'));
  emit('alpha', 'tool/call', { callId: 'replay-barrier', name: 'read', arguments: '{}' });
  await until(() => next.events.some(event => event.type === 'tool_started' && event.toolCallId === 'replay-barrier'));
  expect(await endpoint.call('child', 'claudian_send_message', { text: 'replayed child turn' })).toMatchObject({ isError: true });
  peer.send('session/follow', { type: 'event', event: { seq: 5, type: 'turn/end', data: { turn: 2 } } }, childFollow('child'));
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await next.done;
  await alpha.dispose();
  expect(await endpoint.call('alpha')).toMatchObject({ isError: true });
  await deepseek.dispose();
  expect(endpoint.route.dispose).toHaveBeenCalledTimes(1);
});

it.each(['passive', 'read-only', 'allow-list'] as const)('denies %s at call time even when the native Agent has session tools', async kind => {
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const input = request('Prompt');
  const turn = await startSessionToolTurn(open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() }), 'alpha', input);
  // Native retains a chat preset; policy must be checked by the dispatcher, independently of native permissions.
  Object.assign(input.toolPolicy, { kind, ...(kind === 'allow-list' ? { names: ['claudian_list_destinations'] } : {}) });
  expect(await endpoint.call('alpha')).toMatchObject({ isError: true });
  expect(list).not.toHaveBeenCalled();
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await turn.done;
});

it.each(['cancel', 'terminal', 'release'] as const)('revokes session tool calls on %s without lending a later run its signal', async ending => {
  const endpoint = sessionToolEndpoint();
  const signals: AbortSignal[] = [];
  const list = vi.fn((_args: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<{ sessions: [] }>(resolve => signal.addEventListener('abort', () => resolve({ sessions: [] }), { once: true }));
  });
  const session = open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() });
  const first = await startSessionToolTurn(session, 'alpha');
  const pending = endpoint.call('alpha');
  await until(() => signals.length === 1);
  if (ending === 'cancel') first.execution.cancel();
  if (ending === 'release') void session.dispose();
  if (ending === 'terminal') emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await until(() => signals[0].aborted);
  await pending;
  if (ending !== 'terminal') emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'cancelled' } });
  await first.done;
  expect(await endpoint.call('alpha')).toMatchObject({ isError: true });
  if (ending === 'release') return;
  const second = await startSessionToolTurn(session, 'alpha');
  expect(signals[0].aborted).toBe(true);
  list.mockImplementationOnce(async (_args, signal) => { signals.push(signal); return { sessions: [] }; });
  expect(await endpoint.call('alpha')).toMatchObject({ isError: false });
  expect(signals[1].aborted).toBe(false);
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await second.done;
});

it('resolves nested child session-tool ownership when the root creation catalog arrives last', async () => {
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const session = open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() });
  const turn = await startSessionToolTurn(session, 'alpha');
  for (const [id, parent] of [['child', 'alpha'], ['grandchild', 'child']]) {
    peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: id, parentSessionId: parent, origin: 'subagent', agentAvailable: true, running: true }] });
    peer.send('session/control', { type: 'projection', sessionId: parent, key: 'subagentCatalog', value: [{ id, mode: 'continuable' }] });
    peer.send('session/control', { type: 'projection', sessionId: id, key: 'subagent', value: { parentSessionId: parent, mode: 'continuable' } });
    await until(() => [...peer.streams.values()].some(stream => stream.endpoint === 'session/follow' && childFollow(id)(stream.args)));
  }
  peer.send('session/follow', { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 2, type: 'subagent/catalog', data: { childId: 'grandchild', mode: 'continuable' } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } }, childFollow('grandchild'));
  peer.send('session/follow', { type: 'event', event: { seq: 3, type: 'tool/call', data: { callId: 'session-call', name: 'claudian_list_destinations', arguments: '{}' } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 2, type: 'tool/call', data: { callId: 'session-call', name: 'claudian_list_destinations', arguments: '{}' } } }, childFollow('grandchild'));
  emit('alpha', 'subagent/catalog', { childId: 'child', mode: 'continuable' });
  emit('alpha', 'tool/call', { callId: 'catalog-barrier', name: 'read', arguments: '{}' });
  await until(() => turn.events.some(event => event.type === 'tool_started' && event.toolCallId === 'catalog-barrier'));
  const childResult = await endpoint.call('child');
  const grandchildResult = await endpoint.call('grandchild');
  peer.send('session/follow', { type: 'event', event: { seq: 4, type: 'turn/end', data: { turn: 1 } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 3, type: 'turn/end', data: { turn: 1 } } }, childFollow('grandchild'));
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await turn.done;
  expect(childResult).toEqual({ isError: false, text: '{"sessions":[]}' });
  expect(grandchildResult).toEqual({ isError: false, text: '{"sessions":[]}' });
});

// The HTTP bridge and native follow frames arrive independently; no fixture retries the invocation. Ownership alone
// admits it: native's own call event need not have arrived.
it('reconciles one root session-tool invocation that arrives before native claims its run', async () => {
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const session = open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() });
  const execution = session.execute(request('Prompt'));
  const events: ProviderExecutionEvent[] = [];
  const done = (async () => { for await (const event of execution.events) events.push(event); })();
  await until(() => peer.calls.some(call => call.method === 'session/prompt' && call.args.request.requestId === execution.executionId));
  const pending = endpoint.call('alpha');
  expect(list).not.toHaveBeenCalled();
  emit('alpha', 'turn/start', { turn: seq });
  emit('alpha', 'user/message', { source: { kind: 'user', rpcId: execution.executionId }, content: [] });
  const result = await pending;
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await done;
  expect(result).toEqual({ isError: false, text: '{"sessions":[]}' });
  expect(list).toHaveBeenCalledTimes(1);
});

it.each(['native', 'request', 'session'] as const)('cancels a pending session-tool invocation with its %s lifetime', async ending => {
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const session = open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() });
  const execution = session.execute(request('Prompt'));
  const events: ProviderExecutionEvent[] = [];
  const done = (async () => { for await (const event of execution.events) events.push(event); })();
  await until(() => peer.calls.some(call => call.method === 'session/prompt' && call.args.request.requestId === execution.executionId));
  const native = new AbortController();
  const pending = endpoint.call('alpha', 'claudian_list_destinations', {}, native.signal);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => realTimeout(resolve, 10));
  const settledBeforeCancellation = settled;
  if (ending === 'native') native.abort();
  if (ending === 'request') execution.cancel();
  if (ending === 'session') void session.dispose();
  expect(await pending).toMatchObject({ isError: true });
  emit('alpha', 'turn/start', { turn: seq });
  emit('alpha', 'user/message', { source: { kind: 'user', rpcId: execution.executionId }, content: [] });
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await done;
  expect(settledBeforeCancellation).toBe(false);
  if (ending === 'session') return;
  const next = await startSessionToolTurn(session, 'alpha');
  // Even a later call with the same ID cannot revive the cancelled invocation.
  expect(list).not.toHaveBeenCalled();
  expect(await endpoint.call('alpha')).toMatchObject({ isError: false });
  expect(list).toHaveBeenCalledTimes(1);
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await next.done;
});

it('bounds ownership reconciliation and denies a call whose run native never claims', async () => {
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const session = open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() });
  const execution = session.execute(request('Prompt'));
  const events: ProviderExecutionEvent[] = [];
  const done = (async () => { for await (const event of execution.events) events.push(event); })();
  await until(() => peer.calls.some(call => call.method === 'session/prompt' && call.args.request.requestId === execution.executionId));
  vi.useFakeTimers({ toNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const pending = endpoint.call('alpha');
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  vi.advanceTimersByTime(10_000);
  expect(await pending).toMatchObject({ isError: true });
  vi.useRealTimers();
  emit('alpha', 'turn/start', { turn: seq });
  emit('alpha', 'user/message', { source: { kind: 'user', rpcId: execution.executionId }, content: [] });
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await done;
  expect(list).not.toHaveBeenCalled();
});

it.each(['native', 'request', 'timeout'] as const)('denies a pre-announcement child call after %s and cannot lend it a later request', async ending => {
  const nativeCall = peer.onCall;
  peer.onCall = (method, args) => method === 'session/cancel' ? {} : nativeCall(method, args);
  const endpoint = sessionToolEndpoint();
  const list = vi.fn(async () => ({ sessions: [] }));
  const session = open(port(), undefined, 'persistent', { list, send: vi.fn(), read: vi.fn() });
  const first = await startSessionToolTurn(session, 'alpha');
  // Another live claim keeps an unresolved caller ambiguous when alpha ends.
  const otherList = vi.fn(async () => ({ sessions: [] }));
  const other = await startSessionToolTurn(open(port(), undefined, 'persistent', { list: otherList, send: vi.fn(), read: vi.fn() }), 'beta');
  const native = new AbortController();
  vi.useFakeTimers({ toNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const pending = endpoint.call('child', 'claudian_list_destinations', {}, native.signal);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => realTimeout(resolve, 10));
  const settledBeforeEnding = settled;
  if (ending === 'native') native.abort();
  if (ending === 'timeout') vi.advanceTimersByTime(10_000);
  if (ending === 'request') first.execution.cancel();
  await new Promise(resolve => realTimeout(resolve, 10));
  const settledAfterEnding = settled;
  vi.useRealTimers();
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await first.done;
  const next = await startSessionToolTurn(session, 'alpha');
  peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'child', parentSessionId: 'alpha', origin: 'subagent', agentAvailable: true, running: true }] });
  peer.send('session/control', { type: 'projection', sessionId: 'alpha', key: 'subagentCatalog', value: [{ id: 'child', mode: 'continuable' }] });
  peer.send('session/control', { type: 'projection', sessionId: 'child', key: 'subagent', value: { parentSessionId: 'alpha', mode: 'continuable' } });
  emit('alpha', 'subagent/catalog', { childId: 'child', mode: 'continuable' });
  await until(() => [...peer.streams.values()].some(stream => stream.endpoint === 'session/follow' && childFollow('child')(stream.args)));
  peer.send('session/follow', { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } }, childFollow('child'));
  peer.send('session/follow', { type: 'event', event: { seq: 2, type: 'tool/call', data: { callId: 'child-call', name: 'claudian_list_destinations', arguments: '{}' } } }, childFollow('child'));
  emit('alpha', 'tool/call', { callId: 'barrier', name: 'read', arguments: '{}' });
  await until(() => next.events.some(event => event.type === 'tool_started' && event.toolCallId === 'barrier'));
  const result = await pending;
  const oldDispatches = list.mock.calls.length;
  // A fresh invocation proves the child is now owned and callable under the new request.
  const fresh = await endpoint.call('child');
  peer.send('session/follow', { type: 'event', event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }, childFollow('child'));
  emit('alpha', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  emit('beta', 'turn/end', { turn: seq, reason: { kind: 'completed' } });
  await Promise.all([next.done, other.done]);
  expect(settledBeforeEnding).toBe(false);
  expect(settledAfterEnding).toBe(ending !== 'request');
  expect(result).toMatchObject({ isError: true });
  expect(oldDispatches).toBe(0);
  expect(fresh).toMatchObject({ isError: false });
  expect(list).toHaveBeenCalledTimes(1);
  expect(otherList).not.toHaveBeenCalled();
});
