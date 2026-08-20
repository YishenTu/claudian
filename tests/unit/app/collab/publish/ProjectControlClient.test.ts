import { collabControlOperationCodec } from '@claudian/collab-protocol';

import type {
  CollabHttpOperationOptions,
  CollabJsonRequest,
} from '@/app/collab/lan/CollabHttpClient';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import {
  ProjectControlClient,
  type ProjectControlTransport,
} from '@/app/collab/publish/ProjectControlClient';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const CREDENTIAL = 'A'.repeat(43);
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

function member() {
  return {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Alice',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role: 'member',
    status: 'active',
  };
}

function request() {
  return {
    commentCount: 0,
    createdAt: CREATED_AT,
    description: 'Published change',
    firstBaseOid: HEAD,
    id: 'request-a',
    latestHeadOid: HEAD,
    memberId: 'member-a',
    revision: 0,
    status: 'open',
    ticketRelations: [],
    updatedAt: CREATED_AT,
  };
}

function envelope(data: unknown): unknown {
  return {
    data,
    protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-control',
  };
}

function snapshotEnvelope(): unknown {
  return envelope({
    currentMember: member(),
    eventSequence: 2,
    hostTransfer: {
      canAccept: true,
      canCancel: false,
      canDecline: true,
      expiresAt: '2026-08-08T00:15:00.000Z',
      offeredAt: CREATED_AT,
      phase: 'offered',
      targetMemberId: 'member-a',
      transferId: 'transfer-a',
    },
    members: [member()],
    openRequests: [request()],
    openTicketCount: 0,
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
  });
}

function comment() {
  return {
    authorMemberId: 'member-a',
    body: 'Please revise',
    createdAt: CREATED_AT,
    id: 'comment-a',
    requestId: 'request-a',
  };
}

function detailEnvelope(): unknown {
  return envelope({
    comments: { comments: [comment()] },
    currentMainOid: HEAD,
    request: { ...request(), commentCount: 1 },
    reviewCondition: 'clean',
    reviewedHeadOid: HEAD,
  });
}

