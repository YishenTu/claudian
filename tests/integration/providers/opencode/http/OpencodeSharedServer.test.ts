import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFixture, turn, waitFor } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';

import { type ProviderExecutionEvent, type ProviderExecutionRequest } from '@/core/execution';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

it('prewarms concurrent tab-presence requests without creating native draft sessions', async () => {
  const f = await createFixture();
  try {
    await Promise.all([f.workspace.startRuntime?.(), f.workspace.startRuntime?.()]);
    expect(f.processes()).toHaveLength(1);
    const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    expect(await control.request('/fixture/sessions')).toMatchObject({ data: { ids: [] } });
    await control.dispose();
    await f.workspace.metadataService.loadCatalog();
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => undefined);
    expect(f.processes()).toHaveLength(1);
  } finally { await f.dispose(); }
});

it('retains a v2 conversation database binding when runtime settings move to another database', () => {
  const conversation: any = { providerId: 'opencode', sessionId: 'original', providerState: { sessionId: 'original', databasePath: '/original.db' } };
  const settings = { providerConfigs: { opencode: { enabled: true, environmentHash: 'old', environmentVariables: 'OPENCODE_DB=/replacement.db' } } };
  expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
  expect(opencodeSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);
  expect(conversation).toMatchObject({ sessionId: 'original', providerState: { databasePath: '/original.db' } });
});

it('coalesces command discovery and reads command changes from the retained server', async () => {
  const f = await createFixture();
  const load = () => f.workspace.commandLoader!.loadCommands({ plugin: f.plugin, conversation: null, allowIsolatedMetadataCreation: true, signal: new AbortController().signal });
  const discovery = new ProviderCommandDiscoveryStore(async () => {
    const result = await load();
    if (result.status !== 'ready' && result.status !== 'empty') return result;
    return normalizeProviderCommandDiscoveryItems(await f.workspace.commandCatalog.listDropdownEntries({ includeBuiltIns: false, commandSnapshot: result.status === 'ready' ? result.items : [] }));
  });
  const pickerConfig = f.workspace.commandCatalog.getDropdownConfig();
  const picker = new SlashCommandSource({ providerConfig: pickerConfig, providerDiscovery: discovery, includeBuiltIns: false });
  try {
    writeFileSync(f.log + '.commands', JSON.stringify([{ name: 'before' }]));
    const results = await Promise.all([discovery.load(), load()]);
    expect(results).toEqual([expect.objectContaining({ status: 'ready', items: [expect.objectContaining({ name: 'before' })] }), expect.objectContaining({ status: 'ready' })]);
    const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    expect(await control.request('/fixture/command-reads')).toEqual({ data: 1 });
    writeFileSync(f.log + '.commands', JSON.stringify([{ name: 'after' }]));
    expect(pickerConfig.refreshOnOpen).toBe(true);
    picker.onOpen();
    await Promise.resolve();
    expect(discovery.getSnapshot().status).toBe('loading');
    await Promise.resolve();
    expect(await discovery.load()).toMatchObject({ status: 'ready', items: [{ name: 'after' }] });
    expect(picker.load({ atInputStart: true, start: 0, end: 1, query: '', trigger: '/' }, new AbortController().signal).map(item => item.label)).toEqual(['/after']);
    expect(getOpencodeProviderSettings(f.plugin.settings).discoveredModels).toEqual([]);
    expect(f.processes()).toHaveLength(1);
    await control.dispose();
  } finally { picker.destroy(); discovery.invalidate(); await f.dispose(); }
});

