import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest, type ProviderSessionConfig } from '@/core/execution';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { createOpencodeWorkspaceServices } from '@/providers/opencode/app/OpencodeWorkspaceServices';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { forkOpencodeSession } from '@/providers/opencode/history/OpencodeSessionFork';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { buildOpencodeRuntimeEnv } from '@/providers/opencode/runtime/OpencodeRuntimeEnvironment';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

const fixture = `#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http');
if (process.argv.includes('--version')) { console.log('2.0.14'); return; }
fs.appendFileSync(process.env.PROCESS_LOG, JSON.stringify({ pid: process.pid, db: process.env.OPENCODE_DB }) + '\\n');
const feeds = new Set(), forms = new Map(); let sequence = 0;
const emit = (type, data) => { if(type==='form.created') forms.set(data.form.id,data.form); if(type==='form.cancelled'||type==='form.replied') forms.delete(data.id); for (const feed of feeds) feed.write('data: ' + JSON.stringify({ type, data }) + '\\n\\n'); };
const sessions = new Map(); let held = null;
const config = () => { const a=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8')), b=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); return {...a,...b,agent:{...a.agent,...b.agent},agents:{...a.agents,...b.agents}}; };
const agents = () => { const c = config(); return Object.entries(c.agent || {}).map(([id, a]) => ({id, system:a.prompt})).concat(Object.entries(c.agents || {}).map(([id,a]) => ({id,...a}))).filter(a => !a.disabled && !c.agents?.[a.id]?.disabled); };
const server = http.createServer(async (req, res) => {
 let raw = ''; for await (const c of req) raw += c;
 const body = raw ? JSON.parse(raw) : {}, route = new URL(req.url, 'http://localhost').pathname;
 const parts = route.split('/'), id = parts[3];
 res.setHeader('Content-Type', 'application/json');
 const reply = data => res.end(JSON.stringify({data}));
 if (route === '/api/event') { feeds.add(res); res.on('close',()=>feeds.delete(res)); res.setHeader('Content-Type','text/event-stream'); res.write('data: ' + JSON.stringify({type:'server.connected',data:{}}) + '\\n\\n'); return; }
 if (route === '/fixture/config') return reply({ config:config(), path:process.env.OPENCODE_CONFIG });
 if (route === '/fixture/event') { emit(body.type, body.data); res.writeHead(204).end(); return; }
 if (route === '/fixture/disconnect') { for(const f of feeds) f.end(); res.writeHead(204).end(); return; }
 if (route === '/api/session/global/form/form_owned' && req.method==='DELETE') { emit('form.cancelled',{sessionID:'global',id:'form_owned'}); res.writeHead(204).end(); return; }
 // Saved provider credentials live in the native database.
 if (route === '/api/model') return reply(process.env.OPENCODE_DB === ':memory:' ? [{ id:'free', providerID:'opencode', name:'Free', enabled:true, variants:[] }] : [{ id:'chat', providerID:'local', name:'Chat', enabled:true, variants:[] }]);
 if (route === '/api/form') return reply([...forms.values()]);
 if (route === '/api/command') return reply([]);
 if (route === '/api/agent') return reply(agents());
 if (route === '/fixture/sessions') return reply({ ids:[...sessions.keys()], held:held?.length ?? 0 });
 if (route === '/fixture/hold-sessions') { held = []; res.writeHead(204).end(); return; }
 if (route === '/fixture/release-sessions') { const pending = held ?? []; held = null; for (const send of pending) send(); res.writeHead(204).end(); return; }
 if (route === '/api/session') { const id = 'ses_' + (++sequence); const session = {id, agent:body.agent}; sessions.set(id,session); if (held) { held.push(() => reply(session)); return; } return reply(session); }
 const session = sessions.get(id);
 if (!session) { res.writeHead(404).end(); return; }
 if (parts.length === 4 && req.method === 'DELETE') { sessions.delete(id); res.writeHead(204).end(); return; }
 if (parts.length === 4) return reply(session);
 if (parts[4] === 'fork') { const child={...session,id:'ses_'+(++sequence)}; sessions.set(child.id,child); return reply(child); }
 if (parts[4] === 'message') { res.end(JSON.stringify({data:[],cursor:{}})); return; }
 if (parts[4] === 'agent') { session.agent=body.agent; res.writeHead(204).end(); return; }
 if (parts[4] === 'model') { session.model=body.model; res.writeHead(204).end(); return; }
 if (parts[4] === 'interrupt') { emit('session.execution.interrupted',{sessionID:id}); res.writeHead(204).end(); return; }
 if (parts[4] === 'prompt') {
  reply({id:'msg_user'});
  setTimeout(()=>{
   emit('session.execution.started',{sessionID:id});
   emit('session.text.delta',{sessionID:id,assistantMessageID:'msg_'+id,ordinal:0,delta:body.text});
   if(body.text !== 'hold') emit('session.execution.succeeded',{sessionID:id});
  },10); return;
 }
 res.writeHead(404).end();
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));
process.stdin.resume(); process.stdin.on('end',()=>{ for(const f of feeds) f.end(); server.close(); });
`;

