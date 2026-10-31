// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';

import { createFixture, turn } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';

import type { ProviderExecutionEvent, ProviderExecutionRun, ProviderExecutionSession, ProviderSessionEvent } from '@/core/execution';
import { decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import type { OpencodeServerLease } from '@/providers/opencode/http/OpencodeServerService';
import { updateOpencodeProviderSettings } from '@/providers/opencode/settings';

function watch(run: ProviderExecutionRun) {
  const events: ProviderExecutionEvent[] = [];
  const published = new EventEmitter();
  const done = (async () => {
    for await (const event of run.events) { events.push(event); published.emit('event'); }
    published.emit('event');
    return events;
  })();
  return { events, done, async until(predicate: (events: ProviderExecutionEvent[]) => boolean) {
    const signal = AbortSignal.timeout(5_000);
    while (!predicate(events)) await once(published, 'event', { signal });
  } };
}

function watchSession(session: ProviderExecutionSession) {
  const events: ProviderSessionEvent[] = [];
  const published = new EventEmitter();
  session.onEvent(event => { events.push(event); published.emit('event'); });
  return { events, async until(predicate: (events: ProviderSessionEvent[]) => boolean) {
    const signal = AbortSignal.timeout(5_000);
    while (!predicate(events)) await once(published, 'event', { signal });
  } };
}

const post = (control: OpencodeServerLease, route: string, body: Record<string, unknown> = {}) => control.request(route, { method: 'POST', body });
const hold = (control: OpencodeServerLease, route: string) => post(control, '/fixture/hold-route', { route });
const arrived = (control: OpencodeServerLease, route: string) => control.request('/fixture/wait-route?route=' + encodeURIComponent(route));
const release = (control: OpencodeServerLease, route: string) => post(control, '/fixture/release-route', { route });
const nativeEvent = (control: OpencodeServerLease, type: string, data: Record<string, unknown>) => post(control, '/fixture/event', { type, data });
const fault = (control: OpencodeServerLease, route: string, status: number) => post(control, '/fixture/route-error', { route, status, error: { message: status === 403 ? 'Authentication expired' : 'Native request failed' } });

async function setup() {
  const fixture = await createFixture();
  await fixture.workspace.metadataService.loadCatalog();
  const control = await fixture.workspace.serverService.acquire(fixture.cli, fixture.root, fixture.environment);
  onTestFinished(async () => { await control.dispose(); await fixture.dispose(); });
  return { ...fixture, control };
}

it.each(['unavailable model', 'already aborted signal'] as const)('starts no native process for an %s', async cause => {
  const f = await createFixture();
  const session = f.createSession();
  const controller = new AbortController();
  if (cause === 'unavailable model') updateOpencodeProviderSettings(f.plugin.settings, { visibleModels: [] });
  else controller.abort();
  try {
    const events = await watch(session.execute({ ...turn('hello'), signal: controller.signal })).done;
    expect(events.at(-1)).toMatchObject(cause === 'unavailable model'
      ? { type: 'execution_error', category: 'configuration' }
      : { type: 'cancelled', reason: 'cancelled' });
    expect(events.some(event => event.type === 'turn_started')).toBe(false);
    expect(f.processes()).toEqual([]);
  } finally { await session.dispose(); await f.dispose(); }
});

it('reports native interruption as provider cancellation without a caller Stop', async () => {
  const f = await setup();
  const session = f.createSession();
  try {
    const output = watch(session.execute(turn('hold')));
    await output.until(events => events.some(event => event.type === 'text_delta'));
    expect(output.events[0]).toMatchObject({ type: 'session_state_changed', snapshot: {
      providerSessionId: 'ses_1', status: 'executing', providerState: {
        databasePath: f.environment.OPENCODE_DB, nativeConversationContextEstablished: false,
      },
    } });
    expect(output.events.some(event => event.type === 'turn_completed')).toBe(false);
    await nativeEvent(f.control, 'session.execution.interrupted', { sessionID: session.getSnapshot().providerSessionId });
    expect((await output.done).at(-1)).toMatchObject({ type: 'cancelled', reason: 'provider-cancelled' });
  } finally { await session.dispose(); }
});

it('opens a trusted persisted binding lazily and sequences its execution events', async () => {
  const f = await createFixture();
  const session = f.createSession({ resumeSeed: { providerSessionId: 'ses_1', providerState: { databasePath: f.environment.OPENCODE_DB } } });
  expect(f.processes()).toEqual([]);
  await f.workspace.metadataService.loadCatalog();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  await post(control, '/api/session');
  try {
    const output = watch(session.execute(turn('hold')));
    await output.until(events => events.some(event => event.type === 'text_delta'));
    expect(output.events[0]).toMatchObject({ type: 'session_state_changed', snapshot: {
      providerSessionId: 'ses_1', status: 'executing',
      providerState: { databasePath: f.environment.OPENCODE_DB, nativeConversationContextEstablished: true },
    } });
    expect(output.events.some(event => event.type === 'turn_completed')).toBe(false);
    expect(output.events.slice(0, 3).map(event => event.scope.sequence)).toEqual([1, 2, 3]);
    await nativeEvent(control, 'session.execution.succeeded', { sessionID: 'ses_1' });
    expect((await output.done).map(event => event.type)).toEqual([
      'session_state_changed', 'turn_started', 'user_message_started', 'text_delta', 'session_state_changed', 'turn_completed',
    ]);
    expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'ses_1', status: 'idle', providerState: { databasePath: f.environment.OPENCODE_DB } });
    expect((await control.request<{ data: { ids: string[] } }>('/fixture/sessions')).data.ids).toEqual(['ses_1']);
    expect(f.processes().map(process => process.db)).toEqual([f.environment.OPENCODE_DB]);
  } finally { await session.dispose(); await control.dispose(); await f.dispose(); }
});

