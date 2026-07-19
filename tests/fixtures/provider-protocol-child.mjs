import * as readline from 'node:readline';

const mode = process.argv[2];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const kimiConfigOptions = (model = 'kimi-code/k2') => [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: model,
    options: [
      { value: 'kimi-code/k2', name: 'K2' },
      { value: 'kimi-code/k3', name: 'K3' },
    ],
  },
  {
    type: 'select',
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    currentValue: 'off',
    options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }],
  },
  {
    type: 'select',
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'yolo', name: 'YOLO' },
    ],
  },
];

let pendingKimiPromptId = null;

for await (const line of rl) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }

  if (mode === 'kimi-acp') {
    if (message.id === 900 && message.method === undefined) {
      if (pendingKimiPromptId === null) continue;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'kimi-fixture-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fixture reply' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: pendingKimiPromptId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } },
      });
      pendingKimiPromptId = null;
      continue;
    }

    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Kimi Code CLI Fixture', version: '0.27.0' },
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: 'login', name: 'Log in', description: 'Fixture login' }],
        },
      });
      continue;
    }
    if (message.method === 'session/new' || message.method === 'session/load') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          sessionId: 'kimi-fixture-session',
          configOptions: kimiConfigOptions(),
        },
      });
      continue;
    }
    if (message.method === 'session/set_config_option') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          configOptions: kimiConfigOptions(
            message.params?.configId === 'model' ? message.params.value : 'kimi-code/k2',
          ),
        },
      });
      continue;
    }
    if (message.method === 'session/prompt') {
      pendingKimiPromptId = message.id;
      send({
        jsonrpc: '2.0',
        id: 900,
        method: 'session/request_permission',
        params: {
          sessionId: 'kimi-fixture-session',
          toolCall: { toolCallId: 'tool-1', title: 'Read', rawInput: { path: 'README.md' } },
          options: [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      continue;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Unknown fixture method: ${message.method}` },
    });
    continue;
  }

  const command = mode === 'pi' ? message.type : message.method;
  if (command === 'fixture/exit' || command === 'fixture_exit') {
    process.stderr.write('fixture requested process exit\n');
    process.exit(17);
  }
  if (command === 'fixture/hang' || command === 'fixture_hang') {
    continue;
  }
  if (command === 'fixture/primitive') {
    process.stdout.write('null\n42\n"ignored"\n');
  }

  if (mode === 'pi') {
    send({
      id: message.id,
      result: { command: message.type, payload: message.payload ?? null },
      success: true,
      type: 'response',
    });
    continue;
  }

  send({
    id: message.id,
    jsonrpc: '2.0',
    result: { method: message.method, params: message.params ?? null },
  });
}
