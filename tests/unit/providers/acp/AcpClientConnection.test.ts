import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import type {
  AcpSessionNotification,
  JsonRpcRequestOptions,
} from '../../../../src/providers/acp';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  JsonRpcErrorResponse,
} from '../../../../src/providers/acp';

interface ConnectionHarness {
  close: () => void;
  connection: AcpClientConnection;
  nextOutbound: () => Promise<Record<string, unknown>>;
  sendInbound: (message: Record<string, unknown>) => void;
  transport: AcpJsonRpcTransport;
}

function createConnectionHarness(
  connectionFactory: (transport: AcpJsonRpcTransport) => AcpClientConnection,
): ConnectionHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output });
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const transport = new AcpJsonRpcTransport({ input, output });

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

describe('AcpClientConnection', () => {
  it('advertises derived client capabilities and dispatches session notifications', async () => {
    const notifications: AcpSessionNotification[] = [];
    const harness = createConnectionHarness((transport) => new AcpClientConnection({
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
    const notifications: AcpSessionNotification[] = [];
    const harness = createConnectionHarness((transport) => new AcpClientConnection({
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

  it('falls back to legacy method names and caches the resolved method', async () => {
    const harness = createConnectionHarness((transport) => new AcpClientConnection({ transport }));

    try {
      const firstPromise = harness.connection.setMode({
        modeId: 'plan',
        sessionId: 'session-1',
      });

      const firstAttempt = await harness.nextOutbound();
      expect(firstAttempt.method).toBe('session/set_mode');
      harness.sendInbound({
        error: {
          code: -32601,
          message: 'Method not found',
        },
        id: firstAttempt.id,
        jsonrpc: '2.0',
      });

      const secondAttempt = await harness.nextOutbound();
      expect(secondAttempt.method).toBe('setSessionMode');
      harness.sendInbound({
        id: secondAttempt.id,
        jsonrpc: '2.0',
        result: {},
      });

      await expect(firstPromise).resolves.toEqual({});

      const cachedPromise = harness.connection.setMode({
        modeId: 'plan',
        sessionId: 'session-1',
      });

      const cachedAttempt = await harness.nextOutbound();
      expect(cachedAttempt.method).toBe('setSessionMode');
      harness.sendInbound({
        id: cachedAttempt.id,
        jsonrpc: '2.0',
        result: {},
      });

      await expect(cachedPromise).resolves.toEqual({});
    } finally {
      harness.connection.dispose();
      harness.transport.dispose();
      harness.close();
    }
  });

  it('negotiates the standard set-model method and caches the legacy fallback', async () => {
    const harness = createConnectionHarness((transport) => new AcpClientConnection({ transport }));

    try {
      const firstPromise = harness.connection.setModel({
        _meta: { reasoningEffort: 'high' },
        modelId: 'model-1',
        sessionId: 'session-1',
      });

      const firstAttempt = await harness.nextOutbound();
      expect(firstAttempt).toMatchObject({
        method: 'session/set_model',
        params: {
          _meta: { reasoningEffort: 'high' },
          modelId: 'model-1',
          sessionId: 'session-1',
        },
      });
      harness.sendInbound({
        error: {
          code: -32601,
          message: 'Method not found',
        },
        id: firstAttempt.id,
        jsonrpc: '2.0',
      });

      const secondAttempt = await harness.nextOutbound();
      expect(secondAttempt.method).toBe('setSessionModel');
      harness.sendInbound({
        id: secondAttempt.id,
        jsonrpc: '2.0',
        result: { _meta: { accepted: true } },
      });
      await expect(firstPromise).resolves.toEqual({ _meta: { accepted: true } });

      const cachedPromise = harness.connection.setModel({
        modelId: 'model-2',
        sessionId: 'session-1',
      });
      const cachedAttempt = await harness.nextOutbound();
      expect(cachedAttempt).toMatchObject({
        method: 'setSessionModel',
        params: {
          modelId: 'model-2',
          sessionId: 'session-1',
        },
      });
      harness.sendInbound({
        id: cachedAttempt.id,
        jsonrpc: '2.0',
        result: {},
      });
      await expect(cachedPromise).resolves.toEqual({});
    } finally {
      harness.connection.dispose();
      harness.transport.dispose();
      harness.close();
    }
  });

  it('disables request timeout for prompt turns across method fallback', async () => {
    const promptRequest = {
      prompt: [{ text: 'hi', type: 'text' as const }],
      sessionId: 'session-1',
    };
    const requests: Array<{
      method: string;
      options?: JsonRpcRequestOptions;
      params?: unknown;
    }> = [];
    const transport = {
      notify: () => undefined,
      onNotification: () => () => undefined,
      onRequest: () => () => undefined,
      request: async (method: string, params?: unknown, options?: JsonRpcRequestOptions) => {
        requests.push({ method, options, params });
        if (method === 'session/prompt') {
          throw new JsonRpcErrorResponse(method, -32601, 'Method not found');
        }
        return { stopReason: 'end_turn' };
      },
      signal: new AbortController().signal,
    } as unknown as AcpJsonRpcTransport;
    const connection = new AcpClientConnection({ transport });

    await expect(connection.prompt(promptRequest)).resolves.toEqual({
      stopReason: 'end_turn',
    });

    expect(requests).toEqual([
      {
        method: 'session/prompt',
        options: { timeoutMs: 0 },
        params: promptRequest,
      },
      {
        method: 'prompt',
        options: { timeoutMs: 0 },
        params: promptRequest,
      },
    ]);
  });

  it('sends cancel notifications to all known aliases when no working method is cached', async () => {
    const harness = createConnectionHarness((transport) => new AcpClientConnection({ transport }));

    try {
      harness.connection.cancel({ sessionId: 'session-1' });

      await expect(harness.nextOutbound()).resolves.toMatchObject({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'session-1' },
      });
      await expect(harness.nextOutbound()).resolves.toMatchObject({
        jsonrpc: '2.0',
        method: 'cancel',
        params: { sessionId: 'session-1' },
      });
    } finally {
      harness.connection.dispose();
      harness.transport.dispose();
      harness.close();
    }
  });
});
