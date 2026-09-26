import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import type {
  ACPSessionNotification,
  JSONRPCRequestOptions,
} from '../../../../src/providers/acp';
import {
  ACPClientConnection,
  ACPJSONRPCTransport
} from '../../../../src/providers/acp';

interface ConnectionHarness {
  close: () => void;
  connection: ACPClientConnection;
  nextOutbound: () => Promise<Record<string, unknown>>;
  sendInbound: (message: Record<string, unknown>) => void;
  transport: ACPJSONRPCTransport;
}

function createConnectionHarness(
  connectionFactory: (transport: ACPJSONRPCTransport) => ACPClientConnection,
): ConnectionHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output });
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const transport = new ACPJSONRPCTransport({ input, output });

  reader.on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    queued.push(message);
  });

  return {
    close: () => {
      reader.close();
      input.end();
      output.end();
    },
    connection: connectionFactory(transport),
    nextOutbound: () => {
      if (queued.length > 0) {
        return Promise.resolve(queued.shift()!);
      }
      return new Promise(resolve => waiters.push(resolve));
    },
    sendInbound: (message) => {
      input.write(`${JSON.stringify(message)}\n`);
    },
    transport,
  };
}

describe('ACPClientConnection', () => {
  it('forks a session through the ACP protocol and returns the new identity', async () => {
    const harness = createConnectionHarness(transport => new ACPClientConnection({ transport }));
    harness.transport.start();
    try {
      const pending = harness.connection.forkSession({ sessionId: 'source', cwd: '/workspace', mcpServers: [] });
      const outbound = await harness.nextOutbound();
      expect(outbound).toMatchObject({ method: 'session/fork', params: { sessionId: 'source', cwd: '/workspace', mcpServers: [] } });
      harness.sendInbound({ jsonrpc: '2.0', id: outbound.id, result: { sessionId: 'child' } });
      await expect(pending).resolves.toEqual({ sessionId: 'child' });
    } finally {
      harness.connection.dispose();
      harness.transport.dispose();
      harness.close();
    }
  });

  it('advertises derived client capabilities and dispatches session notifications', async () => {
    const notifications: ACPSessionNotification[] = [];
    const harness = createConnectionHarness((transport) => new ACPClientConnection({
      clientInfo: { name: 'claudian', version: '0.0.0-test' },
      delegate: {
        fileSystem: {
          readTextFile: async () => ({ content: 'hello' }),
        },
        onSessionNotification: async (notification) => {
          notifications.push(notification);
        },
      },
      transport,
    }));

    try {
      const initializePromise = harness.connection.initialize();
      const outbound = await harness.nextOutbound();

      expect(outbound.method).toBe('initialize');
      expect(outbound.params).toMatchObject({
        clientCapabilities: {
          fs: {
            readTextFile: true,
          },
        },
        clientInfo: { name: 'claudian', version: '0.0.0-test' },
        protocolVersion: 1,
      });

      harness.sendInbound({
        id: outbound.id,
        jsonrpc: '2.0',
        result: {
          agentCapabilities: { loadSession: true },
          agentInfo: { name: 'gemini', version: '1.0.0' },
          protocolVersion: 1,
        },
      });

      await initializePromise;

      harness.sendInbound({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'Renamed Session',
          },
        },
      });

      await new Promise(resolve => setImmediate(resolve));
      expect(notifications).toEqual([{
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'session_info_update',
          title: 'Renamed Session',
        },
      }]);
    } finally {
      harness.connection.dispose();
      harness.transport.dispose();
      harness.close();
    }
  });

  it('preserves opaque metadata across initialize, session lifecycle, and notifications', async () => {
    const notifications: ACPSessionNotification[] = [];
    const harness = createConnectionHarness((transport) => new ACPClientConnection({
      delegate: {
        onSessionNotification: (notification) => {
          notifications.push(notification);
        },
      },
      transport,
    }));

    try {
      const initializePromise = harness.connection.initialize({
        _meta: {
          nested: { enabled: true },
          'vendor.example/trace': 'trace-1',
        },
      });
      const initializeRequest = await harness.nextOutbound();
      expect(initializeRequest).toMatchObject({
        method: 'initialize',
        params: {
          _meta: {
            nested: { enabled: true },
            'vendor.example/trace': 'trace-1',
          },
        },
      });
      harness.sendInbound({
        id: initializeRequest.id,
        jsonrpc: '2.0',
        result: {
          _meta: { 'vendor.example/agent': { revision: 3 } },
          protocolVersion: 1,
        },
      });
      await expect(initializePromise).resolves.toEqual({
        _meta: { 'vendor.example/agent': { revision: 3 } },
        protocolVersion: 1,
      });

      const newSessionPromise = harness.connection.newSession({
        _meta: { 'vendor.example/session': 'new' },
        cwd: '/vault',
        mcpServers: [],
      });
      const newSessionRequest = await harness.nextOutbound();
      expect(newSessionRequest.params).toEqual({
        _meta: { 'vendor.example/session': 'new' },
        cwd: '/vault',
        mcpServers: [],
      });
      harness.sendInbound({
        id: newSessionRequest.id,
        jsonrpc: '2.0',
        result: {
          _meta: { 'vendor.example/session': 'created' },
          sessionId: 'session-1',
        },
      });
      await expect(newSessionPromise).resolves.toEqual({
        _meta: { 'vendor.example/session': 'created' },
        sessionId: 'session-1',
      });

      const loadSessionPromise = harness.connection.loadSession({
        _meta: { 'vendor.example/session': 'load' },
        cwd: '/vault',
        mcpServers: [],
        sessionId: 'session-1',
      });
      const loadSessionRequest = await harness.nextOutbound();
      expect(loadSessionRequest.params).toEqual({
        _meta: { 'vendor.example/session': 'load' },
        cwd: '/vault',
        mcpServers: [],
        sessionId: 'session-1',
      });
      harness.sendInbound({
        id: loadSessionRequest.id,
        jsonrpc: '2.0',
        result: {
          _meta: { 'vendor.example/session': 'loaded' },
          sessionId: 'session-1',
        },
      });
      await expect(loadSessionPromise).resolves.toEqual({
        _meta: { 'vendor.example/session': 'loaded' },
        sessionId: 'session-1',
      });

      harness.sendInbound({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          _meta: { 'vendor.example/notification': ['opaque'] },
          sessionId: 'session-1',
          update: {
            _meta: { 'vendor.example/update': { sequence: 1 } },
            content: { text: 'hello', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        },
      });

      await new Promise(resolve => setImmediate(resolve));
      expect(notifications).toEqual([{
        _meta: { 'vendor.example/notification': ['opaque'] },
        sessionId: 'session-1',
        update: {
          _meta: { 'vendor.example/update': { sequence: 1 } },
          content: { text: 'hello', type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      }]);
    } finally {
      harness.connection.dispose();
      harness.transport.dispose();
      harness.close();
    }
  });

  it('propagates unsupported methods without retrying a retired alias', async () => {
    const harness = createConnectionHarness(transport => new ACPClientConnection({ transport }));
    const requestSpy = jest.spyOn(harness.transport, 'request');
    try {
      const pending = harness.connection.setMode({ modeId: 'plan', sessionId: 'session-1' });
      const outcome = pending.catch(error => error);
      const outbound = await harness.nextOutbound();
      expect(outbound.method).toBe('session/set_mode');
      harness.sendInbound({ jsonrpc: '2.0', id: outbound.id, error: { code: -32601, message: 'Method not found' } });
      expect(await outcome).toMatchObject({ code: -32601 });
      expect(requestSpy).toHaveBeenCalledTimes(1);
    } finally { harness.connection.dispose(); harness.transport.dispose(); harness.close(); }
  });

  it('sets the model through the standard method with opaque metadata', async () => {
    const harness = createConnectionHarness(transport => new ACPClientConnection({ transport }));
    try {
      const pending = harness.connection.setModel({ _meta: { reasoningEffort: 'high' }, modelId: 'model-1', sessionId: 'session-1' });
      const outbound = await harness.nextOutbound();
      expect(outbound).toMatchObject({ method: 'session/set_model', params: { _meta: { reasoningEffort: 'high' }, modelId: 'model-1', sessionId: 'session-1' } });
      harness.sendInbound({ jsonrpc: '2.0', id: outbound.id, result: { _meta: { accepted: true } } });
      await expect(pending).resolves.toEqual({ _meta: { accepted: true } });
    } finally { harness.connection.dispose(); harness.transport.dispose(); harness.close(); }
  });

  it('disables request timeout for prompt turns', async () => {
    const promptRequest = {
      prompt: [{ text: 'hi', type: 'text' as const }],
      sessionId: 'session-1',
    };
    const requests: Array<{
      method: string;
      options?: JSONRPCRequestOptions;
      params?: unknown;
    }> = [];
    const transport = {
      notify: () => undefined,
      onNotification: () => () => undefined,
      onRequest: () => () => undefined,
      request: async (method: string, params?: unknown, options?: JSONRPCRequestOptions) => {
        requests.push({ method, options, params });
        return { stopReason: 'end_turn' };
      },
      signal: new AbortController().signal,
    } as unknown as ACPJSONRPCTransport;
    const connection = new ACPClientConnection({ transport });

    await expect(connection.prompt(promptRequest)).resolves.toEqual({
      stopReason: 'end_turn',
    });

    expect(requests).toEqual([
      {
        method: 'session/prompt',
        options: { timeoutMs: 0 },
        params: promptRequest,
      },
    ]);
  });

  it('sends one cancel notification using the standard method', async () => {
    const harness = createConnectionHarness(transport => new ACPClientConnection({ transport }));
    const notifySpy = jest.spyOn(harness.transport, 'notify');
    try {
      harness.connection.cancel({ sessionId: 'session-1' });
      await expect(harness.nextOutbound()).resolves.toMatchObject({ method: 'session/cancel', params: { sessionId: 'session-1' } });
      expect(notifySpy).toHaveBeenCalledTimes(1);
    } finally { harness.connection.dispose(); harness.transport.dispose(); harness.close(); }
  });
});
