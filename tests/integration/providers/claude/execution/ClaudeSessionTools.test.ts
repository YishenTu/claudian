import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';

import type { ProviderExecutionRequest, ProviderSessionConfig, ProviderSessionToolPort } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SessionToolMCPServer } from '@/core/session-tools/sessionToolMCP';
import { ClaudeExecutionSession } from '@/providers/claude/execution/ClaudeExecutionSession';

const sdk = sdkModule as unknown as {
  getLastOptions(): sdkModule.Options | undefined;
  resetMockMessages(): void;
  setMockMessages(messages: unknown[], options?: { appendResult: boolean }): void;
};
const nativeName = 'mcp__claudian_sessions__claudian_list_destinations';
const result = { type: 'result', subtype: 'success' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function request(toolPolicy: ProviderExecutionRequest['toolPolicy'] = { kind: 'provider-default' }): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text: 'Hello' }],
    configuration: { model: 'claude-sonnet-4-5', systemInstructions: { kind: 'provider-default' } },
    toolPolicy, signal: new AbortController().signal,
  };
}
function session(port?: ProviderSessionToolPort, lifecycle: ProviderSessionConfig['lifecycle'] = 'persistent') {
  const host = {
    app: { vault: { adapter: { basePath: '/vault' } } },
    settings: {
      providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5']) },
      model: 'claude-sonnet-4-5', permissionMode: 'manual', mediaFolder: '', systemPrompt: '', userName: '',
    },
    getResolvedProviderCliPath: async () => '/bin/claude',
    getActiveEnvironmentVariables: () => '',
  } as unknown as ProviderHost;
  return new ClaudeExecutionSession(host, {
    lifecycle, nativePersistence: 'enabled', vaultWorkingDirectory: '/vault', sessionTools: port,
    interactionPort: { requestApproval: jest.fn(), askUserQuestion: jest.fn(), dismissInteraction: jest.fn() },
  });
}
async function drain(events: AsyncIterable<unknown>) {
  for await (const event of events) {
    expect(event).not.toMatchObject({ type: 'execution_error' });
  }
}
function tool(id: string, parent: string | null = null) {
  return { type: 'assistant', parent_tool_use_id: parent, message: { id: `msg-${id}`, content: [
    { type: 'tool_use', id, name: nativeName, input: {} },
  ] } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Expected native boundary was not reached');
}
async function connect() {
  const server = sdk.getLastOptions()?.mcpServers?.claudian_sessions;
  expect(server).toMatchObject({ type: 'sdk', name: 'claudian_sessions', timeout: expect.any(Number), disableAutoBackground: true });
  expect(sdk.getLastOptions()).not.toHaveProperty('strictMcpConfig');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await (server as unknown as { instance: SessionToolMCPServer }).instance.connect(serverTransport);
  const client = new Client({ name: 'claude-session-tools-test', version: '1' });
  await client.connect(clientTransport);
  return client;
}
function call(client: Client, id: string) {
  return client.callTool({ name: 'claudian_list_destinations', arguments: {}, _meta: { 'claudecode/toolUseId': id } });
}

describe('Claude session tools', () => {
  beforeEach(() => sdk.resetMockMessages());

  it.each(['persistent', 'ephemeral'] as const)('attaches only with a port and creates fresh servers for %s queries', async lifecycle => {
    const unbound = session(undefined, lifecycle);
    await drain(unbound.execute(request()).events);
    expect(sdk.getLastOptions()?.mcpServers).toBeUndefined();
    await unbound.dispose();
    const bound = session({ list: async () => ({ sessions: [] }), send: jest.fn(), read: jest.fn() }, lifecycle);
    try {
      await drain(bound.execute(request()).events);
      const first = sdk.getLastOptions()?.mcpServers?.claudian_sessions;
      const client = await connect();
      const tools = (await client.listTools()).tools;
      expect(tools.map(t => t.name)).toEqual(['claudian_list_destinations', 'claudian_send_message', 'claudian_read_session']);
      expect(tools.every(t => t._meta?.['anthropic/alwaysLoad'] === true)).toBe(true);
      expect(await client.callTool({ name: 'claudian_list_destinations', arguments: {} })).toMatchObject({ isError: true });
      await client.close();
      await drain(bound.execute(request()).events);
      expect(sdk.getLastOptions()?.mcpServers?.claudian_sessions === first).toBe(lifecycle === 'persistent');
      // Different instructions force a new persistent query too.
      const next = request();
      await drain(bound.execute({ ...next, configuration: { ...next.configuration, systemInstructions: { kind: 'explicit', instructions: 'Changed' } } }).events);
      expect(sdk.getLastOptions()?.mcpServers?.claudian_sessions).not.toBe(first);
    } finally { await bound.dispose(); }
  });

  it.each([
    { kind: 'provider-default' }, { kind: 'unrestricted' }, { kind: 'passive' }, { kind: 'read-only' },
    { kind: 'allow-list', names: ['claudian_list_destinations', nativeName] },
  ] satisfies ProviderExecutionRequest['toolPolicy'][])('checks $kind policy when the native tool actually calls', async policy => {
    const end = deferred<unknown>();
    sdk.setMockMessages([tool('call'), end.promise], { appendResult: false });
    const list = jest.fn(async () => ({ sessions: [] }));
    const bound = session({ list, send: jest.fn(), read: jest.fn() });
    const run = bound.execute(request(policy));
    const outputs: unknown[] = [];
    const consume = (async () => { for await (const event of run.events) outputs.push(event); })();
    let client: Client | undefined;
    try {
      await until(() => outputs.some(event => (event as { type: string }).type === 'tool_started'));
      client = await connect();
      const response = await call(client, 'call');
      const allowed = policy.kind === 'provider-default' || policy.kind === 'unrestricted';
      expect(response.isError).toBe(!allowed);
      expect(list).toHaveBeenCalledTimes(allowed ? 1 : 0);
    } finally {
      end.resolve(result);
      await consume;
      await client?.close();
      await bound.dispose();
    }
  });

  it('correlates an MCP control call that overtakes its native tool-start output', async () => {
    const start = deferred<unknown>();
    const end = deferred<unknown>();
    sdk.setMockMessages([start.promise, end.promise], { appendResult: false });
    const list = jest.fn(async () => ({ sessions: [] }));
    const bound = session({ list, send: jest.fn(), read: jest.fn() });
    const consume = drain(bound.execute(request()).events);
    let client: Client | undefined;
    try {
      await until(() => Boolean(sdk.getLastOptions()));
      client = await connect();
      const pending = call(client, 'overtaking-call');
      // MCP dispatch runs before the delayed iterator output, as in the real SDK.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(list).not.toHaveBeenCalled();
      start.resolve(tool('overtaking-call'));
      expect(await pending).toMatchObject({ isError: false });
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      start.resolve(null); end.resolve(result); await consume;
      await client?.close(); await bound.dispose();
    }
  });

  it('routes send arguments and native cancellation through the caller port', async () => {
    const end = deferred<unknown>();
    const sendTool = tool('send');
    sendTool.message.content[0].name = 'mcp__claudian_sessions__claudian_send_message';
    sdk.setMockMessages([sendTool, end.promise], { appendResult: false });
    const entered = deferred<AbortSignal>();
    const send = jest.fn((_args, signal: AbortSignal) => {
      entered.resolve(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
    });
    const bound = session({ list: jest.fn(), send, read: jest.fn() });
    const outputs: unknown[] = [];
    const run = bound.execute(request());
    const consume = (async () => { for await (const event of run.events) outputs.push(event); })();
    let client: Client | undefined;
    try {
      await until(() => outputs.some(event => (event as { type: string }).type === 'tool_started'));
      client = await connect();
      const nativeAbort = new AbortController();
      const pending = client.callTool({
        name: 'claudian_send_message', arguments: { sessionId: 'recipient', text: 'Hello' },
        _meta: { 'claudecode/toolUseId': 'send' },
      }, undefined, { signal: nativeAbort.signal });
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      const signal = await entered.promise;
      expect(send).toHaveBeenCalledWith({ sessionId: 'recipient', text: 'Hello' }, signal);
      nativeAbort.abort();
      expect(await outcome).toHaveProperty('error');
      await until(() => signal.aborted);
      expect(signal.aborted).toBe(true);
    } finally {
      end.resolve(result); await consume;
      await client?.close(); await bound.dispose();
    }
  });

  it.each(['complete', 'interrupt', 'release'] as const)('revokes original call ownership on %s and never lends a newer run to late children', async finish => {
    const end = deferred<unknown>();
    sdk.setMockMessages([tool('old'), end.promise], { appendResult: false });
    const signals: AbortSignal[] = [];
    const list = jest.fn((_args: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
    });
    const bound = session({ list, send: jest.fn(), read: jest.fn() });
    const run = bound.execute(request());
    const outputs: unknown[] = [];
    const consume = (async () => { for await (const event of run.events) outputs.push(event); })();
    let client: Client | undefined;
    const nextEnd = deferred<unknown>();
    try {
      await until(() => outputs.some(event => (event as { type: string }).type === 'tool_started'));
      client = await connect();
      const pending = call(client, 'old');
      await until(() => signals.length === 1);
      if (finish === 'interrupt') bound.cancel();
      if (finish === 'release') {
        end.resolve(result);
        await bound.dispose();
      } else end.resolve(result);
      await consume;
      expect(signals[0].aborted).toBe(true);
      expect(await pending).toMatchObject({ isError: true });
      if (finish === 'release') return;
      sdk.setMockMessages([tool('late-child', 'old'), tool('old'), tool('new'), nextEnd.promise], { appendResult: false });
      const next = bound.execute(request());
      const nextOutputs: unknown[] = [];
      const nextConsume = (async () => { for await (const event of next.events) nextOutputs.push(event); })();
      await until(() => nextOutputs.some(event => (event as { toolCallId?: string }).toolCallId === 'new'));
      expect(await call(client, 'old')).toMatchObject({ isError: true });
      expect(await call(client, 'late-child')).toMatchObject({ isError: true });
      const newPending = call(client, 'new');
      await until(() => signals.length === 2);
      expect(signals[1].aborted).toBe(false);
      nextEnd.resolve(result);
      await nextConsume;
      expect(signals[1].aborted).toBe(true);
      expect(await newPending).toMatchObject({ isError: true });
    } finally {
      end.resolve(result); nextEnd.resolve(result);
      await client?.close(); await bound.dispose();
    }
  });
});
