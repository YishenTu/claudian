import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { AntigravityNativeProcess } from './AntigravityNativeProcess';

// Runs as `agy acp` inside Linux and records the transcript where agy keeps it: under the Linux HOME.
if (process.argv.slice(2).join(' ') !== 'acp') throw new Error(`Unexpected agy launch arguments: ${process.argv.slice(2).join(' ')}`);
const peer = new AntigravityNativeProcess();
peer.newSessionId = `wsl-${process.pid}`;
const home = process.env.HOME!;

void (async () => {
  for (let count = 1; ; count += 1) {
    await peer.waitForPrompts(count);
    const { request } = peer.prompts[count - 1];
    const sessionCwd = peer.newRequests.at(-1)!.cwd;
    const text = request.prompt.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
    const reply = JSON.stringify({ platform: process.platform, cwd: process.cwd(), sessionCwd, text, home });
    const notes = path.posix.join(sessionCwd, 'notes.md');
    const now = new Date().toISOString();
    const logs = path.posix.join(home, '.gemini', 'antigravity-cli', 'brain', request.sessionId, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.posix.join(logs, 'transcript_full.jsonl'), [
      { content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`, created_at: now, source: 'USER_EXPLICIT', status: 'DONE', step_index: 0, type: 'USER_INPUT' },
      { created_at: now, source: 'MODEL', status: 'DONE', step_index: 1, tool_calls: [{ args: { Path: notes }, name: 'read_file' }], type: 'PLANNER_RESPONSE' },
      { content: reply, created_at: now, source: 'MODEL', status: 'DONE', step_index: 2, type: 'PLANNER_RESPONSE' },
    ].map(step => JSON.stringify(step)).join('\n') + '\n');
    peer.emit({
      kind: 'read', locations: [{ path: notes }], name: 'read_file', rawInput: { Path: notes },
      sessionUpdate: 'tool_call', status: 'completed', title: 'File notes.md', toolCallId: `read-${count}`,
    }, request.sessionId);
    peer.emit({ content: { text: reply, type: 'text' }, sessionUpdate: 'agent_message_chunk' }, request.sessionId);
    peer.finishPrompt();
  }
})();
peer.child.stdout.pipe(process.stdout);
peer.child.stderr.pipe(process.stderr);
process.stdin.pipe(peer.child.stdin);
