import { createServer, type Server } from 'node:http';

import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import {
  type CloudAuthorityHttpRequest,
  NodeCloudAuthorityHttpTransport,
} from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => {
    if (error) reject(error);
    else resolve();
  }));
}

function request(
  url: string,
  overrides: Partial<CloudAuthorityHttpRequest> = {},
): CloudAuthorityHttpRequest {
  return {
    headers: { 'x-test-actor': 'actor-test' },
    method: 'GET',
    url,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('NodeCloudAuthorityHttpTransport', () => {
  it('sends one bounded JSON request and projects the response metadata', async () => {
    type ReceivedRequest = {
      readonly body: string;
      readonly contentLength: string | undefined;
      readonly contentType: string | undefined;
      readonly actor: string | undefined;
    };
    let resolveReceived!: (value: ReceivedRequest) => void;
    const received = new Promise<ReceivedRequest>(resolve => { resolveReceived = resolve; });
    const origin = await listen(createServer(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      resolveReceived({
        actor: typeof incoming.headers['x-test-actor'] === 'string'
          ? incoming.headers['x-test-actor']
          : undefined,
        body: Buffer.concat(chunks).toString('utf8'),
        contentLength: incoming.headers['content-length'],
        contentType: incoming.headers['content-type'],
      });
      response.statusCode = 201;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end('{"accepted":true}');
    }));
    const transport = new NodeCloudAuthorityHttpTransport();

    await expect(transport.request(request(`${origin}/operation`, {
      body: { projectId: 'project-test' },
      method: 'POST',
    }))).resolves.toEqual({
      body: { accepted: true },
      contentType: 'application/json; charset=utf-8',
      status: 201,
    });
    await expect(received).resolves.toEqual({
      actor: 'actor-test',
      body: '{"projectId":"project-test"}',
      contentLength: String(Buffer.byteLength('{"projectId":"project-test"}')),
      contentType: 'application/json; charset=utf-8',
    });
  });

  it('does not add body headers to a bodyless request', async () => {
    let resolveHeaders!: (value: {
      readonly contentLength: string | undefined;
      readonly contentType: string | undefined;
    }) => void;
    const receivedHeaders = new Promise<{
      readonly contentLength: string | undefined;
      readonly contentType: string | undefined;
    }>(resolve => { resolveHeaders = resolve; });
    const origin = await listen(createServer((incoming, response) => {
      resolveHeaders({
        contentLength: incoming.headers['content-length'],
        contentType: incoming.headers['content-type'],
      });
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/bodyless`),
    )).resolves.toMatchObject({ body: {}, status: 200 });
    await expect(receivedHeaders).resolves.toEqual({
      contentLength: undefined,
      contentType: undefined,
    });
  });

  it('maps a non-serializable request body to a sanitized error', async () => {
    const body: { self?: unknown } = {};
    body.self = body;

    await expect(new NodeCloudAuthorityHttpTransport().request(request(
      'http://127.0.0.1:1/invalid-body',
      { body, method: 'POST' },
    ))).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'cloud-authority-request-body-invalid' },
    });
  });

  it('rejects an already-cancelled request without opening a connection', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(new NodeCloudAuthorityHttpTransport().request(request(
      'http://127.0.0.1:1/cancelled',
      { signal: controller.signal },
    ))).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'cloud-authority-request-cancelled' },
    });
  });

  it('destroys a stalled request when the caller cancels it', async () => {
    let requestReceived!: () => void;
    const received = new Promise<void>(resolve => { requestReceived = resolve; });
    const origin = await listen(createServer(() => requestReceived()));
    const controller = new AbortController();
    const pending = new NodeCloudAuthorityHttpTransport().request(request(
      `${origin}/stalled`,
      { signal: controller.signal },
    ));
    await received;

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'cloud-authority-request-cancelled' },
    });
  });

  it('destroys a stalled request at its configured deadline', async () => {
    const origin = await listen(createServer(() => undefined));

    await expect(new NodeCloudAuthorityHttpTransport(20).request(
      request(`${origin}/stalled`),
    )).rejects.toMatchObject({
      code: 'operation-timeout',
      safeContext: { reason: 'cloud-authority-request-timeout' },
    });
  });

  it.each([
    '0001',
    String(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes + 1),
  ])('rejects invalid or oversized declared response length %s', async contentLength => {
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-length', contentLength);
      response.setHeader('content-type', 'application/json');
      response.end('0');
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/declared-size`),
    )).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'cloud-authority-response-too-large' },
    });
  });

  it('accepts a valid JSON response exactly at the payload limit', async () => {
    const body = JSON.stringify(
      'x'.repeat(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes - 2),
    );
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-length', String(Buffer.byteLength(body)));
      response.setHeader('content-type', 'application/json');
      response.end(body);
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/exact-size`),
    )).resolves.toEqual({
      body: 'x'.repeat(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes - 2),
      contentType: 'application/json',
      status: 200,
    });
  });

  it('stops a chunked response as soon as the streamed limit is crossed', async () => {
    const chunk = Buffer.alloc(Math.floor(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes / 2) + 1);
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.write(chunk);
      response.write(chunk);
      response.end();
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/streamed-size`),
    )).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'cloud-authority-response-too-large' },
    });
  });

  it.each(['', '{"incomplete":'])('rejects an invalid JSON response %#', async body => {
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(body);
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/invalid-json`),
    )).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'cloud-authority-response-invalid' },
    });
  });

  it('rejects a response stream that closes before completion', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.flushHeaders();
      response.write('{"incomplete":');
      setImmediate(() => response.destroy());
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/closed`),
    )).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'cloud-authority-response-invalid' },
    });
  });

  it('maps an unreachable endpoint without exposing the native error', async () => {
    const closed = createServer();
    const origin = await listen(closed);
    await closeServer(closed);
    servers.splice(servers.indexOf(closed), 1);

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/unreachable`),
    )).rejects.toMatchObject({
      code: 'endpoint-unreachable',
      safeContext: { reason: 'cloud-authority-request-failed' },
    });
  });

  it('returns a redirect without contacting its target', async () => {
    let redirectedRequests = 0;
    const targetOrigin = await listen(createServer((_request, response) => {
      redirectedRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end('{"unexpected":true}');
    }));
    const origin = await listen(createServer((_request, response) => {
      response.statusCode = 307;
      response.setHeader('content-type', 'application/json');
      response.setHeader('location', `${targetOrigin}/target`);
      response.end('{"redirected":true}');
    }));

    await expect(new NodeCloudAuthorityHttpTransport().request(
      request(`${origin}/redirect`),
    )).resolves.toEqual({
      body: { redirected: true },
      contentType: 'application/json',
      status: 307,
    });
    expect(redirectedRequests).toBe(0);
  });

  it('fails closed on a non-HTTP request URL', async () => {
    await expect(new NodeCloudAuthorityHttpTransport().request(
      request('ftp://cloud.example.test/project'),
    )).rejects.toMatchObject({
      code: 'endpoint-unreachable',
      safeContext: { reason: 'cloud-authority-request-failed' },
    });
  });
});
