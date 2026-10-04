import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest, type ProviderSessionConfig } from '@/core/execution';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { SideChatSession } from '@/features/chat/side-chat/SideChatSession';
import { createOpencodeWorkspaceServices } from '@/providers/opencode/app/OpencodeWorkspaceServices';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { forkOpencodeSession } from '@/providers/opencode/history/OpencodeSessionFork';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { buildOpencodeRuntimeEnv } from '@/providers/opencode/runtime/OpencodeRuntimeEnvironment';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

const fixture = `#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http');
if (process.argv.includes('--version')) {
 const ready = () => { fs.appendFileSync(process.env.PROCESS_LOG + '.version-count', 'x'); console.log('2.0.14'); };
 if (fs.existsSync(process.env.PROCESS_LOG + '.version-hold')) {
   fs.writeFileSync(process.env.PROCESS_LOG + '.version-started', '');
   const wait = setInterval(() => { if (!fs.existsSync(process.env.PROCESS_LOG + '.version-hold')) { clearInterval(wait); ready(); } }, 10);
 } else ready();
 return;
}
fs.appendFileSync(process.env.PROCESS_LOG, JSON.stringify({ pid: process.pid, db: process.env.OPENCODE_DB, generation: process.env.GENERATION }) + '\\n');
const feeds = new Set(), forms = new Map(); let sequence = 0, commandReads = 0;
const emit = (type, data) => { if(type==='form.created') forms.set(data.form.id,data.form); if(type==='form.cancelled'||type==='form.replied') forms.delete(data.id); for (const feed of feeds) feed.write('data: ' + JSON.stringify({ type, data }) + '\\n\\n'); };
const store = process.env.OPENCODE_DB + '.sessions.json';
const saved = process.env.OPENCODE_DB !== ':memory:' && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {sessions:[],deleted:[],sequence:0};
const sessions = new Map(saved.sessions), deleted = saved.deleted; sequence = saved.sequence; let held = null;
const save = () => { if (process.env.OPENCODE_DB !== ':memory:') fs.writeFileSync(store, JSON.stringify({sessions:[...sessions],deleted,sequence})); };
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
 if (route === '/api/model') return reply(process.env.OPENCODE_DB === ':memory:' ? [{ id:'free', providerID:'opencode', name:'Free', enabled:true, variants:[] }] : [{ id:'chat', providerID:'local', name:process.env.GENERATION || 'Chat ' + require('node:path').basename(process.env.OPENCODE_DB), enabled:true, variants:[] }]);
 if (route === '/api/form') return reply([...forms.values()]);
 if (route.startsWith('/api/experimental/session/') && route.endsWith('/wait')) return setTimeout(() => { res.writeHead(204).end(); }, 50);
 if (route === '/api/info') return reply({pid:process.pid});
 if (route === '/fixture/command-reads') return reply(commandReads);
 if (route === '/api/command') { commandReads++; return setTimeout(() => reply(fs.existsSync(process.env.PROCESS_LOG + '.commands') ? JSON.parse(fs.readFileSync(process.env.PROCESS_LOG + '.commands','utf8')) : []), 30); }
 if (route === '/api/agent') return reply(agents());
 if (route === '/fixture/sessions') return reply({ ids:[...sessions.keys()], held:held?.length ?? 0, deleted });
 if (route === '/fixture/hold-sessions') { held = []; res.writeHead(204).end(); return; }
 if (route === '/fixture/release-sessions') { const pending = held ?? []; held = null; for (const send of pending) send(); res.writeHead(204).end(); return; }
 if (route === '/api/session') { const id = 'ses_' + (++sequence); const session = {id, agent:body.agent}; sessions.set(id,session); save(); if (held) { held.push(() => reply(session)); return; } return reply(session); }
 const session = sessions.get(id);
 if (!session) { res.writeHead(404).end(); return; }
 if (parts.length === 4 && req.method === 'DELETE') { sessions.delete(id); deleted.push(id); save(); res.writeHead(204).end(); return; }
 if (parts.length === 4) return reply(session);
 if (parts[4] === 'fork') { const child={...session,id:'ses_'+(++sequence)}; sessions.set(child.id,child); save(); if (held) { held.push(() => reply(child)); return; } return reply(child); }
 if (parts[4] === 'message') { res.end(JSON.stringify({data:[{id:'msg_source',type:'assistant',content:[{type:'text',text:'Source reply'}]}],cursor:{}})); return; }
 if (parts[4] === 'agent') { session.agent=body.agent; res.writeHead(204).end(); return; }
 if (parts[4] === 'model') { session.model=body.model; save(); res.writeHead(204).end(); return; }
 if (parts[4] === 'interrupt') { emit('session.execution.interrupted',{sessionID:id}); res.writeHead(204).end(); return; }
 if (parts[4] === 'prompt' || parts[4] === 'command') {
  reply({id:'msg_user'});
  setTimeout(()=>{
   emit('session.execution.started',{sessionID:id});
   emit('session.text.delta',{sessionID:id,assistantMessageID:'msg_'+id,ordinal:0,delta:parts[4] === 'command' ? 'Command: ' + body.name : body.text});
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

async function createFixture(version = '2.0.14') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-shared-v2-')));
  const cli = path.join(root, 'opencode.cjs'), log = path.join(root, 'processes');
  writeFileSync(cli, fixture.replace("console.log('2.0.14')", `console.log('${version}')`), { mode: 0o700 });
  writeFileSync(path.join(root, 'native.db'), '');
  const plugin: any = {
    app: { vault: { adapter: { basePath: root } } },
    settings: { providerConfigs: { opencode: { enabled: true, cliPath: cli, visibleModels: ['local/chat'], environmentVariables: `OPENCODE_DB=${path.join(root, 'native.db')}\nPROCESS_LOG=${log}\nOPENCODE_CONFIG_CONTENT={}` } } },
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
  return { root, cli, log, plugin, workspace, backend, createSession,
    environment: buildOpencodeRuntimeEnv(plugin.settings, cli),
    processes: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; db: string; generation?: string }),
    async dispose() { await workspace.dispose?.(); rmSync(root, { recursive: true, force: true }); },
  };
}

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

it('retains the current server after launch changes while disabled and re-enabling', async () => {
  const f = await createFixture();
  const transition = (mutation: () => void) => f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => mutation());
  try {
    await f.workspace.startRuntime?.();
    await transition(() => { f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=second'; });
    await transition(() => { f.plugin.settings.providerConfigs.opencode.enabled = false; });
    await transition(() => { f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=third'; });
    await transition(() => { f.plugin.settings.providerConfigs.opencode.enabled = true; });
    const starts = f.processes().length;
    const pid = f.processes().at(-1)!.pid;
    await f.workspace.metadataService.loadCatalog();
    await f.workspace.metadataService.loadCommands();
    expect(f.processes()).toHaveLength(starts);
    expect(isAlive(pid)).toBe(true);
  } finally { await f.dispose(); }
});

it('keeps old native work through a launch transition, drains it, and resumes on the replacement', async () => {
  const f = await createFixture();
  const config: ProviderSessionConfig = { vaultWorkingDirectory: f.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} } };
  await f.workspace.metadataService.loadCatalog();
  const owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, config, 'chat');
  const events: ProviderExecutionEvent[] = [];
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const consume = (async () => { for await (const event of owned.session.execute(turn('hold')).events) { events.push(event); if (event.type === 'text_delta') started(); } })();
  let control;
  try {
    await active;
    control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const pid = f.processes()[0].pid;
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=replacement';
    });
    expect(owned.isCurrent()).toBe(true);
    expect(events.some(event => ['cancelled', 'execution_error', 'turn_completed'].includes(event.type))).toBe(false);
    await f.workspace.metadataService.loadCatalog();
    expect(f.processes()).toHaveLength(2);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await control.request('/fixture/event', { method: 'POST', body: { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } } });
    await consume;
    expect(events.at(-1)?.type).toBe('turn_completed');
    await control.dispose();
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isAlive(pid)).toBe(false);
    const resumed: ProviderExecutionEvent[] = [];
    for await (const event of owned.session.execute(turn('continue')).events) resumed.push(event);
    expect(resumed.at(-1)?.type).toBe('turn_completed');
    expect(f.processes()).toHaveLength(2);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { f.plugin.settings.providerConfigs.opencode.enabled = false; });
    expect(owned.isCurrent()).toBe(false);
    expect(f.processes().some(native => isAlive(native.pid))).toBe(false);
  } finally { await control?.dispose(); await owned.release(); await consume; await f.dispose(); }
}, 15000);

it('fences a new turn on a retained idle session until the settings transition commits', async () => {
  const f = await createFixture();
  const config: ProviderSessionConfig = { vaultWorkingDirectory: f.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} } };
  const owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, config, 'chat');
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const mutation = new Promise<void>(resolve => { entered = resolve; });
  let transition: Promise<void> | undefined, second: Promise<void> | undefined;
  const request = turn('stable instructions');
  try {
    await f.workspace.metadataService.loadCatalog();
    for await (const event of owned.session.execute(request).events) { void event; }
    const originalPid = f.processes()[0].pid;
    transition = f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=after commit';
      entered();
      await hold;
    });
    await mutation;
    const events: ProviderExecutionEvent[] = [];
    second = (async () => { for await (const event of owned.session.execute(request).events) events.push(event); })();
    await Promise.race([second, new Promise(resolve => setTimeout(resolve, 200))]);
    expect(events.filter(event => event.type === 'text_delta' || event.type === 'turn_completed')).toEqual([]);
    release();
    await transition;
    await second;
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(f.processes()).toHaveLength(2);
    expect(isAlive(originalPid)).toBe(false);
  } finally { release(); await transition; await owned.release(); await second; await f.dispose(); }
});

it('invalidates v1 sessions independently while a retired v2 generation remains owned', async () => {
  const f = await createFixture();
  const cliV1 = path.join(f.root, 'opencode-v1.cjs');
  writeFileSync(cliV1, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.2.27'); return; }
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.id === undefined) return;
 const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
   : request.method === 'session/new' ? {sessionId:'v1-session',models:{currentModelId:'local/chat',availableModels:[{modelId:'local/chat',name:'Chat'}]}}
   : request.method === 'session/prompt' ? {stopReason:'end_turn'} : {};
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});
`, { mode: 0o700 });
  let control, owned;
  try {
    control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await control.request('/api/info');
    await f.workspace.metadataService.loadCatalog();
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.getResolvedProviderCliPath = async () => cliV1;
      f.plugin.settings.providerConfigs.opencode.cliPath = cliV1;
    });
    owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, {
      vaultWorkingDirectory: f.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
      interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    } satisfies ProviderSessionConfig, 'chat');
    const events: ProviderExecutionEvent[] = [];
    for await (const event of owned.session.execute(turn('v1')).events) events.push(event);
    expect(events.filter(event => event.type === 'execution_error')).toEqual([]);
    expect(events.at(-1)?.type).toBe('turn_completed');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nV1_CHANGE=next';
    });
    expect(owned.isCurrent()).toBe(false);
    expect(owned.session.getStatus()).toBe('disposed');
    expect(isAlive(f.processes()[0].pid)).toBe(true);
  } finally { await owned?.release(); await control?.dispose(); await f.dispose(); }
});

