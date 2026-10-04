import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { testDate } from '@test/helpers/testClock';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

// OpenCode 2.0.18 uses an exclusive `before` boundary and ignores `messageID`.
// Copied messages receive new IDs.
const fixture = `#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http');
if (process.argv.includes('--version')) { console.log('2.0.18'); return; }
const file = process.env.OPENCODE_DB;
const server = http.createServer(async (req, res) => {
 const url = new URL(req.url, 'http://localhost'), [, , , id, action] = url.pathname.split('/');
 const state = JSON.parse(fs.readFileSync(file, 'utf8'));
 let raw = ''; for await (const chunk of req) raw += chunk;
 const body = raw ? JSON.parse(raw) : {};
 res.setHeader('Content-Type', 'application/json');
 if (action === 'message') {
   const offset = Number(url.searchParams.get('cursor') || 0), messages = state.sessions[id];
   if (offset && url.searchParams.has('order')) { res.writeHead(400).end(); return; }
   res.end(JSON.stringify({data:messages.slice(offset, offset + 2), cursor:offset + 2 < messages.length ? {next:String(offset + 2)} : {}})); return;
 }
 if (action === 'fork') {
   state.requests.push(body);
   const messages = state.sessions[id], boundary = body.before ? messages.findIndex(m => m.id === body.before) : messages.length;
   if (boundary < 0) { res.writeHead(400).end(); return; }
   const child = 'child-' + state.requests.length;
   state.sessions[child] = messages.slice(0, boundary).map((m, i) => ({...m, id:child + '-' + i}));
   fs.writeFileSync(file, JSON.stringify(state));
   res.end(JSON.stringify({data:{id:child}})); return;
 }
 res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({url:'http://127.0.0.1:' + server.address().port})));
process.stdin.resume(); process.stdin.on('end', () => server.close());
`;

describe('OpenCode v2 checkpoint forks', () => {
  let env: ForkTestEnvironment;
  let server: OpencodeServerService;
  let history: OpencodeConversationHistoryService;
  let backend: OpencodeExecutionBackend;
  let databasePath: string;
  const nativeMessages = [
    { id: 'z-user', type: 'user', text: 'Remember apples' },
    { id: 'y-assistant', type: 'assistant', content: [{ type: 'text', text: 'Apples remembered' }] },
    { id: 'x-idle', type: 'idle' },
    { id: 'b-user', type: 'user', text: 'Remember pears' },
    { id: 'a-assistant', type: 'assistant', content: [{ type: 'text', text: 'Pears remembered' }] },
  ].map((message, index) => ({ ...message, time: { created: testDate({ seconds: index }).getTime() } }));
  const state = () => JSON.parse(readFileSync(databasePath, 'utf8'));
  const context = () => ({ settings: env.host.settings, vaultPath: env.root, environment: { ...process.env, OPENCODE_DB: databasePath } });

  beforeEach(async () => {
    env = await createForkTestEnvironment();
    server = new OpencodeServerService();
    ProviderWorkspaceRegistry.setServices('opencode', { serverService: server } as any);
    history = new OpencodeConversationHistoryService(async () => server);
    backend = new OpencodeExecutionBackend(env.host, { serverService: server });
    databasePath = path.join(env.root, 'native.db');
    const cliPath = path.join(env.root, 'opencode.cjs');
    writeFileSync(cliPath, fixture, { mode: 0o700 });
    writeFileSync(databasePath, JSON.stringify({ sessions: { source: nativeMessages }, requests: [] }));
    env.host.settings.providerConfigs.opencode = { enabled: true, cliPath, environmentVariables: `OPENCODE_DB=${databasePath}` };
  });
  afterEach(async () => { ProviderWorkspaceRegistry.setServices('opencode', undefined); await server.dispose(); await env.dispose(); });

  async function openSource() {
    const conversation = await env.repository.create({ providerId: 'opencode' });
    await env.repository.update(conversation.id, { sessionId: 'source', providerState: { sessionId: 'source', nativeVersion: 2, databasePath } });
    const source = env.repository.getSync(conversation.id)!;
    const hydrated = await history.hydrateConversationHistory(source, env.root, context());
    await env.repository.update(source.id, hydrated);
    return env.open(backend, env.repository.getSync(source.id)!);
  }

  it.each([0, 1])('retains reply %i and excludes subsequent history, including after hydration and another fork', async turn => {
    const source = await openSource();
    const selected = source.conversation.messages[turn * 2 + 1];
    const child = await env.fork(source, selected, context());
    expect(child).toBeDefined();
    const restored = { ...child!, ...await history.hydrateConversationHistory(child!, env.root, context()) };
    const expected = turn === 0 ? ['Remember apples', 'Apples remembered'] : ['Remember apples', 'Apples remembered', 'Remember pears', 'Pears remembered'];
    expect(restored.messages.map(message => message.content)).toEqual(expected);
    expect(state().requests).toEqual([turn === 0 ? { before: 'x-idle' } : {}]);
    expect(state().sessions.source).toEqual(nativeMessages);
    await env.repository.update(restored.id, { messages: restored.messages });
    const nested = await env.fork(await env.open(backend, restored), restored.messages[1], context());
    expect(nested).toBeDefined();
    const nestedHistory = await history.hydrateConversationHistory(nested!, env.root, context());
    expect(nestedHistory.messages?.map(message => message.content)).toEqual(['Remember apples', 'Apples remembered']);
  }, 15000);

  it('rejects a missing checkpoint without creating a native child', async () => {
    await expect(history.buildForkProviderState('source', 'missing', { nativeVersion: 2, databasePath }, env.root, context()))
      .rejects.toThrow(/checkpoint/i);
    expect(state().requests).toEqual([]);
  });
});
