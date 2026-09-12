import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_LIMITS,
  type CollabCloudCapability,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
  type CollabTicketDetail,
} from '@claudian-collab/protocol';

import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import {
  CollabClientProjection,
  type CollabClientProjectionControlPort,
  type CollabClientProjectionOptions,
  type CollabClientProjectionStore,
} from '@/app/collab/client/CollabClientProjection';
import { ProjectEventClient, type ProjectEventClientSocket, type ProjectEventClientSocketFactory } from '@/app/collab/client/ProjectEventClient';
import type {
  CollabLocalCloudMembershipRecord,
  CollabLocalLanMembershipRecord,
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { CollabLocalProjectRepository, isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabProjectConnection } from '@/app/collab/reconnect/CollabProjectConnection';
import { CloudAuthorityAdapter, CloudProjectEventClient, type CloudProjectEventClientOptions } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';
import { CollabAuthorityControlRouter } from '@/app/collab/remote-authority/CollabAuthorityControlRouter';
import {
  CollabAuthoritySessionFactory,
} from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import { LanAuthorityAdapter } from '@/app/collab/remote-authority/LanAuthorityAdapter';
import type { CloudAuthorityHttpRequest, CloudAuthorityHttpResponse, CloudAuthorityHttpTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import { type CollabCloudProjectSnapshot, type CollabLanProjectSnapshot, type CollabProjectSnapshot, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const HEAD = 'a'.repeat(40);
let cloudVaultRoot: string;
beforeEach(async () => {
  cloudVaultRoot = await mkdtemp(path.join(tmpdir(), 'cloud-projection-vault-'));
  await new CloudProjectCredentialStore(cloudVaultRoot).getOrCreate('project-a');
});
afterEach(async () => { await rm(cloudVaultRoot, { recursive: true, force: true }); });

const registries = new Set<CollabProjectWorkSessionRegistry>();

function admitProjectRetirement(
  _projectId: string,
  operation: () => Promise<void>,
): Promise<void> {
  return operation();
}

describe('CollabClientProjection', () => {
  afterEach(async () => {
    await Promise.all([...registries].map(registry => registry.close()));
    registries.clear();
  });

  it('recovers Cloud snapshot failures through one backoff owner despite healthy HTTP observations', async () => {
    const store = new MemoryProjectionStore();
    store.membership = cloudMembership();
    const options = projectionOptions();
    const sockets: FakeEventSocket[] = [];
    let failSnapshot = false;
    const authoritySessions = cloudEventSessions(() => {
      const socket = new FakeEventSocket();
      sockets.push(socket);
      return socket;
    }, async input => {
      if (input.method === 'GET') return cloudCapabilities();
      if (failSnapshot) throw new CollabError({ code: 'operation-failed' });
      return cloudSnapshotResponse(input);
    });
    const router = new CollabAuthorityControlRouter(store, options.sessions, authoritySessions, {
      tryReconnect: () => connection.reconnect(),
      onConnectionResult: (_projectId, error) => error
        ? connection.observeFailure(error) : connection.observeControlSuccess(),
    });
    const projection = new CollabClientProjection(store, router, {
      ...options, authoritySessions,
      onEventConnectionState: (_projectId, state) => connection.observeEvents(state),
    });
    const connection = options.sessions.acquire('project-a').ensureConnection(() => (
      new CollabProjectConnection({
        onStatusChange: () => undefined,
        reconnect: async signal => {
          await projection.reconnectProject('project-a', { signal });
          return 'connected';
        },
      })
    ));
    await projection.subscribe('project-a', () => undefined);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      failSnapshot = true;
      sockets[0].open();
      await flushEvents();
      expect(connection.status).toBe('offline');
      failSnapshot = false;
      await router.readSnapshot('project-a');
      expect(connection.status).toBe('offline');
      failSnapshot = true;
      await jest.advanceTimersByTimeAsync(1_000);
      sockets[1].open();
      await flushEvents();
      expect(connection.status).toBe('offline');
      await jest.advanceTimersByTimeAsync(1_999);
      expect(sockets).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      failSnapshot = false;
      sockets[2].open();
      await flushEvents();
      expect(connection.status).toBe('connected');
      expect(store.membership.lastEventSequence).toBe(cloudSnapshot().eventSequence);
      expect(store.documents.has('project-a')).toBe(true);
    } finally {
      await options.sessions.close();
      projection.dispose();
      jest.useRealTimers();
    }
  });

  it('refreshes coordination without reading or rewriting cached Ticket details', async () => {
    const store = new CollabLocalProjectRepository(cloudVaultRoot);
    await store.saveMembership(cloudMembership());
    const control = controlPort();
    control.readSnapshot.mockResolvedValue(cloudSnapshot());
    control.readTicket.mockResolvedValue(ticketDetail());
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await projection.readSnapshot('project-a');
    await projection.readTicket('project-a', 'ticket-a');
    const first = await store.loadProjectDocument('project-a', 'cache', value => (
      value as { projectId: string; schemaVersion: number; ticketDetails?: unknown }
    ));
    expect(first?.ticketDetails).toBeUndefined();
    const summaryBytes = JSON.stringify(first).length;
    expect(summaryBytes).toBeLessThan(8_192);
    control.readSnapshot.mockResolvedValue({ ...cloudSnapshot(), eventSequence: 8 });
    await projection.readSnapshot('project-a');
    control.readTicket.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    await expect(projection.readTicket('project-a', 'ticket-a')).resolves.toMatchObject({
      detail: ticketDetail(), source: 'cache', stale: true,
    });
  });

  it.each(['membership', 'negotiation'] as const)('recovers event setup after a transient %s failure', async boundary => {
    const store = new MemoryProjectionStore();
    store.membership = cloudMembership();
    let fault = false;
    store.loadMembership = async () => {
      if (fault && boundary === 'membership') throw new Error('Synthetic filesystem failure');
      return store.membership;
    };
    const sockets: FakeEventSocket[] = [];
    const socketCreated = deferred<void>();
    const options = projectionOptions();
    const control = controlPort();
    control.readSnapshot.mockResolvedValue(cloudSnapshot());
    const projection = new CollabClientProjection(store, control, {
      ...options,
      authoritySessions: cloudEventSessions(() => {
        const socket = new FakeEventSocket();
        sockets.push(socket);
        socketCreated.resolve();
        return socket;
      }, async input => {
        if (fault && boundary === 'negotiation') throw new CollabError({ code: 'endpoint-unreachable' });
        return input.method === 'GET' ? cloudCapabilities() : cloudSnapshotResponse(input);
      }),
      onEventConnectionState: (_projectId, state) => connection.observeEvents(state),
    });
    const connection = options.sessions.acquire('project-a').ensureConnection(() => new CollabProjectConnection({
      onStatusChange: () => undefined,
      reconnect: async signal => {
        await projection.subscribe('project-a', () => undefined);
        await projection.reconnectProject('project-a', { signal });
        return 'connected';
      },
    }));
    connection.requireEvents();
    await projection.readSnapshot('project-a');
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      fault = true;
      await expect(projection.subscribe('project-a', () => undefined)).rejects.toThrow();
      expect(connection.failure).toMatchObject({
        code: boundary === 'membership' ? 'operation-failed' : 'endpoint-unreachable',
      });
      fault = false;
      await jest.advanceTimersByTimeAsync(1_000);
      await socketCreated.promise;
      expect(sockets).toHaveLength(1);
      sockets[0].open();
      await flushEvents();
      expect(connection.status).toBe('connected');
      await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({ stale: false });
    } finally {
      await options.sessions.close();
      jest.useRealTimers();
    }
  });

  it('presents the retained generation without network waits and rejects terminal connection failures', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    const options = projectionOptions();
    options.sessions.acquire('project-a').retainObservation();
    const projection = new CollabClientProjection(store, control, {
      ...options,
      onSnapshotResult: (_projectId, error) => error ? connection.observeFailure(error) : connection.observeSuccess(),
    });
    const connection = options.sessions.acquire('project-a').ensureConnection(() => new CollabProjectConnection({
      onStatusChange: () => undefined, reconnect: async () => 'retry',
    }));
    await projection.readSnapshot('project-a');
    connection.observeSuccess();
    control.readSnapshot.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({
      source: 'online', stale: false, snapshot: { eventSequence: 5 },
    });
    connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
    await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({
      source: 'cache', stale: true, syncState: { generation: 0, status: 'offline' },
    });
    control.readSnapshot.mockResolvedValue({ ...snapshot(), eventSequence: 4 });
    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(projection.readPresentationSnapshot('project-a')).rejects.toMatchObject({ code: 'authority-integrity-error' });
    connection.observeFailure(new CollabError({ code: 'authorization-denied' }));
    await expect(projection.readPresentationSnapshot('project-a')).rejects.toMatchObject({ code: 'authorization-denied' });
    projection.resetProjectConnection('project-a');
    control.readSnapshot.mockResolvedValue({ ...snapshot(), eventSequence: 6 });
    await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({
      snapshot: { eventSequence: 6 }, syncState: { generation: 1 },
    });
    await options.sessions.close();
  });

  it('settles a cancelled cache read before returning retained presentation', async () => {
    const store = new MemoryProjectionStore();
    await new CollabClientProjection(store, controlPort(), projectionOptions()).readSnapshot('project-a');
    const control = controlPort();
    control.readSnapshot.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    const controller = new AbortController();
    store.loadMembership = async () => { controller.abort(); return store.membership; };
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await expect(projection.readPresentationSnapshot('project-a', { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
  });

  it('retains a cold offline cache as stale across local presentation reads', async () => {
    const store = new MemoryProjectionStore();
    await new CollabClientProjection(store, controlPort(), projectionOptions()).readSnapshot('project-a');
    const control = controlPort();
    control.readSnapshot.mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValue({ ...snapshot(), eventSequence: 6 });
    const options = projectionOptions();
    options.sessions.acquire('project-a').retainObservation();
    const projection = new CollabClientProjection(store, control, options);
    await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({ source: 'cache', stale: true });
    const connection = options.sessions.acquire('project-a').ensureConnection(() => new CollabProjectConnection({
      onStatusChange: () => undefined, reconnect: async () => 'retry',
    }));
    connection.observeControlSuccess();
    await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({
      source: 'cache', stale: true, snapshot: { eventSequence: 5 },
    });
    await expect(projection.readSnapshot('project-a')).resolves.toMatchObject({
      source: 'online', stale: false, snapshot: { eventSequence: 6 },
    });
  });

  it('preserves online presentation when an equal-sequence cache fallback finishes after recovery', async () => {
    const store = new MemoryProjectionStore();
    await new CollabClientProjection(store, controlPort(), projectionOptions()).readSnapshot('project-a');
    const loadDocument = store.loadProjectDocument.bind(store);
    const cacheStarted = deferred<void>();
    const releaseCache = deferred<void>();
    store.loadProjectDocument = async (...args) => {
      const cached = await loadDocument(...args);
      cacheStarted.resolve();
      await releaseCache.promise;
      return cached;
    };
    const control = controlPort();
    control.readSnapshot.mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }));
    const options = projectionOptions();
    const projection = new CollabClientProjection(store, control, options);
    const connection = options.sessions.acquire('project-a').ensureConnection(() => new CollabProjectConnection({
      onStatusChange: () => undefined, reconnect: async () => 'retry',
    }));
    const fallback = projection.readSnapshot('project-a');
    await cacheStarted.promise;
    await expect(projection.readSnapshot('project-a')).resolves.toMatchObject({
      source: 'online', stale: false, snapshot: { eventSequence: 5 },
    });
    connection.observeSuccess();
    releaseCache.resolve();
    await fallback;
    await expect(projection.readPresentationSnapshot('project-a')).resolves.toMatchObject({
      source: 'online', stale: false, snapshot: { eventSequence: 5 },
    });
  });

  it('resolves a newer snapshot highlight even when older Ticket details exist', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    control.readTicket.mockResolvedValue(ticketDetail());
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await projection.readSnapshot('project-a');
    await projection.readTicket('project-a', 'ticket-a');
    control.readSnapshot.mockResolvedValue({
      ...snapshot(), eventSequence: 6, openTicketCount: 1,
      ticketHighlights: [{ ...ticketDetail().ticket, id: 'ticket-b', number: 2 }],
    });
    await projection.readSnapshot('project-a');
    control.resolveTicketNumber.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    await expect(projection.resolveTicketNumber({ projectId: 'project-a', ticketNumber: 2 }))
      .resolves.toEqual({ ticketId: 'ticket-b' });
  });

  it.each(['generation', 'origin'] as const)('rejects Ticket cache after authority %s changes', async change => {
    const store = new MemoryProjectionStore();
    store.membership = cloudMembership();
    const control = controlPort();
    control.readSnapshot.mockResolvedValue(cloudSnapshot());
    control.readTicket.mockResolvedValue(ticketDetail());
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await projection.readSnapshot('project-a');
    await projection.readTicket('project-a', 'ticket-a');
    store.membership = {
      ...cloudMembership(), lastEventSequence: 8,
      authority: {
        ...cloudMembership().authority,
        ...(change === 'generation' ? { authorityGeneration: 9 } : { serverUrl: 'https://new.example.test' }),
      },
    };
    projection.resetProjectConnection('project-a');
    const offline = new CollabError({ code: 'endpoint-unreachable' });
    control.readTicket.mockRejectedValue(offline);
    await expect(projection.readTicket('project-a', 'ticket-a')).rejects.toBe(offline);
  });

  it('does not retain a complete Ticket exceeding the offline cache byte budget', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    const detail = ticketDetailWithComments(500);
    const large = {
      ...detail,
      comments: { comments: detail.comments.comments.map(comment => ({
        ...comment, body: 'x'.repeat(16_384),
      })) },
    };
    control.readTicket.mockResolvedValue(large);
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await projection.readSnapshot('project-a');
    await expect(projection.readTicket('project-a', 'ticket-a')).resolves.toMatchObject({
      source: 'online', stale: false,
    });
    const offline = new CollabError({ code: 'endpoint-unreachable' });
    control.readTicket.mockRejectedValue(offline);
    await expect(projection.readTicket('project-a', 'ticket-a')).rejects.toBe(offline);
  });

  it('evicts older details and pages before dropping an oversized newest Ticket', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    let time = Date.parse(CREATED_AT);
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(), now: () => new Date(time++),
    });
    await projection.readSnapshot('project-a');
    for (let index = 0; index < 31; index++) {
      const detail = ticketDetail();
      control.readTicket.mockResolvedValue({
        ...detail,
        comments: { comments: detail.comments.comments.map(comment => ({ ...comment, ticketId: `ticket-${index}` })) },
        ticket: { ...detail.ticket, id: `ticket-${index}`, number: index + 1 },
      });
      await projection.readTicket('project-a', `ticket-${index}`);
    }
    for (let index = 0; index < 16; index++) {
      control.listTickets.mockResolvedValue({ tickets: [ticketDetail().ticket] });
      await projection.listTickets({ projectId: 'project-a', status: 'open', limit: index + 1 });
    }
    const offline = new CollabError({ code: 'endpoint-unreachable' });
    control.readTicket.mockRejectedValue(offline);
    control.listTickets.mockRejectedValue(offline);
    await expect(projection.readTicket('project-a', 'ticket-0')).resolves.toMatchObject({ source: 'cache' });
    await expect(projection.readTicket('project-a', 'ticket-30')).resolves.toMatchObject({ source: 'cache' });
    await expect(projection.listTickets({ projectId: 'project-a', status: 'open', limit: 16 })).resolves.toMatchObject({ source: 'cache' });
    const large = ticketDetailWithComments(260);
    control.readTicket.mockResolvedValue({
      ...large,
      comments: { comments: large.comments.comments.map(comment => ({ ...comment, body: 'x'.repeat(16_384) })) },
    });
    await expect(projection.readTicket('project-a', 'ticket-a')).resolves.toMatchObject({ source: 'online' });
    control.readTicket.mockRejectedValue(offline);
    control.listTickets.mockRejectedValue(offline);
    await expect(projection.readTicket('project-a', 'ticket-a')).rejects.toBe(offline);
    await expect(projection.readTicket('project-a', 'ticket-30')).rejects.toBe(offline);
    await expect(projection.listTickets({ projectId: 'project-a', status: 'open', limit: 16 })).rejects.toBe(offline);
  });

  it.each([0, 1])('preserves the exact UTF-8 cache boundary with %s excess bytes', async excessBytes => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(), now: () => new Date(CREATED_AT),
    });
    await projection.readSnapshot('project-a');
    control.readTicket.mockResolvedValue(ticketDetail());
    await projection.readTicket('project-a', 'ticket-a');
    const request = { projectId: 'project-a', status: 'open' as const, limit: 1 };
    control.listTickets.mockResolvedValue({ tickets: [ticketDetail().ticket] });
    await projection.listTickets(request);

    const previous = store.documents.get('project-a:ticket-cache') as {
      ticketDetails: unknown[]; ticketPages: unknown[];
    };
    const detail = ticketDetailWithComments(260);
    const comments = detail.comments.comments.map(comment => ({
      ...comment, ticketId: 'ticket-new', body: '中😀"\\\n',
    }));
    const incoming = { ...detail, comments: { comments }, ticket: { ...detail.ticket, id: 'ticket-new', number: 18 } };
    const expectedCache = {
      ...previous,
      ticketDetails: [{ cachedAt: CREATED_AT, detail: incoming, ticketId: 'ticket-new' }, ...previous.ticketDetails],
    };
    const byteBudget = 4 * 1024 * 1024;
    let remaining = byteBudget + excessBytes - Buffer.byteLength(JSON.stringify(expectedCache, null, 2));
    for (const comment of comments) {
      const added = Math.min(remaining, 16_384 - Buffer.byteLength(comment.body));
      comment.body += 'x'.repeat(added);
      remaining -= added;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(expectedCache, null, 2))).toBe(byteBudget + excessBytes);
    control.readTicket.mockResolvedValue(incoming);
    await projection.readTicket('project-a', 'ticket-new');
    const saved = store.documents.get('project-a:ticket-cache');
    expect(saved).toEqual(excessBytes === 0 ? expectedCache : {
      ...expectedCache, ticketDetails: expectedCache.ticketDetails.slice(0, 1),
    });
    const offline = new CollabError({ code: 'endpoint-unreachable' });
    control.readTicket.mockRejectedValue(offline);
    control.listTickets.mockRejectedValue(offline);
    await expect(projection.readTicket('project-a', 'ticket-new')).resolves.toMatchObject({ source: 'cache', detail: incoming });
    await expect(projection.listTickets(request)).resolves.toMatchObject({ source: 'cache' });
    const previousResult = await projection.readTicket('project-a', 'ticket-a').then(result => result.source, error => error);
    expect(previousResult).toBe(excessBytes > 0 ? offline : 'cache');
  });

  it.each([
    { first: 'detail', excessBytes: 0 }, { first: 'detail', excessBytes: 1 },
    { first: 'page', excessBytes: 0 }, { first: 'page', excessBytes: 1 },
  ])('stops at the byte boundary after evicting $first with $excessBytes excess bytes', async ({ first, excessBytes }) => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    let time = Date.parse(CREATED_AT);
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(), now: () => new Date(time),
    });
    await projection.readSnapshot('project-a');
    const request = { projectId: 'project-a', status: 'open' as const, limit: 1 };
    control.readTicket.mockResolvedValue(ticketDetail());
    control.listTickets.mockResolvedValue({ tickets: [ticketDetail().ticket] });
    const seedDetail = () => projection.readTicket('project-a', 'ticket-a');
    const seedPage = () => projection.listTickets(request);
    await (first === 'detail' ? seedDetail() : seedPage());
    time += 1000;
    await (first === 'detail' ? seedPage() : seedDetail());
    time += 1000;
    const previous = store.documents.get('project-a:ticket-cache') as {
      ticketDetails: unknown[]; ticketPages: unknown[];
    };
    const detail = ticketDetailWithComments(260);
    const comments = detail.comments.comments.map(comment => ({
      ...comment, ticketId: 'ticket-new', body: '中😀"\\\n',
    }));
    const incoming = { ...detail, comments: { comments }, ticket: { ...detail.ticket, id: 'ticket-new', number: 18 } };
    const entry = { cachedAt: new Date(time).toISOString(), detail: incoming, ticketId: 'ticket-new' };
    const afterFirstEviction = {
      ...previous,
      ticketDetails: first === 'detail' ? [entry] : [entry, ...previous.ticketDetails],
      ticketPages: first === 'page' ? [] : previous.ticketPages,
    };
    const byteBudget = 4 * 1024 * 1024;
    let remaining = byteBudget + excessBytes - Buffer.byteLength(JSON.stringify(afterFirstEviction, null, 2));
    for (const comment of comments) {
      const added = Math.min(remaining, 16_384 - Buffer.byteLength(comment.body));
      comment.body += 'x'.repeat(added);
      remaining -= added;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(afterFirstEviction, null, 2))).toBe(byteBudget + excessBytes);
    control.readTicket.mockResolvedValue(incoming);
    await projection.readTicket('project-a', 'ticket-new');
    const expectedCache = excessBytes === 0 ? afterFirstEviction : {
      ...afterFirstEviction, ticketDetails: [entry], ticketPages: [],
    };
    expect(store.documents.get('project-a:ticket-cache')).toEqual(expectedCache);
    control.readTicket.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    await expect(projection.readTicket('project-a', 'ticket-new')).resolves.toMatchObject({ source: 'cache', detail: incoming });
  });

  it('resolves cached Ticket numbers only when online lookup is unavailable', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    control.readTicket.mockResolvedValue(ticketDetail());
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await projection.readSnapshot('project-a');
    await projection.readTicket('project-a', 'ticket-a');
    const request = { projectId: 'project-a', ticketNumber: ticketDetail().ticket.number };
    control.resolveTicketNumber.mockResolvedValue({ ticketId: null });
    await expect(projection.resolveTicketNumber(request)).resolves.toEqual({ ticketId: null });

    const unavailable = new CollabError({ code: 'endpoint-unreachable' });
    control.resolveTicketNumber.mockRejectedValue(unavailable);
    await expect(projection.resolveTicketNumber(request)).resolves.toEqual({ ticketId: 'ticket-a' });
    await expect(projection.resolveTicketNumber({ ...request, ticketNumber: 999 }))
      .rejects.toBe(unavailable);
    const denied = new CollabError({ code: 'authorization-denied' });
    control.resolveTicketNumber.mockRejectedValue(denied);
    await expect(projection.resolveTicketNumber(request)).rejects.toBe(denied);
  });

  it('coalesces online snapshot reads and durably projects cache plus event cursor', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });

    const [first, second] = await Promise.all([
      projection.readSnapshot('project-a'),
      projection.readSnapshot('project-a'),
    ]);

    expect(first).toEqual({
      snapshot: snapshot(),
      source: 'online',
      stale: false,
      syncState: {
        eventSequence: 5,
        generation: 0,
        projectId: 'project-a',
        status: 'synchronized',
      },
    });
    expect(second).toEqual(first);
    expect(control.readSnapshot).toHaveBeenCalledTimes(1);
    expect(store.documents.get('project-a')).toMatchObject({
      cachedAt: CREATED_AT,
      projectId: 'project-a',
      schemaVersion: 6,
      authorityBinding: JSON.stringify(['lan', 1, membership().authority.endpoint, membership().authority.hostCaFingerprint, membership().authority.gitRemoteUrl]),
      snapshot: { eventSequence: 5 },
    });
    expect(store.membership.lastEventSequence).toBe(5);
  });

  it('projects the authoritative current Member role into local membership', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    control.readSnapshot.mockResolvedValue({
      ...snapshot(),
      currentMember: { ...snapshot().currentMember, role: 'manager' },
    });
    const projection = new CollabClientProjection(store, control, projectionOptions());

    await projection.readSnapshot('project-a');

    expect(store.membership).toMatchObject({
      lastEventSequence: 5,
      member: { id: 'member-a', role: 'manager' },
    });
  });

  it('persists a promoted role before retiring its Manager receipt', async () => {
    const store = new MemoryProjectionStore();
    store.updateMembershipProjection = jest.fn().mockRejectedValue(
      new Error('membership write failed'),
    );
    const control = controlPort();
    control.readSnapshot.mockResolvedValue({
      ...snapshot(),
      currentMember: { ...snapshot().currentMember, role: 'manager' },
    });
    const reconcileSnapshot = jest.fn();
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      managerResponsibility: { reconcileSnapshot },
    });

    await expect(projection.readSnapshot('project-a')).rejects.toThrow(
      'membership write failed',
    );

    expect(store.documents.get('project-a')).toMatchObject({
      snapshot: { currentMember: { role: 'manager' } },
    });
    expect(reconcileSnapshot).not.toHaveBeenCalled();
  });

  it('does not keep a session-owned snapshot open while lifecycle reconciliation is queued', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    let releaseReconciliation!: () => void;
    const reconciliation = new Promise<null>(resolve => {
      releaseReconciliation = () => resolve(null);
    });
    const reconcileSnapshot = jest.fn().mockReturnValue(reconciliation);
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      managerResponsibility: { reconcileSnapshot },
    });

    const read = projection.readSnapshot('project-a');
    const firstSettled = await Promise.race([
      read.then(() => 'snapshot' as const),
      new Promise<'lifecycle'>(resolve => setImmediate(() => resolve('lifecycle'))),
    ]);

    releaseReconciliation();
    await read;
    expect(firstSettled).toBe('snapshot');
    expect(reconcileSnapshot).toHaveBeenCalledTimes(1);
  });

  it('schedules offered Manager responsibility after caching the raw snapshot', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    const offered = {
      expiresAt: '2026-08-08T00:10:00.000Z',
      offeredAt: CREATED_AT,
      offerId: 'offer-one',
      purpose: 'manager-leave' as const,
      sourceManagerMemberId: 'member-manager',
      status: 'offered' as const,
      targetMemberId: 'member-a',
    };
    control.readSnapshot.mockResolvedValue({
      ...snapshot(),
      managerResponsibilityOffer: offered,
    });
    const reconcileSnapshot = jest.fn((_snapshot, assertCurrent: () => void) => {
      assertCurrent();
      expect(store.documents.get('project-a')).toMatchObject({
        snapshot: { managerResponsibilityOffer: offered },
      });
      expect(store.membership.lastEventSequence).toBe(5);
    });
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      managerResponsibility: { reconcileSnapshot },
    });

    const result = await projection.readSnapshot('project-a');

    expect(reconcileSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ managerResponsibilityOffer: offered }),
      expect.any(Function),
    );
    expect(isCollabLanProjectSnapshot(result.snapshot)).toBe(true);
    if (!isCollabLanProjectSnapshot(result.snapshot)) throw new Error('Expected LAN snapshot');
    expect(result.snapshot.managerResponsibilityOffer).toEqual(offered);
    expect(store.documents.get('project-a')).toMatchObject({
      snapshot: { managerResponsibilityOffer: offered },
    });
  });

  it('rejects another current Member identity before persisting its cache', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    control.readSnapshot.mockResolvedValue({
      ...snapshot(),
      currentMember: {
        ...snapshot().currentMember,
        id: 'member-other',
        personalRef: 'refs/heads/members/member-other',
      },
    });
    const projection = new CollabClientProjection(store, control, projectionOptions());

    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
    });
    expect(store.documents.has('project-a')).toBe(false);
    expect(store.membership).toMatchObject({
      lastEventSequence: 0,
      member: { id: 'member-a', role: 'member' },
    });
  });

  it('rejects a lower-sequence snapshot before cache or receipt reconciliation', async () => {
    const store = new MemoryProjectionStore();
    store.membership = {
      ...store.membership,
      lastEventSequence: 6,
    };
    const cached = {
      cachedAt: CREATED_AT,
      projectId: 'project-a',
      schemaVersion: 6,
      authorityBinding: JSON.stringify(['lan', 1, membership().authority.endpoint, membership().authority.hostCaFingerprint, membership().authority.gitRemoteUrl]),
      snapshot: { ...snapshot(), eventSequence: 6 },
      ticketDetails: [],
      ticketPages: [],
    };
    store.documents.set('project-a', cached);
    const reconcileSnapshot = jest.fn();
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      managerResponsibility: { reconcileSnapshot },
    });

    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'projection-event-sequence-regressed' },
    });
    expect(store.documents.get('project-a')).toBe(cached);
    expect(store.membership.lastEventSequence).toBe(6);
    expect(reconcileSnapshot).not.toHaveBeenCalled();
  });

  it('restores a stale cache after reload only for connectivity failures', async () => {
    const store = new MemoryProjectionStore();
    const online = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });
    await online.readSnapshot('project-a');
    online.dispose();
    const offlineControl = controlPort();
    offlineControl.readSnapshot.mockRejectedValue(new CollabError({
      code: 'endpoint-unreachable',
    }));
    const reloaded = new CollabClientProjection(store, offlineControl, projectionOptions());

    await expect(reloaded.readSnapshot('project-a')).resolves.toEqual({
      snapshot: snapshot(),
      source: 'cache',
      stale: true,
      syncState: {
        eventSequence: 5,
        generation: 0,
        projectId: 'project-a',
        status: 'offline',
      },
    });
    offlineControl.readSnapshot.mockRejectedValue(new CollabError({
      code: 'membership-revoked',
    }));
    await expect(reloaded.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'membership-revoked',
    });
  });

  it('strictly restores a Cloud snapshot cache after reload', async () => {
    const store = new MemoryProjectionStore();
    store.membership = cloudMembership();
    const onlineControl = controlPort();
    onlineControl.readSnapshot.mockResolvedValue(cloudSnapshot());
    const online = new CollabClientProjection(store, onlineControl, {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });
    await online.readSnapshot('project-a');
    online.dispose();
    const offlineControl = controlPort();
    offlineControl.readSnapshot.mockRejectedValue(new CollabError({
      code: 'endpoint-unreachable',
    }));
    const reloaded = new CollabClientProjection(store, offlineControl, projectionOptions());

    await expect(reloaded.readSnapshot('project-a')).resolves.toEqual({
      snapshot: cloudSnapshot(),
      source: 'cache',
      stale: true,
      syncState: {
        eventSequence: 7,
        generation: 0,
        projectId: 'project-a',
        status: 'offline',
      },
    });
  });

  it('rejects a pre-cutover LAN cache after membership becomes Cloud', async () => {
    const store = new MemoryProjectionStore();
    const online = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });
    await online.readSnapshot('project-a');
    online.dispose();
    store.membership = cloudMembership();
    const offlineControl = controlPort();
    const unavailable = new CollabError({ code: 'endpoint-unreachable' });
    offlineControl.readSnapshot.mockRejectedValue(unavailable);
    const reloaded = new CollabClientProjection(store, offlineControl, projectionOptions());

    await expect(reloaded.readSnapshot('project-a')).rejects.toBe(unavailable);
    expect(store.removedDocuments).toEqual([['project-a', 'cache']]);
  });

  it('does not invent an offline projection when no valid cache exists', async () => {
    const control = controlPort();
    control.readSnapshot.mockRejectedValue(new CollabError({
      code: 'host-stopped',
    }));
    const projection = new CollabClientProjection(new MemoryProjectionStore(), control, projectionOptions());

    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'host-stopped',
    });
  });

  it('treats old LAN snapshot and Ticket caches as misses after the identity upgrade', async () => {
    const store = new CollabLocalProjectRepository(cloudVaultRoot);
    const retained = membership();
    await store.saveMembership({ ...retained, authority: { ...retained.authority, hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n' } });
    const { authorityGeneration: _generation, ...legacyProject } = snapshot().project;
    const legacyCache = {
      authorityBinding: JSON.stringify(['lan', 1, membership().authority.endpoint, membership().authority.hostCaFingerprint, membership().authority.gitRemoteUrl]),
      cachedAt: CREATED_AT, projectId: 'project-a', schemaVersion: 5,
      snapshot: { ...snapshot(), project: legacyProject },
      ticketDetails: [], ticketPages: [],
    };
    await store.saveProjectDocument('project-a', 'cache', legacyCache);
    await store.saveProjectDocument('project-a', 'ticket-cache', legacyCache);
    const control = controlPort();
    control.readSnapshot.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    control.readTicket.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    const projection = new CollabClientProjection(store, control, projectionOptions());
    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({ code: 'endpoint-unreachable' });
    await expect(projection.readTicket('project-a', 'ticket-a')).rejects.toMatchObject({ code: 'endpoint-unreachable' });
    await expect(store.loadProjectDocument('project-a', 'cache', value => value as { projectId: string; schemaVersion: number }))
      .resolves.toBeNull();
    await expect(store.loadProjectDocument('project-a', 'ticket-cache', value => value as { projectId: string; schemaVersion: number }))
      .resolves.toBeNull();
  });

  it('removes an obsolete schema-3 cache as a miss and replaces it on the next online read', async () => {
    const store = new MemoryProjectionStore();
    store.documents.set('project-a', {
      cachedAt: CREATED_AT,
      projectId: 'project-a',
      schemaVersion: 3,
      snapshot: {
        project: { id: 'project-a', managerMemberId: 'member-host' },
      },
      ticketDetails: [{ privateLegacyTicket: true }],
      ticketPages: [{ privateLegacyPage: true }],
    });
    const control = controlPort();
    control.readSnapshot.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });

    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'endpoint-unreachable',
    });
    expect(store.removedDocuments).toEqual([['project-a', 'cache']]);
    expect(store.documents.has('project-a')).toBe(false);
    expect(store.membership).toEqual(membership());

    control.readSnapshot.mockResolvedValueOnce(snapshot());
    await expect(projection.readSnapshot('project-a')).resolves.toMatchObject({
      source: 'online',
    });
    expect(store.documents.get('project-a')).toMatchObject({
      projectId: 'project-a',
      schemaVersion: 6,
      authorityBinding: JSON.stringify(['lan', 1, membership().authority.endpoint, membership().authority.hostCaFingerprint, membership().authority.gitRemoteUrl]),
      snapshot: {
        project: {
          id: 'project-a',
          managerSetGeneration: 0,
        },
      },
    });
    expect(store.documents.get('project-a')).not.toHaveProperty(
      'snapshot.project.managerMemberId',
    );
  });

  it('restores previously loaded Ticket pages and details as stale read-only data', async () => {
    const store = new MemoryProjectionStore();
    const onlineControl = controlPort();
    onlineControl.readTicket.mockResolvedValue(ticketDetail());
    onlineControl.readTicketPage.mockRejectedValue(new Error('bounded page is not cacheable'));
    onlineControl.listTickets.mockResolvedValue({ tickets: [ticketDetail().ticket] });
    const online = new CollabClientProjection(store, onlineControl, {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });
    await online.readSnapshot('project-a');
    await online.listTickets({ projectId: 'project-a', status: 'open' });
    await online.readTicket('project-a', 'ticket-a');
    online.dispose();

    expect(onlineControl.readTicket).toHaveBeenCalledWith(
      'project-a',
      'ticket-a',
      {},
    );
    expect(onlineControl.readTicketPage).not.toHaveBeenCalled();

    const offlineControl = controlPort();
    offlineControl.readTicket.mockRejectedValue(new CollabError({
      code: 'endpoint-unreachable',
    }));
    offlineControl.listTickets.mockRejectedValue(new CollabError({
      code: 'endpoint-unreachable',
    }));
    const offline = new CollabClientProjection(store, offlineControl, projectionOptions());

    await expect(offline.listTickets({
      projectId: 'project-a',
      status: 'open',
    })).resolves.toEqual({
      page: { tickets: [ticketDetail().ticket] },
      source: 'cache',
      stale: true,
    });
    await expect(offline.readTicket('project-a', 'ticket-a'))
      .resolves.toEqual({
        detail: ticketDetail(),
        source: 'cache',
        stale: true,
      });
  });

  it('keeps complete multi-page Ticket cache separate from bounded online reads', async () => {
    const store = new MemoryProjectionStore();
    const completeDetail = ticketDetailWithComments(101);
    const onlineControl = controlPort();
    onlineControl.readTicket.mockResolvedValue(completeDetail);
    const online = new CollabClientProjection(store, onlineControl, {
      ...projectionOptions(),
      now: () => new Date(CREATED_AT),
    });
    await online.readSnapshot('project-a');
    await online.readTicket('project-a', 'ticket-a');
    online.dispose();

    const offlineControl = controlPort();
    const offlineFailure = new CollabError({ code: 'endpoint-unreachable' });
    offlineControl.readTicket.mockRejectedValue(offlineFailure);
    offlineControl.readTicketPage.mockRejectedValue(offlineFailure);
    const offline = new CollabClientProjection(store, offlineControl, projectionOptions());

    await expect(offline.readTicket('project-a', 'ticket-a')).resolves.toEqual({
      detail: completeDetail,
      source: 'cache',
      stale: true,
    });
    await expect(offline.readTicketPage('project-a', 'ticket-a')).rejects.toBe(offlineFailure);
  });

  it('restores a complete Ticket larger than a wire comment page from durable cache', async () => {
    const store = new CollabLocalProjectRepository(cloudVaultRoot);
    await store.saveMembership(cloudMembership());
    const completeDetail = ticketDetailWithComments(10);
    const expected = {
      ...completeDetail,
      comments: {
        comments: completeDetail.comments.comments.map(comment => ({
          ...comment,
          body: 'x'.repeat(16 * 1024),
        })),
      },
    };
    let online = true;
    const request: CloudAuthorityHttpTransport = async input => {
      if (!online) throw new CollabError({ code: 'endpoint-unreachable' });
      if (input.method === 'GET') return cloudCapabilities(['tickets']);
      const operation = input.url.split('/').at(-1);
      if (operation === 'getProjectSnapshot') return cloudSnapshotResponse(input);
      const data = operation === 'getTicket'
        ? {
          ...expected,
          comments: { comments: expected.comments.comments.slice(0, 6), nextCursor: 'six' },
        }
        : { comments: expected.comments.comments.slice(6) };
      return {
        body: collabCloudSuccessEnvelope(
          (input.body as { readonly requestId: string }).requestId,
          data,
        ),
        contentType: 'application/json',
        status: 200,
      };
    };
    const sessions = new CollabProjectWorkSessionRegistry();
    registries.add(sessions);
    const authoritySessions = new CollabAuthoritySessionFactory([
      new CloudAuthorityAdapter(cloudVaultRoot, { request }),
    ]);
    const control = new CollabAuthorityControlRouter(store, sessions, authoritySessions);
    const projection = new CollabClientProjection(store, control, { authoritySessions, sessions });
    const snapshot = await projection.readSnapshot('project-a');
    await expect(projection.readTicket('project-a', 'ticket-a')).resolves.toEqual({
      detail: expected,
      source: 'online',
      stale: false,
    });

    online = false;

    await expect(projection.readTicket('project-a', 'ticket-a')).resolves.toEqual({
      detail: expected,
      source: 'cache',
      stale: true,
    });
    await expect(projection.readSnapshot('project-a')).resolves.toMatchObject({
      snapshot: snapshot.snapshot,
      source: 'cache',
      stale: true,
    });
  });

  it('never falls back to cached Tickets for authorization failures', async () => {
    const store = new MemoryProjectionStore();
    const onlineControl = controlPort();
    onlineControl.listTickets.mockResolvedValue({ tickets: [ticketDetail().ticket] });
    onlineControl.readTicket.mockResolvedValue(ticketDetail());
    const online = new CollabClientProjection(store, onlineControl, projectionOptions());
    await online.readSnapshot('project-a');
    await online.listTickets({ projectId: 'project-a', status: 'open' });
    await online.readTicket('project-a', 'ticket-a');

    onlineControl.listTickets.mockRejectedValue(new CollabError({
      code: 'membership-revoked',
    }));
    onlineControl.readTicket.mockRejectedValue(new CollabError({
      code: 'authorization-denied',
    }));

    await expect(online.listTickets({
      projectId: 'project-a',
      status: 'open',
    })).rejects.toMatchObject({ code: 'membership-revoked' });
    await expect(online.readTicket('project-a', 'ticket-a'))
      .rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('coalesces event refreshes, notifies invalidation subscribers, and tears down', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    const socket = new FakeEventSocket();
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      authoritySessions: lanEventSessions(() => socket),
    });
    const listener = jest.fn();
    const subscription = await projection.subscribe('project-a', listener);

    socket.message(lanEvent('request-updated', { requestId: 'request-a' }, 1));
    socket.message(lanEvent('request-updated', { requestId: 'request-a' }, 2));
    await flushEvents();

    expect(control.readSnapshot).toHaveBeenCalledTimes(1);
    expect(store.membership.lastEventSequence).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      eventSequence: 5,
      project: expect.objectContaining({ id: 'project-a' }),
    }));
    expect(socket.closed).toEqual([]);

    subscription.dispose();
    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
    projection.dispose();
  });

  it('routes terminal event and snapshot fallback through one retirement handler', async () => {
    const store = new MemoryProjectionStore();
    store.membership = { ...cloudMembership(), lastEventSequence: 5 };
    const control = controlPort();
    const socket = new FakeEventSocket();
    const retirement = { handle: jest.fn().mockResolvedValue(undefined) };
    const retirementAdmission = jest.fn(admitProjectRetirement);
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      authoritySessions: cloudEventSessions(() => socket),
      retirement,
      retirementAdmission,
    });
    await projection.subscribe('project-a', jest.fn());

    socket.message({
      kind: 'project.retired',
      occurredAt: CREATED_AT,
      payload: { retiredAt: CREATED_AT, retirementId: 'retirement-project-a' },
      projectId: 'project-a',
      protocolVersion: 10,
      sequence: 6,
    });
    await flushEvents();
    expect(retirement.handle).toHaveBeenCalledWith(
      {
        projectId: 'project-a',
        retiredAt: CREATED_AT,
        retirementId: 'retirement-project-a',
      },
      'event',
    );
    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);

    control.readSnapshot.mockRejectedValue(new CollabError({
      code: 'project-retired',
      safeContext: {
        projectId: 'project-a',
        retiredAt: CREATED_AT,
        operationId: 'retirement-project-a',
      },
    }));
    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'project-retired',
    });
    expect(retirement.handle).toHaveBeenLastCalledWith(
      {
        projectId: 'project-a',
        retiredAt: CREATED_AT,
        retirementId: 'retirement-project-a',
      },
      'terminal-fallback',
    );
    control.listRequestComments.mockRejectedValue(new CollabError({
      code: 'project-retired',
      safeContext: { projectId: 'project-a', retiredAt: CREATED_AT },
    }));
    await expect(projection.listRequestComments('project-a', 'request-a', {}))
      .rejects.toMatchObject({ code: 'project-retired' });
    expect(retirement.handle).toHaveBeenLastCalledWith(
      { projectId: 'project-a', retiredAt: CREATED_AT },
      'terminal-fallback',
    );
    expect(retirementAdmission).toHaveBeenCalledTimes(3);
  });

  it('detaches a retired event session without awaiting its own convergence', async () => {
    const store = new MemoryProjectionStore();
    store.membership = { ...membership(), lastEventSequence: 5 };
    const socket = new FakeEventSocket();
    const holder: { projection?: CollabClientProjection } = {};
    const retirement = {
      handle: jest.fn(() => holder.projection!.closeProject('project-a')),
    };
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      authoritySessions: lanEventSessions(() => socket),
      retirement,
      retirementAdmission: admitProjectRetirement,
    });
    holder.projection = projection;
    await projection.subscribe('project-a', jest.fn());
    socket.message(lanEvent('project-retired', { retiredAt: CREATED_AT }, 6));
    await flushEvents();

    expect(retirement.handle).toHaveBeenCalledTimes(1);
    await expect(Promise.race([
      retirement.handle.mock.results[0]!.value,
      new Promise(resolve => setTimeout(() => resolve('deadlocked'), 100)),
    ])).resolves.toBeUndefined();
    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
  });

  it('does not await terminal convergence from work owned by the closing Project session', async () => {
    const store = new MemoryProjectionStore();
    const control = controlPort();
    control.readSnapshot.mockRejectedValue(new CollabError({
      code: 'project-retired',
      safeContext: { projectId: 'project-a', retiredAt: CREATED_AT },
    }));
    const retirement = { handle: jest.fn(() => new Promise<void>(() => undefined)) };
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      retirement,
      retirementAdmission: admitProjectRetirement,
    });

    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'project-retired',
    });
    expect(retirement.handle).toHaveBeenCalledWith(
      { projectId: 'project-a', retiredAt: CREATED_AT },
      'terminal-fallback',
    );
  });

  it('leaves event and fallback retirement untouched when lifecycle admission rejects', async () => {
    const store = new MemoryProjectionStore();
    store.membership = { ...membership(), lastEventSequence: 5 };
    const control = controlPort();
    const socket = new FakeEventSocket();
    const retirement = { handle: jest.fn().mockResolvedValue(undefined) };
    const retirementAdmission = jest.fn(async () => {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'project-lifecycle-owner-conflict' },
      });
    });
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      authoritySessions: lanEventSessions(() => socket),
      retirement,
      retirementAdmission,
    });
    await projection.subscribe('project-a', jest.fn());

    socket.message(lanEvent('project-retired', { retiredAt: CREATED_AT }, 6));
    await flushEvents();

    control.readSnapshot.mockRejectedValue(new CollabError({
      code: 'project-retired',
      safeContext: { projectId: 'project-a', retiredAt: CREATED_AT },
    }));
    await expect(projection.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'project-retired',
    });
    await flushEvents();

    expect(retirementAdmission).toHaveBeenCalledTimes(2);
    expect(retirement.handle).not.toHaveBeenCalled();
    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
  });

  it('disposes the old event client and reloads membership after a Project reset', async () => {
    const store = new MemoryProjectionStore();
    const sockets: FakeEventSocket[] = [];
    const endpoints: string[] = [];
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      authoritySessions: lanEventSessions(input => {
        endpoints.push(input.endpoint);
        const socket = new FakeEventSocket();
        sockets.push(socket);
        return socket;
      }),
    });

    await projection.subscribe('project-a', jest.fn());
    const currentMembership = store.membership;
    if (!isCollabLocalLanMembership(currentMembership)) throw new Error('Expected LAN membership');
    store.membership = {
      ...currentMembership,
      authority: {
        ...currentMembership.authority,
        endpoint: 'https://192.168.1.30:54545',
      },
    };
    projection.resetProjectConnection('project-a');
    await projection.subscribe('project-a', jest.fn());

    expect(sockets[0]?.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
    expect(endpoints).toEqual([
      'https://192.168.1.20:54545',
      'https://192.168.1.30:54545',
    ]);
  });

  it('rejects a subscription when its adapter resolves after the membership generation resets', async () => {
    const store = new MemoryProjectionStore();
    store.membership = cloudMembership();
    const requested = deferred<void>();
    const response = deferred<CloudAuthorityHttpResponse>();
    const createSocket = jest.fn(() => new FakeEventSocket());
    let requestCount = 0;
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      authoritySessions: cloudEventSessions(createSocket, async input => {
        if (requestCount++ > 0) return cloudSnapshotResponse(input);
        requested.resolve();
        return response.promise;
      }),
    });

    const subscription = projection.subscribe('project-a', jest.fn());
    await requested.promise;
    projection.resetProjectConnection('project-a');
    response.resolve(cloudCapabilities());

    await expect(subscription).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'projection-project-connection-reset' },
    });
    expect(createSocket).not.toHaveBeenCalled();
    projection.dispose();
  });

  it('disposes an event connection created while its authority generation resets', async () => {
    const store = new MemoryProjectionStore();
    const socket = new FakeEventSocket();
    const holder: { projection?: CollabClientProjection } = {};
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      authoritySessions: lanEventSessions(() => {
        holder.projection?.resetProjectConnection('project-a');
        return socket;
      }),
    });
    holder.projection = projection;

    await expect(projection.subscribe('project-a', jest.fn())).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'projection-project-connection-reset' },
    });
    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
    projection.dispose();
  });

  it('closes Project activity through the local-exit activity port', async () => {
    const store = new MemoryProjectionStore();
    const socket = new FakeEventSocket();
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      authoritySessions: lanEventSessions(() => socket),
    });
    await projection.subscribe('project-a', jest.fn());

    await expect(projection.closeProject('project-a')).resolves.toBeUndefined();

    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
  });

  it('leaves the borrowed registry open until its composition owner closes it', async () => {
    const options = projectionOptions();
    const socket = new FakeEventSocket();
    const projection = new CollabClientProjection(new MemoryProjectionStore(), controlPort(), {
      ...options,
      authoritySessions: lanEventSessions(() => socket),
    });
    await projection.subscribe('project-a', jest.fn());

    projection.dispose();
    expect(socket.closed).toEqual([]);
    await options.sessions.close();

    expect(socket.closed).toEqual([{ code: 1000, reason: 'Client stopped' }]);
    await expect(projection.subscribe('project-a', jest.fn())).rejects.toMatchObject({
      code: 'host-stopped',
      safeContext: { reason: 'projection-disposed' },
    });
  });

  it('fences an old in-flight snapshot after a Project reset', async () => {
    const store = new MemoryProjectionStore();
    let resolveFirst!: (value: CollabProjectSnapshot) => void;
    const control = controlPort();
    control.readSnapshot
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(snapshot());
    const projection = new CollabClientProjection(store, control, projectionOptions());

    const staleRead = projection.readSnapshot('project-a');
    projection.resetProjectConnection('project-a');
    resolveFirst(snapshot());

    await expect(staleRead).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.documents.has('project-a')).toBe(false);
    await expect(projection.readSnapshot('project-a')).resolves.toMatchObject({
      source: 'online',
    });
    expect(control.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('dispatches Accept with a fresh idempotency key and exact reviewed OIDs', async () => {
    const control = controlPort();
    const mergeOid = 'b'.repeat(40);
    control.acceptRequest.mockResolvedValue({
      mainOid: mergeOid,
      mergeCommitOid: mergeOid,
      request: {
        commentCount: 0,
        createdAt: CREATED_AT,
        description: 'Published change',
        firstBaseOid: HEAD,
        id: 'request-a',
        latestHeadOid: HEAD,
        memberId: 'member-a',
        mergedOid: mergeOid,
        revision: 2,
        status: 'merged',
        ticketRelations: [],
        updatedAt: CREATED_AT,
      },
    });
    const projection = new CollabClientProjection(new MemoryProjectionStore(), control, projectionOptions());

    await expect(projection.acceptRequest(
      'project-a',
      'request-a',
      HEAD,
      HEAD,
      1,
      [],
    )).resolves.toMatchObject({ mainOid: mergeOid });
    expect(control.acceptRequest).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadOid: HEAD,
      expectedMainOid: HEAD,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      idempotencyKey: expect.stringMatching(/^accept-[a-f0-9]{32}$/),
      projectId: 'project-a',
      requestId: 'request-a',
    }));
  });

  it('uses an explicit Accept idempotency key across transport retries', async () => {
    const control = controlPort();
    control.acceptRequest.mockResolvedValue({
      mainOid: HEAD,
      mergeCommitOid: HEAD,
      request: {
        commentCount: 0,
        createdAt: CREATED_AT,
        description: 'Published change',
        firstBaseOid: HEAD,
        id: 'request-a',
        latestHeadOid: HEAD,
        memberId: 'member-a',
        mergedOid: HEAD,
        revision: 2,
        status: 'merged',
        ticketRelations: [],
        updatedAt: CREATED_AT,
      },
    });
    const projection = new CollabClientProjection(new MemoryProjectionStore(), control, projectionOptions());
    const acceptRequest = projection.acceptRequest.bind(projection) as unknown as (
      projectId: string,
      requestId: string,
      expectedMainOid: string,
      expectedHeadOid: string,
      expectedRequestRevision: number,
      expectedResolvingTickets: readonly [],
      options: Readonly<Record<string, never>>,
      idempotencyKey: string,
    ) => Promise<unknown>;

    await acceptRequest(
      'project-a',
      'request-a',
      HEAD,
      HEAD,
      1,
      [],
      {},
      'accept-intent-stable',
    );

    expect(control.acceptRequest).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'accept-intent-stable',
    }));
  });

  it('reuses an explicit comment idempotency key across a presentation retry', async () => {
    const control = controlPort();
    control.createComment.mockResolvedValue({
      comment: {
        authorMemberId: 'member-a',
        body: 'Please revise',
        createdAt: CREATED_AT,
        id: 'comment-a',
        requestId: 'request-a',
      },
    });
    const projection = new CollabClientProjection(new MemoryProjectionStore(), control, projectionOptions());

    await projection.addComment({
      body: 'Please revise',
      idempotencyKey: 'comment-intent-stable',
      projectId: 'project-a',
      requestId: 'request-a',
    });

    expect(control.createComment).toHaveBeenCalledWith({
      body: 'Please revise',
      idempotencyKey: 'comment-intent-stable',
      projectId: 'project-a',
      requestId: 'request-a',
    });
  });
});