it('retains a v2 conversation database binding when runtime settings move to another database', () => {
  const conversation: any = { providerId: 'opencode', sessionId: 'original', providerState: { sessionId: 'original', nativeVersion: 2, databasePath: '/original.db' } };
  const settings = { providerConfigs: { opencode: { enabled: true, environmentHash: 'old', environmentVariables: 'OPENCODE_DB=/replacement.db' } } };
  const result = opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);
  expect(result.changed).toBe(true);
  expect(result.invalidatedConversations).toEqual([]);
  expect(conversation).toMatchObject({ sessionId: 'original', providerState: { nativeVersion: 2, databasePath: '/original.db' } });
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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    const child = await forkOpencodeSession({ cliPath: f.cli, cwd: f.root, environment: f.environment, nativeVersion: 2, sourceSessionId: native.data.id, resolveServerService: async () => service });
    expect(child).not.toBe(native.data.id);
    expect(await lease.request(`/api/session/${child}`)).toMatchObject({ data: { id: child } });
    expect(f.processes()).toHaveLength(1);
    await lease.dispose();
  } finally { ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
});

it.each([false, true])('keeps history, model recovery and forks on the bound database after changing the default (missing file: %s)', async missing => {
  const f = await createFixture();
  let lease;
  try {
    lease = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const native = await lease.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
    await lease.request(`/api/session/${native.data.id}/model`, { method: 'POST', body: { model: { providerID: 'local', id: 'chat' } } });
    ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
    const history = opencodeProviderRegistration.historyService!;
    const conversation: any = { providerId: 'opencode', sessionId: native.data.id, messages: [], providerState: { nativeVersion: 2, databasePath: f.environment.OPENCODE_DB } };
    const nextDatabase = path.join(f.root, 'replacement.db');
    writeFileSync(nextDatabase, '');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.settings.providerConfigs.opencode.environmentVariables += `\nOPENCODE_DB=${nextDatabase}`;
      opencodeSettingsReconciler.reconcileModelWithEnvironment(f.plugin.settings, [conversation]);
    });
    if (missing) rmSync(f.environment.OPENCODE_DB!);
    const context = { settings: f.plugin.settings, environment: buildOpencodeRuntimeEnv(f.plugin.settings, f.cli), vaultPath: f.root };
    expect(await history.recoverConversationModelSelection!(conversation, f.root, context)).toBe('opencode:local/chat');
    const hydrated = await history.hydrateConversationHistory(conversation, f.root, context);
    expect(hydrated.providerState?.databasePath).toBe(f.environment.OPENCODE_DB);
    expect(hydrated.messages?.some(message => message.content === 'Source reply')).toBe(true);
    const child = await history.buildForkProviderState!(native.data.id, 'msg_source', conversation.providerState, f.root, context);
    expect(child.databasePath).toBe(f.environment.OPENCODE_DB);
    expect(child.sessionId).not.toBe(native.data.id);
    const reader = await f.workspace.serverService.acquire(f.cli, f.root, { ...context.environment, OPENCODE_DB: f.environment.OPENCODE_DB });
    try { expect(await reader.request(`/api/session/${child.sessionId}`)).toMatchObject({ data: { id: child.sessionId } }); }
    finally { await reader.dispose(); }
  } finally { await lease?.dispose(); ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
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

it('fences new acquisitions during provider transitions and drains the previous generation', async () => {
  const f = await createFixture();
  try {
    const old = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await old.request('/api/model');
    await f.workspace.serverService.beginTransition();
    await expect(old.request('/api/model')).resolves.toMatchObject({ data: expect.any(Array) });
    const controller = new AbortController();
    const waiting = f.workspace.serverService.acquire(f.cli, f.root, f.environment, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    const nextEnvironment = { ...f.environment, GENERATION: 'next' };
    f.workspace.serverService.reconcileLaunch(f.cli, f.root, nextEnvironment);
    f.workspace.serverService.endTransition();
    const next = await f.workspace.serverService.acquire(f.cli, f.root, nextEnvironment);
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


async function createSideFixture() {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const source = await control.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
  const sourceState = { nativeVersion: 2, sessionId: source.data.id, databasePath: f.environment.OPENCODE_DB };
  const capabilities = opencodeProviderRegistration.getConversationCapabilities?.(sourceState) ?? opencodeProviderRegistration.capabilities;
  const history = opencodeProviderRegistration.historyService;
  ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
  const side = new SideChatSession({
    providerId: 'opencode', ephemeral: capabilities.supportsEphemeralFork ?? capabilities.supportsEphemeralSessions,
    lifecycleRegistry: f.plugin.executionLifecycleRegistry, resolveBackend: () => f.backend,
    vaultWorkingDirectory: f.root,
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    buildChildResumeState: () => Promise.resolve(history.buildForkProviderState(source.data.id, 'msg_source', sourceState, f.root,
      { settings: f.plugin.settings, environment: f.environment, vaultPath: f.root }, { lifecycle: 'ephemeral' })),
  });
  return { ...f, control, side, sourceId: source.data.id,
    send: (text: string) => side.execute({ text, images: [], configuration: turn(text).configuration }),
    async dispose() { await side.dispose(); await control.dispose(); ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); },
  };
}

it('retains a v2 side fork across turns and connection replacement, then deletes only the child on discard', async () => {
  const f = await createSideFixture();
  try {
    expect(await f.send('first side turn')).toMatchObject({ status: 'completed' });
    const childId = f.side.providerSessionId!;
    expect(childId).not.toBe(f.sourceId);
    // Changed instructions replace the kernel, but must not delete the side session.
    expect(await f.send('second side turn')).toMatchObject({ status: 'completed' });
    expect(f.side.providerSessionId).toBe(childId);
    expect(await f.control.request(`/api/session/${childId}`)).toMatchObject({ data: { id: childId } });
    await f.side.dispose();
    await f.side.dispose();
    await expect(f.control.request(`/api/session/${childId}`)).rejects.toThrow('404');
    expect(await f.control.request(`/api/session/${f.sourceId}`)).toMatchObject({ data: { id: f.sourceId } });
    expect(await f.control.request('/fixture/sessions')).toMatchObject({ data: { ids: [f.sourceId], deleted: [childId] } });
  } finally { await f.dispose(); }
});

it('discards a v2 side fork whose native creation finishes after disposal starts', async () => {
  const f = await createSideFixture();
  try {
    await f.control.request('/fixture/hold-sessions', { method: 'POST' });
    const run = f.send('discard during fork');
    const deadline = Date.now() + 5000;
    while ((await f.control.request<{ data: { held: number } }>('/fixture/sessions')).data.held === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await f.control.request('/fixture/sessions')).toMatchObject({ data: { held: 1 } });
    const disposal = f.side.dispose();
    await f.control.request('/fixture/release-sessions', { method: 'POST' });
    await disposal;
    await run;
    expect(await f.control.request('/fixture/sessions')).toMatchObject({ data: { ids: [f.sourceId] } });
  } finally { await f.dispose(); }
});

it.each([false, true])('deletes the side child after a server disconnect (retry: %s)', async retry => {
  const f = await createSideFixture();
  let next: Awaited<ReturnType<typeof f.workspace.serverService.acquire>> | undefined;
  try {
    expect(await f.send('side before disconnect')).toMatchObject({ status: 'completed' });
    const childId = f.side.providerSessionId!;
    let disconnected!: () => void;
    const failed = new Promise<void>(resolve => { disconnected = resolve; });
    await f.control.subscribe(() => undefined, disconnected, () => false);
    await f.control.request('/fixture/disconnect', { method: 'POST' }).catch(() => undefined);
    await failed;
    const retried = retry ? await f.send('side after reconnect') : undefined;
    expect(retried?.status).toBe(retry ? 'completed' : undefined);
    await f.side.dispose();
    next = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    expect(await next.request('/fixture/sessions')).toMatchObject({ data: { ids: [f.sourceId], deleted: [childId] } });
  } finally { await next?.dispose(); await f.dispose(); }
});

it('initializes the provider-owned service for early history and reuses it for later tab startup and forks', async () => {
  const f = await createFixture();
  await f.workspace.dispose?.();
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.register('opencode', opencodeProviderRegistration.workspace!);
  f.plugin.storage = { getAdapter: () => ({}) };
  f.plugin.runProviderExecutionTransition = (ids: string[], mutation: any) => f.plugin.executionLifecycleRegistry.runTransition(ids, mutation);
  writeFileSync(f.environment.OPENCODE_DB! + '.sessions.json', JSON.stringify({ sessions: [['source', { id: 'source', model: { providerID: 'local', id: 'chat' } }]], deleted: [], sequence: 1 }));
  const context = {
    settings: f.plugin.settings, environment: { ...f.environment, PATH: process.env.PATH }, vaultPath: f.root,
    ensureWorkspace: () => ProviderWorkspaceRegistry.ensureInitialized(f.plugin, 'opencode', 'history'),
  };
  const conversation: any = { sessionId: 'source', messages: [], providerState: { nativeVersion: 2, databasePath: f.environment.OPENCODE_DB } };
  try {
    const history = opencodeProviderRegistration.historyService;
    expect(await history.recoverConversationModelSelection!(conversation, f.root, context)).toBe('opencode:local/chat');
    const workspace = ProviderWorkspaceRegistry.getIfInitialized('opencode');
    expect(workspace).not.toBeNull();
    await workspace?.startRuntime?.();
    expect(await history.buildForkProviderState!('source', 'msg_source', conversation.providerState, f.root, context)).toMatchObject({ sessionId: 'ses_2', databasePath: f.environment.OPENCODE_DB });
    expect(f.processes()).toHaveLength(1);
  } finally { await ProviderWorkspaceRegistry.disposeInitialized(); ProviderWorkspaceRegistry.clear(); await f.dispose(); }
});

it.each(['same instructions', 'changed instructions'])('keeps retired background work owned while the next turn uses the replacement: %s', async instructions => {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const session = f.createSession();
  const background: any[] = [];
  session.onEvent(event => background.push(event));
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const parent = (async () => { for await (const event of session.execute(turn('hold')).events) if (event.type === 'text_delta') started(); })();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const emit = (type: string, data: object) => control.request('/fixture/event', { method: 'POST', body: { type, data } });
  try {
    await active;
    const pid = f.processes()[0].pid;
    const identity = { sessionID: 'ses_1', assistantMessageID: 'parent', id: 'spawn' };
    await emit('session.tool.input.started', { ...identity, name: 'subagent' });
    await emit('session.tool.called', { ...identity, input: { run_in_background: true } });
    await emit('session.tool.progress', { ...identity, metadata: { sessionID: 'child' } });
    await emit('session.execution.succeeded', { sessionID: 'ses_1' });
    await parent;
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=background';
    });
    expect(session.getStatus()).toBe('executing');
    const nextRequest = turn(instructions === 'same instructions' ? 'hold' : 'replacement');
    const continued = (async () => {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({ ...nextRequest, input: [{ type: 'text', text: 'next' }] }).events) events.push(event);
      return events;
    })();
    await emit('session.text.ended', { sessionID: 'child', assistantMessageID: 'child-reply', ordinal: 0, text: 'Still working' });
    await emit('session.execution.succeeded', { sessionID: 'child' });
    expect((await continued).at(-1)?.type).toBe('turn_completed');
    expect(f.processes()).toHaveLength(2);
    await control.dispose();
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(background).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'background_turn_completed', reason: 'completed' }),
      expect.objectContaining({ type: 'async_subagent_completed', subagentId: 'child', result: 'Still working' }),
    ]));
    expect(isAlive(pid)).toBe(false);
  } finally { await control.dispose(); await session.dispose(); await parent; await f.dispose(); }
}, 10000);

