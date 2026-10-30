#!/usr/bin/env node
/* global process, URL */
// Fixture native Host: real Linux Node, launch files, authenticated HTTP/WebSocket and sessions plugin.
// It does not emulate dsh's authenticated model providers or qualify its ephemeral persistence seams.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('--version')) { process.stdout.write('dsh 0.0.0-fixture\n'); process.exit(0); }
const require = createRequire(process.env.DSH_FIXTURE_PACKAGE);
const { WebSocketServer } = require('ws');
const args = process.argv.slice(2);
const patchPath = args[args.indexOf('--patch') + 1];
const patch = JSON.parse(readFileSync(patchPath, 'utf8'));
const rows = patch.flatMap(row => row.insert ?? []);
const preset = rows.find(row => row.config?.id === 'claudian');
const compatibility = preset.config.plugins.find(row => row.id === 'claudian-compatibility');
const sessions = preset.config.plugins.find(row => row.id === 'claudian-sessions');
const ephemeral = rows.find(row => row.id === 'claudian-ephemeral');
const lifecycle = rows.find(row => row.id === 'claudian-lifecycle');
await import(pathToFileURL(ephemeral.name).href);
// Exercise Linux access to all generated ephemeral paths without claiming native guard semantics.
readFileSync(ephemeral.config.stateFile, 'utf8');
writeFileSync(ephemeral.config.readyFile, JSON.stringify({ persistence: false }));
for (const root of [ephemeral.config.spillRoot, ephemeral.config.attachmentRoot]) {
  mkdirSync(root); writeFileSync(join(root, 'fixture'), 'Linux artifact');
}
process.on('SIGTERM', signal => {
  appendFileSync(process.env.DSH_FIXTURE_EXIT, `${signal ?? 'owner'}\n`);
  process.exit(0);
});
(await import(pathToFileURL(lifecycle.name).href)).apply();
const tools = [];
await (await import(sessions.name)).apply({
  loader: { import: async () => ({ defineTool: spec => spec }) }, tools: { register: tool => tools.push(tool) },
}, sessions.config);
const sections = [];
const events = {};
const presentation = [];
(await import(compatibility.name)).apply({
  effect: fn => fn(), on: (name, handler) => { events[name] = handler; },
  sessionProjections: { stateOf: () => ({ lastTurn: 1 }) },
  systemPrompt: { getSectionOrder: name => name, section: spec => { sections.push(spec); return () => {}; } },
}, compatibility.config);
const pending = new Map();
let httpAuth = 0;
let websocketAuth = 0;
const server = createServer((request, response) => {
  if (request.url === '/?token=fixture') {
    response.writeHead(302, { 'Set-Cookie': 'session=fixture', Location: '/' }).end(); return;
  }
  if (request.headers.cookie !== 'session=fixture') { response.writeHead(401).end(); return; }
  httpAuth++;
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', async () => {
    const frame = JSON.parse(body);
    try {
      const value = await call(frame.method, frame.payload.args);
      response.end(JSON.stringify({ rpcId: frame.rpcId, result: { ok: true, value } }));
    } catch (error) {
      response.end(JSON.stringify({ rpcId: frame.rpcId, result: { ok: false, error: { message: error.message } } }));
    }
  });
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.headers.cookie !== 'session=fixture') { socket.destroy(); return; }
  websocketAuth++;
  sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client));
});
sockets.on('connection', socket => socket.on('message', bytes => {
  const frame = JSON.parse(bytes.toString());
  if (frame.type !== 'open') return;
  const value = frame.endpoint === '$events'
    ? { type: 'ready', clientId: 'linux-fixture' }
    : { type: 'baseline', value: { projections: {} } };
  socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }));
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(`http://127.0.0.1:${server.address().port}/?token=fixture\n`);

async function call(method, args) {
  if (method === 'session/list') return { items: [
    { sessionId: 'root', cwd: process.cwd(), agentAvailable: true, running: false },
    { sessionId: 'child', cwd: process.cwd(), parentSessionId: 'root', origin: 'subagent', agentAvailable: true, running: false },
  ] };
  if (method === 'fixture/inspect') {
    const agent = { id: 'root', session: { id: 'root', header: {} }, ctx: { tools: { presentAs: mode => { presentation.push(mode); return () => {}; } } } };
    events['agent/created']?.({ agent });
    return {
      platform: process.platform, executable: process.execPath, cwd: process.cwd(), args, patchPath,
      plugins: preset.config.plugins.map(row => row.id), httpAuth, websocketAuth,
      relayHasCredentials: !!JSON.parse(process.env.CLAUDIAN_DEEPSEEK_SESSION_RELAY ?? '{}').env?.CLAUDIAN_SESSION_TOOL_ROUTE,
      prompt: sections[0].text({ agent }), presentation,
      promptFile: join(compatibility.config.promptDirectory, createHash('sha256').update('root').digest('hex') + '.txt'),
      forks: JSON.parse(readFileSync(ephemeral.config.stateFile, 'utf8')).forks,
      spill: readFileSync(join(ephemeral.config.spillRoot, 'fixture'), 'utf8'),
      attachment: readFileSync(join(ephemeral.config.attachmentRoot, 'fixture'), 'utf8'),
    };
  }
  if (method === 'fixture/tool') {
    const abort = new AbortController();
    pending.set(args.id, abort);
    try { return await tools.find(tool => tool.name === args.tool).execute(args.input, { agent: { id: args.caller }, signal: abort.signal }); }
    finally { pending.delete(args.id); }
  }
  if (method === 'fixture/cancel') { pending.get(args.id)?.abort(); return {}; }
  throw new Error('Unexpected fixture method');
}