function projectionOptions(): Pick<CollabClientProjectionOptions, 'authoritySessions' | 'sessions'> {
  const sessions = new CollabProjectWorkSessionRegistry();
  registries.add(sessions);
  return {
    authoritySessions: new CollabAuthoritySessionFactory([new LanAuthorityAdapter()]),
    sessions,
  };
}

function lanEventSessions(createSocket: ProjectEventClientSocketFactory): CollabAuthoritySessionFactory {
  return new CollabAuthoritySessionFactory([new LanAuthorityAdapter({
    createEvent: (input, onInvalidation) => new ProjectEventClient(input, onInvalidation, { createSocket }),
  })]);
}

function cloudEventSessions(
  createSocket: NonNullable<CloudProjectEventClientOptions['createSocket']>,
  request: CloudAuthorityHttpTransport = async input => (
    input.method === 'GET' ? cloudCapabilities() : cloudSnapshotResponse(input)
  ),
): CollabAuthoritySessionFactory {
  return new CollabAuthoritySessionFactory([new CloudAuthorityAdapter(cloudVaultRoot, {
    createEventClient: (input, onInvalidation) => new CloudProjectEventClient(input, onInvalidation, { createSocket }),
    request,
  })]);
}

function cloudCapabilities(additional: readonly CollabCloudCapability[] = []): CloudAuthorityHttpResponse {
  return {
    body: collabCloudCapabilityDocument(['project-events', 'project-snapshot', ...additional], {
      maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
      maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
      maxCheckpointRepositoryBundleBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
      maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
      maxDevelopmentBootstrapGitBundleBytes: 1_024,
      maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
      maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
      maxEventReplay: 100,
      maxGitReceivePackBytes: 1_024,
      maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      maxRepositoryBytes: 1_024,
    }),
    contentType: 'application/json',
    status: 200,
  };
}