it('cancelling a turn waiting on retired background work leaves that work draining', async () => {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const session = f.createSession();
  const background: any[] = [];
  session.onEvent(event => background.push(event));
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const parent = (async () => { for await (const event of session.execute(turn('hold')).events) if (event.type === 'text_delta') started(); })();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const emit = (type: string, data: object) => control.request('/fixture/event', { method: 'POST', body: { type, data } });
  try {
    await active;
    const pid = f.processes()[0].pid;
    const identity = { sessionID: 'ses_1', assistantMessageID: 'parent', id: 'spawn' };
    await emit('session.tool.input.started', { ...identity, name: 'subagent' });
    await emit('session.tool.called', { ...identity, input: { run_in_background: true } });
    await emit('session.tool.progress', { ...identity, metadata: { sessionID: 'child' } });
    await emit('session.execution.succeeded', { sessionID: 'ses_1' });
    await parent;
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=background';
    });
    const waiting = session.execute(turn('next'));
    const events: ProviderExecutionEvent[] = [];
    const consumed = (async () => { for await (const event of waiting.events) events.push(event); })();
    await new Promise(resolve => setTimeout(resolve, 50));
    waiting.cancel();
    await consumed;
    expect(events.at(-1)).toMatchObject({ type: 'cancelled', reason: 'cancelled' });
    expect(session.getStatus()).toBe('executing');
    await emit('session.text.ended', { sessionID: 'child', assistantMessageID: 'child-reply', ordinal: 0, text: 'Still working' });
    await emit('session.execution.succeeded', { sessionID: 'child' });
    await control.dispose();
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(background).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'async_subagent_completed', subagentId: 'child', result: 'Still working' }),
    ]));
    expect(background).not.toContainEqual(expect.objectContaining({ type: 'background_turn_completed', reason: 'provider-ended' }));
    expect(session.getStatus()).toBe('idle');
    expect(isAlive(pid)).toBe(false);
    expect(f.processes()).toHaveLength(1);
  } finally { await control.dispose(); await session.dispose(); await parent; await f.dispose(); }
}, 10000);

