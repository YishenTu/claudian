import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import spawn from 'cross-spawn';

jest.mock('cross-spawn', () => jest.fn());

import { createNativeRPCProcess, createNativeVersionProcess } from '@test/helpers/providers/NativeRPCTestProcess';

import type { ProviderExecutionEvent } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

it.each([
  ['yolo', 'allow'],
  ['normal', 'reject'],
])('answers v1 approval requests according to %s mode', async (permissionMode, expectedDecision) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-acp-approval-'));
  jest.mocked(spawn).mockImplementation((_command, args) => {
    if (args?.includes('--version')) return createNativeVersionProcess('1.2.27');
    const proc: ChildProcessWithoutNullStreams = createNativeRPCProcess((method, _params, notify) => {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      if (method === 'session/new') return { sessionId: 'native-session' };
      if (method === 'session/set_config_option') return { configOptions: [] };
      if (method === 'session/prompt') {
        return new Promise(resolve => {
          const onReply = (chunk: Buffer): void => {
            const message = JSON.parse(chunk.toString());
            if (message.id !== 'native-approval') return;
            proc.stdin.off('data', onReply);
            notify('session/update', { sessionId: 'native-session', update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Native decision: ${message.result.outcome.optionId}` },
            } });
            resolve({ stopReason: 'end_turn' });
          };
          proc.stdin.on('data', onReply);
          proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: 'native-approval', method: 'session/request_permission', params: {
            sessionId: 'native-session',
            toolCall: { toolCallId: 'shell-1', title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'pwd' } },
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
            ],
          } }) + '\n');
        });
      }
      return {};
    });
    return proc;
  });
  const host = {
    settings: { model: 'opencode:test/model', providerConfigs: { opencode: { enabled: true, visibleModels: ['test/model'], discoveredModels: [{ rawId: 'test/model', label: 'Test' }] } } },
    getResolvedProviderCliPath: async () => '/test/opencode',
    mutateSettings: async () => undefined,
    notifyProviderChatOptionsChanged: () => undefined,
  } as unknown as ProviderHost;
  const session = new OpencodeExecutionBackend(host, { serverService: new OpencodeServerService() }).createSession({
    lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported', vaultWorkingDirectory: root,
    interactionPort: {
      requestApproval: async request => ({ interactionId: request.interactionId, decision: 'deny' }),
      askUserQuestion: async request => ({ interactionId: request.interactionId, answers: null }),
      dismissInteraction() {},
    },
  });
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute({
      configuration: { permissionMode, systemInstructions: { kind: 'provider-default' } },
      input: [{ type: 'text', text: 'Run pwd.' }], toolPolicy: { kind: 'provider-default' },
      signal: new AbortController().signal,
    }).events) events.push(event);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text_delta', text: `Native decision: ${expectedDecision}` }),
    ]));
    expect(events.at(-1)?.type).toBe('turn_completed');
  } finally {
    await session.dispose();
    await fs.rm(root, { recursive: true, force: true });
    jest.mocked(spawn).mockReset();
  }
});