function cloudSnapshotResponse(input: CloudAuthorityHttpRequest): CloudAuthorityHttpResponse {
  const snapshot = cloudSnapshot();
  const { authorityKind: _authorityKind, mainOid, ...project } = snapshot.project;
  return {
    body: collabCloudSuccessEnvelope(
      (input.body as { readonly requestId: string }).requestId,
      {
        ...snapshot,
        project: { ...project, authorityGeneration: 1, expectedMainOid: mainOid },
      },
    ),
    contentType: 'application/json',
    status: 200,
  };
}

function lanEvent(kind: string, payload: Readonly<Record<string, unknown>>, sequence: number) {
  return { kind, occurredAt: CREATED_AT, payload, projectId: 'project-a', protocolVersion: 9, sequence };
}

async function flushEvents(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

class FakeEventSocket implements ProjectEventClientSocket {
  readonly closed: Array<{ code: number; reason: string }> = [];
  private closeListener?: (code: number) => void;
  private messageListener?: (data: string) => void;
  private openListener?: () => void;

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    this.closeListener?.(code);
  }

  onClose(listener: (code: number) => void): void { this.closeListener = listener; }
  onError(_listener: () => void): void {}
  onMessage(listener: (data: string) => void): void { this.messageListener = listener; }
  onOpen(listener: () => void): void { this.openListener = listener; }
  open(): void { this.openListener?.(); }
  message(value: unknown): void { this.messageListener?.(JSON.stringify(value)); }
}