it('bootstraps canonical history while retaining retired-session locators', async () => {
  const f = await setup();
  const previousSessions = [{ sessionId: 'retired-session', databasePath: '/old/opencode.db' }];
  const session = f.createSession({ resumeSeed: { providerState: { nativeConversationContextEstablished: false, previousSessions } } });
  try {
    const events = await watch(session.execute({ ...turn('hello'), conversationHistory: [
      { id: 'u1', role: 'user', content: 'prior', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'answer', timestamp: 2 },
    ] })).done;
    expect(events.at(-1)?.type).toBe('turn_completed');
    const [prompt] = readFileSync(f.log + '.prompts', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(prompt.context).toEqual([]);
    expect(decodeRecoveryPrompt(prompt.text)).toEqual({ currentInput: 'hello' });
    expect(prompt.text).toContain('User: prior\n\nAssistant: answer');
    expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'ses_1', providerState: { nativeConversationContextEstablished: true, previousSessions } });
  } finally { await session.dispose(); }
});

it('classifies a native session 404 separately from an authentication failure', async () => {
  const f = await setup();
  for (const status of [403, 404]) {
    await fault(f.control, '/api/session/saved', status);
    const session = f.createSession({ resumeSeed: { providerSessionId: 'saved', providerState: { databasePath: f.environment.OPENCODE_DB } } });
    try {
      const events = await watch(session.execute(turn('hello'))).done;
      expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: status === 404 ? 'provider-session-missing' : 'provider', ...(status === 404 ? { missingProviderSessionId: 'saved' } : {}) });
      expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'saved' });
    } finally { await session.dispose(); }
  }
});

it('persists cold replay intent across a native configuration failure and replays only once', async () => {
  const f = await setup();
  const first = f.createSession();
  await fault(f.control, '/api/session/ses_1/model', 400);
  const failed = await watch(first.execute(turn('hello'))).done;
  expect(failed.at(-1)?.type).toBe('execution_error');
  const snapshot = first.getSnapshot();
  expect(snapshot).toMatchObject({ providerSessionId: 'ses_1', status: 'invalidated', providerState: {
    databasePath: f.environment.OPENCODE_DB, nativeConversationContextEstablished: false,
  } });
  await first.dispose();
  await fault(f.control, '/api/session/ses_1/model', 0);
  const replacement = f.createSession({ resumeSeed: { providerSessionId: snapshot.providerSessionId!, providerState: { ...snapshot.providerState, futureResumeCursor: { token: 'cursor-1' } } } });
  const request = { ...turn('hello'), conversationHistory: [
    { id: 'u1', role: 'user' as const, content: 'replay-once', timestamp: 1 },
    { id: 'a1', role: 'assistant' as const, content: 'prior-answer', timestamp: 2 },
  ] };
  try {
    expect((await watch(replacement.execute(request)).done).at(-1)?.type).toBe('turn_completed');
    expect(replacement.getSnapshot()).toMatchObject({ providerSessionId: 'ses_1', providerState: { futureResumeCursor: { token: 'cursor-1' }, nativeConversationContextEstablished: true } });
    expect((await watch(replacement.execute(request)).done).at(-1)?.type).toBe('turn_completed');
    const prompts = readFileSync(f.log + '.prompts', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(prompts.map(prompt => prompt.sessionID)).toEqual(['ses_1', 'ses_1']);
    expect(prompts[0].text).toContain('replay-once');
    expect(prompts[1].text).not.toContain('replay-once');
  } finally { await replacement.dispose(); }
});

it('quarantines native output received during session load and configuration', async () => {
  const f = await setup();
  await post(f.control, '/api/session');
  const load = '/api/session/ses_1', model = load + '/model';
  await hold(f.control, load); await hold(f.control, model);
  let delivered!: () => void;
  await f.control.subscribe(event => { if (event.type === 'fixture.barrier') delivered(); }, () => undefined, () => false);
  const sendReplay = async (text: string) => {
    const drained = new Promise<void>(resolve => { delivered = resolve; });
    await nativeEvent(f.control, 'session.text.delta', { sessionID: 'ses_1', assistantMessageID: text, ordinal: 0, delta: text });
    await nativeEvent(f.control, 'fixture.barrier', {});
    await drained;
  };
  const session = f.createSession({ resumeSeed: { providerSessionId: 'ses_1', providerState: { databasePath: f.environment.OPENCODE_DB } } });
  try {
    const output = watch(session.execute(turn('live-output')));
    await arrived(f.control, load);
    await sendReplay('historic-load-output');
    await release(f.control, load);
    await arrived(f.control, model);
    await sendReplay('historic-config-output');
    await release(f.control, model);
    const events = await output.done;
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.flatMap(event => event.type === 'text_delta' ? [event.text] : [])).toEqual(['live-output']);
  } finally { await release(f.control, load); await release(f.control, model); await session.dispose(); }
});

