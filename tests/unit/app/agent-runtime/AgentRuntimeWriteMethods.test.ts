import type { CollabChangeRequest, CollabComment, CollabTicketComment, CollabTicketDetail, CollabTicketSummary } from '@claudian-collab/protocol';

import { AgentRuntimeGateway } from '@/app/agent-runtime/AgentRuntimeGateway';
import type { CollabAgentPort } from '@/app/agent-runtime/AgentRuntimeMethodRegistry';
import type { CollabConflictDescriptor, CollabPublicationReview, CollabRequestReview } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-a';
const TICKET_ID = 'ticket-a';
const REQUEST_ID = 'request-a';
const MAIN_OID = '1'.repeat(40);
const HEAD_OID = '2'.repeat(40);
const CANDIDATE_OID = '3'.repeat(40);
const MERGE_OID = '4'.repeat(40);

const TICKET: CollabTicketSummary = {
  acceptedRelationCount: 0,
  authorMemberId: 'member-a',
  commentCount: 0,
  createdAt: '2026-08-11T00:00:00.000Z',
  id: TICKET_ID,
  number: 4,
  revision: 1,
  status: 'open',
  title: 'Agent operations',
  updatedAt: '2026-08-11T00:00:00.000Z',
};

function agentTicket(ticket: CollabTicketSummary) {
  return {
    authorMemberId: ticket.authorMemberId,
    commentCount: ticket.commentCount,
    createdAt: ticket.createdAt,
    id: ticket.id,
    number: ticket.number,
    revision: ticket.revision,
    status: ticket.status,
    title: ticket.title,
    updatedAt: ticket.updatedAt,
    ...(ticket.closedAt && ticket.closedByMemberId
      ? { closedAt: ticket.closedAt, closedByMemberId: ticket.closedByMemberId }
      : {}),
  };
}

const DETAIL: CollabTicketDetail = {
  acceptedRelations: { acceptedRelations: [] },
  body: 'Implement the Runtime write surface.',
  comments: { comments: [] },
  ticket: TICKET,
};

const COMMENT: CollabTicketComment = {
  authorMemberId: 'member-a',
  body: 'Started.',
  createdAt: '2026-08-11T00:01:00.000Z',
  id: 'ticket-comment-a',
  ticketId: TICKET_ID,
};

const REQUEST: CollabChangeRequest = {
  commentCount: 0,
  createdAt: '2026-08-11T00:00:00.000Z',
  description: 'Publish the Runtime API.',
  firstBaseOid: MAIN_OID,
  id: REQUEST_ID,
  latestHeadOid: HEAD_OID,
  memberId: 'member-a',
  revision: 2,
  status: 'open',
  ticketRelations: [{
    commitOid: HEAD_OID,
    id: 'relation-a',
    kind: 'resolves',
    state: 'pending',
    ticketId: TICKET_ID,
    ticketNumber: 4,
    ticketRevision: 0,
    ticketTitle: TICKET.title,
  }],
  updatedAt: '2026-08-11T00:02:00.000Z',
};

const REQUEST_REVIEW: CollabRequestReview = {
  canAccept: true,
  comparisonBaseOid: MAIN_OID,
  comparisonKind: 'candidate',
  comparisonTargetOid: CANDIDATE_OID,
  detail: {
    comments: { comments: [] },
    currentMainOid: MAIN_OID,
    request: REQUEST,
    reviewedHeadOid: HEAD_OID,
    reviewCondition: 'clean',
  },
  files: [{
    binary: false,
    kind: 'modified',
    largeForReview: false,
    path: 'notes/change.md',
    workingTreeContentHash: 'must-not-cross-runtime',
  }],
  projectId: PROJECT_ID,
};

const REQUEST_COMMENT: CollabComment = {
  authorMemberId: 'member-a',
  body: 'Please clarify this change.',
  createdAt: '2026-08-11T00:03:00.000Z',
  id: 'request-comment-a',
  requestId: REQUEST_ID,
};