it.each([
  ['an environment change', 'Current catalog'],
  ['a default database change that keeps the bound server', 'Chat replacement.db'],
] as const)('does not republish superseded execution metadata after %s', async (_, currentLabel) => {
  const f = await createFixture();
  const session = f.createSession();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  let consume: Promise<void> | undefined;
  try {
    await f.workspace.metadataService.loadCatalog();
    await control.request('/fixture/hold-sessions', { method: 'POST' });
    consume = (async () => { for await (const event of session.execute(turn('late metadata')).events) { void event; } })();
    const deadline = Date.now() + 3000;
    const held = async () => (await control.request<{ data: { held: number } }>('/fixture/sessions')).data.held;
    while (!await held() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await held()).toBe(1);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      const config = f.plugin.settings.providerConfigs.opencode;
      config.environmentVariables = currentLabel === 'Current catalog'
        ? `${config.environmentVariables}\nGENERATION=${currentLabel}`
        : config.environmentVariables.replace(f.environment.OPENCODE_DB!, path.join(f.root, 'replacement.db'));
    });
    await f.workspace.metadataService.loadCatalog();
    const currentModels = getOpencodeProviderSettings(f.plugin.settings).discoveredModels;
    expect(currentModels[0].label).toContain(currentLabel);
    await control.request('/fixture/release-sessions', { method: 'POST' });
    await consume;
    expect(getOpencodeProviderSettings(f.plugin.settings).discoveredModels).toEqual(currentModels);
  } finally { await control.request('/fixture/release-sessions', { method: 'POST' }).catch(() => undefined); await session.dispose(); await consume; await control.dispose(); await f.dispose(); }
});

