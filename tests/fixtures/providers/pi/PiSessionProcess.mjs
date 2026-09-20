import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// A deterministic external Pi RPC peer. No application implementation is imported.
const root = process.env.CLAUDIAN_TEST_PI_ROOT;
const args = process.argv.slice(2);
const sessionIndex = args.indexOf('--session');
const noSession = args.includes('--no-session');
const sessionFile = noSession ? null : sessionIndex < 0 ? path.join(root, 'source.jsonl') : args[sessionIndex + 1];
const memoryRecords = [];
const contextsFile = path.join(root, 'contexts.jsonl');
const pendingDialogs = new Map();
const write = record => process.stdout.write(JSON.stringify(record) + '\n');
const respond = (request, data) => write({ type: 'response', id: request.id, command: request.type, success: true, data });
const readRecords = file => file === null ? memoryRecords : fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  const request = JSON.parse(line);
  switch (request.type) {
    case 'get_state': {
      const [header] = readRecords(sessionFile);
      respond(request, {
        sessionId: header?.id ?? 'pi-source',
        sessionFile: process.env.CLAUDIAN_TEST_PI_MISMATCH === '1' ? path.join(root, 'wrong.jsonl') : sessionFile,
        pid: process.pid,
      });
      break;
    }
    case 'get_commands': respond(request, { commands: [] }); break;
    case 'set_model':
    case 'set_thinking_level':
    case 'get_session_stats': respond(request, {}); break;
    case 'prompt': {
      const records = readRecords(sessionFile);
      const ordinal = readRecords(contextsFile).length + 1;
      fs.appendFileSync(contextsFile, JSON.stringify({
        file: sessionFile, ...(noSession ? { text: request.message, images: request.images ?? [] } : {}), ids: records.filter(record => record.type === 'message').map(record => record.id),
      }) + '\n');
      const entries = [
        { type: 'message', id: `pi-user-${ordinal}`, parentId: records.at(-1)?.type === 'message' ? records.at(-1).id : null,
          message: { role: 'user', content: request.message } },
        { type: 'message', id: `pi-assistant-${ordinal}`, parentId: `pi-user-${ordinal}`,
          message: { role: 'assistant', content: [{ type: 'text', text: `Reply ${ordinal}` }] } },
      ];
      if (noSession) memoryRecords.push(...entries);
      else fs.appendFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      respond(request, {});
      write({ type: 'agent_start' });
      write({ type: 'message_update', assistantMessageEvent: { text_delta: `Reply ${ordinal}` } });
      write({ type: 'agent_end' });
      break;
    }
    case 'fixture_echo': respond(request, { value: request.value }); break;
    case 'fixture_extension':
      pendingDialogs.set('dialog-1', request);
      write({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 'Proceed?' });
      break;
    case 'extension_ui_response': {
      const pending = pendingDialogs.get(request.id);
      if (pending) { pendingDialogs.delete(request.id); respond(pending, request); }
      break;
    }
    case 'fixture_hang': write({ type: 'fixture_waiting' }); break;
    case 'fixture_exit':
      process.stderr.write('fixture requested exit\n');
      process.exit(17);
      break;
    default:
      write({ type: 'response', id: request.id, success: false, error: `Unsupported fixture command: ${request.type}` });
  }
}