describe('ProjectControlClient', () => {
  it('reads the full Project snapshot and ensures the exact personal head', async () => {
    const transport: ProjectControlTransport = {
      requestWithMember: jest.fn(async <T>(
        controlRequest: CollabJsonRequest<T>,
        _credential: string,
        _options?: CollabHttpOperationOptions,
      ) => controlRequest.decode(controlRequest.method === 'GET'
        ? snapshotEnvelope()
        : envelope({ mainOid: HEAD, request: request() }))),
    };
    const client = new ProjectControlClient(transport);

    await expect(client.readSnapshot('project-a', CREDENTIAL)).resolves.toMatchObject({
      currentMember: { id: 'member-a' },
      hostTransfer: { phase: 'offered', transferId: 'transfer-a' },
      openRequests: [{ id: 'request-a' }],
    });
    await expect(client.ensureMyRequest({
      description: 'Published change',
      expectedMainOid: HEAD,
      headOid: HEAD,
      idempotencyKey: 'publish-head',
      memberCredential: CREDENTIAL,
      projectId: 'project-a',
    })).resolves.toMatchObject({ request: { latestHeadOid: HEAD } });

    expect(transport.requestWithMember).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'GET',
        path: '/v9/projects/project-a/snapshot',
      }),
      CREDENTIAL,
      {},
    );
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: {
          description: 'Published change',
          expectedMainOid: HEAD,
          headOid: HEAD,
          idempotencyKey: 'publish-head',
          projectId: 'project-a',
        },
        idempotencyKey: 'publish-head',
        method: 'PUT',
        path: '/v9/projects/project-a/requests/mine',
      }),
      CREDENTIAL,
      {},
    );
  });

  it('reads exact request detail and creates an immutable comment', async () => {
    const transport: ProjectControlTransport = {
      requestWithMember: jest.fn(async <T>(controlRequest: CollabJsonRequest<T>) => (
        controlRequest.decode(controlRequest.method === 'GET'
          ? detailEnvelope()
          : envelope({
            comment: comment(),
            request: { ...request(), commentCount: 1 },
          }))
      )),
    };
    const client = new ProjectControlClient(transport);

    await expect(client.readRequest({
      memberCredential: CREDENTIAL,
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toMatchObject({
      comments: { comments: [{ id: 'comment-a' }] },
      request: { id: 'request-a' },
      reviewedHeadOid: HEAD,
    });
    await expect(client.createComment({
      body: 'Please revise',
      idempotencyKey: 'comment-key',
      memberCredential: CREDENTIAL,
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toMatchObject({
      comment: { body: 'Please revise', id: 'comment-a' },
      request: { commentCount: 1 },
    });
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'GET',
        path: '/v9/projects/project-a/requests/request-a',
      }),
      CREDENTIAL,
      {},
    );
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: {
          body: 'Please revise',
          idempotencyKey: 'comment-key',
          projectId: 'project-a',
          requestId: 'request-a',
        },
        idempotencyKey: 'comment-key',
        method: 'POST',
        path: '/v9/projects/project-a/requests/request-a/comments',
      }),
      CREDENTIAL,
      {},
    );
  });

  it('accepts one exact reviewed head and validates the merged response', async () => {
    const transport: ProjectControlTransport = {
      requestWithMember: jest.fn(async <T>(controlRequest: CollabJsonRequest<T>) => (
        controlRequest.decode(envelope({
          mainOid: MERGE,
          mergeCommitOid: MERGE,
          request: {
            ...request(),
            mergedOid: MERGE,
            status: 'merged',
          },
        }))
      )),
    };
    const client = new ProjectControlClient(transport);

    await expect(client.acceptRequest({
      expectedHeadOid: HEAD,
      expectedMainOid: HEAD,
      expectedRequestRevision: 0,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      memberCredential: CREDENTIAL,
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toMatchObject({
      mainOid: MERGE,
      request: { mergedOid: MERGE, status: 'merged' },
    });
    expect(transport.requestWithMember).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          expectedHeadOid: HEAD,
          expectedMainOid: HEAD,
          expectedRequestRevision: 0,
          expectedResolvingTickets: [],
          idempotencyKey: 'accept-key',
          projectId: 'project-a',
          requestId: 'request-a',
        },
        idempotencyKey: 'accept-key',
        method: 'POST',
        path: '/v9/projects/project-a/requests/request-a/accept',
      }),
      CREDENTIAL,
      {},
    );
  });

  it.each([
    envelope({ request: request() }),
    envelope({ request: { ...request(), latestHeadOid: 'invalid' } }),
    envelope({
      ...(snapshotEnvelope() as { data: object }).data,
      currentMember: { ...member(), personalRef: 'refs/heads/main' },
    }),
  ])('rejects malformed authority data', value => {
    expect(() => (
      'request' in ((value as { data: object }).data)
        ? collabControlOperationCodec('ensureMyRequest').decodeResponse(value)
        : lanCollabControlOperationCodec('getSnapshot').decodeResponse(value)
    )).toThrow(expect.objectContaining({ code: 'protocol-payload-invalid' }));
  });

  it.each([
    envelope({
      ...(detailEnvelope() as { data: object }).data,
      reviewedHeadOid: 'b'.repeat(40),
    }),
    envelope({
      comment: { ...comment(), requestId: 'request-b' },
      request: { ...request(), commentCount: 1 },
    }),
  ])('rejects inconsistent request projection data %#', value => {
    expect(() => (
      'changedFiles' in ((value as { data: object }).data)
        ? collabControlOperationCodec('getRequest').decodeResponse(value)
        : collabControlOperationCodec('createComment').decodeResponse(value)
    )).toThrow(expect.objectContaining({ code: 'protocol-payload-invalid' }));
  });

  it.each([
    envelope({
      mainOid: MERGE,
      mergeCommitOid: HEAD,
      request: { ...request(), mergedOid: MERGE, status: 'merged' },
    }),
    envelope({
      mainOid: MERGE,
      mergeCommitOid: MERGE,
      request: { ...request(), status: 'open' },
    }),
  ])('rejects inconsistent Accept response %#', value => {
    expect(() => collabControlOperationCodec('acceptRequest').decodeResponse(value)).toThrow(expect.objectContaining({
      code: 'protocol-payload-invalid',
    }));
  });
});
