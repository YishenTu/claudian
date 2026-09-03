import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  type CollabAuthorityTransferStatus,
  type CollabCloudCapability,
  collabCloudCapabilityDocument,
  collabCloudErrorEnvelope,
  collabCloudSuccessEnvelope,
  CollabError as ProtocolError,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { WebSocketServer } from 'ws';

import type { CollabLocalCloudMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import {
  CloudAuthorityAdapter,
  CloudProjectEventClient,
  type CloudProjectEventSocket,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import { NodeCloudAuthorityArtifactTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityArtifactTransport';
import {
  type CloudAuthorityHttpRequest,
  NodeCloudAuthorityHttpTransport,
} from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';

const PROJECT_ID = 'project-cloud';
const ACTOR_ID = 'member-alice';
const CREATED_AT = '2026-08-22T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const MERGED_OID = 'c'.repeat(40);
const STEP_12_CLOUD_MANAGEMENT_CAPABILITIES = Object.freeze([
  'cloud-imported-membership-claims',
  'cloud-project-create',
  'cloud-project-invitations',
  'cloud-project-join',
  'cloud-project-leave',
  'cloud-project-manager-responsibility',
  'cloud-project-membership',
  'development-bootstrap',
  'project-checkpoint-export',
] satisfies readonly CollabCloudCapability[]);

function changeRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commentCount: 0,
    createdAt: CREATED_AT,
    description: 'Published change',
    firstBaseOid: MAIN_OID,
    id: 'request-one',
    latestHeadOid: HEAD_OID,
    memberId: ACTOR_ID,
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function ticketSummary(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    acceptedRelationCount: 0,
    authorMemberId: ACTOR_ID,
    commentCount: 0,
    createdAt: CREATED_AT,
    id: 'ticket-one',
    number: 1,
    revision: 1,
    status: 'open',
    title: 'Ticket title',
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function ticketDetail(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    acceptedRelations: { acceptedRelations: [] },
    body: 'Ticket body',
    comments: { comments: [] },
    ticket: ticketSummary(),
    ...overrides,
  };
}

function membership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      bindingVersion: 4,
      gitRemoteUrl: `https://cloud.example.test/v4/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 8,
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
  maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
  maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
  maxCheckpointRepositoryBundleBytes:
    COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
  maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
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
      authorityGeneration: 1,
      createdAt: '2026-08-22T00:00:00.000Z',
      expectedMainOid: 'a'.repeat(40),
      id: PROJECT_ID,
      mainRef: 'refs/heads/main',
      name: 'Cloud Project',
    },
    ticketHighlights: [],
  });
}

function boundCapabilityDocument(
  capabilities: readonly CollabCloudCapability[],
) {
  return collabCloudCapabilityDocument([
    ...new Set<CollabCloudCapability>(['project-snapshot', ...capabilities]),
  ], limits);
}

function envelopeRequestId(input: CloudAuthorityHttpRequest | string): string {
  if (typeof input === 'string') return input;
  return (input.body as { readonly requestId: string }).requestId;
}

function cloudSnapshotResponse(input: CloudAuthorityHttpRequest | string) {
  return {
    body: collabCloudSuccessEnvelope(envelopeRequestId(input), cloudSnapshot()),
    contentType: 'application/json',
    status: 200,
  } as const;
}

describe('CloudAuthorityAdapter', () => {
  jest.setTimeout(30_000);

  it('preserves the HTTPS prefix with native certificate verification for JSON, artifacts, and WebSockets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-tls-'));
    const identity = await new LanTlsIdentity(root, { installationKey: TEST_INSTALLATION_A })
      .issueServerIdentity('127.0.0.1');
    const observed: Array<{ actor: unknown; path: string }> = [];
    const server = createHttpsServer({ cert: identity.certificateChainPem, key: identity.privateKeyPem }, (request, response) => {
      observed.push({ actor: request.headers['x-claudian-development-actor'], path: request.url ?? '' });
      if (request.url?.endsWith('/checkpoint/checkpoint.json')) {
        response.setHeader('content-type', 'application/octet-stream');
        response.setHeader('content-length', '2');
        response.end('{}');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.method === 'GET'
        ? collabCloudCapabilityDocument(['authority-transfer', 'project-snapshot', 'project-events'], limits)
        : collabCloudSuccessEnvelope('tls-snapshot', cloudSnapshot())));
    });
    const sockets = new WebSocketServer({ noServer: true });
    let connected!: () => void;
    const opened = new Promise<void>(resolve => { connected = resolve; });
    server.on('upgrade', (request, socket, head) => {
      observed.push({ actor: request.headers['x-claudian-development-actor'], path: request.url ?? '' });
      sockets.handleUpgrade(request, socket, head, connected);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const serverUrl = `HTTPS://127.0.0.1:${address.port}/operator/cloud/`;
    const trustedCa = getCACertificates('default');
    let eventDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(new CloudAuthorityAdapter().connect({ projectId: PROJECT_ID, serverUrl }))
        .rejects.toMatchObject({ code: 'endpoint-unreachable' });
      // Install only this fixture CA in the test process; production TLS options remain untouched.
      setDefaultCACertificates([...trustedCa, identity.caCertificatePem]);
      const bound = membership();
      const session = await new CloudAuthorityAdapter({
        requestIdFactory: () => 'tls-snapshot',
      }).create({
        ...bound,
        authority: {
          ...bound.authority,
          gitRemoteUrl: `https://127.0.0.1:${address.port}/operator/cloud/v4/projects/project-cloud/repository.git`,
          serverUrl,
        },
      });
      try {
        const artifact = await session.lifecycle!.downloadAuthorityTransferArtifact({
          artifact: 'checkpoint.json', projectId: PROJECT_ID, transferId: 'transfer-one',
        });
        const chunks: Buffer[] = [];
        for await (const chunk of artifact.body) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString('utf8')).toBe('{}');
        session.events.connect({ afterSequence: 3, onInvalidation: async () => 3 });
        await Promise.race([
          opened,
          new Promise<never>((_resolve, reject) => {
            eventDeadline = setTimeout(() => reject(new Error('TLS event connection did not open')), 5_000);
          }),
        ]);
        expect(observed).toEqual([
          { actor: undefined, path: '/operator/cloud/collab/capabilities' },
          { actor: undefined, path: '/operator/cloud/v4/projects/project-cloud/operations/getProjectSnapshot' },
          { actor: undefined, path: '/operator/cloud/v4/projects/project-cloud/authority-transfers/transfer-one/checkpoint/checkpoint.json' },
          { actor: undefined, path: '/operator/cloud/v4/projects/project-cloud/events?afterSequence=3' },
        ]);
      } finally {
        session.dispose();
      }
    } finally {
      clearTimeout(eventDeadline);
      setDefaultCACertificates(trustedCa);
      for (const peer of sockets.clients) peer.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures an unbound connection target before asynchronous negotiation', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const adapter = new CloudAuthorityAdapter({
      request: async input => {
        await ready;
        return {
          body: input.method === 'GET'
            ? collabCloudCapabilityDocument(['project-snapshot'], limits)
            : collabCloudSuccessEnvelope(envelopeRequestId(input), cloudSnapshot()),
          contentType: 'application/json',
          status: 200,
        };
      },
    });
    const binding = { projectId: PROJECT_ID, serverUrl: 'HTTP://198.51.100.20/operator/cloud' };
    const pending = adapter.connect(binding);
    binding.projectId = 'project-foreign';
    binding.serverUrl = 'https://foreign.example.test';
    release();
    const connection = await pending;
    try {
      expect(connection.projectId).toBe('project-cloud');
      expect(connection.serverUrl).toBe('HTTP://198.51.100.20/operator/cloud');
      await expect(connection.readSnapshot(PROJECT_ID)).resolves.toMatchObject({ project: { id: PROJECT_ID } });
    } finally {
      connection.dispose();
    }
  });

  it.each(['bound', 'unbound'] as const)('cancels %s capability negotiation through the native transport', async kind => {
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    const server = createServer(() => requested());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const adapter = new CloudAuthorityAdapter({ request: new NodeCloudAuthorityHttpTransport(200).request });
    const controller = new AbortController();
    const bound = membership();
    try {
      const pending = kind === 'bound'
        ? adapter.create({
          ...bound,
          authority: {
            ...bound.authority,
            gitRemoteUrl: `${serverUrl}/v4/projects/project-cloud/repository.git`,
            serverUrl,
          },
        }, { signal: controller.signal })
        : adapter.connect({ projectId: PROJECT_ID, serverUrl }, { signal: controller.signal });
      await started;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['dispose', 'caller'] as const)('fences a late snapshot completion after %s cancellation', async cancellation => {
    let release!: (response: Awaited<ReturnType<NodeCloudAuthorityHttpTransport['request']>>) => void;
    const response = new Promise<Awaited<ReturnType<NodeCloudAuthorityHttpTransport['request']>>>(resolve => { release = resolve; });
    let snapshotReads = 0;
    const session = await new CloudAuthorityAdapter({
      request: async input => input.method === 'GET'
        ? { body: boundCapabilityDocument([]), contentType: 'application/json', status: 200 }
        : snapshotReads++ === 0
          ? cloudSnapshotResponse(input)
          : response,
    }).create(membership());
    const controller = new AbortController();
    try {
      const pending = session.control.readSnapshot(PROJECT_ID, { signal: controller.signal });
      if (cancellation === 'dispose') session.dispose();
      else controller.abort();
      release({ body: collabCloudSuccessEnvelope('late-response', cloudSnapshot()), contentType: 'application/json', status: 200 });
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      session.dispose();
    }
  });

  it('owns and closes its prefixed WebSocket without a development assertion', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.method === 'GET'
        ? boundCapabilityDocument(['project-events'])
        : collabCloudSuccessEnvelope('response-bound-snapshot', cloudSnapshot())));
    });
    const sockets = new WebSocketServer({ noServer: true });
    let connected!: () => void;
    let closed!: () => void;
    const opened = new Promise<void>(resolve => { connected = resolve; });
    const disconnected = new Promise<boolean>(resolve => { closed = () => resolve(true); });
    let observed: unknown;
    server.on('upgrade', (request, socket, head) => {
      observed = { actor: request.headers['x-claudian-development-actor'], path: request.url };
      sockets.handleUpgrade(request, socket, head, peer => {
        peer.once('close', closed);
        connected();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const serverUrl = `http://127.0.0.1:${address.port}/operator/cloud`;
    const bound = membership();
    const session = await new CloudAuthorityAdapter({
      requestIdFactory: () => 'response-bound-snapshot',
    }).create({
      ...bound,
      authority: {
        ...bound.authority,
        gitRemoteUrl: `${serverUrl}/v4/projects/project-cloud/repository.git`,
        serverUrl,
      },
    });
    const connection = session.events.connect({ afterSequence: 3, onInvalidation: async () => 3 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await opened;
      // The HTTP upgrade has reached the server; let the client finish opening before disposal.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observed).toEqual({
        actor: undefined,
        path: '/operator/cloud/v4/projects/project-cloud/events?afterSequence=3',
      });
      session.dispose();
      expect(await Promise.race([
        disconnected,
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 200); }),
      ])).toBe(true);
      expect(() => session.events.connect({ afterSequence: 3, onInvalidation: async () => 3 }))
        .toThrow(expect.objectContaining({ code: 'cancelled' }));
    } finally {
      clearTimeout(timer);
      connection.dispose();
      session.dispose();
      for (const peer of sockets.clients) peer.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['upload', 'download'] as const)('aborts a prefixed artifact %s when the unbound connection is disposed', async direction => {
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    let observed: unknown;
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/collab/capabilities')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(collabCloudCapabilityDocument(['authority-transfer'], limits)));
      } else {
        observed = { actor: request.headers['x-claudian-development-actor'], path: request.url };
        request.resume();
        requested();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const connection = await new CloudAuthorityAdapter({
      artifacts: new NodeCloudAuthorityArtifactTransport(200, 400),
    }).connect({
      projectId: PROJECT_ID,
      serverUrl: `http://127.0.0.1:${address.port}/operator/cloud`,
    });
    const artifact = { artifact: 'checkpoint.json' as const, projectId: PROJECT_ID, transferId: 'transfer-one' };
    try {
      const pending = direction === 'upload'
        ? connection.lifecycle.uploadAuthorityTransferArtifact({ ...artifact, body: Readable.from('x'), byteCount: 1 })
        : connection.lifecycle.downloadAuthorityTransferArtifact(artifact);
      await started;
      connection.dispose();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      expect(observed).toEqual({
        actor: undefined,
        path: '/operator/cloud/v4/projects/project-cloud/authority-transfers/transfer-one/checkpoint/checkpoint.json',
      });
    } finally {
      connection.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['bound', 'unbound'] as const)('disposes %s connections by aborting in-flight reads and closing further admission', async kind => {
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    let snapshotReads = 0;
    const server = createServer((request, response) => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(boundCapabilityDocument([])));
      } else if (kind === 'bound' && snapshotReads++ === 0) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(collabCloudSuccessEnvelope(
          'response-bound-snapshot',
          cloudSnapshot(),
        )));
      } else {
        reading();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const adapter = new CloudAuthorityAdapter({
      request: new NodeCloudAuthorityHttpTransport(200).request,
      requestIdFactory: () => 'response-bound-snapshot',
    });
    const bound = membership();
    const connection = kind === 'bound'
      ? await adapter.create({
        ...bound,
        authority: {
          ...bound.authority,
          gitRemoteUrl: `${serverUrl}/v4/projects/project-cloud/repository.git`,
          serverUrl,
        },
      })
      : await adapter.connect({ projectId: PROJECT_ID, serverUrl });
    const read = () => 'control' in connection
      ? connection.control.readSnapshot(PROJECT_ID)
      : connection.readSnapshot(PROJECT_ID);
    try {
      const pending = read();
      await started;
      connection.dispose();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      await expect(read()).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      connection.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    { authorityGeneration: undefined },
    { authorityGeneration: 0 },
    { authorityGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { bindingVersion: 2 },
    { wireVersion: 6 },
    { gitRemoteUrl: 'https://other.example.test/v4/projects/project-cloud/repository.git' },
  ])('rejects invalid bound authority facts before connecting: %j', async authority => {
    const bound = membership();
    const request = jest.fn(async () => { throw new Error('Connection must not be attempted'); });
    await expect(new CloudAuthorityAdapter({ request }).create({
      ...bound,
      authority: { ...bound.authority, ...authority } as CollabLocalCloudMembershipRecord['authority'],
    })).rejects.toThrow('Invalid Cloud authority binding');
  });

  it('rejects a bound personal ref for another Member before connecting', async () => {
    const bound = membership();
    const request = jest.fn(async () => { throw new Error('Connection must not be attempted'); });
    await expect(new CloudAuthorityAdapter({ request }).create({
      ...bound,
      member: { ...bound.member, personalRef: 'refs/heads/members/member-bob' },
    })).rejects.toThrow('Invalid Cloud authority binding');
  });

  it('uses the configured HTTP prefix without asserting a development identity', async () => {
    const observed: Array<{ actor: string | string[] | undefined; path: string }> = [];
    const server = createServer((request, response) => {
      observed.push({
        actor: request.headers['x-claudian-development-actor'],
        path: request.url ?? '',
      });
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.end(JSON.stringify(collabCloudCapabilityDocument(['project-snapshot'], limits)));
        return;
      }
      const snapshot = cloudSnapshot();
      response.end(JSON.stringify(collabCloudSuccessEnvelope('prefixed-snapshot', {
        ...snapshot,
        project: { ...snapshot.project, authorityGeneration: 7 },
      })));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const serverUrl = `HTTP://127.0.0.1:${address.port}/operator/cloud`;
    const gitRemoteUrl = `http://127.0.0.1:${address.port}/operator/cloud/v4/projects/project-cloud/repository.git`;
    const bound = membership();
    const adapter = new CloudAuthorityAdapter({ requestIdFactory: () => 'prefixed-snapshot' });
    try {
      const session = await adapter.create({
        ...bound,
        authority: { ...bound.authority, authorityGeneration: 7, gitRemoteUrl, serverUrl },
      });
      try {
        expect(session.git).toEqual({ headers: [], remoteUrl: gitRemoteUrl });
        expect(observed).toEqual([
          { actor: undefined, path: '/operator/cloud/collab/capabilities' },
          { actor: undefined, path: '/operator/cloud/v4/projects/project-cloud/operations/getProjectSnapshot' },
        ]);
      } finally {
        session.dispose();
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('exposes only the implemented Step 13 membership-management capabilities', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => input.method === 'GET'
      ? {
        body: boundCapabilityDocument(STEP_12_CLOUD_MANAGEMENT_CAPABILITIES),
        contentType: 'application/json',
        status: 200,
      }
      : cloudSnapshotResponse(input));
    const adapter = new CloudAuthorityAdapter({ request });
    const [session, lifecycle] = await Promise.all([
      adapter.create(membership()),
      adapter.connect({
        projectId: PROJECT_ID,
        serverUrl: 'https://cloud.example.test',
      }),
    ]);

    for (const capability of STEP_12_CLOUD_MANAGEMENT_CAPABILITIES) {
      const expected = [
        'cloud-imported-membership-claims',
        'cloud-project-invitations',
        'cloud-project-leave',
        'cloud-project-manager-responsibility',
        'cloud-project-membership',
      ].includes(capability);
      expect(session.supports(capability)).toBe(expected);
      expect(lifecycle.supports(capability)).toBe(expected);
    }
    expect(session.membership?.authorityKind).toBe('cloud');
  });

  it('opens one exact bound Cloud Leave recovery connection', async () => {
    const readPersonalRef = jest.fn(async () => HEAD_OID);
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: collabCloudCapabilityDocument([
            'cloud-project-leave',
            'cloud-project-manager-responsibility',
            'cloud-project-membership',
            'git-upload-pack',
            'project-snapshot',
          ], limits),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1);
      const data = operation === 'getProjectSnapshot'
        ? cloudSnapshot()
        : operation === 'listProjectMembers'
          ? {
            managerSetGeneration: 7,
            members: [{
              bindingState: 'bound',
              displayName: 'Alice',
              importedClaimGeneration: null,
              importedClaimState: 'not-applicable',
              memberId: ACTOR_ID,
              membershipRevision: 9,
              role: 'manager',
            }],
            projectId: PROJECT_ID,
          }
          : {
            discardedRequestId: null,
            leftAt: CREATED_AT,
            managerSetGeneration: 8,
            memberId: ACTOR_ID,
            projectId: PROJECT_ID,
            promotedSuccessorMemberId: null,
            status: 'left',
          };
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), data),
        contentType: 'application/json',
        status: 200,
      };
    });
    const connection = await new CloudAuthorityAdapter({
      readPersonalRef,
      request,
    }).connectPendingLeave({
      authorityGeneration: 1,
      memberId: ACTOR_ID,
      personalRef: 'refs/heads/members/member-alice',
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });

    await expect(connection.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
      currentMember: { id: ACTOR_ID },
    });
    await expect(connection.listProjectMembers({ projectId: PROJECT_ID })).resolves
      .toMatchObject({ managerSetGeneration: 7 });
    await expect(connection.readPersonalRefOid(
      'refs/heads/members/member-alice',
    )).resolves.toBe(HEAD_OID);
    await expect(connection.leaveProject({
      expectedManagerSetGeneration: 7,
      expectedMembershipRevision: 9,
      expectedOfferRevision: null,
      expectedPersonalRefOid: HEAD_OID,
      idempotencyKey: 'leave-cloud-one',
      managerResponsibilityOfferId: null,
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({ memberId: ACTOR_ID, status: 'left' });

    expect(readPersonalRef).toHaveBeenCalledWith(expect.objectContaining({
      personalRef: 'refs/heads/members/member-alice',
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }));
    connection.dispose();
  });

  it('opens one exact bound Cloud Retirement recovery connection', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: collabCloudCapabilityDocument([
            'cloud-project-membership',
            'project-retirement',
            'project-snapshot',
          ], limits),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1);
      const data = operation === 'getProjectSnapshot'
        ? cloudSnapshot()
        : operation === 'listProjectMembers'
          ? {
            managerSetGeneration: 7,
            members: [{
              bindingState: 'bound',
              displayName: 'Alice',
              importedClaimGeneration: null,
              importedClaimState: 'not-applicable',
              memberId: ACTOR_ID,
              membershipRevision: 9,
              role: 'manager',
            }],
            projectId: PROJECT_ID,
          }
          : {
            acknowledgementRequired: true,
            kind: 'project-retired',
            projectId: PROJECT_ID,
            retiredAt: CREATED_AT,
            retirementId: 'retirement-cloud-one',
            terminalExpiresAt: '2026-09-26T00:00:00.000Z',
          };
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), data),
        contentType: 'application/json',
        status: 200,
      };
    });
    const connection = await new CloudAuthorityAdapter({ request })
      .connectPendingRetirement({
        authorityGeneration: 1,
        memberId: ACTOR_ID,
        personalRef: 'refs/heads/members/member-alice',
        projectId: PROJECT_ID,
        serverUrl: 'https://cloud.example.test',
      });

    await expect(connection.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
      currentMember: { id: ACTOR_ID },
    });
    await expect(connection.listProjectMembers({ projectId: PROJECT_ID })).resolves
      .toMatchObject({ managerSetGeneration: 7 });
    await expect(connection.retireProject({
      expectedAuthorityGeneration: 1,
      expectedMainOid: HEAD_OID,
      idempotencyKey: 'retire-cloud-one',
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({ retirementId: 'retirement-cloud-one' });
    connection.dispose();
  });

  it('opens one exact bound authority-transfer connection without a snapshot preflight', async () => {
    const transferStatus = {
      batchRevision: null,
      batchSha256: null,
      checkpointSha256: null,
      createdAt: CREATED_AT,
      direction: 'cloud-to-lan',
      expiresAt: '2026-09-21T00:00:00.000Z',
      phase: 'collecting-readiness',
      projectId: PROJECT_ID,
      relinquishmentProof: null,
      sourceAuthority: { generation: 1, kind: 'cloud' },
      state: 'active',
      targetAuthority: { generation: 2, kind: 'lan' },
      targetUrl: 'https://192.168.1.10:43123',
      transferId: 'transfer-cloud-to-lan',
      updatedAt: CREATED_AT,
    } satisfies CollabAuthorityTransferStatus;
    const requests: CloudAuthorityHttpRequest[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      requests.push(input);
      return {
        body: input.method === 'GET'
          ? collabCloudCapabilityDocument([
            'authority-transfer',
            'cloud-project-membership',
            'project-snapshot',
          ], limits)
          : collabCloudSuccessEnvelope(envelopeRequestId(input), transferStatus),
        contentType: 'application/json',
        status: 200,
      };
    });
    const connection = await new CloudAuthorityAdapter({ request })
      .connectAuthorityTransfer({
        authorityGeneration: 1,
        memberId: ACTOR_ID,
        personalRef: 'refs/heads/members/member-alice',
        projectId: PROJECT_ID,
        serverUrl: 'https://cloud.example.test',
      });

    expect(requests.map(input => input.url)).toEqual([
      'https://cloud.example.test/collab/capabilities',
    ]);
    await expect(connection.lifecycle.authorityTransfer(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: transferStatus.transferId },
    )).resolves.toEqual(transferStatus);
    expect(requests.map(input => input.url)).toEqual([
      'https://cloud.example.test/collab/capabilities',
      `https://cloud.example.test/v4/projects/${PROJECT_ID}`
        + '/operations/getProjectAuthorityTransfer',
    ]);
    connection.dispose();
  });

  it('reads an unbound lifecycle snapshot using only the server-established Member identity', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? collabCloudCapabilityDocument(['project-snapshot'], limits)
        : collabCloudSuccessEnvelope(envelopeRequestId(input), cloudSnapshot()),
      contentType: 'application/json',
      status: 200,
    }));
    const lifecycle = await new CloudAuthorityAdapter({ request }).connect({
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });

    await expect(lifecycle.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
      currentMember: {
        id: ACTOR_ID,
        personalRef: 'refs/heads/members/member-alice',
      },
      project: { id: PROJECT_ID },
    });
    lifecycle.dispose();
  });

  it('rejects a bound session before exposing mutation ports when its authenticated snapshot has another authority generation', async () => {
    const requests: CloudAuthorityHttpRequest[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      requests.push(input);
      return {
        body: input.method === 'GET'
          ? collabCloudCapabilityDocument([
            'cloud-project-membership',
            'project-snapshot',
          ], limits)
          : collabCloudSuccessEnvelope(envelopeRequestId(input), cloudSnapshot()),
        contentType: 'application/json',
        status: 200,
      };
    });
    const bound = membership();
    const pending = new CloudAuthorityAdapter({ request }).create({
      ...bound,
      authority: { ...bound.authority, authorityGeneration: 7 },
    });

    await expect(pending).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-control-snapshot-response-mismatch' },
    });
    expect(requests.map(input => input.url)).toEqual([
      'https://cloud.example.test/collab/capabilities',
      `https://cloud.example.test/v4/projects/${PROJECT_ID}/operations/getProjectSnapshot`,
    ]);
  });

  it('rejects an authenticated snapshot success envelope correlated to another request', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? boundCapabilityDocument([])
        : collabCloudSuccessEnvelope('response-for-another-request', cloudSnapshot()),
      contentType: 'application/json',
      status: 200,
    }));

    await expect(new CloudAuthorityAdapter({
      request,
      requestIdFactory: () => 'snapshot-request',
    }).create(membership())).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-control-response-request-id-mismatch' },
    });
  });

  it.each(['success', 'rejection'] as const)(
    'rejects an operation %s envelope correlated to another request without completed-rejection provenance',
    async outcome => {
      const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
        if (input.method === 'GET') {
          return {
            body: boundCapabilityDocument(['requests']),
            contentType: 'application/json',
            status: 200,
          };
        }
        if (input.url.endsWith('/getProjectSnapshot')) {
          return cloudSnapshotResponse('operation-request');
        }
        return {
          body: outcome === 'success'
            ? collabCloudSuccessEnvelope('response-for-another-request', {
              mainOid: MAIN_OID,
              request: changeRequest(),
            })
            : collabCloudErrorEnvelope(
              'response-for-another-request',
              new ProtocolError({ code: 'authorization-denied' }),
            ),
          contentType: 'application/json',
          status: outcome === 'success' ? 200 : 403,
        };
      });
      const session = await new CloudAuthorityAdapter({
        request,
        requestIdFactory: () => 'operation-request',
      }).create(membership());

      const operation = session.control.ensure({
        description: 'Published change',
        expectedMainOid: MAIN_OID,
        headOid: HEAD_OID,
        idempotencyKey: 'publish-head',
        projectId: PROJECT_ID,
      });
      const rejection: unknown = await operation.catch((error: unknown) => error);
      expect(rejection).toMatchObject({
        code: 'authority-integrity-error',
        safeContext: { reason: 'cloud-control-response-request-id-mismatch' },
      });
      expect(rejection).not.toBeInstanceOf(CloudAuthorityRejection);
      session.dispose();
    },
  );

  it('admits a Project through a short-lived connection without a fabricated membership', async () => {
    const received: unknown[] = [];
    let returnedProjectId = PROJECT_ID;
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.end(JSON.stringify(collabCloudCapabilityDocument(['cloud-project-create'], limits)));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        actor: request.headers['x-claudian-development-actor'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        path: request.url,
      });
      response.end(JSON.stringify(collabCloudSuccessEnvelope('request-entry', {
        createdAt: CREATED_AT,
        mainOid: MAIN_OID,
        managerSetGeneration: 1,
        memberId: 'member-server-selected',
        membershipRevision: 2,
        personalRef: 'refs/heads/members/member-server-selected',
        projectId: returnedProjectId,
        role: 'manager',
      })));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    try {
      const connection = await new CloudAuthorityAdapter({
        requestIdFactory: () => 'request-entry',
      }).connect({
        projectId: PROJECT_ID,
        serverUrl: `http://127.0.0.1:${address.port}/operator/cloud/`,
      });
      try {
        await expect(connection.createProject({
          idempotencyKey: 'create-exact-intent',
          managerDisplayName: 'Alice',
          projectId: PROJECT_ID,
          projectName: 'Cloud Project',
        })).resolves.toMatchObject({
          memberId: 'member-server-selected',
          personalRef: 'refs/heads/members/member-server-selected',
          projectId: PROJECT_ID,
        });
        expect(received).toEqual([{
          actor: undefined,
          body: {
            data: {
              idempotencyKey: 'create-exact-intent',
              managerDisplayName: 'Alice',
              projectId: 'project-cloud',
              projectName: 'Cloud Project',
            },
            protocolVersion: 8,
            requestId: 'request-entry',
          },
          path: '/operator/cloud/v4/projects/project-cloud/operations/createCloudProject',
        }]);
        returnedProjectId = 'project-other';
        await expect(connection.createProject({
          idempotencyKey: 'create-exact-intent',
          managerDisplayName: 'Alice',
          projectId: PROJECT_ID,
          projectName: 'Cloud Project',
        })).rejects.toMatchObject({ code: 'authority-integrity-error' });
      } finally {
        connection.dispose();
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('binds negotiated lifecycle control and artifact routes without a local registry', async () => {
    const transferStatus = {
      batchRevision: null,
      batchSha256: null,
      checkpointSha256: null,
      createdAt: CREATED_AT,
      direction: 'cloud-to-lan',
      expiresAt: '2026-09-21T00:00:00.000Z',
      phase: 'collecting-readiness',
      projectId: PROJECT_ID,
      relinquishmentProof: null,
      sourceAuthority: { generation: 1, kind: 'cloud' },
      state: 'active',
      targetAuthority: { generation: 2, kind: 'lan' },
      targetUrl: 'https://192.168.1.10:43123',
      transferId: 'transfer-cloud-to-lan',
      updatedAt: CREATED_AT,
    } satisfies CollabAuthorityTransferStatus;
    const jsonRequests: CloudAuthorityHttpRequest[] = [];
    const uploaded: Buffer[] = [];
    const adapter = new CloudAuthorityAdapter({
      artifacts: {
        download: input => Promise.resolve({
          body: Readable.from(['checkpoint']),
          byteCount: 10,
          status: 200,
        }),
        upload: async input => {
          for await (const chunk of input.body) uploaded.push(Buffer.from(chunk));
          return { body: undefined, contentType: null, status: 204 };
        },
      },
      request: async input => {
        jsonRequests.push(input);
        if (input.method === 'GET') {
          return {
            body: collabCloudCapabilityDocument([
              'authority-transfer',
              'project-retirement',
              'project-snapshot',
            ], limits),
            contentType: 'application/json',
            status: 200,
          };
        }
        const operation = input.url.split('/').at(-1);
        return {
          body: collabCloudSuccessEnvelope(
            envelopeRequestId(input),
            operation === 'getProjectSnapshot' ? cloudSnapshot() : transferStatus,
          ),
          contentType: 'application/json',
          status: 200,
        };
      },
    });
    const session = await adapter.create(membership());
    expect(session.lifecycle).toBeDefined();

    await expect(session.lifecycle!.authorityTransfer(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: transferStatus.transferId },
    )).resolves.toEqual(transferStatus);
    await session.lifecycle!.uploadAuthorityTransferArtifact({
      artifact: 'checkpoint.json',
      body: Readable.from(['checkpoint']),
      byteCount: 10,
      projectId: PROJECT_ID,
      transferId: transferStatus.transferId,
    });
    const download = await session.lifecycle!.downloadAuthorityTransferArtifact({
      artifact: 'checkpoint.json',
      projectId: PROJECT_ID,
      transferId: transferStatus.transferId,
    });
    const downloaded: Buffer[] = [];
    for await (const chunk of download.body) downloaded.push(Buffer.from(chunk));

    expect(jsonRequests[2]?.url).toBe(
      `https://cloud.example.test/v4/projects/${PROJECT_ID}`
        + '/operations/getProjectAuthorityTransfer',
    );
    expect(Buffer.concat(uploaded).toString('utf8')).toBe('checkpoint');
    expect(Buffer.concat(downloaded).toString('utf8')).toBe('checkpoint');
  });

  it.each(['upload', 'download'] as const)('rejects binding 2 before binary %s transport', async direction => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ...collabCloudCapabilityDocument(['authority-transfer'], limits),
        bindingVersions: [2],
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const operation = async () => {
        const connection = await new CloudAuthorityAdapter().connect({
          projectId: PROJECT_ID,
          serverUrl: `http://127.0.0.1:${address.port}`,
        });
        const artifact = { artifact: 'checkpoint.json' as const, projectId: PROJECT_ID, transferId: 'transfer-current' };
        if (direction === 'upload') {
          await connection.lifecycle.uploadAuthorityTransferArtifact({
            ...artifact, body: Readable.from(['checkpoint']), byteCount: 10,
          });
        } else {
          await connection.lifecycle.downloadAuthorityTransferArtifact(artifact);
        }
      };
      await expect(operation()).rejects.toMatchObject({ code: 'protocol-version-unsupported' });
      expect(paths).toEqual(['/collab/capabilities']);
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it('keeps lifecycle calls capability-gated and rejects legacy binding documents', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => input.method === 'GET'
      ? {
        body: boundCapabilityDocument([]),
        contentType: 'application/json',
        status: 200,
      }
      : cloudSnapshotResponse(input));
    const session = await new CloudAuthorityAdapter({ request }).create(membership());
    await expect(session.lifecycle!.authorityTransfer(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: 'transfer-unavailable' },
    )).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'cloud-authority-capability-unavailable' },
    });

    request.mockResolvedValueOnce({
      body: {
        ...collabCloudCapabilityDocument([], limits),
        bindingVersions: [2],
        protocolVersions: [6],
      },
      contentType: 'application/json',
      status: 200,
    });
    await expect(new CloudAuthorityAdapter({ request }).create(membership()))
      .rejects.toMatchObject({ code: 'protocol-version-unsupported' });
  });

  it('uses the desktop transport for default capability and snapshot reads', async () => {
    const requests: Array<{ readonly actor: string | undefined; readonly url: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        actor: typeof request.headers['x-claudian-development-actor'] === 'string'
          ? request.headers['x-claudian-development-actor']
          : undefined,
        url: request.url ?? '',
      });
      response.setHeader('content-type', 'application/json; charset=utf-8');
      if (request.method === 'GET') {
        response.end(JSON.stringify(collabCloudCapabilityDocument([
          'project-snapshot',
        ], limits)));
        return;
      }
      response.end(JSON.stringify(collabCloudSuccessEnvelope(
        'request-snapshot',
        cloudSnapshot(),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('renderer fetch is disabled'),
    );
    const localMembership = {
      ...membership(),
      authority: {
        ...membership().authority,
        gitRemoteUrl: `http://127.0.0.1:${address.port}/v4/projects/project-cloud/repository.git`,
        serverUrl: `http://127.0.0.1:${address.port}`,
      },
    } satisfies CollabLocalCloudMembershipRecord;

    try {
      const session = await new CloudAuthorityAdapter({
        requestIdFactory: () => 'request-snapshot',
      }).create(localMembership);
      expect(requests).toEqual([
        { actor: undefined, url: '/collab/capabilities' },
        {
          actor: undefined,
          url: `/v4/projects/${PROJECT_ID}/operations/getProjectSnapshot`,
        },
      ]);
      session.dispose();
    } finally {
      fetchMock.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

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
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), cloudSnapshot()),
        contentType: 'application/json; charset=utf-8',
        status: 200,
      };
    });
    const session = await new CloudAuthorityAdapter({ request }).create(membership());
    expect(session.supports('project-snapshot')).toBe(true);
    expect(session.supports('requests')).toBe(false);
    expect(session.git).toEqual({
      headers: [],
      remoteUrl: `https://cloud.example.test/v4/projects/${PROJECT_ID}/repository.git`,
    });
    expect(requests).toEqual([
      expect.objectContaining({
        headers: {},
        method: 'GET',
        url: 'https://cloud.example.test/collab/capabilities',
      }),
      expect.objectContaining({
        body: expect.objectContaining({ data: { projectId: PROJECT_ID } }),
        headers: {},
        method: 'POST',
        url: `https://cloud.example.test/v4/projects/${PROJECT_ID}/operations/getProjectSnapshot`,
      }),
    ]);
  });

  it('ensures the current member Request through the package-owned Cloud operation', async () => {
    const requests: CloudAuthorityHttpRequest[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      requests.push(input);
      if (input.method === 'GET') {
        return {
          body: boundCapabilityDocument(['requests']),
          contentType: 'application/json; charset=utf-8',
          status: 200,
        };
      }
      if (input.url.endsWith('/getProjectSnapshot')) return cloudSnapshotResponse(input);
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), {
          mainOid: MAIN_OID,
          request: changeRequest(),
        }),
        contentType: 'application/json; charset=utf-8',
        status: 200,
      };
    });
    const session = await new CloudAuthorityAdapter({
      request,
      requestIdFactory: () => 'request-ensure',
    }).create(membership());
    const controller = new AbortController();

    await expect(session.control.ensure({
      description: 'Published change',
      expectedMainOid: MAIN_OID,
      headOid: HEAD_OID,
      idempotencyKey: 'publish-head',
      projectId: PROJECT_ID,
      signal: controller.signal,
    })).resolves.toMatchObject({ id: 'request-one', latestHeadOid: HEAD_OID });
    expect(requests[2]).toEqual({
      body: {
        data: {
          description: 'Published change',
          expectedMainOid: MAIN_OID,
          headOid: HEAD_OID,
          idempotencyKey: 'publish-head',
          projectId: PROJECT_ID,
        },
        protocolVersion: 8,
        requestId: 'request-ensure',
      },
      headers: {},
      method: 'POST',
      signal: expect.any(AbortSignal),
      url: `https://cloud.example.test/v4/projects/${PROJECT_ID}/operations/ensureMyRequest`,
    });
  });

  it('routes Accept through the canonical Cloud operation with its exact authority tuple', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => input.method === 'GET'
      ? {
        body: boundCapabilityDocument(['accept']),
        contentType: 'application/json',
        status: 200,
      }
      : input.url.endsWith('/getProjectSnapshot')
        ? cloudSnapshotResponse(input)
        : {
          body: collabCloudSuccessEnvelope(envelopeRequestId(input), {
            mainOid: MERGED_OID,
            mergeCommitOid: MERGED_OID,
            request: changeRequest({
              latestHeadOid: HEAD_OID,
              mergedOid: MERGED_OID,
              revision: 1,
              status: 'merged',
            }),
          }),
          contentType: 'application/json; charset=utf-8',
          status: 200,
        });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;
    const controller = new AbortController();

    await expect(control.acceptRequest({
      expectedHeadOid: HEAD_OID,
      expectedMainOid: MAIN_OID,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-intent',
      projectId: PROJECT_ID,
      requestId: 'request-one',
      signal: controller.signal,
    })).resolves.toMatchObject({
      mainOid: MERGED_OID,
      request: { id: 'request-one', mergedOid: MERGED_OID, status: 'merged' },
    });
    expect(request.mock.calls[2]?.[0]).toEqual({
      body: {
        data: {
          expectedHeadOid: HEAD_OID,
          expectedMainOid: MAIN_OID,
          expectedRequestRevision: 1,
          expectedResolvingTickets: [],
          idempotencyKey: 'accept-intent',
          projectId: PROJECT_ID,
          requestId: 'request-one',
        },
        protocolVersion: 8,
        requestId: expect.any(String),
      },
      headers: {},
      method: 'POST',
      signal: expect.any(AbortSignal),
      url: `https://cloud.example.test/v4/projects/${PROJECT_ID}/operations/acceptRequest`,
    });
  });

  it('rejects an Accept response for a different reviewed Request tuple', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? boundCapabilityDocument(['accept'])
        : input.url.endsWith('/getProjectSnapshot')
          ? cloudSnapshotResponse(input).body
          : collabCloudSuccessEnvelope(envelopeRequestId(input), {
            mainOid: MERGED_OID,
            mergeCommitOid: MERGED_OID,
            request: changeRequest({
              id: 'request-other',
              mergedOid: MERGED_OID,
              status: 'merged',
            }),
          }),
      contentType: 'application/json',
      status: 200,
    }));
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.acceptRequest({
      expectedHeadOid: HEAD_OID,
      expectedMainOid: MAIN_OID,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-intent',
      projectId: PROJECT_ID,
      requestId: 'request-one',
    })).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-control-accept-response-mismatch' },
    });
  });

  it('routes Request reads, comments, and metadata through canonical Cloud operations', async () => {
    const operations: string[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: boundCapabilityDocument(['requests']),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
      if (operation === 'getProjectSnapshot') return cloudSnapshotResponse(input);
      operations.push(operation);
      const data = operation === 'getRequest'
        ? {
          comments: { comments: [] },
          currentMainOid: MAIN_OID,
          request: changeRequest(),
          reviewedHeadOid: HEAD_OID,
          reviewCondition: 'clean',
        }
        : operation === 'listRequestComments'
          ? { comments: [] }
          : operation === 'createComment'
            ? {
              comment: {
                authorMemberId: ACTOR_ID,
                body: 'Looks good',
                createdAt: CREATED_AT,
                id: 'comment-one',
                requestId: 'request-one',
              },
              request: changeRequest({ commentCount: 1 }),
            }
            : { request: changeRequest({ description: 'Updated description', revision: 2 }) };
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), data),
        contentType: 'application/json',
        status: 200,
      };
    });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.readRequestPage(PROJECT_ID, 'request-one')).resolves.toMatchObject({
      request: { id: 'request-one' },
    });
    await expect(control.readRequest(PROJECT_ID, 'request-one')).resolves.toMatchObject({
      request: { id: 'request-one' },
    });
    await expect(control.listRequestComments(PROJECT_ID, 'request-one', {})).resolves.toEqual({
      comments: [],
    });
    await expect(control.createComment({
      body: 'Looks good',
      idempotencyKey: 'comment-intent',
      projectId: PROJECT_ID,
      requestId: 'request-one',
    })).resolves.toMatchObject({ comment: { id: 'comment-one' } });
    await expect(control.updateRequestMetadata({
      description: 'Updated description',
      expectedHeadOid: HEAD_OID,
      expectedRequestRevision: 1,
      intentId: 'ui-intent',
      projectId: PROJECT_ID,
      requestId: 'request-one',
    }, 'metadata-intent')).resolves.toMatchObject({
      description: 'Updated description',
      id: 'request-one',
    });
    expect(operations).toEqual([
      'getRequest',
      'getRequest',
      'listRequestComments',
      'createComment',
      'updateMyRequestMetadata',
    ]);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        data: expect.not.objectContaining({ intentId: expect.anything() }),
      }),
    }));
  });

  it('routes all Ticket reads and mutations through canonical Cloud operations', async () => {
    const requests: CloudAuthorityHttpRequest[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      requests.push(input);
      if (input.method === 'GET') {
        return {
          body: boundCapabilityDocument(['tickets']),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
      if (operation === 'getProjectSnapshot') return cloudSnapshotResponse(input);
      const data = operation === 'listTickets'
        ? { tickets: [ticketSummary()] }
        : operation === 'getTicket'
          ? ticketDetail()
          : operation === 'listTicketComments'
            ? { comments: [] }
            : operation === 'listTicketAcceptedRelations'
              ? { acceptedRelations: [] }
              : operation === 'createTicket'
                ? { ticket: ticketDetail() }
                : operation === 'createTicketComment'
                  ? {
                    comment: {
                      authorMemberId: ACTOR_ID,
                      body: 'Ticket comment',
                      createdAt: CREATED_AT,
                      id: 'ticket-comment-one',
                      ticketId: 'ticket-one',
                    },
                    ticket: ticketSummary({ commentCount: 1, revision: 2 }),
                  }
                  : { ticket: ticketSummary({ revision: 2 }) };
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), data),
        contentType: 'application/json',
        status: 200,
      };
    });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.listTickets({ projectId: PROJECT_ID, status: 'open' })).resolves
      .toMatchObject({ tickets: [{ id: 'ticket-one' }] });
    await expect(control.readTicketPage(PROJECT_ID, 'ticket-one')).resolves
      .toMatchObject({ ticket: { id: 'ticket-one' } });
    await expect(control.readTicket(PROJECT_ID, 'ticket-one')).resolves
      .toMatchObject({ ticket: { id: 'ticket-one' } });
    await expect(control.listTicketComments(PROJECT_ID, 'ticket-one', {})).resolves
      .toEqual({ comments: [] });
    await expect(control.listTicketAcceptedRelations(PROJECT_ID, 'ticket-one', {})).resolves
      .toEqual({ acceptedRelations: [] });
    await expect(control.createTicket({
      body: 'Ticket body',
      intentId: 'ui-create-ticket',
      projectId: PROJECT_ID,
      title: 'Ticket title',
    }, 'create-ticket')).resolves.toMatchObject({ ticket: { id: 'ticket-one' } });
    await expect(control.updateTicketContent({
      body: 'Updated body',
      expectedRevision: 1,
      intentId: 'ui-update-ticket',
      projectId: PROJECT_ID,
      ticketId: 'ticket-one',
      title: 'Updated title',
    }, 'update-ticket')).resolves.toMatchObject({ id: 'ticket-one', revision: 2 });
    await expect(control.addTicketComment({
      body: 'Ticket comment',
      intentId: 'ui-comment-ticket',
      projectId: PROJECT_ID,
      ticketId: 'ticket-one',
    }, 'comment-ticket')).resolves.toMatchObject({ id: 'ticket-comment-one' });
    await expect(control.closeTicket({
      expectedRevision: 1,
      intentId: 'ui-close-ticket',
      projectId: PROJECT_ID,
      ticketId: 'ticket-one',
    }, 'close-ticket')).resolves.toMatchObject({ id: 'ticket-one' });
    await expect(control.reopenTicket({
      expectedRevision: 1,
      intentId: 'ui-reopen-ticket',
      projectId: PROJECT_ID,
      ticketId: 'ticket-one',
    }, 'reopen-ticket')).resolves.toMatchObject({ id: 'ticket-one' });

    expect(requests.slice(2).map(input => input.url.split('/').at(-1))).toEqual([
      'listTickets',
      'getTicket',
      'getTicket',
      'listTicketComments',
      'listTicketAcceptedRelations',
      'createTicket',
      'updateTicketContent',
      'createTicketComment',
      'closeTicket',
      'reopenTicket',
    ]);
    for (const input of requests.slice(7)) {
      expect(input.body).toEqual(expect.objectContaining({
        data: expect.not.objectContaining({ intentId: expect.anything() }),
      }));
    }
  });

  it('assembles bounded Cloud Request and Ticket pages for complete reads', async () => {
    const requestComment = (id: string) => ({
      authorMemberId: ACTOR_ID,
      body: id,
      createdAt: CREATED_AT,
      id,
      requestId: 'request-one',
    });
    const ticketComment = (id: string) => ({
      authorMemberId: ACTOR_ID,
      body: id,
      createdAt: CREATED_AT,
      id,
      ticketId: 'ticket-one',
    });
    const acceptedRelation = {
      acceptedAt: CREATED_AT,
      acceptedMergeOid: MAIN_OID,
      commitOid: HEAD_OID,
      id: 'relation-one',
      kind: 'resolves',
      requestId: 'request-one',
    };
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: boundCapabilityDocument(['requests', 'tickets']),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
      if (operation === 'getProjectSnapshot') return cloudSnapshotResponse(input);
      const body = input.body as { readonly data: Readonly<Record<string, unknown>> };
      const data = operation === 'getRequest'
        ? {
          comments: { comments: [requestComment('request-comment-one')], nextCursor: 'request-next' },
          currentMainOid: MAIN_OID,
          request: changeRequest({ commentCount: 2 }),
          reviewedHeadOid: HEAD_OID,
          reviewCondition: 'clean',
        }
        : operation === 'listRequestComments'
          ? { comments: [requestComment('request-comment-two')] }
          : operation === 'getTicket'
            ? ticketDetail({
              acceptedRelations: { acceptedRelations: [], nextCursor: 'relation-next' },
              comments: { comments: [ticketComment('ticket-comment-one')], nextCursor: 'comment-next' },
              ticket: ticketSummary({ acceptedRelationCount: 1, commentCount: 2 }),
            })
            : operation === 'listTicketComments'
              ? { comments: [ticketComment(`ticket-${String(body.data.cursor)}`)] }
              : { acceptedRelations: [acceptedRelation] };
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), data),
        contentType: 'application/json',
        status: 200,
      };
    });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.readRequestPage(PROJECT_ID, 'request-one')).resolves.toMatchObject({
      comments: { comments: [{ id: 'request-comment-one' }], nextCursor: 'request-next' },
    });
    expect(request.mock.calls.map(([input]) => input.url.split('/').at(-1))).toEqual([
      'capabilities', 'getProjectSnapshot', 'getRequest',
    ]);
    await expect(control.readRequest(PROJECT_ID, 'request-one')).resolves.toMatchObject({
      comments: { comments: [{ id: 'request-comment-one' }, { id: 'request-comment-two' }] },
    });
    await expect(control.readTicketPage(PROJECT_ID, 'ticket-one')).resolves.toMatchObject({
      acceptedRelations: { acceptedRelations: [], nextCursor: 'relation-next' },
      comments: { comments: [{ id: 'ticket-comment-one' }], nextCursor: 'comment-next' },
    });
    await expect(control.readTicket(PROJECT_ID, 'ticket-one')).resolves.toMatchObject({
      acceptedRelations: { acceptedRelations: [{ id: 'relation-one' }] },
      comments: {
        comments: [{ id: 'ticket-comment-one' }, { id: 'ticket-comment-next' }],
      },
    });
  });

  it('rejects a Ticket cursor reused across complete comment and relation collections', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: boundCapabilityDocument(['tickets']),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1);
      if (operation === 'getProjectSnapshot') return cloudSnapshotResponse(input);
      return {
        body: collabCloudSuccessEnvelope(
          envelopeRequestId(input),
          operation === 'getTicket'
            ? ticketDetail({
              acceptedRelations: { acceptedRelations: [], nextCursor: 'same-cursor' },
              comments: { comments: [], nextCursor: 'same-cursor' },
            })
            : { comments: [] },
        ),
        contentType: 'application/json',
        status: 200,
      };
    });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.readTicket(PROJECT_ID, 'ticket-one')).rejects.toMatchObject({
      code: 'authority-integrity-error',
      recoveryActions: ['open-diagnostics'],
      safeContext: { reason: 'cloud-control-relation-cursor-cycled' },
    });
  });

  it('rejects continuation comments returned for a different owner', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: boundCapabilityDocument(['requests', 'tickets']),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
      if (operation === 'getProjectSnapshot') return cloudSnapshotResponse(input);
      const comment = {
        authorMemberId: ACTOR_ID,
        body: 'Wrong owner',
        createdAt: CREATED_AT,
        id: 'comment-wrong-owner',
        ...(operation === 'listRequestComments'
          ? { requestId: 'request-other' }
          : { ticketId: 'ticket-other' }),
      };
      return {
        body: collabCloudSuccessEnvelope(envelopeRequestId(input), { comments: [comment] }),
        contentType: 'application/json',
        status: 200,
      };
    });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.listRequestComments(PROJECT_ID, 'request-one', {})).rejects
      .toMatchObject({ code: 'authority-integrity-error' });
    await expect(control.listTicketComments(PROJECT_ID, 'ticket-one', {})).rejects
      .toMatchObject({ code: 'authority-integrity-error' });
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

  it('rejects a bound session whose authenticated snapshot belongs to a different Project', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? collabCloudCapabilityDocument(['project-snapshot'], limits)
        : collabCloudSuccessEnvelope(envelopeRequestId(input), {
          ...cloudSnapshot(),
          project: { ...cloudSnapshot().project, id: 'project-other' },
        }),
      contentType: 'application/json',
      status: 200,
    }));
    await expect(new CloudAuthorityAdapter({ request }).create(membership())).rejects
      .toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-control-snapshot-response-mismatch' },
    });
  });

});

