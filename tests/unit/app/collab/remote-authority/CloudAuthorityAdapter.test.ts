import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
} from '@claudian/collab-protocol';

import type { CollabLocalCloudMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  CloudAuthorityAdapter,
  type CloudAuthorityHttpRequest,
  CloudProjectEventClient,
  type CloudProjectEventSocket,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';

const PROJECT_ID = 'project-cloud';
const ACTOR_ID = 'member-alice';

function membership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      bindingVersion: 1,
      developmentActorId: ACTOR_ID,
      gitRemoteUrl: `https://cloud.example.test/v1/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 4,
    },
    createdAt: '2026-08-22T00:00:00.000Z',
    lastEventSequence: 3,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: ACTOR_ID,
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Project',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

const limits = {
  maxDevelopmentBootstrapGitBundleBytes: 1_024,
  maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
  maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
  maxEventReplay: 100,
  maxGitReceivePackBytes: 1_024,
  maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
  maxRepositoryBytes: 1_024,
};

function cloudSnapshot() {
  return COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse({
    currentMember: {
      activatedAt: '2026-08-22T00:00:00.000Z',
      createdAt: '2026-08-22T00:00:00.000Z',
      displayName: 'Alice',
      id: ACTOR_ID,
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
      status: 'active',
    },
    eventSequence: 7,
    members: [{
      activatedAt: '2026-08-22T00:00:00.000Z',
      createdAt: '2026-08-22T00:00:00.000Z',
      displayName: 'Alice',
      id: ACTOR_ID,
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
      status: 'active',
    }],
    openRequests: [],
    openTicketCount: 0,
    project: {
      createdAt: '2026-08-22T00:00:00.000Z',
      expectedMainOid: 'a'.repeat(40),
      id: PROJECT_ID,
      mainRef: 'refs/heads/main',
      name: 'Cloud Project',
    },
    ticketHighlights: [],
  });
}

describe('CloudAuthorityAdapter', () => {
  it('negotiates package capabilities and maps the strict Cloud snapshot', async () => {
    const requests: CloudAuthorityHttpRequest[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      requests.push(input);
      if (input.method === 'GET') {
        return {
          body: {
            ...collabCloudCapabilityDocument([
              'git-upload-pack',
              'project-events',
              'project-snapshot',
            ], limits),
            capabilities: [
              'future-read-capability',
              'git-upload-pack',
              'project-events',
              'project-snapshot',
            ],
          },
          contentType: 'application/json; charset=utf-8',
          status: 200,
        };
      }
      return {
        body: collabCloudSuccessEnvelope('request-snapshot', cloudSnapshot()),
        contentType: 'application/json; charset=utf-8',
        status: 200,
      };
    });
    const session = await new CloudAuthorityAdapter({ request }).create(membership());

    await expect(session.control.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
      currentMember: { id: ACTOR_ID },
      eventSequence: 7,
      project: {
        authorityKind: 'cloud',
        id: PROJECT_ID,
        mainOid: 'a'.repeat(40),
      },
    });
    expect(session.supports('project-snapshot')).toBe(true);
    expect(session.supports('requests')).toBe(false);
    expect(session.git).toEqual({
      headers: [{ name: 'X-Claudian-Development-Actor', value: ACTOR_ID }],
      remoteUrl: `https://cloud.example.test/v1/projects/${PROJECT_ID}/repository.git`,
    });
    expect(requests).toEqual([
      expect.objectContaining({
        headers: { 'x-claudian-development-actor': ACTOR_ID },
        method: 'GET',
        url: 'https://cloud.example.test/collab/capabilities',
      }),
      expect.objectContaining({
        body: expect.objectContaining({ data: { projectId: PROJECT_ID } }),
        headers: { 'x-claudian-development-actor': ACTOR_ID },
        method: 'POST',
        url: `https://cloud.example.test/v1/projects/${PROJECT_ID}/operations/getProjectSnapshot`,
      }),
    ]);
  });

  it('fails closed on unsupported binding or wire versions', async () => {
    const document = collabCloudCapabilityDocument(['project-snapshot'], limits);
    const adapter = new CloudAuthorityAdapter({
      request: async () => ({
        body: { ...document, bindingVersions: [2] },
        contentType: 'application/json',
        status: 200,
      }),
    });

    await expect(adapter.create(membership())).rejects.toMatchObject({
      code: 'protocol-version-unsupported',
    });
  });

  it('cancels a chunked JSON response as soon as the payload limit is crossed', async () => {
    let pullCount = 0;
    let cancelled = false;
    const chunk = new Uint8Array(Math.floor(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes / 2) + 1);
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      pull: controller => {
        pullCount += 1;
        if (pullCount <= 2) controller.enqueue(chunk);
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));

    await expect(new CloudAuthorityAdapter().create(membership())).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'cloud-authority-response-too-large' },
    });
    expect(cancelled).toBe(true);
    fetchMock.mockRestore();
  });

  it('cancels a response rejected by its declared content length', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
    });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      headers: {
        'content-length': String(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes + 1),
        'content-type': 'application/json',
      },
      status: 200,
    }));

    await expect(new CloudAuthorityAdapter().create(membership())).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'cloud-authority-response-too-large' },
    });
    expect(cancelled).toBe(true);
    fetchMock.mockRestore();
  });
});

