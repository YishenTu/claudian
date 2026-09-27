import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';

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
let leafId = readRecords(sessionFile).filter(record => record.id && record.type !== 'session').at(-1)?.id ?? null;
let cancelTree = false;
let holdNext = false;
let userOnlyNext = false;
let queueNextSteer = false;
const commands = new Map();
const extensionIndex = args.indexOf('--extension');
if (extensionIndex >= 0) {
  const sdkDir = path.join(path.dirname(args[extensionIndex + 1]), 'node_modules', '@mariozechner', 'pi-coding-agent');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  fs.copyFileSync(new URL('./PiSessionManager.mjs', import.meta.url), path.join(sdkDir, 'index.js'));
  const extension = await import(pathToFileURL(args[extensionIndex + 1]).href);
  extension.default({
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: customType => {
      const entry = { type: 'custom', customType, id: `anchor-${Date.now()}`, parentId: leafId };
      fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
      leafId = entry.id;
    },
  });
}
const extensionContext = {
  isIdle: () => true,
  sessionManager: {
    getLeafId: () => leafId,
    getSessionId: () => readRecords(sessionFile)[0]?.id,
    getSessionFile: () => sessionFile,
    getEntry: id => readRecords(sessionFile).find(record => record.id === id),
  },
  navigateTree: async id => {
    if (cancelTree) return { cancelled: true };
    if (id === leafId) return { cancelled: false };
    const entry = readRecords(sessionFile).find(record => record.id === id);
    if (!entry) throw new Error('Missing tree entry');
    leafId = entry.message?.role === 'user' || entry.type === 'custom_message' ? entry.parentId : entry.id;
    return { cancelled: false };
  },
  switchSession: async (file, options) => {
    if (cancelTree) return { cancelled: true };
    leafId = readRecords(file).at(-1)?.id ?? null;
    await options?.withSession?.(extensionContext);
    return { cancelled: false };
  },
  ui: { setStatus: (statusKey, statusText) => write({ type: 'extension_ui_request', method: 'setStatus', statusKey, statusText }) },
};

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
    case 'get_commands': respond(request, { commands: [...commands.keys()].map(name => ({ name, source: 'extension' })) }); break;
    case 'fixture_tree_cancel': cancelTree = request.cancel; respond(request, {}); break;
    case 'fixture_queue_steer': queueNextSteer = true; respond(request, {}); break;
    case 'fixture_hold_next': holdNext = true; userOnlyNext = request.userOnly === true; respond(request, {}); break;
    case 'set_model':
    case 'set_thinking_level':
      respond(request, {}); break;
    case 'get_session_stats': {
      const byId = new Map(readRecords(sessionFile).map(record => [record.id, record]));
      let usage;
      for (let id = leafId; id && byId.has(id); id = byId.get(id).parentId) {
        const message = byId.get(id).message;
        if (message?.role === 'assistant' && message.usage) { usage = message.usage; break; }
      }
      respond(request, { contextUsage: { tokens: usage ? usage.input + usage.output : null, contextWindow: 200000 } });
      break;
    }
    case 'fixture_fail':
      respond(request, {});
      write({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Fixture failure' } });
      write({ type: 'agent_end' });
      break;
    case 'steer':
    case 'prompt': {
      if (request.type === 'steer' && queueNextSteer) {
        queueNextSteer = false;
        respond(request, {});
        break;
      }
      const commandName = request.message?.split(' ')[0]?.slice(1);
      if (request.message?.startsWith('/') && commands.has(commandName)) {
        await commands.get(commandName).handler(request.message.slice(commandName.length + 2), extensionContext);
        respond(request, {});
        break;
      }
      const records = readRecords(sessionFile);
      const byId = new Map(records.map(record => [record.id, record]));
      const activeIds = [];
      for (let id = leafId; id && byId.has(id); id = byId.get(id).parentId) activeIds.unshift(id);
      const ordinal = readRecords(contextsFile).length + 1;
      fs.appendFileSync(contextsFile, JSON.stringify({
        file: sessionFile, ...(noSession ? { text: request.message, images: request.images ?? [] } : {}), ids: activeIds.filter(id => byId.get(id).type === 'message'),
      }) + '\n');
      const entries = [
        { type: 'message', id: `pi-user-${ordinal}`, parentId: leafId,
          message: { role: 'user', content: request.message } },
        { type: 'message', id: `pi-assistant-${ordinal}`, parentId: `pi-user-${ordinal}`,
          message: { role: 'assistant', usage: { input: ordinal * 1000, output: 10 }, content: [{ type: 'text', text: `Reply ${ordinal}` }] } },
      ];
      if (userOnlyNext) entries.pop();
      userOnlyNext = false;
      leafId = entries.at(-1).id;
      if (noSession) memoryRecords.push(...entries);
      else fs.appendFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      respond(request, {});
      write({ type: 'agent_start' });
      write({ type: 'message_update', assistantMessageEvent: { text_delta: `Reply ${ordinal}` } });
      if (!holdNext) write({ type: 'agent_end' });
      holdNext = false;
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