it('shares discovery and independent chat sessions, retaining the server after one session closes', async () => {
  const f = await createFixture();
  const { createSession, workspace, log } = f;
  const a = createSession(), b = createSession();
  const collect = async (text: string) => { const events: ProviderExecutionEvent[] = []; for await (const event of b.execute(turn(text)).events) events.push(event); return events; };
  try {
    expect(await workspace.metadataService.loadCatalog()).toBe(true);
    const run = a.execute(turn('hold'));
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const consume = (async () => { for await (const event of run.events) if (event.type === 'text_delta') started(); })();
    await active;
    expect((await collect('beta')).at(-1)?.type).toBe('turn_completed');
    expect(await workspace.metadataService.loadCatalog()).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    run.cancel(); await consume; await a.dispose();
    expect((await collect('beta revised')).at(-1)?.type).toBe('turn_completed');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { await a.dispose(); await b.dispose(); await f.dispose(); }
}, 20000);

it('gives each conversation its own resolved system prompt and applies a change at its next turn', async () => {
  const f = await createFixture();
  const explicit = f.createSession(), defaults = f.createSession();
  const mainAgent = (text: string, instructions: string): ProviderExecutionRequest => ({ ...turn(text), configuration: { ...turn(text).configuration, systemInstructions: { kind: 'main-agent', instructions } } });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const native = async () => (await control.request<{ data: { sessions: Record<string, string | null>; agents: string[] } }>('/fixture/system')).data;
  const complete = async (session: typeof explicit, request: ProviderExecutionRequest) => {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute(request).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  };
  try {
    expect(await f.workspace.metadataService.loadCatalog()).toBe(true);
    await complete(explicit, turn('alpha'));
    await complete(defaults, mainAgent('beta', 'First project paragraph'));
    expect((await native()).sessions.ses_1).toBe('Instructions for alpha');
    expect((await native()).sessions.ses_2).toContain('First project paragraph');
    await complete(defaults, mainAgent('beta edited', 'Second project paragraph'));
    expect((await native()).sessions.ses_2).toContain('Second project paragraph');

    // A running turn keeps the prompt it started with.
    const run = defaults.execute(mainAgent('hold', 'Second project paragraph'));
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const consume = (async () => { for await (const event of run.events) if (event.type === 'text_delta') started(); })();
    await active;
    expect((await native()).sessions.ses_2).toContain('Second project paragraph');
    run.cancel(); await consume;

    await complete(defaults, mainAgent('beta again', 'Third project paragraph'));
    const after = await native();
    expect(after.sessions.ses_2).toContain('Third project paragraph');
    expect(after.sessions.ses_2).not.toContain('Second project paragraph');
    expect(after.sessions.ses_1).toBe('Instructions for alpha');
    // The replaced conversation agent is unregistered; only the two live conversations keep one each.
    expect(after.agents.filter(id => id.startsWith('build-'))).toHaveLength(2);

    // Repeating unchanged instructions reuses the native session and its registered agent.
    await complete(explicit, turn('alpha'));
    expect(await native()).toEqual(after);
    await complete(explicit, turn('alpha edited'));
    expect((await native()).sessions).toEqual({ ses_1: 'Instructions for alpha edited', ses_2: 'Third project paragraph' });

    // The caller-resolved text survives a profile change for both instruction kinds.
    for (const [session, next] of [[explicit, turn('alpha edited')], [defaults, mainAgent('beta readonly', 'Third project paragraph')]] as const) {
      await complete(session, { ...next, toolPolicy: { kind: 'read-only' } });
    }
    const readonly = await native();
    expect(readonly.sessions).toEqual({ ses_1: 'Instructions for alpha edited', ses_2: 'Third project paragraph' });
    expect(readonly.agents.filter(id => id.startsWith('claudian-inline-edit-'))).toHaveLength(2);
    expect(f.processes()).toHaveLength(1);
  } finally { await control.dispose(); await explicit.dispose(); await defaults.dispose(); await f.dispose(); }
}, 20000);

it('isolates different databases and gives each in-memory execution its own process', async () => {
  const f = await createFixture();
  try {
    const leases = await Promise.all([
      f.workspace.serverService.acquire(f.cli, f.root, f.environment),
      f.workspace.serverService.acquire(f.cli, f.root, { ...f.environment, OPENCODE_DB: path.join(f.root, 'other.db') }),
      ...[1, 2].map(() => f.workspace.serverService.acquire(f.cli, f.root, { ...f.environment, OPENCODE_DB: ':memory:' })),
    ]);
    await Promise.all(leases.map(lease => lease.request('/api/model')));
    expect(f.processes()).toHaveLength(4);
    expect(f.processes().filter(process => process.db === ':memory:')).toHaveLength(2);
    await Promise.all(leases.map(lease => lease.dispose()));
    for (const native of f.processes().filter(process => process.db === ':memory:')) expect(() => process.kill(native.pid, 0)).toThrow();
    for (const native of f.processes()) expect(() => process.kill(native.pid, 0)).toThrow();
    const persistent = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await persistent.request('/api/model');
    expect(f.processes()).toHaveLength(5);
    await persistent.dispose();
  } finally { await f.dispose(); }
});

it('dispatches global forms once and fans out stream failure before replacing the server', async () => {
  const f = await createFixture();
  const eventsA: string[] = [], eventsB: string[] = [], failures: string[] = [];
  try {
    const a = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const b = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    let failed!: () => void;
    const disconnected = new Promise<void>(resolve => { failed = resolve; });
    let reachedBarrier!: () => void;
    const eventsDrained = new Promise<void>(resolve => { reachedBarrier = resolve; });
    await a.subscribe(event => {
      eventsA.push(event.type);
      if (event.type === 'fixture.barrier') reachedBarrier();
    }, () => { failures.push('a'); }, () => true);
    await b.subscribe(event => eventsB.push(event.type), () => { failures.push('b'); failed(); }, () => true);
    const form = { type: 'form.created', data: { form: { id: 'form_owned', sessionID: 'global', metadata: { kind: 'mcp-elicitation' } } } };
    await a.request('/fixture/event', { method: 'POST', body: form });
    await a.request('/fixture/event', { method: 'POST', body: form });
    // A marker after both creates proves delivery completed while the form remains active.
    await a.request('/fixture/event', { method: 'POST', body: { type: 'fixture.barrier', data: {} } });
    await eventsDrained;
    expect(eventsA.filter(type => type === 'form.created')).toHaveLength(1);
    expect(eventsB.filter(type => type === 'form.created')).toHaveLength(0);
    await a.request('/fixture/disconnect', { method: 'POST' }).catch(() => undefined);
    await disconnected;
    expect(failures).toEqual(['a', 'b']);
    const [next, peer] = await Promise.all([1, 2].map(() => f.workspace.serverService.acquire(f.cli, f.root, f.environment)));
    await Promise.all([next.request('/api/model'), peer.request('/api/model')]);
    expect(f.processes()).toHaveLength(2);
    await Promise.all([a.dispose(), b.dispose(), next.dispose(), peer.dispose()]);
  } finally { await f.dispose(); }
});

it('keeps global forms and stream failures routed after the first subscriber closes', async () => {
  const f = await createFixture();
  try {
    const first = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const peer = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const firstEvent = vi.fn(), firstError = vi.fn();
    let receiveForm!: () => void, receiveError!: () => void;
    const receivedForm = new Promise<void>(resolve => { receiveForm = resolve; });
    const receivedError = new Promise<void>(resolve => { receiveError = resolve; });
    await first.subscribe(firstEvent, firstError, () => true);
    await peer.subscribe(event => {
      if (event.type === 'form.created') receiveForm();
    }, receiveError, () => true);
    await first.dispose();
    firstEvent.mockClear();
    await peer.request('/fixture/event', { method: 'POST', body: {
      type: 'form.created', data: { form: { id: 'form_owned', sessionID: 'global' } },
    } });
    await receivedForm;
    expect(firstEvent).not.toHaveBeenCalled();
    expect(f.processes()).toHaveLength(1);
    await peer.request('/fixture/disconnect', { method: 'POST' }).catch(() => undefined);
    await receivedError;
    expect(firstError).not.toHaveBeenCalled();
    await peer.dispose();
  } finally { await f.dispose(); }
});

it('releases a reader without reprocessing user config references', async () => {
  const f = await createFixture();
  try {
    const source = path.join(f.root, 'user.json'), prompt = path.join(f.root, 'instructions.md');
    writeFileSync(prompt, 'User instructions');
    writeFileSync(source, JSON.stringify({ agents: { user: { system: '{file:./instructions.md}' } } }));
    const environment = { ...f.environment, OPENCODE_CONFIG: source };
    const reader = await f.workspace.serverService.acquire(f.cli, f.root, environment);
    const peer = await f.workspace.serverService.acquire(f.cli, f.root, environment);
    const effective = await peer.request('/fixture/config');
    rmSync(prompt);
    await expect(reader.dispose()).resolves.toBeUndefined();
    expect(await peer.request('/fixture/config')).toEqual(effective);
    await peer.dispose();
  } finally { await f.dispose(); }
});

it('preserves explicit user config references and watches edits without overwriting the user file', async () => {
  const f = await createFixture();
  try {
    const source = path.join(f.root, 'user.json'), prompt = path.join(f.root, 'instructions.md');
    writeFileSync(prompt, 'User prompt with {env:LITERAL_TEXT}');
    const content = JSON.stringify({ plugins: [{ package: './plugin.ts', options: { unchanged: true } }], agent: { user: { prompt: '{file:./instructions.md}' } } });
    writeFileSync(source, content);
    const lease = await f.workspace.serverService.acquire(f.cli, f.root, { ...f.environment, OPENCODE_CONFIG: source });
    const effective = await lease.request<{ data: { config: any; path: string } }>('/fixture/config');
    expect(effective.data.path.startsWith(f.root + path.sep)).toBe(false);
    expect(effective.data.config.plugins[0]).toEqual({ package: pathToFileURL(path.join(f.root, 'plugin.ts')).href, options: { unchanged: true } });
    expect(effective.data.config.agent.user.prompt).toBe('User prompt with {env:LITERAL_TEXT}');
    expect(readFileSync(source, 'utf8')).toBe(content);
    const updated = JSON.stringify({ agent: { user: { prompt: 'Updated user instructions' } } });
    writeFileSync(source, updated);
    const deadline = Date.now() + 3000;
    let observed = '';
    do {
      const current = await lease.request<{ data: { config: any } }>('/fixture/config');
      observed = current.data.config.agent.user.prompt;
      if (observed === 'Updated user instructions') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    expect(observed).toBe('Updated user instructions');
    expect(readFileSync(source, 'utf8')).toBe(updated);
    expect(f.processes()).toHaveLength(1);
    await lease.dispose();
  } finally { await f.dispose(); }
});

it('recovers a global form created before any interactive chat subscribed', async () => {
  const f = await createFixture();
  try {
    const metadata = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await metadata.request('/fixture/event', { method: 'POST', body: { type: 'form.created', data: { form: { id: 'form_owned', sessionID: 'global' } } } });
    const chat = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const events: string[] = [];
    await chat.subscribe(event => events.push(event.type), () => undefined, () => true);
    await chat.refreshGlobalForms();
    await chat.refreshGlobalForms();
    expect(events.filter(type => type === 'form.created')).toHaveLength(1);
    await chat.dispose();
    expect(await metadata.request('/api/form')).toEqual({ data: [] });
    await metadata.dispose();
  } finally { await f.dispose(); }
});

it('rejects an acquisition when disposal overtakes its availability check', async () => {
  const f = await createFixture();
  try {
    const acquiring = f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await f.workspace.serverService.dispose();
    await expect(acquiring.then(() => undefined)).rejects.toThrow('disposed');
  } finally {
    await f.workspace.serverService.invalidate();
    await f.dispose();
  }
});

it.each([
  ['v1', [expect.stringContaining('OpenCode v1 is no longer supported')]],
  ['disabled', []],
  ['missing', []],
] as const)('does not prewarm a server for %s OpenCode', async (mode, rejections) => {
  const f = await createFixture(mode === 'v1' ? '1.18.31' : undefined);
  if (mode === 'disabled') updateOpencodeProviderSettings(f.plugin.settings, { enabled: false });
  if (mode === 'missing') f.plugin.getResolvedProviderCliPath = async () => path.join(f.root, 'missing-opencode');
  try {
    // An unsupported CLI rejects the prewarm; a disabled provider or missing CLI skips it.
    const outcome = await f.workspace.startRuntime?.().then(() => [], (error: Error) => [error.message]);
    expect(outcome).toEqual(rejections);
    expect(existsSync(f.log)).toBe(false);
  } finally { await f.dispose(); }
});

it('cancelling one coalesced command query leaves its peer and the retained server working', async () => {
  const f = await createFixture();
  const cancel = new AbortController();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  await control.request('/fixture/hold-commands', { method: 'POST' });
  const abandoned = f.workspace.metadataService.discoverCommands(cancel.signal);
  const peer = f.workspace.metadataService.discoverCommands(new AbortController().signal);
  try {
    const deadline = Date.now() + 3000;
    while ((await control.request<{ data: number }>('/fixture/command-reads')).data === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    expect(await control.request('/fixture/command-reads')).toEqual({ data: 1 });
    cancel.abort(new Error('Picker closed'));
    await Promise.all([
      expect(abandoned).rejects.toThrow('Picker closed'),
      control.request('/fixture/release-commands', { method: 'POST' }),
    ]);
    await expect(peer).resolves.toMatchObject({ loaded: true });
    expect(await control.request('/fixture/command-reads')).toEqual({ data: 1 });
    expect(f.processes()).toHaveLength(1);
  } finally {
    await control.request('/fixture/release-commands', { method: 'POST' }).catch(() => undefined);
    await control.dispose();
    await f.dispose();
  }
});

it('executes commands added after an existing session connected through the native command endpoint', async () => {
  const f = await createFixture();
  const session = f.createSession();
  const collect = async (text: string) => { const events: ProviderExecutionEvent[] = []; for await (const event of session.execute(turn(text)).events) events.push(event); return events; };
  try {
    await f.workspace.metadataService.loadCatalog();
    const request = turn('first');
    expect((await collect('first')).at(-1)?.type).toBe('turn_completed');
    writeFileSync(f.log + '.commands', JSON.stringify([{ name: 'added' }]));
    await f.workspace.metadataService.discoverCommands();
    const events: ProviderExecutionEvent[] = [];
    // Keep the same execution configuration so this turn uses the connected kernel.
    for await (const event of session.execute({ ...request, input: [{ type: 'text', text: '/added' }] }).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'Command: added' })]);
    expect(f.processes()).toHaveLength(1);
  } finally { await session.dispose(); await f.dispose(); }
});

