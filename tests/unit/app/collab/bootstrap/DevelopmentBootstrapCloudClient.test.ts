import { ClientRequest, createServer, type Server } from 'node:http';

import {
  collabCloudErrorEnvelope,
  collabCloudSuccessEnvelope,
  CollabError as ProtocolCollabError,
  decodeCollabProtocolEnvelope,
  developmentBootstrapOperationCodec,
  matchCollabCloudRoute,
} from '@claudian-collab/protocol';

import {
  DevelopmentBootstrapCloudClient,
} from '@/app/collab/bootstrap/DevelopmentBootstrapCloudClient';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  HOST_MEMBER_ID,
  MANIFEST_SHA256,
  PROJECT_ID,
} from './fixtures';

function attemptStatus(state: 'collecting' | 'uploaded') {
  return {
    attemptId: ATTEMPT_ID,
    bundleState: state === 'uploaded' ? 'uploaded' as const : 'missing' as const,
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
    manifestSha256: MANIFEST_SHA256,
    projectId: PROJECT_ID,
    reporterMemberIds: [],
    state: state === 'uploaded' ? 'validating' as const : state,
  };
}

describe('DevelopmentBootstrapCloudClient', () => {
  let server: Server;
  let serverUrl: string;

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  });

  it('uses package routes and actor-bound envelopes for JSON and streamed upload', async () => {
    const observations: Array<{
      readonly actor: string | undefined;
      readonly body: Buffer;
      readonly kind: string;
    }> = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
      if (match?.kind !== 'development-bootstrap') throw new Error('unexpected route');
      observations.push({
        actor: Array.isArray(request.headers['x-claudian-development-actor'])
          ? request.headers['x-claudian-development-actor'][0]
          : request.headers['x-claudian-development-actor'],
        body,
        kind: match.operation,
      });
      if (match.operation === 'beginDevelopmentBootstrap') {
        const envelope = decodeCollabProtocolEnvelope(JSON.parse(body.toString('utf8')));
        if (envelope.status !== 'ok') throw envelope.error;
        const decoded = developmentBootstrapOperationCodec(match.operation)
          .decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(collabCloudSuccessEnvelope(
          envelope.value.requestId,
          attemptStatus('collecting'),
        )));
        return;
      }
      expect(request.headers['content-type']).toBe('application/x-git-bundle');
      expect(request.headers['content-encoding']).toBe('identity');
      expect(request.headers['content-length']).toBe('3');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(collabCloudSuccessEnvelope(
        'response-upload',
        attemptStatus('uploaded'),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    serverUrl = `http://127.0.0.1:${address.port}`;
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl,
    });

    await expect(client.begin({ manifest: bootstrapManifest() }))
      .resolves.toMatchObject({ state: 'collecting' });
    await expect(client.upload({
      attemptId: ATTEMPT_ID,
      byteCount: 3,
      contentEncoding: 'identity',
      contentType: 'application/x-git-bundle',
      sha256: 'a'.repeat(64),
    }, _signal => (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })())).resolves.toMatchObject({ bundleState: 'uploaded' });

    expect(observations).toEqual([
      expect.objectContaining({ actor: HOST_MEMBER_ID, kind: 'beginDevelopmentBootstrap' }),
      expect.objectContaining({
        actor: HOST_MEMBER_ID,
        body: Buffer.from([1, 2, 3]),
        kind: 'putDevelopmentBootstrapGitBundle',
      }),
    ]);
  });

  it('removes the alternate error listener after every successful drain wait', async () => {
    server = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(collabCloudSuccessEnvelope(
        'response-backpressure',
        attemptStatus('uploaded'),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const originalWrite = ClientRequest.prototype.write;
    const errorListenerCounts: number[] = [];
    jest.spyOn(ClientRequest.prototype, 'write').mockImplementation(function (
      this: ClientRequest,
      chunk: Uint8Array,
    ): boolean {
      Reflect.apply(originalWrite, this, [chunk]);
      queueMicrotask(() => {
        this.emit('drain');
        errorListenerCounts.push(this.listenerCount('error'));
      });
      return false;
    });
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    });

    await expect(client.upload({
      attemptId: ATTEMPT_ID,
      byteCount: 20,
      contentEncoding: 'identity',
      contentType: 'application/x-git-bundle',
      sha256: 'a'.repeat(64),
    }, _signal => (async function* () {
      for (let index = 0; index < 20; index += 1) {
        yield new Uint8Array([index]);
      }
    })())).resolves.toMatchObject({ bundleState: 'uploaded' });

    expect(errorListenerCounts).toHaveLength(20);
    expect(errorListenerCounts.every(count => count === 1)).toBe(true);
  });

  it('maps a canonical Cloud error without retaining response content', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 403;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(collabCloudErrorEnvelope(
        'response-denied',
        new ProtocolCollabError({ code: 'authorization-denied' }),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    });

    await expect(client.get({ attemptId: ATTEMPT_ID })).rejects.toMatchObject({
      code: 'authorization-denied',
    });
  });

  it('aborts a stalled JSON request through the caller signal', async () => {
    server = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(collabCloudSuccessEnvelope(
          'response-stalled-get',
          attemptStatus('collecting'),
        )));
      }, 300);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    }) as unknown as {
      get(request: { attemptId: string }, signal: AbortSignal): Promise<unknown>;
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), 25);

    await expect(client.get({ attemptId: ATTEMPT_ID }, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(Date.now() - startedAt).toBeLessThan(200);
    clearTimeout(timer);
  });

  it('returns a stalled upload iterator when the caller aborts', async () => {
    server = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(collabCloudSuccessEnvelope(
          'response-stalled-upload',
          attemptStatus('uploaded'),
        )));
      }, 300);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    }) as unknown as {
      upload(
        request: {
          attemptId: string;
          byteCount: number;
          contentEncoding: 'identity';
          contentType: 'application/x-git-bundle';
          sha256: string;
        },
        body: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
        signal: AbortSignal,
      ): Promise<unknown>;
    };
    let returned = false;
    let settleNext: (() => void) | undefined;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(resolve => {
            settleNext = () => resolve({ done: true, value: undefined });
            setTimeout(settleNext, 300);
          }),
          return: async () => {
            returned = true;
            settleNext?.();
            return { done: true, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);

    await expect(client.upload({
      attemptId: ATTEMPT_ID,
      byteCount: 3,
      contentEncoding: 'identity',
      contentType: 'application/x-git-bundle',
      sha256: 'a'.repeat(64),
    }, _signal => body, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(returned).toBe(true);
    clearTimeout(timer);
  });

  it('stops and returns the upload producer before surfacing an early Cloud response', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 403;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(collabCloudErrorEnvelope(
        'response-early-denied',
        new ProtocolCollabError({ code: 'authorization-denied' }),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    });
    let returned = false;
    let producerSignal: AbortSignal | undefined;
    let nextCount = 0;
    let settleNext: (() => void) | undefined;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            nextCount += 1;
            if (nextCount === 1) {
              return { done: false as const, value: new Uint8Array([1]) };
            }
            return new Promise<IteratorResult<Uint8Array>>(resolve => {
              settleNext = () => resolve({ done: true, value: undefined });
              setTimeout(settleNext, 300);
            });
          },
          return: async () => {
            returned = true;
            settleNext?.();
            return { done: true, value: undefined };
          },
        };
      },
    };
    const startedAt = Date.now();

    await expect(client.upload({
      attemptId: ATTEMPT_ID,
      byteCount: 3,
      contentEncoding: 'identity',
      contentType: 'application/x-git-bundle',
      sha256: 'a'.repeat(64),
    }, signal => {
      producerSignal = signal;
      return body;
    })).rejects.toMatchObject({ code: 'authorization-denied' });

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(returned).toBe(true);
    expect(producerSignal?.aborted).toBe(true);
  });

  it('bounds a stalled upload iterator cleanup after an early Cloud response', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 403;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(collabCloudErrorEnvelope(
        'response-early-stalled-cleanup',
        new ProtocolCollabError({ code: 'authorization-denied' }),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    });
    let nextCount = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextCount += 1;
            return nextCount === 1
              ? Promise.resolve({ done: false as const, value: new Uint8Array([1]) })
              : new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        };
      },
    };
    const startedAt = Date.now();

    await expect(client.upload({
      attemptId: ATTEMPT_ID,
      byteCount: 3,
      contentEncoding: 'identity',
      contentType: 'application/x-git-bundle',
      sha256: 'a'.repeat(64),
    }, _signal => body)).rejects.toMatchObject({ code: 'operation-timeout' });

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('returns the upload producer before surfacing the total request deadline', async () => {
    jest.useFakeTimers();
    let requestReceived!: () => void;
    const received = new Promise<void>(resolve => { requestReceived = resolve; });
    server = createServer(() => requestReceived());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const client = new DevelopmentBootstrapCloudClient({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: `http://127.0.0.1:${address.port}`,
    });
    let returned = false;
    let settleReturn!: () => void;
    let nextCount = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextCount += 1;
            return nextCount === 1
              ? Promise.resolve({ done: false as const, value: new Uint8Array([1]) })
              : new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: () => new Promise<IteratorResult<Uint8Array>>(resolve => {
            returned = true;
            settleReturn = () => resolve({ done: true, value: undefined });
          }),
        };
      },
    };
    const upload = client.upload({
      attemptId: ATTEMPT_ID,
      byteCount: 3,
      contentEncoding: 'identity',
      contentType: 'application/x-git-bundle',
      sha256: 'a'.repeat(64),
    }, _signal => body);
    const observed = upload.then(
      value => ({ error: null, value }),
      error => ({ error, value: null }),
    );
    let settled = false;
    void observed.then(() => { settled = true; });
    await received;

    jest.advanceTimersByTime(15 * 60 * 1_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(returned).toBe(true);
    expect(settled).toBe(false);

    settleReturn();
    await expect(observed).resolves.toMatchObject({
      error: { code: 'operation-timeout' },
      value: null,
    });
    jest.useRealTimers();
  });
});
