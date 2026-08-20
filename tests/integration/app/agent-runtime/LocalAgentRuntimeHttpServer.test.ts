import {
  createServer,
  request as createRequest,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AgentRuntimeGateway,
  type CollabAgentPort,
} from '@/app/agent-runtime/AgentRuntimeGateway';
import {
  LocalAgentRuntimeHttpServer,
  type LocalAgentRuntimeHttpServerEndpoint,
} from '@/app/agent-runtime/LocalAgentRuntimeHttpServer';

function readPort(): jest.Mocked<CollabAgentPort> {
  return {
    acceptRequest: jest.fn(),
    addComment: jest.fn(),
    addTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    confirmPublish: jest.fn(),
    createTicket: jest.fn(),
    inspectProject: jest.fn(),
    listProjects: jest.fn().mockResolvedValue({ status: 'success', value: [] }),
    listTickets: jest.fn(),
    publish: jest.fn(),
    boundedQueries: {
      listRequestComments: jest.fn(),
      listTicketAcceptedRelations: jest.fn(),
      listTicketComments: jest.fn(),
      prepareReview: jest.fn(),
      readTicket: jest.fn(),
    },
    readConflict: jest.fn(),
    readConflictFile: jest.fn(),
    readProjectSelection: jest.fn().mockResolvedValue({
      status: 'success',
      value: { projects: [], selectedProjectId: null },
    }),
    readReviewFile: jest.fn(),
    readSnapshot: jest.fn(),
    readWorkingTreeReviewFile: jest.fn(),
    reopenTicket: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

async function post(
  endpoint: LocalAgentRuntimeHttpServerEndpoint,
  body: unknown,
): Promise<Response> {
  return fetch(endpoint.rpcUrl, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

describe('LocalAgentRuntimeHttpServer', () => {
  const runtimes: LocalAgentRuntimeHttpServer[] = [];
  const occupiedServers: Server[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
    await Promise.allSettled(occupiedServers.splice(0).map(closeServer));
  });

  function runtime(
    resolveCollab: () => Promise<CollabAgentPort | null> = async () => readPort(),
    portCandidates: readonly number[] = [0],
    handlerShutdownTimeoutMs?: number,
    invocationTimeoutMs?: number,
    maxResponseBytes?: number,
  ): LocalAgentRuntimeHttpServer {
    const value = new LocalAgentRuntimeHttpServer(
      new AgentRuntimeGateway(resolveCollab),
      {
        ...(handlerShutdownTimeoutMs === undefined ? {} : { handlerShutdownTimeoutMs }),
        ...(invocationTimeoutMs === undefined ? {} : { invocationTimeoutMs }),
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
        portCandidates,
      },
    );
    runtimes.push(value);
    return value;
  }

  it('serves consistent protocol-4 discovery on the versioned loopback route', async () => {
    const endpoint = await runtime().start();

    expect(new URL(endpoint.origin).hostname).toBe('127.0.0.1');
    expect(endpoint.rpcUrl).toBe(`${endpoint.origin}/v1/rpc`);
    const response = await post(endpoint, {
      id: 'operations-1',
      method: 'runtime.operations.list',
      params: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'operations-1',
      result: {
        access: 'read-write',
        name: 'claudian-agent-runtime',
        protocolVersion: 5,
      },
    });

    await expect((await post(endpoint, {
      id: 'health-1',
      method: 'runtime.health.check',
      params: {},
    })).json()).resolves.toEqual({
      id: 'health-1',
      result: { ok: true, protocolVersion: 5 },
    });
    await expect((await post(endpoint, {
      id: 'operation-1',
      method: 'runtime.operations.get',
      params: { name: 'collab.projects.get' },
    })).json()).resolves.toMatchObject({
      id: 'operation-1',
      result: {
        operation: { name: 'collab.projects.get' },
        protocolVersion: 5,
      },
    });
  });

  it.each([
    ['wrong path', '/missing', { method: 'POST' }, 404, 'RPC route not found.'],
    ['wrong method', '/v1/rpc', { method: 'GET' }, 405, 'RPC method must be POST.'],
    [
      'unsupported media type',
      '/v1/rpc',
      { body: '{}', headers: { 'Content-Type': 'text/plain' }, method: 'POST' },
      415,
      'Content-Type must be application/json.',
    ],
    [
      'malformed JSON',
      '/v1/rpc',
      { body: '{', headers: { 'Content-Type': 'application/json' }, method: 'POST' },
      400,
      'Invalid JSON request body.',
    ],
  ] as const)('rejects %s without resolving Collab', async (
    _label,
    path,
    init,
    expectedStatus,
    expectedMessage,
  ) => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const endpoint = await runtime(resolveCollab).start();

    const response = await fetch(`${endpoint.origin}${path}`, init);

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get('allow')).toBe(expectedStatus === 405 ? 'POST' : null);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_request', message: expectedMessage },
      id: null,
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('rejects invalid and oversized RPC bodies before dispatch', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const endpoint = await runtime(resolveCollab).start();

    const invalid = await post(endpoint, { id: 'missing-fields' });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'invalid_request' },
      id: null,
    });

    const oversized = await fetch(endpoint.rpcUrl, {
      body: JSON.stringify({
        id: 'large-1',
        method: 'runtime.health.check',
        padding: 'x'.repeat(65_536),
        params: {},
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(oversized.status).toBe(413);
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('returns a correlated timeout and fences non-cooperative late work', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const port = readPort();
    port.listProjects.mockImplementation(() => {
      markStarted?.();
      return new Promise(() => undefined);
    });
    const server = runtime(async () => port, [0], 20, 20);
    const endpoint = await server.start();

    const responsePromise = post(endpoint, {
      id: 'timeout-1',
      method: 'collab.projects.list',
      params: {},
    });
    await started;
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'request_timeout',
        message: 'Agent Runtime request timed out.',
      },
      id: 'timeout-1',
    });
    const before = Date.now();
    await server.close();
    expect(Date.now() - before).toBeLessThan(500);
  });

  it('measures the response cap from serialized UTF-8 bytes', async () => {
    const project = {
      authorityKind: 'lan' as const,
      connectionStatus: 'connected' as const,
      health: 'healthy' as const,
      hostStatus: 'stopped' as const,
      id: 'project-unicode',
      name: '界'.repeat(32),
      workspacePath: 'workspace/unicode',
    };
    const expected = {
      id: 'unicode-1',
      result: {
        projects: [{
          connectionStatus: project.connectionStatus,
          health: project.health,
          id: project.id,
          name: project.name,
        }],
        selectedProjectId: null,
      },
    };
    const exactBytes = Buffer.byteLength(JSON.stringify(expected), 'utf8');
    const exactPort = readPort();
    exactPort.listProjects.mockResolvedValue({ status: 'success', value: [project] });
    const exactEndpoint = await runtime(
      async () => exactPort,
      [0],
      undefined,
      undefined,
      exactBytes,
    ).start();

    const accepted = await post(exactEndpoint, {
      id: 'unicode-1',
      method: 'collab.projects.list',
      params: {},
    });
    await expect(accepted.json()).resolves.toEqual(expected);

    const cappedPort = readPort();
    cappedPort.listProjects.mockResolvedValue({ status: 'success', value: [project] });
    const cappedEndpoint = await runtime(
      async () => cappedPort,
      [0],
      undefined,
      undefined,
      exactBytes - 1,
    ).start();
    const rejected = await post(cappedEndpoint, {
      id: 'unicode-1',
      method: 'collab.projects.list',
      params: {},
    });

    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toEqual({
      error: {
        code: 'response_too_large',
        message: 'Agent Runtime response is too large.',
      },
      id: 'unicode-1',
    });
  });

  it('aborts an invocation when the HTTP client disconnects', async () => {
    let markStarted: (() => void) | undefined;
    let markAborted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>(resolve => {
      markAborted = resolve;
    });
    const port = readPort();
    port.listProjects.mockImplementation(options => new Promise(resolve => {
      markStarted?.();
      options?.signal?.addEventListener('abort', () => {
        markAborted?.();
        resolve({ durableProgress: false, status: 'cancelled' });
      }, { once: true });
    }));
    const server = runtime(async () => port);
    const endpoint = await server.start();
    const payload = JSON.stringify({
      id: 'disconnect-1',
      method: 'collab.projects.list',
      params: {},
    });
    const request = createRequest(endpoint.rpcUrl, {
      headers: {
        'Content-Length': Buffer.byteLength(payload),
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    request.on('error', () => undefined);
    request.end(payload);
    await started;

    request.destroy();

    await aborted;
    expect(port.listProjects).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('falls back when the preferred candidate is occupied', async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServers.push(occupied);
    const occupiedPort = (occupied.address() as AddressInfo).port;

    const endpoint = await runtime(async () => readPort(), [occupiedPort, 0]).start();

    expect(Number(new URL(endpoint.origin).port)).not.toBe(occupiedPort);
  });

  it('fails when every candidate is occupied and remains retryable', async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServers.push(occupied);
    const occupiedPort = (occupied.address() as AddressInfo).port;
    const server = runtime(async () => readPort(), [occupiedPort]);

    await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await closeServer(occupied);
    occupiedServers.splice(occupiedServers.indexOf(occupied), 1);

    await expect(server.start()).resolves.toMatchObject({
      rpcUrl: `http://127.0.0.1:${occupiedPort}/v1/rpc`,
    });
  });

  it('bounds shutdown when a Collab handler ignores abort', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const port: CollabAgentPort = {
      ...readPort(),
      listProjects: jest.fn(() => {
        markStarted?.();
        return new Promise(() => undefined);
      }),
    };
    const server = runtime(async () => port, [0], 20);
    const endpoint = await server.start();
    const request = post(endpoint, {
      id: 'projects-1',
      method: 'collab.projects.list',
      params: {},
    }).catch(() => undefined);
    await started;

    const before = Date.now();
    await server.close();

    expect(Date.now() - before).toBeLessThan(500);
    await request;
  });

  it('tracks an admitted write until its application operation settles', async () => {
    let markStarted: (() => void) | undefined;
    let releaseWrite: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const writeReleased = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    const port = readPort();
    port.createTicket.mockImplementation(async () => {
      markStarted?.();
      await writeReleased;
      return { durableProgress: false, status: 'cancelled' };
    });
    const server = runtime(async () => port, [0], 20, 20);
    const endpoint = await server.start();
    const request = post(endpoint, {
      id: 'write-close-1',
      method: 'collab.tickets.create',
      params: {
        body: 'Runtime lifecycle test.',
        projectId: 'project-alpha',
        title: 'Lifecycle test',
      },
    }).catch(() => undefined);
    await started;

    await server.close();
    let settled = false;
    const writeSettlement = server.waitForWriteInvocations().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseWrite?.();
    await writeSettlement;
    await request;
  });

  it('keeps the application intent stable when a timed-out write is retried', async () => {
    let markStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const firstReleased = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const ticket = {
      acceptedRelations: { acceptedRelations: [] },
      body: 'Retry after an ambiguous timeout.',
      comments: { comments: [] },
      ticket: {
        acceptedRelationCount: 0,
        authorMemberId: 'member-a',
        commentCount: 0,
        createdAt: '2026-08-12T00:00:00.000Z',
        id: 'ticket-retry',
        number: 1,
        revision: 1,
        status: 'open' as const,
        title: 'Retry-safe write',
        updatedAt: '2026-08-12T00:00:00.000Z',
      },
    };
    const intentIds: string[] = [];
    const port = readPort();
    port.createTicket.mockImplementation(async input => {
      intentIds.push(input.intentId ?? '');
      if (intentIds.length === 1) {
        markStarted?.();
        await firstReleased;
      }
      return { status: 'success', value: ticket };
    });
    const server = runtime(async () => port, [0], 20, 20);
    const endpoint = await server.start();
    const rpcRequest = {
      id: 'write-timeout-retry',
      method: 'collab.tickets.create',
      params: {
        body: ticket.body,
        projectId: 'project-alpha',
        title: ticket.ticket.title,
      },
    };

    const timedOut = post(endpoint, rpcRequest);
    await started;
    await expect((await timedOut).json()).resolves.toEqual({
      error: {
        code: 'request_timeout',
        message: 'Agent Runtime request timed out.',
      },
      id: rpcRequest.id,
    });

    await expect((await post(endpoint, rpcRequest)).json()).resolves.toMatchObject({
      id: rpcRequest.id,
      result: { ticket: { id: ticket.ticket.id } },
    });
    expect(intentIds).toHaveLength(2);
    expect(new Set(intentIds).size).toBe(1);

    releaseFirst?.();
    await server.waitForWriteInvocations();
  });

  it('coalesces concurrent starts and supports idempotent close and restart', async () => {
    const server = runtime();

    const [first, second] = await Promise.all([server.start(), server.start()]);
    expect(second).toEqual(first);

    await Promise.all([server.close(), server.close()]);
    await expect(fetch(first.rpcUrl)).rejects.toThrow();

    const restarted = await server.start();
    const response = await post(restarted, {
      id: 'restart-1',
      method: 'runtime.health.check',
      params: {},
    });
    expect(response.status).toBe(200);
  });

  it('aborts an active Collab call before close completes', async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const port: CollabAgentPort = {
      ...readPort(),
      listProjects: jest.fn(options => new Promise(resolve => {
        observedSignal = options?.signal;
        markStarted?.();
        options?.signal?.addEventListener('abort', () => {
          resolve({ durableProgress: false, status: 'cancelled' });
        }, { once: true });
      })),
    };
    const server = runtime(async () => port);
    const endpoint = await server.start();
    const request = post(endpoint, {
      id: 'close-1',
      method: 'collab.projects.list',
      params: {},
    }).catch(() => undefined);
    await started;

    await server.close();

    expect(observedSignal?.aborted).toBe(true);
    await request;
  });

  it('does not orphan a listener when close races start', async () => {
    const server = runtime();

    const start = server.start();
    const close = server.close();
    const endpoint = await start;
    await close;

    await expect(fetch(endpoint.rpcUrl)).rejects.toThrow();
  });
});

function occupyLoopbackPort(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
