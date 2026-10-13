import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  createSessionToolMCPDispatcher,
  createSessionToolMCPServer,
} from '@/core/session-tools/sessionToolMCP';
import {
  SESSION_TOOL_SPECS,
  type SessionToolCallHandler,
  type SessionToolCallRequest,
} from '@/core/session-tools/sessionToolSpecs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

async function connect(handler: SessionToolCallHandler) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createSessionToolMCPServer(handler).connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('session tool MCP server through the MCP SDK client', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('initializes and lists always-loaded tools with the shared JSON Schemas', async () => {
    client = await connect(jest.fn());

    expect(client.getServerVersion()).toMatchObject({ name: 'claudian_sessions' });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    const { tools } = await client.listTools();
    expect(tools).toEqual(SESSION_TOOL_SPECS.map(spec => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      _meta: { 'anthropic/alwaysLoad': true },
    })));
    await expect(client.ping()).resolves.toEqual({});
  });

  it('calls the handler with native arguments and tool-use id and returns its result', async () => {
    const requests: SessionToolCallRequest[] = [];
    client = await connect(async request => {
      requests.push(request);
      return request.name === 'claudian_send_message'
        ? { isError: true, text: 'A session cannot message itself.' }
        : { isError: false, text: '[]' };
    });

    const listed = await client.callTool({
      name: 'claudian_list_destinations',
      arguments: {},
      _meta: { 'claudecode/toolUseId': 'toolu_1' },
    });
    const sent = await client.callTool({ name: 'claudian_send_message', arguments: { text: 'Hi' } });

    expect(listed).toEqual({ content: [{ type: 'text', text: '[]' }], isError: false });
    expect(sent).toEqual({ content: [{ type: 'text', text: 'A session cannot message itself.' }], isError: true });
    expect(requests.map(({ name, args, nativeToolUseId }) => ({ name, args, nativeToolUseId }))).toEqual([
      { name: 'claudian_list_destinations', args: {}, nativeToolUseId: 'toolu_1' },
      { name: 'claudian_send_message', args: { text: 'Hi' }, nativeToolUseId: undefined },
    ]);
  });

  it('reports handler failures as tool errors and unknown tools as invalid params', async () => {
    client = await connect(async () => { throw new Error('Port released.'); });

    await expect(client.callTool({ name: 'claudian_list_destinations', arguments: {} })).resolves.toEqual({
      content: [{ type: 'text', text: 'Port released.' }],
      isError: true,
    });
    const unknown = client.callTool({ name: 'send_message', arguments: {} });
    await expect(unknown).rejects.toBeInstanceOf(McpError);
    await expect(unknown).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('aborts only the cancelled call when the client sends notifications/cancelled', async () => {
    const started = deferred<AbortSignal>();
    client = await connect(async request => {
      if (request.name === 'claudian_send_message') {
        started.resolve(request.signal);
        await new Promise(resolve => request.signal.addEventListener('abort', resolve));
      }
      return { isError: false, text: '[]' };
    });
    const controller = new AbortController();

    const pending = client.callTool({ name: 'claudian_send_message', arguments: { text: 'Hi' } }, undefined, {
      signal: controller.signal,
    });
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    controller.abort('user stopped');

    await expect(pending).rejects.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    await expect(client.callTool({ name: 'claudian_list_destinations', arguments: {} }))
      .resolves.toMatchObject({ isError: false });
  });

  it('aborts in-flight calls when the transport closes', async () => {
    const started = deferred<AbortSignal>();
    client = await connect(async request => {
      started.resolve(request.signal);
      await new Promise(resolve => request.signal.addEventListener('abort', resolve));
      return { isError: false, text: '[]' };
    });

    const pending = client.callTool({ name: 'claudian_list_destinations', arguments: {} });
    const signal = await started.promise;
    await client.close();
    client = undefined;

    await expect(pending).rejects.toThrow();
    expect(signal.aborted).toBe(true);
  });
});

describe('session tool MCP dispatcher', () => {
  const dispatcher = createSessionToolMCPDispatcher(jest.fn());

  it.each([
    ['echoes a supported protocol version', '2024-11-05', '2024-11-05'],
    ['answers an unsupported version with the latest supported one', '2099-01-01', '2025-11-25'],
  ])('%s', async (_label, requested, negotiated) => {
    await expect(dispatcher.handle({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    })).resolves.toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: negotiated } });
  });

  it('rejects unknown methods and malformed messages, and does not answer notifications or responses', async () => {
    await expect(dispatcher.handle({ jsonrpc: '2.0', id: 'a', method: 'resources/list' }))
      .resolves.toEqual({ jsonrpc: '2.0', id: 'a', error: { code: -32601, message: 'Method not found: resources/list' } });
    await expect(dispatcher.handle({ id: 2, method: 'ping' }))
      .resolves.toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    await expect(dispatcher.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).resolves.toBeUndefined();
    await expect(dispatcher.handle({ jsonrpc: '2.0', id: 3, result: {} })).resolves.toBeUndefined();
  });

  it('aborts a call when its external request signal aborts', async () => {
    const started = deferred<AbortSignal>();
    const local = createSessionToolMCPDispatcher(async request => {
      started.resolve(request.signal);
      await new Promise(resolve => request.signal.addEventListener('abort', resolve));
      return { isError: false, text: '[]' };
    });
    const disconnect = new AbortController();

    const response = local.handle(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'claudian_list_destinations', arguments: {} } },
      disconnect.signal,
    );
    const signal = await started.promise;
    disconnect.abort();

    await expect(response).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
  });
});