describe('CloudProjectEventClient', () => {
  it('preserves the terminal retirement identity instead of degrading it to a snapshot', async () => {
    const socket = new FakeSocket();
    const onInvalidation = jest.fn(async invalidation => invalidation.sequence);
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: () => socket,
    });

    client.start();
    socket.open();
    await flush();
    socket.message(JSON.stringify({
      kind: 'project.retired',
      occurredAt: '2026-08-27T00:00:00.000Z',
      payload: {
        retiredAt: '2026-08-27T00:00:00.000Z',
        retirementId: 'retirement-cloud-one',
      },
      projectId: PROJECT_ID,
      protocolVersion: 8,
      sequence: 4,
    }));
    await flush();

    expect(onInvalidation).toHaveBeenLastCalledWith({
      kind: 'retired',
      retiredAt: '2026-08-27T00:00:00.000Z',
      retirementId: 'retirement-cloud-one',
      sequence: 4,
    });
    client.dispose();
  });

  it('refreshes snapshot first, detects a gap, and reconnects after the applied cursor', async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<() => void> = [];
    const onInvalidation = jest.fn(async invalidation => invalidation.sequence);
    const client = new CloudProjectEventClient({
      afterSequence: 3,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: input => {
        const socket = new FakeSocket();
        sockets.push(socket);
        expect(input).toEqual({
          headers: {},
          url: `wss://cloud.example.test/v4/projects/${PROJECT_ID}/events?afterSequence=${
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
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: input => {
        const socket = new FakeSocket();
        sockets.push(socket);
        expect(input.url).toBe(
          `wss://cloud.example.test/v4/projects/${PROJECT_ID}/events?afterSequence=${
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
      protocolVersion: 8,
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
        protocolVersion: 8,
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
      protocolVersion: 8,
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
