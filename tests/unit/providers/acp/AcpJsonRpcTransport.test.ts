import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import {
  AcpJsonRpcTransport,
  JsonRpcErrorResponse,
} from '../../../../src/providers/acp/AcpJsonRpcTransport';

interface TransportHarness {
  close: () => void;
  nextOutbound: () => Promise<Record<string, unknown>>;
  sendInbound: (message: Record<string, unknown>) => void;
  transport: AcpJsonRpcTransport;
}

function createTransportHarness(): TransportHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output });
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];

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
    nextOutbound: () => {
      if (queued.length > 0) {
        return Promise.resolve(queued.shift()!);
      }
      return new Promise(resolve => waiters.push(resolve));
    },
    sendInbound: (message) => {
      input.write(`${JSON.stringify(message)}\n`);
    },
    transport: new AcpJsonRpcTransport({ input, output }),
  };
}

describe('AcpJsonRpcTransport', () => {
  let harness: TransportHarness;

  beforeEach(() => {
    harness = createTransportHarness();
  });

  afterEach(() => {
    harness.transport.dispose();
    harness.close();
  });

  it('resolves request responses', async () => {
    const requestPromise = harness.transport.request<{ sessionId: string }>('session/new', {
      cwd: '/tmp/project',
      mcpServers: [],
    });

    const outbound = await harness.nextOutbound();
    expect(outbound.method).toBe('session/new');
    expect(outbound.jsonrpc).toBe('2.0');

    harness.sendInbound({
      id: outbound.id,
      jsonrpc: '2.0',
      result: { sessionId: 'session-1' },
    });

    await expect(requestPromise).resolves.toEqual({ sessionId: 'session-1' });
  });

  it('surfaces JSON-RPC errors with codes', async () => {
    const requestPromise = harness.transport.request('session/load', {
      cwd: '/tmp/project',
      mcpServers: [],
      sessionId: 'session-1',
    });

    const outbound = await harness.nextOutbound();
    harness.sendInbound({
      error: {
        code: -32601,
        message: 'Method not found',
      },
      id: outbound.id,
      jsonrpc: '2.0',
    });

    await expect(requestPromise).rejects.toBeInstanceOf(JsonRpcErrorResponse);
    await expect(requestPromise).rejects.toMatchObject({
      code: -32601,
      message: 'Method not found',
      method: 'session/load',
    });
  });

  it('handles server-initiated requests', async () => {
    harness.transport.start();
    harness.transport.onRequest('fs/read_text_file', async (params) => {
      expect(params).toEqual({
        path: '/tmp/project/src/index.ts',
        sessionId: 'session-1',
      });
      return { content: 'export {};' };
    });

    harness.sendInbound({
      id: 7,
      jsonrpc: '2.0',
      method: 'fs/read_text_file',
      params: {
        path: '/tmp/project/src/index.ts',
        sessionId: 'session-1',
      },
    });

    await expect(harness.nextOutbound()).resolves.toEqual({
      id: 7,
      jsonrpc: '2.0',
      result: { content: 'export {};' },
    });
  });

  it('rejects pending requests when disposed', async () => {
    const requestPromise = harness.transport.request('session/prompt', {
      prompt: [{ text: 'hi', type: 'text' }],
      sessionId: 'session-1',
    }, {
      timeoutMs: 0,
    });

    await harness.nextOutbound();
    harness.transport.dispose(new Error('transport stopped'));

    await expect(requestPromise).rejects.toThrow('transport stopped');
  });
});