it('owns a late ephemeral creation response on its original generation across a settings transition', async () => {
  const f = await createFixture();
  const session = f.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const inventory = () => control.request<{ data: { ids: string[]; held: number; deleted: string[] } }>('/fixture/sessions').then(result => result.data);
  let consume: Promise<void> | undefined;
  try {
    await f.workspace.metadataService.loadCatalog();
    await control.request('/fixture/hold-sessions', { method: 'POST' });
    consume = (async () => { for await (const event of session.execute(turn('late')).events) { void event; } })();
    const deadline = Date.now() + 3000;
    while (!(await inventory()).held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await inventory()).held).toBe(1);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=late'; });
    const disposal = session.dispose();
    await control.request('/fixture/release-sessions', { method: 'POST' });
    await disposal;
    await consume;
    expect(await inventory()).toMatchObject({ ids: [], deleted: ['ses_1'] });
    expect(f.processes()).toHaveLength(1);
    const pid = f.processes()[0].pid;
    await control.dispose();
    expect(isAlive(pid)).toBe(false);
  } finally { await control.dispose(); await session.dispose(); await consume; await f.dispose(); }
}, 10000);


it.each(['v1', 'disabled'])('does not prewarm a server for %s OpenCode', async mode => {
  const f = await createFixture(mode === 'v1' ? '1.18.31' : undefined);
  if (mode === 'disabled') f.plugin.settings.providerConfigs.opencode.enabled = false;
  try {
    await f.workspace.startRuntime?.();
    expect(existsSync(f.log)).toBe(false);
  } finally { await f.dispose(); }
});

