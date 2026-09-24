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
 if (url.pathname.endsWith('/message')) {
   if (url.searchParams.has('cursor')) {
     if (url.searchParams.has('order')) { res.writeHead(400).end(); return; }
     data = [{ id: 'msg_answer', type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: 'Native answer' }] }];
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
    await history.hydrateConversationHistory(conversation, root, context);
    expect(conversation.messages.map(message => message.content)).toEqual(['Native question', 'Native answer']);
    await expect(history.buildForkProviderState('ses_parent', '', conversation.providerState, root, context))
      .resolves.toMatchObject({ sessionId: 'ses_child', databasePath, nativeVersion: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