function membership(): CollabLocalLanMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      endpoint: 'https://192.168.1.20:54545',
      gitRemoteUrl: 'https://192.168.1.20:54545/v1/git/project-a/repository.git',
      hostCaCertificatePem: 'certificate',
      hostCaFingerprint: 'ab'.repeat(32),
      kind: 'lan',
    },
    createdAt: CREATED_AT,
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 0,
    member: {
      credential: 'A'.repeat(43),
      displayName: 'Alice',
      id: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      role: 'member',
    },
    project: {
      id: 'project-a',
      name: 'Alpha',
      workspacePath: 'workspace/project-a',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

function cloudMembership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      bindingVersion: 6,
      gitRemoteUrl: 'https://cloud.example.test/v6/projects/project-a/repository.git',
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 10,
    },
    createdAt: CREATED_AT,
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      role: 'member',
    },
    project: {
      id: 'project-a',
      name: 'Alpha',
      workspacePath: 'workspace/project-a',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

function snapshot(): CollabLanProjectSnapshot {
  const currentMember = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Alice',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role: 'member' as const,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 5,
    members: [currentMember],
    openTicketCount: 0,
    openRequests: [],
    project: {
      authorityKind: 'lan',
      createdAt: CREATED_AT,
      hostMemberId: 'member-host',
      id: 'project-a',
      mainOid: HEAD,
      mainRef: 'refs/heads/main',
      authorityGeneration: 1,
      managerSetGeneration: 0,
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function cloudSnapshot(): CollabCloudProjectSnapshot {
  const currentMember = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Alice',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role: 'member' as const,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 7,
    members: [currentMember],
    openTicketCount: 0,
    openRequests: [],
    project: {
      authorityGeneration: 7,
      authorityKind: 'cloud',
      createdAt: CREATED_AT,
      id: 'project-a',
      mainOid: HEAD,
      mainRef: 'refs/heads/main',
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function controlPort(): jest.Mocked<CollabClientProjectionControlPort> {
  return {
    addTicketComment: jest.fn(),
    acceptRequest: jest.fn(),
    closeTicket: jest.fn(),
    createComment: jest.fn(),
    createTicket: jest.fn(),
    ensure: jest.fn(),
    listRequestComments: jest.fn(),
    listTicketAcceptedRelations: jest.fn(),
    listTicketComments: jest.fn(),
    listTickets: jest.fn(),
    resolveTicketNumber: jest.fn(),
    readRequest: jest.fn(),
    readRequestPage: jest.fn(),
    readSnapshot: jest.fn().mockResolvedValue(snapshot()),
    readTicket: jest.fn(),
    readTicketPage: jest.fn(),
    reopenTicket: jest.fn(),
    updateRequestMetadata: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

function ticketDetail(): CollabTicketDetail {
  return {
    acceptedRelations: { acceptedRelations: [] },
    body: 'Saved Ticket body',
    comments: {
      comments: [{
        authorMemberId: 'member-a',
        body: 'Saved comment',
        createdAt: CREATED_AT,
        id: 'comment-a',
        ticketId: 'ticket-a',
      }],
    },
    ticket: {
      acceptedRelationCount: 0,
      authorMemberId: 'member-a',
      commentCount: 1,
      createdAt: CREATED_AT,
      id: 'ticket-a',
      number: 17,
      revision: 2,
      status: 'open',
      title: 'Saved Ticket',
      updatedAt: CREATED_AT,
    },
  };
}

function ticketDetailWithComments(count: number): CollabTicketDetail {
  const detail = ticketDetail();
  return {
    ...detail,
    comments: {
      comments: Array.from({ length: count }, (_, index) => ({
        authorMemberId: 'member-a',
        body: `Saved comment ${index}`,
        createdAt: CREATED_AT,
        id: `comment-${index}`,
        ticketId: 'ticket-a',
      })),
    },
    ticket: {
      ...detail.ticket,
      commentCount: count,
    },
  };
}

class MemoryProjectionStore implements CollabClientProjectionStore {
  readonly documents = new Map<string, unknown>();
  readonly removedDocuments: Array<[string, 'cache' | 'ticket-cache']> = [];
  membership: CollabLocalMembershipRecord = membership();

  async loadMembership(): Promise<CollabLocalMembershipRecord | null> {
    return this.membership;
  }

  async loadProjectDocument<T>(
    projectId: string,
    kind: 'cache' | 'ticket-cache',
    decode: (value: unknown) => T,
  ): Promise<T | null> {
    const value = this.documents.get(kind === 'cache' ? projectId : `${projectId}:${kind}`);
    return value === undefined ? null : decode(value);
  }

  async saveProjectDocument(
    projectId: string,
    kind: 'cache' | 'ticket-cache',
    document: unknown,
  ): Promise<void> {
    this.documents.set(kind === 'cache' ? projectId : `${projectId}:${kind}`, document);
  }

  async removeProjectDocument(projectId: string, kind: 'cache' | 'ticket-cache'): Promise<boolean> {
    this.removedDocuments.push([projectId, kind]);
    return this.documents.delete(kind === 'cache' ? projectId : `${projectId}:${kind}`);
  }

  async updateMembershipProjection(
    _projectId: string,
    memberId: string,
    role: CollabLocalMembershipRecord['member']['role'],
    sequence: number,
  ): Promise<CollabLocalMembershipRecord> {
    const current = this.membership;
    if (isCollabLocalLanMembership(current)) {
      this.membership = {
        ...current,
        lastEventSequence: sequence,
        member: { ...current.member, id: memberId, role },
      };
    } else {
      this.membership = {
        ...current,
        lastEventSequence: sequence,
        member: { ...current.member, id: memberId, role },
      };
    }
    return this.membership;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>(settle => { resolve = settle; }),
    resolve,
  };
}