it('cancelling one coalesced command query leaves its peer and the retained server working', async () => {
  const f = await createFixture();
  const cancel = new AbortController();
  const abandoned = f.workspace.metadataService.discoverCommands(cancel.signal);
  const peer = f.workspace.metadataService.discoverCommands(new AbortController().signal);
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  try {
    const deadline = Date.now() + 3000;
    while ((await control.request<{ data: number }>('/fixture/command-reads')).data === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    cancel.abort(new Error('Picker closed'));
    await expect(abandoned).rejects.toThrow('Picker closed');
    await expect(peer).resolves.toMatchObject({ loaded: true });
    expect(await control.request('/fixture/command-reads')).toEqual({ data: 1 });
    expect(f.processes()).toHaveLength(1);
  } finally { await control.dispose(); await f.dispose(); }
});

it('disables without deadlocking cleanup for an ephemeral session whose original generation already drained', async () => {
  const f = await createFixture();
  await f.workspace.startRuntime?.();
  await f.workspace.metadataService.loadCatalog();
  const config: ProviderSessionConfig = { vaultWorkingDirectory: f.root, lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} } };
  const owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, config, 'chat');
  let disabling: Promise<void> | undefined;
  try {
    for await (const event of owned.session.execute(turn('auxiliary')).events) expect(event.type).not.toBe('execution_error');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=cleanup'; });
    const pid = f.processes()[0].pid;
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isAlive(pid)).toBe(false);
    let disabled = false;
    disabling = f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { f.plugin.settings.providerConfigs.opencode.enabled = false; }).then(() => { disabled = true; });
    const disableDeadline = Date.now() + 3000;
    while (!disabled && Date.now() < disableDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(disabled).toBe(true);
    expect(JSON.parse(readFileSync(f.environment.OPENCODE_DB! + '.sessions.json', 'utf8')).deleted).toEqual(['ses_1']);
    expect(f.processes().some(native => isAlive(native.pid))).toBe(false);
  } finally {
    // Release a broken implementation's gate so a failed regression does not leak a process.
    f.workspace.serverService.endTransition();
    await disabling;
    await owned.release();
    await f.dispose();
  }
}, 10000);


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