const PUBLICATION_REVIEW: CollabPublicationReview = {
  baseMainOid: MAIN_OID,
  canConfirm: true,
  candidateOid: CANDIDATE_OID,
  comparisonBaseOid: MAIN_OID,
  comparisonTargetOid: CANDIDATE_OID,
  contributionHeadOid: HEAD_OID,
  currentMainOid: MAIN_OID,
  files: REQUEST_REVIEW.files,
  kind: 'publication',
  operationId: 'publish-operation-a',
  projectId: PROJECT_ID,
};

const CONFLICT: CollabConflictDescriptor = {
  conflicts: [{ kind: 'text', path: 'notes/change.md' }],
  mergeBaseOid: MAIN_OID,
  operationId: 'conflict-operation-a',
  projectId: PROJECT_ID,
  startingMainOid: MAIN_OID,
  startingPersonalOid: HEAD_OID,
};

function port(): jest.Mocked<CollabAgentPort> {
  return {
    addComment: jest.fn(),
    addTicketComment: jest.fn(),
    acceptRequest: jest.fn(),
    closeTicket: jest.fn(),
    confirmPublish: jest.fn(),
    createTicket: jest.fn(),
    inspectProject: jest.fn(),
    listProjects: jest.fn(),
    listTickets: jest.fn(),
    boundedQueries: {
      listRequestComments: jest.fn(),
      listTicketAcceptedRelations: jest.fn(),
      listTicketComments: jest.fn(),
      prepareReview: jest.fn(),
      readTicket: jest.fn(),
    },
    publish: jest.fn(),
    readConflict: jest.fn(),
    readConflictFile: jest.fn(),
    readProjectSelection: jest.fn(),
    readReviewFile: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        file: REQUEST_REVIEW.files[0]!,
        kind: 'text',
        newText: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n',
        oldText: 'old one\nold two\n',
      },
    }),
    readSnapshot: jest.fn(),
    readWorkingTreeReviewFile: jest.fn(),
    reopenTicket: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

function intentId(rpcId: string): string {
  return `r${Buffer.from(rpcId, 'ascii').toString('base64url')}`;
}

