import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { requestHttpsBytes } from '@/app/collab/lan/httpsRequest';
import { LanTlsIdentity, type LanTlsServerIdentity } from '@/app/collab/lan/LanTlsIdentity';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('requestHttpsBytes', () => {
  let directory: string;
  let identity: LanTlsServerIdentity;
  let server: Server;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'claudian-https-bytes-'));
    identity = await new LanTlsIdentity(directory, {
      installationKey: TEST_INSTALLATION_A,
    }).issueServerIdentity('127.0.0.1');
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function listen(handler: Parameters<typeof createServer>[1]) {
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    return {
      ca: identity.caCertificatePem,
      hostname: '127.0.0.1',
      method: 'POST',
      path: '/bytes',
      port: address.port,
    };
  }

  it('preserves request and response bytes, status, and headers at the byte limit', async () => {
    const request = await listen((incoming, response) => {
      response.writeHead(201, { 'content-type': 'application/octet-stream' });
      incoming.pipe(response);
    });
    const body = Buffer.from('é雪', 'utf8');
    await expect(requestHttpsBytes(request, {
      body, maxResponseBytes: 5, timeoutMs: 1_000,
    })).resolves.toMatchObject({
      body,
      headers: { 'content-type': 'application/octet-stream' },
      statusCode: 201,
    });
  });

  it('rejects an untrusted server before transmitting HTTP credentials', async () => {
    let authorization: string | undefined;
    const request = await listen((incoming, response) => {
      authorization = incoming.headers.authorization;
      response.end();
    });
    await expect(requestHttpsBytes({
      ...request,
      ca: [],
      headers: { authorization: 'Bearer private-credential' },
    }, {
      body: null, maxResponseBytes: 100, timeoutMs: 1_000,
    })).rejects.toMatchObject({ reason: 'tls-untrusted' });
    expect(authorization).toBeUndefined();
  });

  it('rejects an oversized chunked response without waiting for its end', async () => {
    const closed = deferred();
    const request = await listen((_incoming, response) => {
      response.once('close', () => closed.resolve());
      response.write('é');
      response.write('雪');
      response.write('!');
    });
    await expect(requestHttpsBytes(request, {
      body: null, maxResponseBytes: 5, timeoutMs: 1_000,
    })).rejects.toMatchObject({ reason: 'response-too-large' });
    await closed.promise;
  });

  it.each(['cancelled', 'timeout'] as const)(
    'closes a stalled response when %s', async reason => {
      const received = deferred();
      const closed = deferred();
      const request = await listen((_incoming, response) => {
        response.once('close', () => closed.resolve());
        response.write('partial');
        received.resolve();
      });
      const controller = new AbortController();
      const result = requestHttpsBytes(request, {
        body: null,
        maxResponseBytes: 100,
        signal: controller.signal,
        timeoutMs: reason === 'timeout' ? 100 : 1_000,
      }).catch((error: unknown) => error);
      await received.promise;
      if (reason === 'cancelled') controller.abort();
      await expect(result).resolves.toMatchObject({ reason });
      await closed.promise;
    },
  );

  it('rejects a response that closes before its declared content length', async () => {
    const request = await listen((_incoming, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('partial', () => response.destroy());
    });
    await expect(requestHttpsBytes(request, {
      body: null, maxResponseBytes: 100, timeoutMs: 1_000,
    })).rejects.toMatchObject({ reason: 'response-failed' });
  });
});