it('drains an execution launch captured before a transition even when version detection finishes afterward', async () => {
  const f = await createFixture();
  f.plugin.getResolvedProviderCliPath = async () => f.plugin.settings.providerConfigs.opencode.cliPath;
  const replacementCLI = path.join(f.root, 'replacement.cjs');
  writeFileSync(replacementCLI, fixture, { mode: 0o700 });
  const session = f.createSession();
  let run: Promise<ProviderExecutionEvent[]> | undefined;
  try {
    await f.workspace.metadataService.loadCatalog();
    writeFileSync(f.log + '.version-hold', '');
    run = (async () => { const events: ProviderExecutionEvent[] = []; for await (const event of session.execute(turn('late launch')).events) events.push(event); return events; })();
    const deadline = Date.now() + 3000;
    while (!existsSync(f.log + '.version-started') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(f.log + '.version-started')).toBe(true);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { f.plugin.settings.providerConfigs.opencode.cliPath = replacementCLI; });
    rmSync(f.log + '.version-hold');
    expect((await run).at(-1)?.type).toBe('turn_completed');
    const pid = f.processes().at(-1)!.pid;
    const drained = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < drained) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isAlive(pid)).toBe(false);
  } finally { rmSync(f.log + '.version-hold', { force: true }); await session.dispose(); await run; await f.dispose(); }
}, 10000);

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
}