it('loads a module plugin folder once per shared server and forwards the native caller to its port', async () => {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const list = vi.fn().mockResolvedValue({ sessions: [{ sessionId: 'target' }] });
  const send = vi.fn().mockResolvedValue({ sessionId: 'target', title: 'Review', provider: 'codex', status: 'queued' });
  const session = f.createSession({ sessionTools: { list, send, read: vi.fn() } });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const events: ProviderExecutionEvent[] = [];
  const run = (async () => { for await (const e of session.execute(turn('hold')).events) events.push(e); })();
  try {
    await waitFor(() => events.some(e => e.type === 'text_delta'));
    const { data } = await control.request<any>('/fixture/config');
    const configPath = data.path;
    expect(data.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/call$/);
    expect(data.routeId).toEqual(expect.any(String));
    const entry = data.config.plugins.find((p: any) => p.package.includes('/session-tools'));
    const dir = fileURLToPath(entry.package);
    expect(path.dirname(dir)).toBe(path.dirname(data.path));
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'module' });
    expect(existsSync(path.join(dir, 'index.js'))).toBe(true);
    const call = (sessionID: string) => control.request<any>('/fixture/session-tool', { method: 'POST', body: { tool: 'claudian_list_destinations', args: {}, sessionID } });
    expect((await call('ses_1')).data).toMatchObject({ specs: [
      { name: 'claudian_list_destinations', options: { codemode: false } },
      { name: 'claudian_send_message', options: { codemode: false } },
      { name: 'claudian_read_session', options: { codemode: false } },
    ], result: { output: '{"sessions":[{"sessionId":"target"}]}' } });
    expect(list).toHaveBeenCalledTimes(1);
    expect((await call('unknown')).data.isError).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    const aborted = await control.request<any>('/fixture/session-tool', { method: 'POST', body: { tool: 'claudian_list_destinations', args: {}, sessionID: 'ses_1', aborted: true } });
    expect(aborted.data.isError).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    const sent = await control.request<any>('/fixture/session-tool', { method: 'POST', body: { tool: 'claudian_send_message', args: { sessionId: 'target', text: 'Hello' }, sessionID: 'ses_1' } });
    expect(sent.data.result.output).toBe('{"sessionId":"target","title":"Review","provider":"codex","status":"queued"}');
    expect(send).toHaveBeenCalledWith({ sessionId: 'target', text: 'Hello' }, expect.any(AbortSignal));
    const peer = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await peer.dispose();
    expect(f.register).toHaveBeenCalledTimes(1);
    const signal = list.mock.calls[0][1] as AbortSignal;
    await session.dispose();
    await run;
    expect(signal.aborted).toBe(true);
    expect((await call('ses_1')).data.isError).toBe(true);
    await control.dispose();
    await f.workspace.dispose?.();
    expect(existsSync(path.dirname(configPath))).toBe(false);
    const response = await fetch(data.url, {method:'POST',headers:{'Content-Type':'application/json','X-Claudian-Route':data.routeId},body:JSON.stringify({tool:'claudian_list_destinations',args:{},callerNativeId:'ses_1'})});
    expect(response.status).toBe(404);
  } finally { await session.dispose(); await run; await control.dispose(); await f.dispose(); }
});
