import { createServer, type Server, type ServerResponse } from 'node:http';
import { PassThrough, Readable } from 'node:stream';

import { collabCloudErrorEnvelope,CollabError } from '@claudian-collab/protocol';

import {
  NodeCloudAuthorityArtifactTransport,
} from '@/app/collab/remote-authority/NodeCloudAuthorityArtifactTransport';
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('NodeCloudAuthorityArtifactTransport', () => {
  it('streams exact uploads and downloads without renderer fetch', async () => {
    const uploaded: Buffer[] = [];
    const origin = await listen(createServer(async (request, response) => {
      if (request.method === 'PUT') {
        for await (const chunk of request) uploaded.push(Buffer.from(chunk));
        response.writeHead(204, { 'content-length': '0' });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-length': '8',
        'content-type': 'application/octet-stream',
      });
      response.write('arti');
      response.end('fact');
    }));
    const transport = new NodeCloudAuthorityArtifactTransport();
    await expect(transport.upload({
      body: Readable.from(['artifact']),
      byteCount: 8,
      headers: { 'x-test': 'actor' },
      maximumBytes: 8,
      url: `${origin}/upload`,
    })).resolves.toMatchObject({ status: 204 });
    const response = await transport.download({
      headers: { 'x-test': 'actor' },
      maximumBytes: 8,
      url: `${origin}/download`,
    });
    expect('byteCount' in response).toBe(true);
    if (!('byteCount' in response)) throw new Error('expected artifact response');
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(uploaded).toString('utf8')).toBe('artifact');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('artifact');
  });

  it('maps JSON errors while preserving the package envelope', async () => {
    const origin = await listen(createServer((_request, response) => {
      const body = JSON.stringify(collabCloudErrorEnvelope(
        'request-artifact',
        new CollabError({ code: 'authority-transfer-stale' }),
      ));
      response.writeHead(409, {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(body);
    }));
    await expect(new NodeCloudAuthorityArtifactTransport().download({
      headers: {},
      maximumBytes: 16,
      url: `${origin}/error`,
    })).resolves.toMatchObject({ status: 409 });
  });

  it('owns abort and deadline cleanup for stalled streams', async () => {
    const origin = await listen(createServer(() => undefined));
    const controller = new AbortController();
    const cancelled = new NodeCloudAuthorityArtifactTransport().download({
      headers: {},
      maximumBytes: 16,
      signal: controller.signal,
      url: `${origin}/cancelled`,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    await expect(new NodeCloudAuthorityArtifactTransport(20, 100).download({
      headers: {},
      maximumBytes: 16,
      url: `${origin}/timeout`,
    })).rejects.toMatchObject({ code: 'operation-timeout' });
  });

  it('resets the idle timeout while a download continues making progress', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let serverResponse!: ServerResponse;
    const origin = await listen(createServer((_request, response) => {
      serverResponse = response;
      response.writeHead(200, {
        'content-length': '5',
        'content-type': 'application/octet-stream',
      });
      response.write('x');
    }));
    const response = await new NodeCloudAuthorityArtifactTransport(20, 200).download({
      headers: {},
      maximumBytes: 5,
      url: `${origin}/progress`,
    });
    if (!('byteCount' in response)) throw new Error('expected artifact response');

    const chunks = response.body[Symbol.asyncIterator]();
    await expect(chunks.next()).resolves.toEqual({ done: false, value: Buffer.from('x') });
    for (let index = 1; index < 5; index += 1) {
      await jest.advanceTimersByTimeAsync(10);
      serverResponse.write('x');
      await expect(chunks.next()).resolves.toEqual({ done: false, value: Buffer.from('x') });
    }
    serverResponse.end();

    await expect(chunks.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('closes the HTTP response when the artifact consumer destroys its body', async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>(resolve => { markClosed = resolve; });
    const origin = await listen(createServer((request, response) => {
      request.once('close', markClosed);
      response.writeHead(200, {
        'content-length': '1024',
        'content-type': 'application/octet-stream',
      });
      response.write('x');
    }));
    const response = await new NodeCloudAuthorityArtifactTransport(200, 2_000).download({
      headers: {},
      maximumBytes: 1024,
      url: `${origin}/consumer-destroy`,
    });
    if (!('byteCount' in response)) throw new Error('expected artifact response');

    response.body.destroy();

    await expect(Promise.race([
      closed.then(() => true),
      new Promise<false>(resolve => window.setTimeout(() => resolve(false), 100)),
    ])).resolves.toBe(true);
  });

  it('times out an idle stream even when its absolute deadline remains open', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(200, {
        'content-length': '2',
        'content-type': 'application/octet-stream',
      });
      response.write('x');
    }));
    const response = await new NodeCloudAuthorityArtifactTransport(20, 200).download({
      headers: {},
      maximumBytes: 2,
      url: `${origin}/idle`,
    });
    if (!('byteCount' in response)) throw new Error('expected artifact response');

    const chunks = response.body[Symbol.asyncIterator]();
    await expect(chunks.next()).resolves.toEqual({ done: false, value: Buffer.from('x') });
    await Promise.all([
      expect(chunks.next()).rejects.toMatchObject({ code: 'operation-timeout' }),
      jest.advanceTimersByTimeAsync(20),
    ]);
  });

  it('enforces the absolute deadline despite continuous stream progress', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let serverResponse!: ServerResponse;
    const origin = await listen(createServer((_request, response) => {
      serverResponse = response;
      response.writeHead(200, {
        'content-length': '10',
        'content-type': 'application/octet-stream',
      });
      response.write('x');
    }));
    const response = await new NodeCloudAuthorityArtifactTransport(20, 45).download({
      headers: {},
      maximumBytes: 10,
      url: `${origin}/deadline`,
    });
    if (!('byteCount' in response)) throw new Error('expected artifact response');

    const chunks = response.body[Symbol.asyncIterator]();
    await expect(chunks.next()).resolves.toEqual({ done: false, value: Buffer.from('x') });
    for (let elapsed = 10; elapsed <= 40; elapsed += 10) {
      await jest.advanceTimersByTimeAsync(10);
      serverResponse.write('x');
      await expect(chunks.next()).resolves.toEqual({ done: false, value: Buffer.from('x') });
    }
    await Promise.all([
      expect(chunks.next()).rejects.toMatchObject({ code: 'operation-timeout' }),
      jest.advanceTimersByTimeAsync(5),
    ]);
  });

  it('rejects invalid lengths and destroys a mismatched response stream', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(200, {
        connection: 'close',
        'content-length': '9',
        'content-type': 'application/octet-stream',
      });
      response.end('short');
    }));
    const response = await new NodeCloudAuthorityArtifactTransport().download({
      headers: {},
      maximumBytes: 9,
      url: `${origin}/short`,
    });
    if (!('byteCount' in response)) throw new Error('expected artifact response');
    await expect((async () => {
      for await (const chunk of response.body) void chunk;
    })()).rejects.toMatchObject({ code: 'protocol-payload-invalid' });

    await expect(new NodeCloudAuthorityArtifactTransport().upload({
      body: Readable.from(['oversized']),
      byteCount: 9,
      headers: {},
      maximumBytes: 8,
      url: `${origin}/upload`,
    })).rejects.toMatchObject({ code: 'operation-failed' });
  });

  it('waits for an exact request body after an early successful response', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(204, { 'content-length': '0' });
      response.end();
    }));
    const body = new PassThrough();
    let settled = false;
    const uploaded = new NodeCloudAuthorityArtifactTransport().upload({
      body,
      byteCount: 2,
      headers: {},
      maximumBytes: 2,
      url: `${origin}/upload`,
    }).finally(() => {
      settled = true;
    });

    body.write('a');
    await new Promise<void>(resolve => window.setTimeout(resolve, 20));
    expect(settled).toBe(false);

    body.end('b');
    await expect(uploaded).resolves.toMatchObject({ status: 204 });
  });

  it('rejects a short request body after an early successful response', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(204, { 'content-length': '0' });
      response.end();
    }));

    await expect(new NodeCloudAuthorityArtifactTransport().upload({
      body: Readable.from(['a']),
      byteCount: 2,
      headers: {},
      maximumBytes: 2,
      url: `${origin}/upload`,
    })).rejects.toMatchObject({ code: 'operation-failed' });
  });
});