it.each(['replace', 'disable'])('starts tab presence requested during a %s transition from the committed settings', async mode => {
  const f = await createFixture();
  const hold = f.log + '.version-hold';
  let startup: Promise<void> | undefined;
  const live = () => f.processes().filter(native => isAlive(native.pid)).map(native => native.generation ?? 'initial');
  try {
    await f.workspace.startRuntime?.();
    writeFileSync(hold, '');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      startup = f.workspace.startRuntime?.();
      // A startup that reads settings before the transition commits reaches version detection here.
      await waitFor(() => existsSync(f.log + '.version-started'), 300);
      if (mode === 'disable') f.plugin.settings.providerConfigs.opencode.enabled = false;
      else f.plugin.settings.providerConfigs.opencode.environmentVariables += '\nGENERATION=replacement';
      rmSync(hold);
    });
    await startup;
    const expected = mode === 'disable' ? [] : ['replacement'];
    await waitFor(() => JSON.stringify(live()) === JSON.stringify(expected));
    expect(live()).toEqual(expected);
  } finally { rmSync(hold, { force: true }); await startup?.catch(() => undefined); await f.dispose(); }
}, 10000);

it('keeps a bound database server and the new default prewarm when only the default database changes', async () => {
  const f = await createFixture();
  const oldDatabase = f.environment.OPENCODE_DB!;
  const nextDatabase = path.join(f.root, 'replacement.db');
  const live = (database: string) => f.processes().filter(native => native.db === database && isAlive(native.pid));
  let bound, resumed;
  try {
    await f.workspace.startRuntime?.();
    bound = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      const config = f.plugin.settings.providerConfigs.opencode;
      config.environmentVariables = config.environmentVariables.replace(oldDatabase, nextDatabase);
    });
    expect(live(nextDatabase)).toHaveLength(1);
    resumed = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await resumed.request('/api/info');
    expect({ old: live(oldDatabase).length, next: live(nextDatabase).length }).toEqual({ old: 1, next: 1 });
    await resumed.dispose();
    await bound.dispose();
    await waitFor(() => live(oldDatabase).length === 0);
    expect({ old: live(oldDatabase).length, next: live(nextDatabase).length }).toEqual({ old: 0, next: 1 });
  } finally { await resumed?.dispose(); await bound?.dispose(); await f.dispose(); }
});

it.each([
  ['an unknown stored version', undefined, true],
  ['a stored v1 version', 1, true],
  ['an uninitialized workspace', 2, false],
] as const)('forks %s on a v2 runtime with one version probe and one native process', async (_, nativeVersion, initialized) => {
  const f = await createFixture();
  writeFileSync(f.environment.OPENCODE_DB! + '.sessions.json', JSON.stringify({ sessions: [['source', { id: 'source' }]], deleted: [], sequence: 1 }));
  const probes = () => existsSync(f.log + '.version-count') ? readFileSync(f.log + '.version-count', 'utf8').length : 0;
  ProviderWorkspaceRegistry.clear();
  try {
    if (initialized) {
      ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
      await f.workspace.startRuntime?.();
    }
    const before = probes();
    const context = { settings: f.plugin.settings, environment: f.environment, vaultPath: f.root };
    const state = { ...(nativeVersion ? { nativeVersion } : {}), databasePath: f.environment.OPENCODE_DB };
    expect(await opencodeProviderRegistration.historyService.buildForkProviderState!('source', 'msg_source', state, f.root, context))
      .toMatchObject({ sessionId: 'ses_2', nativeVersion: 2, databasePath: f.environment.OPENCODE_DB });
    expect({ probes: probes() - before, processes: f.processes().length }).toEqual({ probes: 1, processes: 1 });
  } finally { ProviderWorkspaceRegistry.clear(); await f.dispose(); }
});