it.each([
  ['ephemeral', 'provider-default', false],
  ['persistent', 'provider-default', true],
  ['ephemeral', 'enabled', true],
] as const)('applies %s %s retention on the trusted native database', async (lifecycle, nativePersistence, retained) => {
  const f = await setup();
  const seeded = retained ? await post(f.control, '/api/session') as { data: { id: string } } : undefined;
  const session = f.createSession({ lifecycle, nativePersistence, ...(seeded ? {
    resumeSeed: { providerSessionId: seeded.data.id, providerState: { databasePath: f.environment.OPENCODE_DB } },
  } : {}) });
  try {
    expect((await watch(session.execute(turn('hello'))).done).at(-1)?.type).toBe('turn_completed');
    const id = session.getSnapshot().providerSessionId;
    await session.dispose();
    const state = await f.control.request<{ data: { ids: string[]; deleted: string[] } }>('/fixture/sessions');
    expect(state.data.ids).toEqual(retained ? [id] : []);
    expect(state.data.deleted).toEqual(retained ? [] : [id]);
    expect(f.processes().map(process => process.db)).toEqual([f.environment.OPENCODE_DB]);
  } finally { await session.dispose(); }
});

it('joins pending native interruption when immediate session disposal follows Stop', async () => {
  const f = await setup();
  const session = f.createSession();
  const output = watch(session.execute(turn('hold')));
  await output.until(events => events.some(event => event.type === 'text_delta'));
  const interrupt = '/api/session/' + session.getSnapshot().providerSessionId + '/interrupt';
  await hold(f.control, interrupt);
  try {
    session.cancel();
    let disposed = false;
    const disposal = session.dispose().then(() => { disposed = true; });
    await arrived(f.control, interrupt);
    expect(disposed).toBe(false);
    await release(f.control, interrupt);
    await disposal;
    expect((await output.done).at(-1)?.type).toBe('cancelled');
    expect(() => session.execute(turn('again'))).toThrow('OpenCode execution session is disposed');
  } finally { await release(f.control, interrupt); await session.dispose(); }
});

it('publishes idle native-stream failure through the session channel', async () => {
  const f = await setup();
  const session = f.createSession();
  try {
    expect((await watch(session.execute(turn('hello'))).done).at(-1)?.type).toBe('turn_completed');
    const observation = watchSession(session);
    await post(f.control, '/fixture/disconnect').catch(() => undefined);
    await observation.until(events => events.some(event => event.type === 'session_error'));
    expect(observation.events).toEqual([
      expect.objectContaining({ type: 'session_state_changed', snapshot: expect.objectContaining({ status: 'invalidated', invalidation: expect.objectContaining({ reason: 'process-exited', recoverable: true }) }) }),
      expect.objectContaining({ type: 'session_error', category: 'process-exited' }),
    ]);
  } finally { await session.dispose(); }
});


it('reports native stream death during configuration as a terminal process error and disposes idempotently', async () => {
  const f = await setup();
  const session = f.createSession();
  await hold(f.control, '/api/session/ses_1/model');
  try {
    const output = watch(session.execute(turn('hello')));
    await arrived(f.control, '/api/session/ses_1/model');
    await post(f.control, '/fixture/disconnect').catch(() => undefined);
    const events = await output.done;
    expect(events.at(-2)).toMatchObject({ type: 'session_state_changed', snapshot: {
      status: 'invalidated', invalidation: { reason: 'process-exited', recoverable: true },
    } });
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'process-exited', recoverable: true });
    expect(session.getStatus()).toBe('invalidated');
    await Promise.all([session.dispose(), session.dispose()]);
    expect(() => session.execute(turn('again'))).toThrow('OpenCode execution session is disposed');
  } finally { await session.dispose(); }
});