describe('Agent Runtime write methods', () => {
  it('creates a Ticket through the application command with retry-stable intent', async () => {
    const collab = port();
    collab.createTicket.mockResolvedValue({ status: 'success', value: DETAIL });
    const gateway = new AgentRuntimeGateway(async () => collab);
    const id = 'ticket.create.1';

    await expect(gateway.handle({
      id,
      method: 'collab.tickets.create',
      params: {
        body: DETAIL.body,
        projectId: PROJECT_ID,
        title: TICKET.title,
      },
    })).resolves.toEqual({
      id,
      result: {
        acceptedRelations: [],
        body: DETAIL.body,
        comments: [],
        projectId: PROJECT_ID,
        ticket: agentTicket(TICKET),
      },
    });
    expect(collab.createTicket).toHaveBeenCalledWith({
      body: DETAIL.body,
      intentId: intentId(id),
      projectId: PROJECT_ID,
      title: TICKET.title,
    }, { signal: expect.any(AbortSignal) });
  });

  it('reuses the exact application intent when the same RPC request is retried', async () => {
    const collab = port();
    collab.createTicket.mockResolvedValue({ status: 'success', value: DETAIL });
    const gateway = new AgentRuntimeGateway(async () => collab);
    const request = {
      id: 'ticket.retry.1',
      method: 'collab.tickets.create',
      params: {
        body: DETAIL.body,
        projectId: PROJECT_ID,
        title: TICKET.title,
      },
    };

    const first = await gateway.handle(request);
    const replay = await gateway.handle(request);

    expect(replay).toEqual(first);
    expect(collab.createTicket).toHaveBeenCalledTimes(2);
    expect(collab.createTicket.mock.calls.map(([input]) => input.intentId)).toEqual([
      intentId(request.id),
      intentId(request.id),
    ]);
  });

  it.each([
    ['update', 'collab.tickets.update', 'updateTicketContent'],
    ['close', 'collab.tickets.close', 'closeTicket'],
    ['reopen', 'collab.tickets.reopen', 'reopenTicket'],
  ] as const)('%ss a Ticket with its expected revision', async (
    _label,
    method,
    portMethod,
  ) => {
    const collab = port();
    collab[portMethod].mockResolvedValue({ status: 'success', value: TICKET });
    const gateway = new AgentRuntimeGateway(async () => collab);
    const id = `ticket.${_label}.1`;
    const content = method === 'collab.tickets.update'
      ? { body: DETAIL.body, title: TICKET.title }
      : {};

    await expect(gateway.handle({
      id,
      method,
      params: {
        ...content,
        expectedRevision: TICKET.revision,
        projectId: PROJECT_ID,
        ticketId: TICKET_ID,
      },
    })).resolves.toEqual({
      id,
      result: { projectId: PROJECT_ID, ticket: agentTicket(TICKET) },
    });
    expect(collab[portMethod]).toHaveBeenCalledWith({
      ...content,
      expectedRevision: TICKET.revision,
      intentId: intentId(id),
      projectId: PROJECT_ID,
      ticketId: TICKET_ID,
    }, { signal: expect.any(AbortSignal) });
  });

  it('adds an immutable Ticket comment', async () => {
    const collab = port();
    collab.addTicketComment.mockResolvedValue({ status: 'success', value: COMMENT });
    const gateway = new AgentRuntimeGateway(async () => collab);
    const id = '_ticket-comment';

    await expect(gateway.handle({
      id,
      method: 'collab.tickets.comments.create',
      params: { body: COMMENT.body, projectId: PROJECT_ID, ticketId: TICKET_ID },
    })).resolves.toEqual({
      id,
      result: { comment: COMMENT, projectId: PROJECT_ID },
    });
    expect(collab.addTicketComment).toHaveBeenCalledWith({
      body: COMMENT.body,
      intentId: intentId(id),
      projectId: PROJECT_ID,
      ticketId: TICKET_ID,
    }, { signal: expect.any(AbortSignal) });
  });

  it.each([
    ['blank title', 'collab.tickets.create', { body: DETAIL.body, projectId: PROJECT_ID, title: '   ' }],
    ['oversized body', 'collab.tickets.create', {
      body: '\u754c'.repeat(11_000),
      projectId: PROJECT_ID,
      title: TICKET.title,
    }],
    ['negative revision', 'collab.tickets.close', {
      expectedRevision: -1,
      projectId: PROJECT_ID,
      ticketId: TICKET_ID,
    }],
    ['zero Ticket revision', 'collab.tickets.close', {
      expectedRevision: 0,
      projectId: PROJECT_ID,
      ticketId: TICKET_ID,
    }],
    ['unsafe Ticket revision', 'collab.tickets.close', {
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      projectId: PROJECT_ID,
      ticketId: TICKET_ID,
    }],
  ])('rejects %s before resolving Collab', async (_label, method, params) => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({ id: 'invalid-write', method, params })).resolves.toEqual({
      error: { code: 'invalid_params', message: 'Invalid RPC params.' },
      id: 'invalid-write',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('adds an immutable Request comment without review preparation', async () => {
    const collab = port();
    collab.addComment.mockResolvedValue({ status: 'success', value: REQUEST_COMMENT });
    const gateway = new AgentRuntimeGateway(async () => collab);

    await expect(gateway.handle({
      id: 'request.comment.general',
      method: 'collab.requests.comments.create',
      params: {
        body: REQUEST_COMMENT.body,
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
      },
    })).resolves.toMatchObject({
      id: 'request.comment.general',
      result: { comment: { id: REQUEST_COMMENT.id }, projectId: PROJECT_ID },
    });
    expect(collab.boundedQueries.prepareReview).not.toHaveBeenCalled();
    expect(collab.readReviewFile).not.toHaveBeenCalled();
    expect(collab.addComment).toHaveBeenLastCalledWith({
      body: REQUEST_COMMENT.body,
      intentId: intentId('request.comment.general'),
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
    }, { signal: expect.any(AbortSignal) });
  });

  it('accepts an exact Request with resolving Ticket revisions', async () => {
    const collab = port();
    collab.acceptRequest.mockResolvedValue({
      status: 'success',
      value: { mainOid: MERGE_OID, mergeCommitOid: MERGE_OID, request: { ...REQUEST, status: 'merged', mergedOid: MERGE_OID } },
    });
    const gateway = new AgentRuntimeGateway(async () => collab);
    const id = 'request.accept.1';
    const expectedResolvingTickets = [{ revision: TICKET.revision, ticketId: TICKET_ID }];

    await expect(gateway.handle({
      id,
      method: 'collab.requests.accept',
      params: {
        expectedHeadOid: HEAD_OID,
        expectedMainOid: MAIN_OID,
        expectedRequestRevision: REQUEST.revision,
        expectedResolvingTickets,
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
      },
    })).resolves.toMatchObject({
      id,
      result: { mainOid: MERGE_OID, mergeCommitOid: MERGE_OID, projectId: PROJECT_ID },
    });
    expect(collab.acceptRequest).toHaveBeenCalledWith({
      expectedHeadOid: HEAD_OID,
      expectedMainOid: MAIN_OID,
      expectedRequestRevision: REQUEST.revision,
      expectedResolvingTickets,
      intentId: intentId(id),
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
    }, { signal: expect.any(AbortSignal) });
  });

  it('preserves stale precondition details from the application boundary', async () => {
    const collab = port();
    collab.acceptRequest.mockResolvedValue({
      error: new CollabError({
        code: 'stale-request-metadata',
        recoveryActions: ['retry'],
        safeContext: { reason: 'request-revision-changed' },
      }),
      staleKind: 'request-metadata',
      status: 'stale',
    });
    const gateway = new AgentRuntimeGateway(async () => collab);

    await expect(gateway.handle({
      id: 'request.accept.stale',
      method: 'collab.requests.accept',
      params: {
        expectedHeadOid: HEAD_OID,
        expectedMainOid: MAIN_OID,
        expectedRequestRevision: REQUEST.revision,
        expectedResolvingTickets: [],
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
      },
    })).resolves.toEqual({
      error: {
        code: 'stale-request-metadata',
        data: {
          group: 'state',
          recoveryActions: ['retry'],
          safeContext: { reason: 'request-revision-changed' },
          staleKind: 'request-metadata',
          status: 'stale',
        },
        message: 'collab.error.stale-request-metadata',
      },
      id: 'request.accept.stale',
    });
  });

  it('rejects duplicate resolving Ticket expectations before resolving Collab', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);
    const duplicate = { revision: TICKET.revision, ticketId: TICKET_ID };

    await expect(gateway.handle({
      id: 'accept-duplicate',
      method: 'collab.requests.accept',
      params: {
        expectedHeadOid: HEAD_OID,
        expectedMainOid: MAIN_OID,
        expectedRequestRevision: REQUEST.revision,
        expectedResolvingTickets: [duplicate, duplicate],
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
      },
    })).resolves.toEqual({
      error: { code: 'invalid_params', message: 'Invalid RPC params.' },
      id: 'accept-duplicate',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('rejects undeclared resolving Ticket fields before resolving Collab', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'accept-extra-field',
      method: 'collab.requests.accept',
      params: {
        expectedHeadOid: HEAD_OID,
        expectedMainOid: MAIN_OID,
        expectedRequestRevision: REQUEST.revision,
        expectedResolvingTickets: [{
          extra: true,
          revision: TICKET.revision,
          ticketId: TICKET_ID,
        }],
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
      },
    })).resolves.toEqual({
      error: { code: 'invalid_params', message: 'Invalid RPC params.' },
      id: 'accept-extra-field',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('publishes directly when the application needs no confirmation', async () => {
    const collab = port();
    collab.publish.mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: HEAD_OID,
        projectId: PROJECT_ID,
        remoteHeadOid: HEAD_OID,
        request: REQUEST,
        state: 'request-synchronized',
      },
    });
    const gateway = new AgentRuntimeGateway(async () => collab);

    await expect(gateway.handle({
      id: 'publish-direct',
      method: 'collab.changes.publish',
      params: { description: REQUEST.description, projectId: PROJECT_ID },
    })).resolves.toMatchObject({
      id: 'publish-direct',
      result: { projectId: PROJECT_ID, state: 'request-synchronized' },
    });
    expect(collab.confirmPublish).not.toHaveBeenCalled();
  });

  it('performs at most one exact Publish confirmation and maps review fields explicitly', async () => {
    const collab = port();
    collab.publish.mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: HEAD_OID,
        projectId: PROJECT_ID,
        review: PUBLICATION_REVIEW,
        state: 'review-required',
      },
    });
    collab.confirmPublish.mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: HEAD_OID,
        projectId: PROJECT_ID,
        review: { ...PUBLICATION_REVIEW, operationId: 'publish-operation-b' },
        state: 'review-required',
      },
    });
    const gateway = new AgentRuntimeGateway(async () => collab);

    const response = await gateway.handle({
      id: 'publish-confirm',
      method: 'collab.changes.publish',
      params: { description: REQUEST.description, projectId: PROJECT_ID },
    });

    expect(collab.confirmPublish).toHaveBeenCalledTimes(1);
    expect(collab.confirmPublish).toHaveBeenCalledWith({
      description: REQUEST.description,
      expectedCandidateOid: CANDIDATE_OID,
      expectedMainOid: MAIN_OID,
      operationId: PUBLICATION_REVIEW.operationId,
      projectId: PROJECT_ID,
    }, { signal: expect.any(AbortSignal) });
    expect(response).toMatchObject({
      result: {
        review: {
          files: [{ path: 'notes/change.md' }],
          operationId: 'publish-operation-b',
        },
        state: 'review-required',
      },
    });
    expect(JSON.stringify(response)).not.toContain('workingTreeContentHash');
    expect(JSON.stringify(response)).not.toContain('must-not-cross-runtime');
  });

  it('preserves public conflict recovery identity without exposing conflict internals', async () => {
    const collab = port();
    collab.publish.mockResolvedValue({
      conflict: CONFLICT,
      error: new CollabError({
        code: 'content-conflict',
        recoveryActions: ['review-conflicts'],
        safeContext: { reason: 'accepted-state-conflict-pending' },
      }),
      status: 'conflict',
    });
    const gateway = new AgentRuntimeGateway(async () => collab);

    const response = await gateway.handle({
      id: 'publish-conflict',
      method: 'collab.changes.publish',
      params: { description: REQUEST.description, projectId: PROJECT_ID },
    });

    expect(response).toEqual({
      error: {
        code: 'content-conflict',
        data: {
          conflictOperationId: CONFLICT.operationId,
          group: 'state',
          projectId: PROJECT_ID,
          recoveryActions: ['review-conflicts'],
          safeContext: { reason: 'accepted-state-conflict-pending' },
          status: 'conflict',
        },
        message: 'collab.error.content-conflict',
      },
      id: 'publish-conflict',
    });
    expect(JSON.stringify(response)).not.toContain('startingMainOid');
    expect(JSON.stringify(response)).not.toContain('notes/change.md');
  });

  it('preserves durable recovery identity for an interrupted Publish', async () => {
    const collab = port();
    collab.publish.mockResolvedValue({
      durablePhase: 'committed',
      durableProgress: true,
      error: new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'publish-response-unknown' },
      }),
      operationId: 'publish-recovery-a',
      status: 'recovery-required',
    });
    const gateway = new AgentRuntimeGateway(async () => collab);

    await expect(gateway.handle({
      id: 'publish-recovery',
      method: 'collab.changes.publish',
      params: { description: REQUEST.description, projectId: PROJECT_ID },
    })).resolves.toEqual({
      error: {
        code: 'durable-progress-recovery-required',
        data: {
          durablePhase: 'committed',
          durableProgress: true,
          group: 'operation',
          operationId: 'publish-recovery-a',
          recoveryActions: ['resume'],
          safeContext: { reason: 'publish-response-unknown' },
          status: 'recovery-required',
        },
        message: 'collab.error.durable-progress-recovery-required',
      },
      id: 'publish-recovery',
    });
  });
});