const turn = (text: string): ProviderExecutionRequest => ({
  input: [{ type: 'text', text }],
  configuration: { model: 'opencode:local/chat', permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: `Instructions for ${text}` } },
  toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
});

async function createFixture(disableBuild = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-shared-v2-')));
  const cli = path.join(root, 'opencode.cjs'), log = path.join(root, 'processes');
  writeFileSync(cli, fixture, { mode: 0o700 });
  const plugin: any = {
    app: { vault: { adapter: { basePath: root } } },
    settings: { providerConfigs: { opencode: { enabled: true, cliPath: cli, visibleModels: ['local/chat'], environmentVariables: `OPENCODE_DB=${path.join(root, 'native.db')}\nPROCESS_LOG=${log}\nOPENCODE_CONFIG_CONTENT=${JSON.stringify(disableBuild ? { agents: { build: { disabled: true } } } : {})}` } } },
    executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
    getResolvedProviderCliPath: async () => cli,
    mutateSettings: async (fn: (settings: any) => void) => fn(plugin.settings),
    mutateSettingsConditionally: async (fn: (settings: any) => boolean) => fn(plugin.settings),
    notifyProviderChatOptionsChanged() {},
  };
  const workspace = await createOpencodeWorkspaceServices(plugin);
  const backend = new OpencodeExecutionBackend(plugin, workspace);
  const createSession = (config: Partial<ProviderSessionConfig> = {}) => backend.createSession({
    vaultWorkingDirectory: root, lifecycle: 'persistent', nativePersistence: 'provider-default', ...config,
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
  });
  return { root, cli, log, plugin, workspace, createSession,
    environment: buildOpencodeRuntimeEnv(plugin.settings, cli),
    processes: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; db: string }),
    async dispose() { await workspace.dispose?.(); rmSync(root, { recursive: true, force: true }); },
  };
}

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


it('runs auxiliary sessions with saved credentials without persisting them or replacing the catalog', async () => {
  const f = await createFixture();
  const session = f.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  try {
    expect(await f.workspace.metadataService.loadCatalog()).toBe(true);
    const request = turn('title');
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute({ ...request, toolPolicy: { kind: 'passive' } }).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(getOpencodeProviderSettings(f.plugin.settings).discoveredModels.map(model => model.rawId)).toEqual(['local/chat']);
    expect(f.processes().map(process => process.db)).toEqual([f.environment.OPENCODE_DB]);
    await session.dispose();
    const lease = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await expect(lease.request('/api/session/ses_1')).rejects.toThrow('404');
    await lease.dispose();
  } finally { await session.dispose(); await f.dispose(); }
}, 15000);

