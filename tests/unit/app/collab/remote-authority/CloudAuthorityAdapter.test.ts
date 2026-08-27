import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  type CollabAuthorityTransferStatus,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
} from '@claudian-collab/protocol';

import type { CollabLocalCloudMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  CloudAuthorityAdapter,
  CloudProjectEventClient,
  type CloudProjectEventSocket,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type {
  CloudAuthorityHttpRequest,
} from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';

const PROJECT_ID = 'project-cloud';
const ACTOR_ID = 'member-alice';
const CREATED_AT = '2026-08-22T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const MERGED_OID = 'c'.repeat(40);

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
      bindingVersion: 2,
      developmentActorId: ACTOR_ID,
      gitRemoteUrl: `https://cloud.example.test/v2/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 6,
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
  it('binds a lifecycle-only snapshot to the canonical Member ref', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? collabCloudCapabilityDocument(['project-snapshot'], limits)
        : collabCloudSuccessEnvelope('response-lifecycle-snapshot', cloudSnapshot()),
      contentType: 'application/json',
      status: 200,
    }));
    const lifecycle = await new CloudAuthorityAdapter({ request }).createLifecycle({
      developmentActorId: ACTOR_ID,
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
            ], limits),
            contentType: 'application/json',
            status: 200,
          };
        }
        return {
          body: collabCloudSuccessEnvelope('request-lifecycle', transferStatus),
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

    expect(jsonRequests[1]?.url).toBe(
      `https://cloud.example.test/v2/projects/${PROJECT_ID}`
        + '/operations/getProjectAuthorityTransfer',
    );
    expect(Buffer.concat(uploaded).toString('utf8')).toBe('checkpoint');
    expect(Buffer.concat(downloaded).toString('utf8')).toBe('checkpoint');
  });

  it('keeps lifecycle calls capability-gated and rejects legacy binding documents', async () => {
    const request = jest.fn(async () => ({
      body: collabCloudCapabilityDocument([], limits),
      contentType: 'application/json',
      status: 200,
    }));
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
        bindingVersions: [1],
        protocolVersions: [4],
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
        serverUrl: `http://127.0.0.1:${address.port}`,
      },
    } satisfies CollabLocalCloudMembershipRecord;

    try {
      const session = await new CloudAuthorityAdapter().create(localMembership);
      await expect(session.control.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
        currentMember: { id: ACTOR_ID },
        project: { authorityKind: 'cloud', id: PROJECT_ID },
      });
      expect(requests).toEqual([
        { actor: ACTOR_ID, url: '/collab/capabilities' },
        {
          actor: ACTOR_ID,
          url: `/v2/projects/${PROJECT_ID}/operations/getProjectSnapshot`,
        },
      ]);
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
      headers: [{
        name: 'X-Claudian-Development-Actor',
        sensitive: false,
        value: ACTOR_ID,
      }],
      remoteUrl: `https://cloud.example.test/v2/projects/${PROJECT_ID}/repository.git`,
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
        url: `https://cloud.example.test/v2/projects/${PROJECT_ID}/operations/getProjectSnapshot`,
      }),
    ]);
  });

  it('ensures the current member Request through the package-owned Cloud operation', async () => {
    const requests: CloudAuthorityHttpRequest[] = [];
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      requests.push(input);
      if (input.method === 'GET') {
        return {
          body: collabCloudCapabilityDocument(['requests'], limits),
          contentType: 'application/json; charset=utf-8',
          status: 200,
        };
      }
      return {
        body: collabCloudSuccessEnvelope('response-ensure', {
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
    expect(requests[1]).toEqual({
      body: {
        data: {
          description: 'Published change',
          expectedMainOid: MAIN_OID,
          headOid: HEAD_OID,
          idempotencyKey: 'publish-head',
          projectId: PROJECT_ID,
        },
        protocolVersion: 6,
        requestId: 'request-ensure',
      },
      headers: { 'x-claudian-development-actor': ACTOR_ID },
      method: 'POST',
      signal: controller.signal,
      url: `https://cloud.example.test/v2/projects/${PROJECT_ID}/operations/ensureMyRequest`,
    });
  });

  it('routes Accept through the canonical Cloud operation with its exact authority tuple', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => input.method === 'GET'
      ? {
        body: collabCloudCapabilityDocument(['accept'], limits),
        contentType: 'application/json',
        status: 200,
      }
      : {
        body: collabCloudSuccessEnvelope('response-accept', {
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
    expect(request.mock.calls[1]?.[0]).toEqual({
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
        protocolVersion: 6,
        requestId: expect.any(String),
      },
      headers: { 'x-claudian-development-actor': ACTOR_ID },
      method: 'POST',
      signal: controller.signal,
      url: `https://cloud.example.test/v2/projects/${PROJECT_ID}/operations/acceptRequest`,
    });
  });

  it('rejects an Accept response for a different reviewed Request tuple', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? collabCloudCapabilityDocument(['accept'], limits)
        : collabCloudSuccessEnvelope('response-accept', {
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
          body: collabCloudCapabilityDocument(['requests'], limits),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
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
        body: collabCloudSuccessEnvelope(`response-${operation}`, data),
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
          body: collabCloudCapabilityDocument(['tickets'], limits),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
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
        body: collabCloudSuccessEnvelope(`response-${operation}`, data),
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

    expect(requests.slice(1).map(input => input.url.split('/').at(-1))).toEqual([
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
    for (const input of requests.slice(6)) {
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
          body: collabCloudCapabilityDocument(['requests', 'tickets'], limits),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
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
        body: collabCloudSuccessEnvelope(`response-${operation}`, data),
        contentType: 'application/json',
        status: 200,
      };
    });
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.readRequest(PROJECT_ID, 'request-one')).resolves.toMatchObject({
      comments: { comments: [{ id: 'request-comment-one' }, { id: 'request-comment-two' }] },
    });
    await expect(control.readTicket(PROJECT_ID, 'ticket-one')).resolves.toMatchObject({
      acceptedRelations: { acceptedRelations: [{ id: 'relation-one' }] },
      comments: {
        comments: [{ id: 'ticket-comment-one' }, { id: 'ticket-comment-next' }],
      },
    });
  });

  it('rejects continuation comments returned for a different owner', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => {
      if (input.method === 'GET') {
        return {
          body: collabCloudCapabilityDocument(['requests', 'tickets'], limits),
          contentType: 'application/json',
          status: 200,
        };
      }
      const operation = input.url.split('/').at(-1)!;
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
        body: collabCloudSuccessEnvelope(`response-${operation}`, { comments: [comment] }),
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
        body: { ...document, bindingVersions: [1] },
        contentType: 'application/json',
        status: 200,
      }),
    });

    await expect(adapter.create(membership())).rejects.toMatchObject({
      code: 'protocol-version-unsupported',
    });
  });

  it('rejects a Cloud snapshot bound to a different Project', async () => {
    const request = jest.fn(async (input: CloudAuthorityHttpRequest) => ({
      body: input.method === 'GET'
        ? collabCloudCapabilityDocument(['project-snapshot'], limits)
        : collabCloudSuccessEnvelope('response-snapshot', {
          ...cloudSnapshot(),
          project: { ...cloudSnapshot().project, id: 'project-other' },
        }),
      contentType: 'application/json',
      status: 200,
    }));
    const control = (await new CloudAuthorityAdapter({ request }).create(membership())).control;

    await expect(control.readSnapshot(PROJECT_ID)).rejects.toMatchObject({
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
      developmentActorId: ACTOR_ID,
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
      protocolVersion: 6,
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
      developmentActorId: ACTOR_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, onInvalidation, {
      createSocket: input => {
        const socket = new FakeSocket();
        sockets.push(socket);
        expect(input).toEqual({
          headers: { 'x-claudian-development-actor': ACTOR_ID },
          url: `wss://cloud.example.test/v2/projects/${PROJECT_ID}/events?afterSequence=${
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
          `wss://cloud.example.test/v2/projects/${PROJECT_ID}/events?afterSequence=${
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
      protocolVersion: 6,
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
        protocolVersion: 6,
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
      protocolVersion: 6,
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
