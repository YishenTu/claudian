import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS, COLLAB_LIMITS, collabCloudCapabilityDocument, type CollabTicketDetail } from '@claudian-collab/protocol';

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
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CloudAuthorityAdapter, CloudProjectEventClient, type CloudProjectEventClientOptions } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import {
  CollabAuthoritySessionFactory,
} from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import { LanAuthorityAdapter } from '@/app/collab/remote-authority/LanAuthorityAdapter';
import type { CloudAuthorityHttpResponse, CloudAuthorityHttpTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import { type CollabCloudProjectSnapshot, type CollabLanProjectSnapshot, type CollabProjectSnapshot, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const HEAD = 'a'.repeat(40);
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
      schemaVersion: 4,
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

  it('reconciles offered Manager responsibility before caching the snapshot', async () => {
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
    const acknowledged = {
      ...offered,
      acknowledgedAt: '2026-08-08T00:01:00.000Z',
      status: 'acknowledged' as const,
    };
    control.readSnapshot.mockResolvedValue({
      ...snapshot(),
      managerResponsibilityOffer: offered,
    });
    const reconcileSnapshot = jest.fn().mockResolvedValue(acknowledged);
    const projection = new CollabClientProjection(store, control, {
      ...projectionOptions(),
      managerResponsibility: { reconcileSnapshot },
    });

    const result = await projection.readSnapshot('project-a');

    expect(reconcileSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      managerResponsibilityOffer: offered,
    }));
    expect(isCollabLanProjectSnapshot(result.snapshot)).toBe(true);
    if (!isCollabLanProjectSnapshot(result.snapshot)) throw new Error('Expected LAN snapshot');
    expect(result.snapshot.managerResponsibilityOffer).toEqual(acknowledged);
    expect(store.documents.get('project-a')).toMatchObject({
      snapshot: { managerResponsibilityOffer: acknowledged },
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
      schemaVersion: 4,
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
      schemaVersion: 4,
      snapshot: {
        project: {
          id: 'project-a',
          managerSetGeneration: 0,
        },
      },
      ticketDetails: [],
      ticketPages: [],
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
      protocolVersion: 6,
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
    const projection = new CollabClientProjection(store, controlPort(), {
      ...projectionOptions(),
      authoritySessions: cloudEventSessions(createSocket, async () => {
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
  request: CloudAuthorityHttpTransport = async () => cloudCapabilities(),
): CollabAuthoritySessionFactory {
  return new CollabAuthoritySessionFactory([new CloudAuthorityAdapter({
    createEventClient: (input, onInvalidation) => new CloudProjectEventClient(input, onInvalidation, { createSocket }),
    request,
  })]);
}

function cloudCapabilities(): CloudAuthorityHttpResponse {
  return {
    body: collabCloudCapabilityDocument(['project-events'], {
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

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    this.closeListener?.(code);
  }

  onClose(listener: (code: number) => void): void { this.closeListener = listener; }
  onError(_listener: () => void): void {}
  onMessage(listener: (data: string) => void): void { this.messageListener = listener; }
  onOpen(_listener: () => void): void {}
  message(value: unknown): void { this.messageListener?.(JSON.stringify(value)); }
}

function membership(): CollabLocalLanMembershipRecord {
  return {
    authority: {
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
      bindingVersion: 2,
      developmentActorId: 'member-a',
      gitRemoteUrl: 'https://cloud.example.test/v2/projects/project-a/repository.git',
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 6,
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
  readonly removedDocuments: Array<[string, 'cache']> = [];
  membership: CollabLocalMembershipRecord = membership();

  async loadMembership(): Promise<CollabLocalMembershipRecord | null> {
    return this.membership;
  }

  async loadProjectDocument<T>(
    projectId: string,
    _kind: 'cache',
    decode: (value: unknown) => T,
  ): Promise<T | null> {
    const value = this.documents.get(projectId);
    return value === undefined ? null : decode(value);
  }

  async saveProjectDocument(
    projectId: string,
    _kind: 'cache',
    document: unknown,
  ): Promise<void> {
    this.documents.set(projectId, document);
  }

  async removeProjectDocument(projectId: string, kind: 'cache'): Promise<boolean> {
    this.removedDocuments.push([projectId, kind]);
    return this.documents.delete(projectId);
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
