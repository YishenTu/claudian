import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';

it.each(['standalone', 'registered before workspace initialization'])('loads V2 history, recovers its model, and forks using %s history', async kind => {
  expect(ProviderWorkspaceRegistry.getServices('opencode')).toBeNull();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-history-')));
  const cliPath = path.join(root, 'opencode.cjs');
  const databasePath = path.join(root, 'data', 'opencode', 'native.db');
  writeFileSync(cliPath, `#!/usr/bin/env node
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('opencode v2.0.12'); return; }
if (!process.argv.includes('serve') || process.env.OPENCODE_DB !== ${JSON.stringify(databasePath)}) process.exit(3);
const server = http.createServer((req, res) => {
 const url = new URL(req.url, 'http://localhost');
 if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')) { res.writeHead(403).end(); return; }
 let data, cursor = {};
 if (url.pathname === '/api/session/ses_worker/message') {
   data = [
     { id: 'msg_worker_user', type: 'user', time: { created: 3 }, text: 'Inspect notes' },
     { id: 'msg_worker', type: 'assistant', time: { created: 4 }, content: [
       { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { filePath: '/vault/notes.md' }, content: [{ type: 'text', text: 'Notes body' }] } },
       { type: 'text', text: 'Worker summary' },
     ] },
     { id: 'msg_worker_user_again', type: 'user', time: { created: 6 }, text: 'Inspect more' },
     { id: 'msg_worker_again', type: 'assistant', time: { created: 7 }, content: [
       { type: 'tool', id: 'call_read_more', name: 'read', state: { status: 'completed', input: { filePath: '/vault/more.md' }, content: [{ type: 'text', text: 'More body' }] } },
       { type: 'text', text: 'Follow-up summary' },
     ] },
   ];
 } else if (url.pathname === '/api/session/ses_background/message') {
   data = [
     { id: 'msg_background_user', type: 'user', time: { created: 4 }, text: 'Survey vault' },
     { id: 'msg_background', type: 'assistant', time: { created: 5 }, content: [{ type: 'text', text: 'Background answer' }] },
     { id: 'msg_background_user_again', type: 'user', time: { created: 8 }, text: 'Survey again' },
     { id: 'msg_background_again', type: 'assistant', time: { created: 9 }, content: [
       { type: 'tool', id: 'call_read_b', name: 'read', state: { status: 'completed', input: { filePath: '/vault/b.md' }, content: [{ type: 'text', text: 'B body' }] } },
       { type: 'text', text: 'Second background answer' },
     ] },
   ];
 } else if (url.pathname.endsWith('/message')) {
   if (url.searchParams.has('cursor')) {
     if (url.searchParams.has('order')) { res.writeHead(400).end(); return; }
     data = [{ id: 'msg_answer', type: 'assistant', time: { created: 2 }, content: [
       { type: 'tool', id: 'call_worker', name: 'subagent', state: { status: 'completed', input: { description: 'Inspect notes', prompt: 'Inspect notes', agent: 'worker' },
         metadata: { sessionID: 'ses_worker' }, content: [{ type: 'text', text: '<subagent sessionID="ses_worker" state="completed">Worker summary</subagent>' }] } },
       { type: 'tool', id: 'call_background', name: 'subagent', state: { status: 'completed', input: { description: 'Survey vault', prompt: 'Survey vault', background: true },
         content: [{ type: 'text', text: 'The subagent is working in the background (sessionID: ses_background)' }] } },
       // Follow-ups reuse each child session for a new, separate task.
       { type: 'tool', id: 'call_worker_again', name: 'subagent', state: { status: 'completed', input: { description: 'Inspect more', prompt: 'Inspect more', agent: 'worker' },
         metadata: { sessionID: 'ses_worker' }, content: [{ type: 'text', text: '<subagent sessionID="ses_worker" state="completed">Follow-up summary</subagent>' }] } },
       { type: 'tool', id: 'call_background_again', name: 'subagent', state: { status: 'completed', input: { description: 'Survey again', prompt: 'Survey again', background: true },
         content: [{ type: 'text', text: 'The subagent is working in the background (sessionID: ses_background)' }] } },
       { type: 'text', text: 'Native answer' },
     ] }];
   } else { data = [{ id: 'msg_user', type: 'user', time: { created: 1 }, text: 'Native question' }]; cursor.next = 'opaque-next'; }
 } else if (url.pathname.endsWith('/fork') && req.method === 'POST') data = { id: 'ses_child' };
 else data = { id: 'ses_parent', model: { providerID: 'deepseek', id: 'chat' } };
 res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data, cursor }));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
process.stdin.resume(); process.stdin.on('end', () => server.close());
`, { mode: 0o700 });
  const history = kind === 'standalone' ? new OpencodeConversationHistoryService() : opencodeProviderRegistration.historyService!;
  const conversation = { id: 'local', sessionId: 'ses_parent', messages: [], providerState: { nativeVersion: 2, databasePath } } as unknown as Conversation;
  const context = { settings: { providerConfigs: { opencode: { cliPath } } }, vaultPath: root, environment: { ...process.env, XDG_DATA_HOME: path.join(root, 'data'), OPENCODE_DB: path.join(root, 'untrusted.db') } };
  try {
    await expect(history.recoverConversationModelSelection!(conversation, root, context)).resolves.toBe('opencode:deepseek/chat');
    Object.assign(conversation, await history.hydrateConversationHistory(conversation, root, context));
    expect(conversation.messages.map(message => message.content)).toEqual(['Native question', 'Native answer']);
    // The child session's own tools are restored into the parent's subagent card.
    expect(conversation.messages[1].toolCalls?.[0].subagent).toMatchObject({
      id: 'call_worker', agentId: 'ses_worker', description: 'Inspect notes', mode: 'sync', status: 'completed', result: 'Worker summary',
      toolCalls: [{ id: 'call_read', name: 'Read', status: 'completed', result: 'Notes body' }],
    });
    // A background launch only acknowledges the child, so its answer comes from the child session.
    expect(conversation.messages[1].toolCalls?.[1].subagent).toMatchObject({
      id: 'call_background', agentId: 'ses_background', mode: 'async', asyncStatus: 'completed', result: 'Background answer', toolCalls: [],
    });
    // A reused child session holds one turn per task; each card keeps only its own turn.
    expect(conversation.messages[1].toolCalls?.[2].subagent).toMatchObject({
      id: 'call_worker_again', agentId: 'ses_worker', result: 'Follow-up summary',
      toolCalls: [{ id: 'call_read_more', result: 'More body' }],
    });
    expect(conversation.messages[1].toolCalls?.[3].subagent).toMatchObject({
      id: 'call_background_again', agentId: 'ses_background', mode: 'async', result: 'Second background answer',
      toolCalls: [{ id: 'call_read_b', result: 'B body' }],
    });
    await expect(history.buildForkProviderState('ses_parent', '', conversation.providerState, root, context))
      .resolves.toMatchObject({ sessionId: 'ses_child', databasePath, nativeVersion: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
