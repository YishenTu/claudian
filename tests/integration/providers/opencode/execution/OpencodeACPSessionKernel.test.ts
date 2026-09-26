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
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

it.each([
  ['yolo', 'allow'],
  ['normal', 'reject'],
])('answers v1 approval requests according to %s mode', async (permissionMode, expectedDecision) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-acp-approval-'));
  const cliPath = path.join(root, 'opencode');
  await fs.writeFile(cliPath, '', { mode: 0o700 });
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
    getResolvedProviderCliPath: async () => cliPath,
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
    expect(jest.mocked(spawn).mock.calls.filter(([, args]) => args?.includes('--version'))).toHaveLength(1);
  } finally {
    await session.dispose();
    await fs.rm(root, { recursive: true, force: true });
    jest.mocked(spawn).mockReset();
  }
});

it.each([false, true])('discovers V1 model metadata while isolating a failed native process (%s)', async (failFirstModel) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-acp-models-'));
  const cliPath = path.join(root, 'opencode');
  await fs.writeFile(cliPath, '', { mode: 0o700 });
  const methods: string[] = [];
  const switches: string[] = [];
  jest.mocked(spawn).mockImplementation((_command, args) => {
    if (args?.includes('--version')) return createNativeVersionProcess('1.2.27');
    const proc = createNativeRPCProcess((method, params, notify) => {
      methods.push(method);
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      if (method === 'session/new') {
        notify('session/update', { sessionId: 'metadata-session', update: {
          sessionUpdate: 'available_commands_update', availableCommands: [],
        } });
        return { sessionId: 'metadata-session', models: { currentModelId: '', availableModels: [
          { modelId: 'test/one', name: 'One' }, { modelId: 'test/two', name: 'Two' },
        ] } };
      }
      if (method === 'session/set_config_option') {
        const model = String(params.value);
        switches.push(model);
        if (failFirstModel && model === 'test/one') {
          proc.emit('exit', 1, null);
          proc.emit('close', 1, null);
          return new Promise(() => undefined);
        }
        const value = model === 'test/one' ? 'high' : 'low';
        return { configOptions: [{ id: 'effort', name: 'Effort', type: 'select', category: 'thought_level',
          currentValue: value, options: [{ value, name: value }],
        }] };
      }
      return {};
    });
    return proc;
  });
  const host: any = {
    app: { vault: { adapter: { basePath: root } } },
    settings: { providerConfigs: { opencode: { enabled: true, visibleModels: ['test/one', 'test/two'] } } },
    executionLifecycleRegistry: { registerTransitionHook: () => () => undefined },
    getResolvedProviderCliPath: async () => cliPath,
    mutateSettingsConditionally: async (mutation: (settings: any) => unknown) => mutation(host.settings),
    notifyProviderChatOptionsChanged: () => undefined,
  };
  const service = new OpencodeMetadataService(host);
  const models = createOpencodeModels(host, service);
  try {
    await models.refresh();
    expect(switches).toEqual(['test/one', 'test/two']);
    expect(methods.filter(method => method === 'session/new')).toHaveLength(failFirstModel ? 2 : 1);
    expect(jest.mocked(spawn).mock.calls.filter(([, args]) => args?.includes('--version'))).toHaveLength(1);
    const nativeSpawns = jest.mocked(spawn).mock.calls.filter(([, args]) => args?.includes('acp'));
    expect(nativeSpawns).toHaveLength(failFirstModel ? 2 : 1);
    for (const [, , options] of nativeSpawns) expect(options?.env?.OPENCODE_DB).toBe(':memory:');
    const thinking = getOpencodeProviderSettings(host.settings).thinkingOptionsByModel;
    expect(thinking['test/one']?.map(option => option.value)).toEqual(failFirstModel ? undefined : ['high']);
    expect(thinking['test/two'].map(option => option.value)).toEqual(['low']);
  } finally {
    await models.dispose();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
    jest.mocked(spawn).mockReset();
  }
});
