import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestHttpRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface TestHttpServer {
  server: http.Server;
  getUrl: () => string;
  received: TestHttpRequest[];
}

export async function createTestHttpServer(
  handler?: (request: TestHttpRequest, response: http.ServerResponse) => void,
): Promise<TestHttpServer> {
  const received: TestHttpRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: TestHttpRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      received.push(entry);

      if (handler) {
        handler(entry, response);
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    getUrl: () => {
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}`;
    },
    received,
  };
}
