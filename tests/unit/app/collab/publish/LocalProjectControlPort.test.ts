import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import {
  type LocalProjectControlClientPort,
  LocalProjectControlPort,
} from '@/app/collab/publish/LocalProjectControlPort';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
function response(data: unknown) {
  return { data, protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION, requestId: 'response-one' };
}
function mergedRequest() {
  return {
    commentCount: 0,
    createdAt: CREATED_AT,
    description: 'Published change',
    firstBaseOid: HEAD,
    id: 'request-a',
    latestHeadOid: HEAD,
    memberId: 'member-a',
    mergedOid: MERGE,
    revision: 2,
    status: 'merged' as const,
    ticketRelations: [],
    updatedAt: CREATED_AT,
  };
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

function snapshot() {
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
    eventSequence: 1,
    members: [currentMember],
    openTicketCount: 0,
    openRequests: [],
    project: {
      authorityKind: 'lan' as const,
      createdAt: CREATED_AT,
      hostMemberId: 'member-host',
      id: 'project-a',
      mainOid: HEAD,
      mainRef: 'refs/heads/main' as const,
      managerSetGeneration: 0,
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function ticketClientMethods() {
  return {
    addTicketComment: jest.fn(),
    createTicket: jest.fn(),
    listRequestComments: jest.fn(),
    listTicketAcceptedRelations: jest.fn(),
    listTicketComments: jest.fn(),
    listTickets: jest.fn(),
    readTicket: jest.fn(),
    reopenTicket: jest.fn(),
    updateRequestMetadata: jest.fn(),
    updateTicketContent: jest.fn(),
    closeTicket: jest.fn(),
  };
}

describe('LocalProjectControlPort', () => {
  it('keeps complete Request continuations on the captured membership and cancellation signal', async () => {
    let currentMembership = membership();
    const signal = new AbortController().signal;
    const firstComment = {
      authorMemberId: 'member-a',
      body: 'First',
      createdAt: CREATED_AT,
      id: 'comment-a',
      requestId: 'request-a',
    };
    const secondComment = { ...firstComment, id: 'comment-b', body: 'Second' };
    const requests: Array<{
      credential: string;
      endpoint: string;
      path: string;
      signal?: AbortSignal;
    }> = [];
    const port = new LocalProjectControlPort({ loadMembership: async () => currentMembership }, {
      createClient: trust => new ProjectControlClient({
        requestWithMember: async (input, credential, options) => {
          requests.push({ credential, endpoint: trust.endpoint, path: input.path, signal: options?.signal });
          if (requests.length === 1) {
            currentMembership = {
              ...membership(),
              member: { ...membership().member, credential: 'B'.repeat(43) },
            };
            return input.decode(response({
              comments: { comments: [firstComment], nextCursor: 'request-next' },
              currentMainOid: HEAD,
              request: { ...mergedRequest(), commentCount: 2 },
              reviewedHeadOid: HEAD,
              reviewCondition: 'clean',
            }));
          }
          return input.decode(response({ comments: [secondComment] }));
        },
      }),
    });

    const detail = await port.readRequest('project-a', 'request-a', { signal });

    expect(detail.comments).toEqual({ comments: [firstComment, secondComment] });
    for (const request of requests) expect(request.signal).toBe(signal);
    expect(requests.map(({ credential, endpoint, path }) => ({ credential, endpoint, path }))).toEqual([
      { credential: 'A'.repeat(43), endpoint: 'https://192.168.1.20:54545', path: '/v9/projects/project-a/requests/request-a' },
      { credential: 'A'.repeat(43), endpoint: 'https://192.168.1.20:54545', path: `/v9/projects/project-a/requests/request-a/comments?cursor=request-next&limit=${COLLAB_LIMITS.maxCommentPageSize}` },
    ]);
  });

  it('propagates cancellation from a complete Request continuation without returning a partial detail', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled continuation');
    let firstPage = true;
    const port = new LocalProjectControlPort({ loadMembership: async () => membership() }, {
      createClient: () => new ProjectControlClient({
        requestWithMember: async (input, _credential, options) => {
          options?.signal?.throwIfAborted();
          if (!firstPage) throw new Error('Unexpected uncancelled continuation');
          firstPage = false;
          const detail = input.decode(response({
            comments: { comments: [], nextCursor: 'request-next' },
            currentMainOid: HEAD,
            request: { ...mergedRequest(), commentCount: 1 },
            reviewedHeadOid: HEAD,
            reviewCondition: 'clean',
          }));
          controller.abort(cancelled);
          return detail;
        },
      }),
    });

    await expect(port.readRequest('project-a', 'request-a', { signal: controller.signal }))
      .rejects.toBe(cancelled);
  });

  it('rejects a repeated continuation cursor with the LAN integrity diagnostic', async () => {
    let firstPage = true;
    const port = new LocalProjectControlPort({ loadMembership: async () => membership() }, {
      createClient: () => new ProjectControlClient({
        requestWithMember: async input => {
          if (!firstPage) return input.decode(response({ comments: [], nextCursor: 'request-next' }));
          firstPage = false;
          return input.decode(response({
            comments: { comments: [], nextCursor: 'request-next' },
            currentMainOid: HEAD,
            request: { ...mergedRequest(), commentCount: 1 },
            reviewedHeadOid: HEAD,
            reviewCondition: 'clean',
          }));
        },
      }),
    });

    await expect(port.readRequest('project-a', 'request-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
      recoveryActions: ['open-diagnostics'],
      safeContext: { reason: 'control-comment-cursor-cycled' },
    });
  });

  it('keeps bounded first-page reads separate from complete UI assembly', async () => {
    const request = {
      commentCount: 2,
      createdAt: CREATED_AT,
      description: 'Published change',
      firstBaseOid: HEAD,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open' as const,
      ticketRelations: [],
      updatedAt: CREATED_AT,
    };
    const firstComment = {
      authorMemberId: 'member-a',
      body: 'First',
      createdAt: CREATED_AT,
      id: 'comment-a',
      requestId: request.id,
    };
    const secondComment = { ...firstComment, body: 'Second', id: 'comment-b' };
    const ticket = {
      acceptedRelationCount: 0,
      authorMemberId: 'member-a',
      commentCount: 2,
      createdAt: CREATED_AT,
      id: 'ticket-a',
      number: 1,
      revision: 1,
      status: 'open' as const,
      title: 'Ticket',
      updatedAt: CREATED_AT,
    };
    const firstTicketComment = {
      authorMemberId: 'member-a',
      body: 'First',
      createdAt: CREATED_AT,
      id: 'ticket-comment-a',
      ticketId: ticket.id,
    };
    const secondTicketComment = {
      ...firstTicketComment,
      body: 'Second',
      id: 'ticket-comment-b',
    };
    const client = {
      ...ticketClientMethods(),
      listRequestComments: jest.fn().mockResolvedValue({ comments: [secondComment] }),
      listTicketComments: jest.fn().mockResolvedValue({ comments: [secondTicketComment] }),
      readRequest: jest.fn().mockResolvedValue({
        comments: { comments: [firstComment], nextCursor: 'request-next' },
        currentMainOid: HEAD,
        request,
        reviewedHeadOid: HEAD,
        reviewCondition: 'clean',
      }),
      readTicket: jest.fn().mockResolvedValue({
        acceptedRelations: { acceptedRelations: [] },
        body: 'Ticket body',
        comments: { comments: [firstTicketComment], nextCursor: 'ticket-next' },
        ticket,
      }),
    } as unknown as LocalProjectControlClientPort;
    const port = new LocalProjectControlPort({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    } as never, { createClient: () => client });

    await expect(port.readRequestPage('project-a', request.id)).resolves.toMatchObject({
      comments: { comments: [firstComment], nextCursor: 'request-next' },
    });
    expect(client.listRequestComments).not.toHaveBeenCalled();
    await expect(port.readRequest('project-a', request.id)).resolves.toMatchObject({
      comments: { comments: [firstComment, secondComment] },
    });
    expect(client.listRequestComments).toHaveBeenCalledTimes(1);

    await expect(port.readTicketPage('project-a', ticket.id)).resolves.toMatchObject({
      comments: { comments: [firstTicketComment], nextCursor: 'ticket-next' },
    });
    expect(client.listTicketComments).not.toHaveBeenCalled();
    await expect(port.readTicket('project-a', ticket.id)).resolves.toMatchObject({
      comments: { comments: [firstTicketComment, secondTicketComment] },
    });
    expect(client.listTicketComments).toHaveBeenCalledTimes(1);
  });

  it('rejects a complete Ticket whose declared comment count is not assembled', async () => {
    const client = {
      ...ticketClientMethods(),
      readTicket: jest.fn().mockResolvedValue({
        acceptedRelations: { acceptedRelations: [] },
        body: 'Ticket body',
        comments: { comments: [] },
        ticket: {
          acceptedRelationCount: 0,
          authorMemberId: 'member-a',
          commentCount: 1,
          createdAt: CREATED_AT,
          id: 'ticket-a',
          number: 1,
          revision: 1,
          status: 'open',
          title: 'Ticket',
          updatedAt: CREATED_AT,
        },
      }),
    } as unknown as LocalProjectControlClientPort;
    const port = new LocalProjectControlPort({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    } as never, { createClient: () => client });

    await expect(port.readTicket('project-a', 'ticket-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'control-ticket-comment-count-mismatch' },
    });
  });

  it('rejects a complete Request whose declared comment count is not assembled', async () => {
    const client = {
      ...ticketClientMethods(),
      readRequest: jest.fn().mockResolvedValue({
        comments: { comments: [] },
        currentMainOid: HEAD,
        request: {
          commentCount: 1,
          createdAt: CREATED_AT,
          description: 'Published change',
          firstBaseOid: HEAD,
          id: 'request-a',
          latestHeadOid: HEAD,
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED_AT,
        },
        reviewedHeadOid: HEAD,
        reviewCondition: 'clean',
      }),
    } as unknown as LocalProjectControlClientPort;
    const port = new LocalProjectControlPort({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    } as never, { createClient: () => client });

    await expect(port.readRequest('project-a', 'request-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'control-request-comment-count-mismatch' },
    });
  });

  it('rejects a complete Ticket whose declared accepted relation count is not assembled', async () => {
    const client = {
      ...ticketClientMethods(),
      readTicket: jest.fn().mockResolvedValue({
        acceptedRelations: { acceptedRelations: [] },
        body: 'Ticket body',
        comments: { comments: [] },
        ticket: {
          acceptedRelationCount: 1,
          authorMemberId: 'member-a',
          commentCount: 0,
          createdAt: CREATED_AT,
          id: 'ticket-a',
          number: 1,
          revision: 1,
          status: 'open',
          title: 'Ticket',
          updatedAt: CREATED_AT,
        },
      }),
    } as unknown as LocalProjectControlClientPort;
    const port = new LocalProjectControlPort({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    } as never, { createClient: () => client });

    await expect(port.readTicket('project-a', 'ticket-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'control-ticket-relation-count-mismatch' },
    });
  });

  it('reloads membership and validates snapshot and request identity', async () => {
    const client: LocalProjectControlClientPort = {
      ...ticketClientMethods(),
      acceptRequest: jest.fn().mockResolvedValue({
        mainOid: MERGE,
        mergeCommitOid: MERGE,
        request: mergedRequest(),
      }),
      createComment: jest.fn().mockResolvedValue({
        comment: {
          authorMemberId: 'member-a',
          body: 'Please revise',
          createdAt: CREATED_AT,
          id: 'comment-a',
          requestId: 'request-a',
        },
        request: { id: 'request-a' },
      }),
      ensureMyRequest: jest.fn().mockResolvedValue({
        mainOid: HEAD,
        request: {
          commentCount: 0,
          createdAt: CREATED_AT,
          description: 'Published change',
          firstBaseOid: HEAD,
          id: 'request-a',
          latestHeadOid: HEAD,
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED_AT,
        },
      }),
      readRequest: jest.fn().mockResolvedValue({
        comments: { comments: [] },
        currentMainOid: HEAD,
        request: {
          commentCount: 0,
          createdAt: CREATED_AT,
          description: 'Published change',
          firstBaseOid: HEAD,
          id: 'request-a',
          latestHeadOid: HEAD,
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED_AT,
        },
        reviewCondition: 'clean',
        reviewedHeadOid: HEAD,
      }),
      readSnapshot: jest.fn().mockResolvedValue(snapshot()),
    };
    const projects = { loadMembership: jest.fn().mockResolvedValue(membership()) };
    const port = new LocalProjectControlPort(projects as never, {
      createClient: jest.fn(() => client),
    });

    await expect(port.readSnapshot('project-a')).resolves.toMatchObject({
      currentMember: { id: 'member-a' },
    });
    await expect(port.ensure({
      description: 'Published change',
      expectedMainOid: HEAD,
      headOid: HEAD,
      idempotencyKey: 'publish-head',
      projectId: 'project-a',
    })).resolves.toMatchObject({ id: 'request-a' });
    await expect(port.readRequest('project-a', 'request-a')).resolves.toMatchObject({
      request: { id: 'request-a' },
    });
    await expect(port.createComment({
      body: 'Please revise',
      idempotencyKey: 'comment-key',
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toMatchObject({ comment: { id: 'comment-a' } });
    expect(client.createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Please revise',
    }));
    await expect(port.acceptRequest({
      expectedHeadOid: HEAD,
      expectedMainOid: HEAD,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toMatchObject({ mainOid: MERGE });
    expect(projects.loadMembership).toHaveBeenCalledTimes(5);
  });

  it('rejects cross-Project or cross-Member control responses', async () => {
    const wrongSnapshot = snapshot();
    wrongSnapshot.project.id = 'project-other';
    const client = {
      ...ticketClientMethods(),
      acceptRequest: jest.fn().mockResolvedValue({
        mainOid: MERGE,
        mergeCommitOid: MERGE,
        request: { ...mergedRequest(), latestHeadOid: MERGE },
      }),
      createComment: jest.fn().mockResolvedValue({
        comment: {
          authorMemberId: 'member-other',
          body: 'Comment',
          createdAt: CREATED_AT,
          id: 'comment-a',
          requestId: 'request-a',
        },
        request: { id: 'request-a' },
      }),
      ensureMyRequest: jest.fn().mockResolvedValue({
        mainOid: HEAD,
        request: {
          commentCount: 0,
          createdAt: CREATED_AT,
          description: 'Published change',
          firstBaseOid: HEAD,
          id: 'request-a',
          latestHeadOid: HEAD,
          memberId: 'member-other',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED_AT,
        },
      }),
      readRequest: jest.fn().mockResolvedValue({
        request: { id: 'request-other' },
      }),
      readSnapshot: jest.fn().mockResolvedValue(wrongSnapshot),
    };
    const port = new LocalProjectControlPort({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    } as never, { createClient: () => client });

    await expect(port.readSnapshot('project-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
    });
    await expect(port.ensure({
      description: 'Published change',
      expectedMainOid: HEAD,
      headOid: HEAD,
      idempotencyKey: 'publish-head',
      projectId: 'project-a',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(port.readRequest('project-a', 'request-a')).rejects.toMatchObject({
      code: 'authority-integrity-error',
    });
    await expect(port.createComment({
      body: 'Comment',
      idempotencyKey: 'comment-key',
      projectId: 'project-a',
      requestId: 'request-a',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(port.acceptRequest({
      expectedHeadOid: HEAD,
      expectedMainOid: HEAD,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      projectId: 'project-a',
      requestId: 'request-a',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('rejects an ensure response validated against a different main', async () => {
    const client = {
      ensureMyRequest: jest.fn().mockResolvedValue({
        mainOid: MERGE,
        request: {
          commentCount: 0,
          createdAt: CREATED_AT,
          description: 'Published change',
          firstBaseOid: HEAD,
          id: 'request-a',
          latestHeadOid: HEAD,
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED_AT,
        },
      }),
    } as unknown as LocalProjectControlClientPort;
    const port = new LocalProjectControlPort({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    } as never, { createClient: () => client });

    await expect(port.ensure({
      description: 'Published change',
      expectedMainOid: HEAD,
      headOid: HEAD,
      idempotencyKey: 'publish-head',
      projectId: 'project-a',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });
});
