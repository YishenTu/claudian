import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import type { AcpSessionNotification } from '../../../../src/providers/acp';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
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
