import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { testTime } from '@test/helpers/testClock';

import { codexTextTurnRequest } from './CodexRequests';
import { CodexRuntimeHarness } from './CodexRuntimeHarness';

// Executable adapter for the authoritative app-server peer; no vendor CLI or model access.
if (process.argv.slice(2, 5).join(' ') !== 'app-server --listen stdio://') throw new Error('Unexpected Codex launch arguments');
const harness = new CodexRuntimeHarness();
harness.autoReconcile = true;
const peer = harness.createProcess({ platformFamily: 'unix', platformOs: process.platform === 'darwin' ? 'macos' : 'linux' });
const threadId = randomUUID();
const home = process.env.CODEX_HOME!;
const sessionPath = path.join(home, 'sessions', `rollout-${threadId}.jsonl`);
let cwd: unknown;
harness.requestOverride = (native, request) => {
  if (request.method === 'initialize') {
    native.respond(request.id, { userAgent: 'codex-wsl-peer', codexHome: home, platformFamily: 'unix', platformOs: process.platform === 'darwin' ? 'macos' : 'linux' });
    return true;
  }
  if (request.method === 'thread/start') {
    cwd = request.params.cwd;
    native.respond(request.id, { thread: { id: threadId, path: sessionPath, turns: [] }, sandbox: { type: 'dangerFullAccess' } });
    return true;
  }
  if (request.method === 'turn/start') {
    const { input } = codexTextTurnRequest(request.params);
    const reply = JSON.stringify({ platform: process.platform, cwd: process.cwd(), threadCwd: cwd, text: input[0].text, home });
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, [
      { type: 'session_meta', payload: { id: threadId, cwd } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input[0].text }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } },
    ].map(record => JSON.stringify({ timestamp: testTime(), ...record })).join('\n') + '\n');
    const turn = { id: `turn-${threadId}`, status: 'completed', items: [] };
    native.respond(request.id, { turn: { ...turn, status: 'inProgress' } });
    native.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'answer', delta: reply });
    native.notify('turn/completed', { threadId, turn });
    return true;
  }
  return false;
};
peer.stdout.pipe(process.stdout);
peer.stderr.pipe(process.stderr);
// A pipe write may contain several JSON-RPC lines; the in-memory peer accepts one record at a time.
createInterface({ input: process.stdin }).on('line', line => peer.stdin.write(line + '\n'));