describe('CloudProjectEventClient', () => {
  it('refreshes snapshot first, detects a gap, and reconnects after the applied cursor', async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<() => void> = [];
    const onInvalidation = jest.fn(async invalidation => invalidation.sequence);
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      developmentActorId: ACTOR_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: input => {
        const socket = new FakeSocket();
        sockets.push(socket);
        expect(input).toEqual({
          headers: { 'x-claudian-development-actor': ACTOR_ID },
          url: `wss://cloud.example.test/v1/projects/${PROJECT_ID}/events?afterSequence=${
            sockets.length === 1 ? 3 : 5
          }`,
        });
        return socket;
      },
      random: () => 0,
      setTimeout: callback => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    client.start();
    sockets[0]!.open();
    await flush();
    expect(onInvalidation).toHaveBeenLastCalledWith({ kind: 'snapshot', sequence: 3 });

    sockets[0]!.message(JSON.stringify({
      kind: 'snapshot.required',
      latestSequence: 5,
    }));
    await flush();
    expect(onInvalidation).toHaveBeenLastCalledWith({ kind: 'snapshot', sequence: 5 });

    sockets[0]!.closed(1000);
    await flush();
    scheduled.shift()?.();
    expect(sockets).toHaveLength(2);
  });

  it('waits for a slow applied cursor before reconnecting while server backpressure stays server-owned', async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<() => void> = [];
    const firstApplication = deferred<number>();
    const onInvalidation = jest.fn()
      .mockImplementationOnce(() => firstApplication.promise)
      .mockImplementation(async invalidation => invalidation.sequence);
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      developmentActorId: ACTOR_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: input => {
        const socket = new FakeSocket();
        sockets.push(socket);
        expect(input.url).toBe(
          `wss://cloud.example.test/v1/projects/${PROJECT_ID}/events?afterSequence=${
            sockets.length === 1 ? 3 : 4
          }`,
        );
        return socket;
      },
      random: () => 0,
      setTimeout: callback => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    client.start();
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      kind: 'request.updated',
      occurredAt: '2026-08-22T00:00:00.000Z',
      payload: { requestId: 'request-one' },
      projectId: PROJECT_ID,
      protocolVersion: 4,
      sequence: 4,
    }));
    sockets[0]!.closed(1006);
    await flush();
    expect(scheduled).toHaveLength(0);

    firstApplication.resolve(4);
    await flush();
    await flush();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(sockets).toHaveLength(2);
  });

  it('bounds a slow event flood to one active and one coalesced refresh', async () => {
    const socket = new FakeSocket();
    const firstApplication = deferred<number>();
    const onInvalidation = jest.fn()
      .mockImplementationOnce(() => firstApplication.promise)
      .mockImplementation(async invalidation => invalidation.sequence);
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      developmentActorId: ACTOR_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: () => socket,
    });

    client.start();
    socket.open();
    for (let sequence = 4; sequence <= 67; sequence += 1) {
      socket.message(JSON.stringify({
        kind: 'request.updated',
        occurredAt: '2026-08-22T00:00:00.000Z',
        payload: { requestId: `request-${sequence}` },
        projectId: PROJECT_ID,
        protocolVersion: 4,
        sequence,
      }));
    }
    await flush();
    expect(onInvalidation).toHaveBeenCalledTimes(1);

    firstApplication.resolve(3);
    await flush();
    await flush();

    expect(onInvalidation).toHaveBeenCalledTimes(2);
    expect(onInvalidation).toHaveBeenLastCalledWith({ kind: 'snapshot', sequence: 67 });
    client.dispose();
  });

  it('drops coalesced callbacks and ignores active completion after disposal', async () => {
    const socket = new FakeSocket();
    const firstApplication = deferred<number>();
    const onInvalidation = jest.fn(() => firstApplication.promise);
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      developmentActorId: ACTOR_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: () => socket,
    });

    client.start();
    socket.open();
    socket.message(JSON.stringify({
      kind: 'request.updated',
      occurredAt: '2026-08-22T00:00:00.000Z',
      payload: { requestId: 'request-four' },
      projectId: PROJECT_ID,
      protocolVersion: 4,
      sequence: 4,
    }));
    await flush();
    expect(onInvalidation).toHaveBeenCalledTimes(1);

    client.dispose();
    firstApplication.resolve(4);
    await flush();
    await flush();

    expect(onInvalidation).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledWith(1000, 'Client stopped');
  });

  it('cancels a pending reconnect during client shutdown', async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<() => void> = [];
    const clearTimeout = jest.fn();
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      developmentActorId: ACTOR_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, async invalidation => invalidation.sequence, {
      clearTimeout,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
      setTimeout: callback => {
        scheduled.push(callback);
        return 42;
      },
    });

    client.start();
    sockets[0]!.open();
    await flush();
    sockets[0]!.closed(1006);
    await flush();
    expect(scheduled).toHaveLength(1);

    client.dispose();
    expect(clearTimeout).toHaveBeenCalledWith(42);
    scheduled[0]?.();
    expect(sockets).toHaveLength(1);
  });
});

class FakeSocket implements CloudProjectEventSocket {
  private closeListener: ((code: number) => void) | undefined;
  private errorListener: (() => void) | undefined;
  private messageListener: ((data: string) => void) | undefined;
  private openListener: (() => void) | undefined;

  close = jest.fn();
  onClose(listener: (code: number) => void): void { this.closeListener = listener; }
  onError(listener: () => void): void { this.errorListener = listener; }
  onMessage(listener: (data: string) => void): void { this.messageListener = listener; }
  onOpen(listener: () => void): void { this.openListener = listener; }
  closed(code: number): void { this.closeListener?.(code); }
  error(): void { this.errorListener?.(); }
  message(data: string): void { this.messageListener?.(data); }
  open(): void { this.openListener?.(); }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
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