it('deletes an auxiliary session whose creation was still pending during disposal', async () => {
  const f = await createFixture();
  const session = f.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const sessions = () => control.request<{ data: { ids: string[]; held: number } }>('/fixture/sessions').then(result => result.data);
  try {
    expect(await f.workspace.metadataService.loadCatalog()).toBe(true);
    await control.request('/fixture/hold-sessions', { method: 'POST' });
    const request = turn('title');
    const run = session.execute({ ...request, toolPolicy: { kind: 'passive' } });
    const consume = (async () => { const events: ProviderExecutionEvent[] = []; for await (const event of run.events) events.push(event); })();
    const deadline = Date.now() + 5000;
    while ((await sessions()).held === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await sessions()).held).toBe(1);
    const disposal = session.dispose();
    await new Promise(resolve => setTimeout(resolve, 50));
    await control.request('/fixture/release-sessions', { method: 'POST' });
    await disposal;
    await consume;
    expect((await sessions()).ids).toEqual([]);
  } finally { await control.dispose(); await session.dispose(); await f.dispose(); }
}, 15000);

it('shares native history and fork operations with catalog and chat transport', async () => {
  const f = await createFixture();
  const service = f.workspace.serverService;
  try {
    await f.workspace.metadataService.loadCatalog();
    const lease = await service.acquire(f.cli, f.root, f.environment);
    const native = await lease.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
    await lease.request(`/api/session/${native.data.id}/model`, { method: 'POST', body: { model: { providerID: 'local', id: 'chat' } } });
    ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
    const history = opencodeProviderRegistration.historyService!;
    const conversation: any = { sessionId: native.data.id, messages: [], providerState: { nativeVersion: 2, databasePath: f.environment.OPENCODE_DB } };
    expect(await history.recoverConversationModelSelection!(conversation, f.root, { settings: f.plugin.settings, environment: { ...f.environment, PATH: process.env.PATH }, vaultPath: f.root })).toBe('opencode:local/chat');
    const child = await forkOpencodeSession({ cliPath: f.cli, cwd: f.root, environment: f.environment, nativeVersion: 2, sourceSessionId: native.data.id, serverService: service });
    expect(child).not.toBe(native.data.id);
    expect(await lease.request(`/api/session/${child}`)).toMatchObject({ data: { id: child } });
    expect(f.processes()).toHaveLength(1);
    await lease.dispose();
  } finally { ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
});

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
    await a.subscribe(event => eventsA.push(event.type), () => { failures.push('a'); }, () => true);
    await b.subscribe(event => eventsB.push(event.type), () => { failures.push('b'); failed(); }, () => true);
    const form = { type: 'form.created', data: { form: { id: 'form_owned', sessionID: 'global', metadata: { kind: 'mcp-elicitation' } } } };
    await a.request('/fixture/event', { method: 'POST', body: form });
    await a.request('/fixture/event', { method: 'POST', body: form });
    await new Promise(resolve => setTimeout(resolve, 20));
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

it('fences new acquisitions during provider transitions and shuts down the previous generation', async () => {
  const f = await createFixture();
  try {
    const old = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await old.request('/api/model');
    await f.workspace.serverService.beginTransition();
    await expect(old.request('/api/model')).rejects.toThrow();
    const controller = new AbortController();
    const waiting = f.workspace.serverService.acquire(f.cli, f.root, f.environment, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    f.workspace.serverService.endTransition();
    const next = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await next.request('/api/model');
    expect(f.processes()).toHaveLength(2);
    await old.dispose(); await next.dispose();
  } finally { await f.dispose(); }
});

it('keeps global forms and stream failures routed after the first subscriber closes', async () => {
  const f = await createFixture();
  try {
    const first = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const peer = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const firstEvent = jest.fn(), firstError = jest.fn();
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
    expect(effective.data.config.plugins[0]).toEqual({ package: new URL(`file://${path.join(f.root, 'plugin.ts')}`).href, options: { unchanged: true } });
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


it('runs safe and yolo chat when the unused native build agent is disabled', async () => {
  const f = await createFixture(true);
  const session = f.createSession();
  try {
    await expect(f.workspace.modelCatalog!.refresh()).resolves.toEqual({ changed: true });
    for (const permissionMode of ['normal', 'yolo'] as const) {
      const request = turn(permissionMode);
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({ ...request, configuration: { ...request.configuration, permissionMode } }).events) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', text: permissionMode })]));
    }
    expect(f.processes()).toHaveLength(1);
  } finally { await session.dispose(); await f.dispose(); }
}, 15000);
