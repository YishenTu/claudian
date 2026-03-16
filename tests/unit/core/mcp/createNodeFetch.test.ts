import * as http from 'http';
import type { AddressInfo } from 'net';

import { createNodeFetch } from '@/core/mcp/McpTester';

interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function createTestServer(handler?: (req: ReceivedRequest, res: http.ServerResponse) => void): {
  server: http.Server;
  getUrl: () => string;
  received: ReceivedRequest[];
} {
  const received: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: ReceivedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      received.push(entry);

      if (handler) {
        handler(entry, res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  server.listen(0);

  return {
    server,
    getUrl: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
    received,
  };
}

describe('createNodeFetch', () => {
  let server: http.Server;
  let getUrl: () => string;
  let received: ReceivedRequest[];
  let nodeFetch: ReturnType<typeof createNodeFetch>;
  const serversToClose: http.Server[] = [];

  beforeAll(() => {
    ({ server, getUrl, received } = createTestServer());
    nodeFetch = createNodeFetch();
  });

  afterAll(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }));

  afterEach(async () => {
    received.length = 0;
    await Promise.all(
      serversToClose.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    serversToClose.length = 0;
  });

  it('should set Content-Length header for POST with body', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    const response = await nodeFetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(response.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(received[0].headers['transfer-encoding']).toBeUndefined();
  });

  it('should deliver valid JSON body without chunk framing', async () => {
    const payload = { jsonrpc: '2.0', method: 'tools/list', id: 2 };
    const body = JSON.stringify(payload);

    await nodeFetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0].body);
    expect(parsed).toEqual(payload);
  });

  it('should not set Content-Length for GET requests without body', async () => {
    await nodeFetch(getUrl(), { method: 'GET' });

    expect(received).toHaveLength(1);
    expect(received[0].headers['content-length']).toBeUndefined();
    expect(received[0].method).toBe('GET');
  });

  it('should forward custom headers', async () => {
    await nodeFetch(getUrl(), {
      method: 'GET',
      headers: { 'X-Custom': 'test-value', Authorization: 'Bearer token123' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].headers['x-custom']).toBe('test-value');
    expect(received[0].headers['authorization']).toBe('Bearer token123');
  });

  it('should return response status and body', async () => {
    const response = await nodeFetch(getUrl(), { method: 'GET' });

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);

    const data = await response.json() as { ok: boolean };
    expect(data).toEqual({ ok: true });
  });

  it('should handle non-200 responses', async () => {
    const { server: errorServer, getUrl: errorUrl, received: errorReceived } = createTestServer(
      (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      },
    );
    serversToClose.push(errorServer);

    const response = await nodeFetch(errorUrl(), { method: 'GET' });

    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(errorReceived).toHaveLength(1);

    const data = await response.json() as { error: string };
    expect(data).toEqual({ error: 'not found' });
  });

  it('should support abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      nodeFetch(getUrl(), { method: 'GET', signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('should accept URL object as input', async () => {
    const url = new URL(getUrl());

    const response = await nodeFetch(url, { method: 'GET' });

    expect(response.ok).toBe(true);
    expect(received).toHaveLength(1);
  });

  it('should handle multi-byte characters in body with correct Content-Length', async () => {
    const body = JSON.stringify({ text: '你好世界' });

    await nodeFetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(received).toHaveLength(1);
    // Content-Length should be byte length, not character length
    expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(body)));
    const parsed = JSON.parse(received[0].body) as { text: string };
    expect(parsed.text).toBe('你好世界');
  });
});
