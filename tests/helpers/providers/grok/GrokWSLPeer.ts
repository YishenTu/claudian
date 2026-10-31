import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { testDate } from '@test/helpers/testClock';

import { GrokNativeProcess } from './GrokNativeProcess';

// Persist the same native ACP updates sent over stdio, as Grok's session store does.
if (process.argv.slice(2, 5).join(' ') !== 'agent --no-leader stdio') throw new Error('Unexpected Grok launch arguments');
const peer = new GrokNativeProcess();
const sessionId = randomUUID();
const home = process.env.GROK_HOME!;
let cwd = '';
peer.newImplementation = async request => { cwd = request.cwd; return { sessionId }; };
peer.promptImplementation = async () => {
  const prompt = peer.promptRequests.at(-1)!;
  const text = prompt.prompt.filter(block => block.type === 'text').map(block => block.text).join('');
  const reply = JSON.stringify({ platform: process.platform, cwd: process.cwd(), sessionCwd: cwd, text, home });
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex: 0 } },
    { sessionUpdate: 'tool_call', toolCallId: 'directory', title: 'list_dir', status: 'completed', rawInput: { target_directory: path.join(cwd, 'notes') } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
    { sessionUpdate: 'turn_completed' },
  ];
  const directory = path.join(home, 'sessions', encodeURIComponent(cwd), sessionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'updates.jsonl'), updates.map(update => JSON.stringify({
    method: 'session/update', timestamp: testDate().getTime(), params: { sessionId, update },
  })).join('\n') + '\n');
  for (const update of updates) peer.emit(update, 'standard', undefined, sessionId);
  return { stopReason: 'end_turn' };
};
peer.child.stdout.pipe(process.stdout);
peer.child.stderr.pipe(process.stderr);
process.stdin.pipe(peer.child.stdin);
