import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { ProviderExecutionRequest, ProviderSessionConfig } from '@/core/execution';
import { findNodeExecutable, getEnhancedPath } from '@/core/process/env';
import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type * as ProcessProbe from '@/core/process/ProcessProbe';
import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { SideChatSession } from '@/features/chat/side-chat/SideChatSession';
import { createOpencodeWorkspaceServices } from '@/providers/opencode/app/OpencodeWorkspaceServices';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { buildOpencodeRuntimeEnv } from '@/providers/opencode/runtime/OpencodeRuntimeEnvironment';

// Spawning the fake server is slow on Windows CI runners.
vi.setConfig({ testTimeout: 45_000 });

// A cold Windows runner can exceed the product's 5-second version probe deadline even after the
// warmup below. This suite is not about that deadline, so give probes a budget under the test timeout.
vi.mock('@/core/process/ProcessProbe', async () => {
  const actual: typeof ProcessProbe = (await vi.importActual<typeof import('@/core/process/ProcessProbe')>('@/core/process/ProcessProbe'));
  return { ...actual, runProcessProbe: (options: ManagedStdioProcessOptions) => actual.runProcessProbe(options, 30_000) };
});

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
const feeds = new Set(), forms = new Map(); let sequence = 0, commandReads = 0, heldCommands = null;
const emit = (type, data) => { if(type==='form.created') forms.set(data.form.id,data.form); if(type==='form.cancelled'||type==='form.replied') forms.delete(data.id); for (const feed of feeds) feed.write('data: ' + JSON.stringify({ type, data }) + '\\n\\n'); };
const store = process.env.OPENCODE_DB + '.sessions.json';
const saved = process.env.OPENCODE_DB !== ':memory:' && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {sessions:[],deleted:[],sequence:0};
const sessions = new Map(saved.sessions), deleted = saved.deleted; sequence = saved.sequence; let held = null;
const save = () => { if (process.env.OPENCODE_DB !== ':memory:') fs.writeFileSync(store, JSON.stringify({sessions:[...sessions],deleted,sequence})); };
const config = () => { const a=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8')), b=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); return {...a,...b,plugins:[...(a.plugins||[]),...(b.plugins||[])],agent:{...a.agent,...b.agent},agents:{...a.agents,...b.agents}}; };
const agents = () => { const c = config(); return Object.entries(c.agent || {}).map(([id, a]) => ({id, system:a.prompt})).concat(Object.entries(c.agents || {}).map(([id,a]) => ({id,...a}))).filter(a => !a.disabled && !c.agents?.[a.id]?.disabled); };
const server = http.createServer(async (req, res) => {
 let raw = ''; for await (const c of req) raw += c;
 const body = raw ? JSON.parse(raw) : {}, route = new URL(req.url, 'http://localhost').pathname;
 const parts = route.split('/'), id = parts[3];
 res.setHeader('Content-Type', 'application/json');
 const reply = data => res.end(JSON.stringify({data}));
 if (route === '/api/event') { feeds.add(res); res.on('close',()=>feeds.delete(res)); res.setHeader('Content-Type','text/event-stream'); res.write('data: ' + JSON.stringify({type:'server.connected',data:{}}) + '\\n\\n'); return; }
 if (route === '/fixture/config') return reply({ config:config(), path:process.env.OPENCODE_CONFIG, url:process.env.CLAUDIAN_SESSION_TOOLS_URL, routeId:process.env.CLAUDIAN_SESSION_TOOLS_ROUTE_ID });
 if (route === '/fixture/session-tool') {
   const entry = config().plugins?.find(p => p.package?.includes('/session-tools'));
   if (!entry) return reply({isError:true,text:'missing plugin'});
   const plugin = await import(entry.package + '/index.js');
   const tools = [], controller = new AbortController();
   if (body.aborted) controller.abort();
   await plugin.default.setup({tool:{transform:async f=>f({add:d=>tools.push(d)})}});
   try { return reply({specs:tools.map(t=>({name:t.name,options:t.options})), result:await tools.find(t=>t.name===body.tool).execute(body.args,{sessionID:body.sessionID,signal:controller.signal})}); }
   catch(error) { return reply({isError:true,text:error.message}); }
 }
 if (route === '/fixture/event') { emit(body.type, body.data); res.writeHead(204).end(); return; }
 if (route === '/fixture/disconnect') { for(const f of feeds) f.end(); res.writeHead(204).end(); return; }
 if (route === '/api/session/global/form/form_owned' && req.method==='DELETE') { emit('form.cancelled',{sessionID:'global',id:'form_owned'}); res.writeHead(204).end(); return; }
 // Saved provider credentials live in the native database.
 if (route === '/api/model') return reply(process.env.OPENCODE_DB === ':memory:' ? [{ id:'free', providerID:'opencode', name:'Free', enabled:true, variants:[] }] : [{ id:'chat', providerID:'local', name:process.env.GENERATION || 'Chat ' + require('node:path').basename(process.env.OPENCODE_DB), enabled:true, variants:[] }]);
 if (route === '/api/form') return reply([...forms.values()]);
 if (route.startsWith('/api/experimental/session/') && route.endsWith('/wait')) return setTimeout(() => { res.writeHead(204).end(); }, 50);
 if (route === '/api/info') return reply({pid:process.pid});
 if (route === '/fixture/command-reads') return reply(commandReads);
 if (route === '/fixture/hold-commands') { heldCommands = []; res.writeHead(204).end(); return; }
 if (route === '/fixture/release-commands') { const pending = heldCommands ?? []; heldCommands = null; for (const send of pending) send(); res.writeHead(204).end(); return; }
 if (route === '/api/command') { commandReads++; const send = () => reply(fs.existsSync(process.env.PROCESS_LOG + '.commands') ? JSON.parse(fs.readFileSync(process.env.PROCESS_LOG + '.commands','utf8')) : [{ name: 'init' }]); if (heldCommands) heldCommands.push(send); else send(); return; }
 if (route === '/api/agent') return reply(agents());
 if (route === '/fixture/sessions') return reply({ ids:[...sessions.keys()], held:held?.length ?? 0, deleted });
 if (route === '/fixture/system') return reply({ sessions:Object.fromEntries([...sessions].map(([id,s]) => [id, agents().find(a => a.id === s.agent)?.system ?? null])), agents:agents().map(a => a.id) });
 if (route === '/fixture/hold-sessions') { held = []; res.writeHead(204).end(); return; }
 if (route === '/fixture/release-sessions') { const pending = held ?? []; held = null; for (const send of pending) send(); res.writeHead(204).end(); return; }
 if (route === '/api/session') { const id = 'ses_' + (++sequence); const session = {id, agent:body.agent}; sessions.set(id,session); save(); if (held) { held.push(() => reply(session)); return; } return reply(session); }
 const session = sessions.get(id);
 if (!session) { res.writeHead(404).end(); return; }
 if (parts.length === 4 && req.method === 'DELETE') { sessions.delete(id); deleted.push(id); save(); res.writeHead(204).end(); return; }
 if (parts.length === 4) return reply(session);
 // A native fork copies the source's stored context into an independent child.
 if (parts[4] === 'fork') { const child={...session,id:'ses_'+(++sequence),context:[...(session.context||[])]}; sessions.set(child.id,child); save(); if (held) { held.push(() => reply(child)); return; } return reply(child); }
 if (parts[4] === 'message') { res.end(JSON.stringify({data:[{id:'msg_source',type:'assistant',content:[{type:'text',text:'Source reply'}]}],cursor:{}})); return; }
 if (parts[4] === 'agent') { session.agent=body.agent; res.writeHead(204).end(); return; }
 if (parts[4] === 'model') { session.model=body.model; save(); res.writeHead(204).end(); return; }
 if (parts[4] === 'interrupt') { emit('session.execution.interrupted',{sessionID:id}); res.writeHead(204).end(); return; }
 if (parts[4] === 'prompt' || parts[4] === 'command') {
  if (parts[4] === 'prompt') {
   // Record the native context each prompt sees before the turn joins it.
   const context = session.context = session.context || [];
   fs.appendFileSync(process.env.PROCESS_LOG + '.prompts', JSON.stringify({sessionID:id,context:[...context],text:body.text}) + '\\n');
   context.push(body.text, 'Reply to ' + body.text); save();
  }
  reply({id:'msg_user'});
  setImmediate(()=>{
   emit('session.execution.started',{sessionID:id});
   emit('session.text.delta',{sessionID:id,assistantMessageID:'msg_'+id,ordinal:0,delta:parts[4] === 'command' ? 'Command: ' + body.name : body.text});
   if(body.text !== 'hold') emit('session.execution.succeeded',{sessionID:id});
  }); return;
 }
 res.writeHead(404).end();
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));
process.stdin.resume(); process.stdin.on('end',()=>{ for(const f of feeds) f.end(); server.close(); });
`;

// On a cold Windows runner the first Node launch alone can take seconds, so pay that cost once here,
// without a deadline, before any test probes or starts the CLI.
beforeAll(() => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-shared-v2-warmup-')));
  try {
    const cli = path.join(root, 'opencode.cjs');
    writeFileSync(cli, fixture, { mode: 0o700 });
    const node = findNodeExecutable(getEnhancedPath(process.env.PATH, cli));
    if (node) execFileSync(node, [cli, '--version'], { env: { ...process.env, PROCESS_LOG: path.join(root, 'processes') }, stdio: 'ignore' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
  const hostFixture = await createProviderHostFixture({
    settings: { providerConfigs: { opencode: { enabled: true, cliPath: cli, visibleModels: ['local/chat'], environmentVariables: `OPENCODE_DB=${path.join(root, 'native.db')}\nPROCESS_LOG=${log}\nOPENCODE_CONFIG_CONTENT={}` } } },
    overrides: { workingDirectory: root, getResolvedProviderCliPath: async () => cli },
  });
  const plugin = hostFixture.host;
  const register = vi.spyOn(plugin.sessionToolEndpoint, 'registerCallRoute');
  const runtimeHost = plugin.getRuntimeHost('opencode');
  const workspace = await createOpencodeWorkspaceServices(plugin);
  const backend = new OpencodeExecutionBackend(runtimeHost, workspace);
  const createSession = (config: Partial<ProviderSessionConfig> = {}) => backend.createSession({
    workingDirectory: root, lifecycle: 'persistent', nativePersistence: 'provider-default', ...config,
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
  });
  return { root, cli, log, plugin, workspace, backend, createSession, register,
    environment: buildOpencodeRuntimeEnv(runtimeHost.environmentText, cli),
    processes: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; db: string; generation?: string }) : [],
    async dispose() { await workspace.dispose?.(); await hostFixture.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function createSideFixture() {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const source = await control.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
  const sourceState = { sessionId: source.data.id, databasePath: f.environment.OPENCODE_DB };
  const capabilities = opencodeProviderRegistration.capabilities;
  const history = opencodeProviderRegistration.historyService;
  ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
  const side = new SideChatSession({
    providerId: 'opencode', ephemeral: capabilities.supportsEphemeralFork ?? capabilities.supportsEphemeralSessions,
    lifecycleRegistry: f.plugin.executionLifecycleRegistry, resolveBackend: () => f.backend,
    workingDirectory: f.root,
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    buildChildResumeState: () => Promise.resolve(history.buildForkProviderState(source.data.id, 'msg_source', sourceState, f.root,
      { ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: f.environment, vaultPath: f.root }, { lifecycle: 'ephemeral' })),
  });
  return { ...f, control, side, sourceId: source.data.id,
    send: (text: string) => side.execute({ text, images: [], configuration: turn(text).configuration }),
    async dispose() { await side.dispose(); await control.dispose(); ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); },
  };
}

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
}

export { createFixture, createSideFixture, fixture, isAlive, turn, waitFor };
