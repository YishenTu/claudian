import type { CollabRequestDetail } from '@claudian-collab/protocol';

import {
  AgentRuntimeGateway,
  type CollabAgentPort,
} from '@/app/agent-runtime';
import { type CollabChangedFile, type CollabConflictSession, type CollabCoordinationSnapshot, type CollabFeaturePort, type CollabLocalProjectSummary, type CollabProjectInspection, type CollabRequestReview, type CollabResult, type CollabTicketDetailProjection, type CollabTicketPageProjection } from '@/core/collab';

const PROJECT: CollabLocalProjectSummary = {
  authorityKind: 'lan',
  connectionStatus: 'connected',
  health: 'healthy',
  hostInstallationStatus: 'hosted-here',
  hostStatus: 'running',
  id: 'project-alpha',
  name: 'Alpha',
  role: 'manager',
  workspacePath: 'workspace/alpha',
};

const CHANGED_FILE: CollabChangedFile = {
  additions: 3,
  binary: false,
  deletions: 1,
  kind: 'modified',
  largeForReview: false,
  newBytes: 24,
  oldBytes: 18,
  path: 'notes/change.md',
  workingTreeContentHash: 'private-working-tree-hash',
};

const RAW_ONLY_FILE: CollabChangedFile = {
  binary: false,
  kind: 'modified',
  largeForReview: false,
  path: 'notes/already-integrated.md',
  workingTreeContentHash: 'private-raw-only-hash',
};

const REQUEST = {
  commentCount: 3,
  createdAt: '2026-08-11T01:00:00.000Z',
  description: 'Improve the note',
  firstBaseOid: 'base-oid',
  id: 'request-mine',
  latestHeadOid: 'head-oid',
  memberId: 'member-manager',
  revision: 2,
  status: 'open' as const,
  ticketRelations: [{
    commitOid: 'head-oid',
    id: 'relation-1',
    kind: 'references' as const,
    state: 'pending' as const,
    ticketId: 'ticket-1',
    ticketNumber: 1,
    ticketRevision: 3,
    ticketTitle: 'Document the flow',
  }],
  updatedAt: '2026-08-11T02:00:00.000Z',
};

const COORDINATION: CollabCoordinationSnapshot = {
  snapshot: {
    currentMember: {
      activatedAt: '2026-08-11T00:00:00.000Z',
      createdAt: '2026-08-11T00:00:00.000Z',
      displayName: 'Manager',
      id: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      role: 'manager',
      status: 'active',
    },
    eventSequence: 7,
    members: [
      {
        activatedAt: '2026-08-11T00:00:00.000Z',
        createdAt: '2026-08-11T00:00:00.000Z',
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
        status: 'active',
      },
      {
        activatedAt: '2026-08-11T00:00:00.000Z',
        createdAt: '2026-08-11T00:00:00.000Z',
        displayName: 'Second Manager',
        id: 'member-manager-2',
        personalRef: 'refs/heads/members/member-manager-2',
        role: 'manager',
        status: 'active',
      },
      {
        activatedAt: '2026-08-11T00:00:00.000Z',
        createdAt: '2026-08-11T00:00:00.000Z',
        displayName: 'Member',
        id: 'member-active',
        personalRef: 'refs/heads/members/member-active',
        role: 'member',
        status: 'active',
      },
      {
        createdAt: '2026-08-11T00:00:00.000Z',
        displayName: 'Pending secret',
        id: 'member-pending',
        personalRef: 'refs/heads/members/member-pending',
        role: 'member',
        status: 'pending',
      },
    ],
    openRequests: [REQUEST],
    openTicketCount: 2,
    project: {
      authorityKind: 'lan',
      createdAt: '2026-08-11T00:00:00.000Z',
      hostMemberId: 'member-manager',
      id: PROJECT.id,
      mainOid: 'main-oid',
      mainRef: 'refs/heads/main',
      managerSetGeneration: 11,
      name: PROJECT.name,
    },
    ticketHighlights: [],
  },
  source: 'online',
  stale: false,
  syncState: {
    eventSequence: 7,
    generation: 3,
    projectId: PROJECT.id,
    status: 'synchronized',
  },
};

const CONFLICT: CollabConflictSession = {
  descriptor: {
    conflicts: [
      {
        acceptedOid: 'private-accepted-blob',
        baseOid: 'private-base-blob',
        kind: 'text',
        path: CHANGED_FILE.path,
        personalOid: 'private-personal-blob',
      },
      { kind: 'binary', path: 'assets/image.png' },
    ],
    mergeBaseOid: 'merge-base-oid',
    operationId: 'operation-1',
    projectId: PROJECT.id,
    startingMainOid: 'starting-main-oid',
    startingPersonalOid: 'starting-personal-oid',
  },
};

const INSPECTION: CollabProjectInspection = {
  conflict: CONFLICT,
  coordination: COORDINATION,
  gitStatus: {
    acceptedMainOid: 'main-oid',
    aheadBy: 1,
    behindBy: 0,
    changedFiles: [CHANGED_FILE],
    headOid: 'head-oid',
    includesAcceptedMain: true,
    personalRemoteOid: 'remote-oid',
    workingTreeClean: false,
  },
  personalChanges: {
    action: 'resolve-changes',
    conflictOperationId: 'operation-1',
    hasContribution: true,
    review: {
      baseMainOid: 'base-main-oid',
      canConfirm: true,
      candidateOid: 'candidate-oid',
      comparisonBaseOid: 'comparison-base-oid',
      comparisonTargetOid: 'comparison-target-oid',
      contributionHeadOid: 'contribution-head-oid',
      currentMainOid: 'main-oid',
      files: [CHANGED_FILE],
      kind: 'publication',
      operationId: 'operation-1',
      projectId: PROJECT.id,
    },
    unpublishedReview: {
      baseOid: 'published-head-oid',
      files: [CHANGED_FILE],
      headOid: 'head-oid',
      kind: 'working-tree',
      projectId: PROJECT.id,
      snapshotId: 'private-snapshot-id',
    },
    updateAvailable: true,
  },
  project: PROJECT,
};

const REQUEST_DETAIL: CollabRequestDetail = {
  comments: {
    comments: [{
      authorMemberId: 'member-manager',
      body: 'Please verify this.',
      createdAt: '2026-08-11T03:00:00.000Z',
      id: 'comment-1',
      requestId: REQUEST.id,
    }, {
      authorMemberId: 'member-manager',
      body: 'Additional overview feedback.',
      createdAt: '2026-08-11T03:00:30.000Z',
      id: 'comment-hidden',
      requestId: REQUEST.id,
    }, {
      authorMemberId: 'member-manager',
      body: 'General overview feedback.',
      createdAt: '2026-08-11T03:01:00.000Z',
      id: 'comment-general',
      requestId: REQUEST.id,
    }],
    nextCursor: 'request-comments-next',
  },
  currentMainOid: 'main-oid',
  request: REQUEST,
  reviewedHeadOid: 'head-oid',
  reviewCondition: 'clean',
};

const REQUEST_REVIEW: CollabRequestReview = {
  canAccept: true,
  comparisonBaseOid: 'comparison-base-oid',
  comparisonKind: 'candidate',
  comparisonTargetOid: 'comparison-target-oid',
  detail: REQUEST_DETAIL,
  files: [CHANGED_FILE],
  projectId: PROJECT.id,
};

const TICKET_PAGE: CollabTicketPageProjection = {
  page: {
    nextCursor: 'next-cursor',
    tickets: [{
      acceptedRelationCount: 0,
      authorMemberId: 'member-manager',
      commentCount: 1,
      createdAt: '2026-08-11T01:00:00.000Z',
      id: 'ticket-1',
      number: 1,
      revision: 3,
      status: 'open',
      title: 'Document the flow',
      updatedAt: '2026-08-11T02:00:00.000Z',
    }],
  },
  source: 'online',
  stale: false,
};

const TICKET_DETAIL: CollabTicketDetailProjection = {
  detail: {
    acceptedRelations: {
      acceptedRelations: [{
        acceptedAt: '2026-08-11T04:00:00.000Z',
        acceptedMergeOid: 'merge-oid',
        commitOid: 'head-oid',
        id: 'accepted-relation-1',
        kind: 'references',
        requestId: REQUEST.id,
      }],
      nextCursor: 'ticket-relations-next',
    },
    body: 'Full Ticket body',
    comments: {
      comments: [{
        authorMemberId: 'member-manager',
        body: 'Ticket comment',
        createdAt: '2026-08-11T03:00:00.000Z',
        id: 'ticket-comment-1',
        ticketId: 'ticket-1',
      }],
      nextCursor: 'ticket-comments-next',
    },
    ticket: TICKET_PAGE.page.tickets[0]!,
  },
  source: 'cache',
  stale: true,
};

function success<T>(value: T): CollabResult<T> {
  return { status: 'success', value };
}

function readPort(): jest.Mocked<CollabAgentPort> {
  return {
    acceptRequest: jest.fn(),
    addComment: jest.fn(),
    addTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    confirmPublish: jest.fn(),
    createTicket: jest.fn(),
    inspectProject: jest.fn().mockResolvedValue(success(INSPECTION)),
    listProjects: jest.fn().mockResolvedValue(success([PROJECT])),
    listTickets: jest.fn().mockResolvedValue(success(TICKET_PAGE)),
    publish: jest.fn(),
    boundedQueries: {
      listRequestComments: jest.fn().mockResolvedValue(success({
        comments: [REQUEST_DETAIL.comments.comments[0]!],
        nextCursor: 'request-comments-next-2',
      })),
      listTicketAcceptedRelations: jest.fn().mockResolvedValue(success({
        acceptedRelations: TICKET_DETAIL.detail.acceptedRelations.acceptedRelations,
        nextCursor: 'ticket-relations-next-2',
      })),
      listTicketComments: jest.fn().mockResolvedValue(success({
        comments: TICKET_DETAIL.detail.comments.comments,
        nextCursor: 'ticket-comments-next-2',
      })),
      prepareReview: jest.fn().mockResolvedValue(success(REQUEST_REVIEW)),
      readTicket: jest.fn().mockResolvedValue(success(TICKET_DETAIL)),
    },
    readConflict: jest.fn().mockResolvedValue(success(CONFLICT)),
    readConflictFile: jest.fn().mockResolvedValue(success({
      accepted: { path: CHANGED_FILE.path, text: 'accepted' },
      base: { path: CHANGED_FILE.path, text: 'base' },
      kind: 'text',
      path: CHANGED_FILE.path,
      personal: { path: CHANGED_FILE.path, text: 'personal' },
      segments: [
        { kind: 'common', text: 'shared\n' },
        {
          accepted: 'accepted\n',
          base: 'base\n',
          id: 'hunk-1',
          kind: 'conflict',
          personal: 'personal\n',
        },
      ],
    })),
    readProjectSelection: jest.fn().mockResolvedValue(success({
      projects: [{ id: PROJECT.id, name: PROJECT.name }],
      selectedProjectId: PROJECT.id,
    })),
    readReviewFile: jest.fn().mockResolvedValue(success({
      file: CHANGED_FILE,
      kind: 'text',
      newText: 'before\ntarget\nafter\n',
      oldText: 'old text',
    })),
    readSnapshot: jest.fn().mockResolvedValue(success(COORDINATION)),
    readWorkingTreeReviewFile: jest.fn().mockResolvedValue(success({
      file: CHANGED_FILE,
      kind: 'binary',
      preview: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
    })),
    reopenTicket: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

async function call(
  port: CollabAgentPort,
  method: string,
  params: Readonly<Record<string, unknown>>,
) {
  return new AgentRuntimeGateway(async () => port).handle({
    id: 'read-1',
    method,
    params,
  });
}

describe('Agent Runtime Collab read methods', () => {
  it('separates lightweight Project list from detailed Project state', async () => {
    const port = readPort();

    await expect(call(port, 'collab.projects.list', {})).resolves.toEqual({
      id: 'read-1',
      result: {
        projects: [{
          connectionStatus: 'connected',
          health: 'healthy',
          id: PROJECT.id,
          name: PROJECT.name,
          role: 'manager',
        }],
        selectedProjectId: PROJECT.id,
      },
    });
    const detail = await call(port, 'collab.projects.get', { projectId: PROJECT.id });

    expect(detail).toMatchObject({
      id: 'read-1',
      result: {
        project: {
          authorityKind: 'lan',
          coordination: {
            currentMember: { id: 'member-manager', status: 'active' },
            mainOid: 'main-oid',
            managerCount: 2,
            managerMemberIds: ['member-manager', 'member-manager-2'],
            members: [
              { id: 'member-manager', role: 'manager', status: 'active' },
              { id: 'member-manager-2', role: 'manager', status: 'active' },
              { id: 'member-active', role: 'member', status: 'active' },
            ],
            openRequestCount: 1,
            openTicketCount: 2,
            source: 'online',
            stale: false,
          },
          hostStatus: 'running',
          id: PROJECT.id,
          workspacePath: PROJECT.workspacePath,
        },
      },
    });
    expect(JSON.stringify(detail)).not.toContain('member-pending');
    expect(detail).not.toHaveProperty('result.project.coordination.managerMemberId');
    expect(detail).not.toHaveProperty('result.project.coordination.managerSetGeneration');
    expect(JSON.stringify(detail)).not.toContain('personalRef');
  });

  it('projects safe local lifecycle fields without recovery records or credentials', async () => {
    const port = readPort();
    const retired = {
      ...PROJECT,
      cleanupStatus: 'failed' as const,
      connectionStatus: 'offline' as const,
      hostStatus: 'not-host' as const,
      lifecycle: 'retired' as const,
      retiredAt: '2026-08-12T00:00:00.000Z',
    };
    port.listProjects.mockResolvedValue(success([retired]));
    port.inspectProject.mockResolvedValue(success({
      project: retired,
    } as CollabProjectInspection));

    const listed = await call(port, 'collab.projects.list', {});
    const detail = await call(port, 'collab.projects.get', { projectId: PROJECT.id });

    expect(listed).toMatchObject({
      result: {
        projects: [{
          cleanupStatus: 'failed',
          lifecycle: 'retired',
          retiredAt: '2026-08-12T00:00:00.000Z',
        }],
      },
    });
    expect(detail).toMatchObject({
      result: {
        project: {
          cleanupStatus: 'failed',
          coordination: null,
          lifecycle: 'retired',
          retiredAt: '2026-08-12T00:00:00.000Z',
        },
      },
    });
    const serialized = JSON.stringify({ detail, listed });
    expect(serialized).not.toContain('memberCredential');
    expect(serialized).not.toContain('hostCaCertificatePem');
    expect(serialized).not.toContain('cleanupOperationId');
    expect(serialized).not.toContain('package');
  });

  it('keeps the Cloud Agent Runtime projection authority-neutral and local', async () => {
    const port = readPort();
    const cloudProject: CollabLocalProjectSummary = {
      ...PROJECT,
      authorityKind: 'cloud',
      hostStatus: 'not-host',
    };
    const cloudCoordination: CollabCoordinationSnapshot = {
      ...COORDINATION,
      snapshot: {
        ...COORDINATION.snapshot,
        project: {
          authorityKind: 'cloud',
          createdAt: COORDINATION.snapshot.project.createdAt,
          id: PROJECT.id,
          mainOid: COORDINATION.snapshot.project.mainOid,
          mainRef: COORDINATION.snapshot.project.mainRef,
          name: PROJECT.name,
        },
      },
    };
    port.inspectProject.mockResolvedValue(success({
      ...INSPECTION,
      coordination: cloudCoordination,
      project: cloudProject,
    }));

    const detail = await call(port, 'collab.projects.get', { projectId: PROJECT.id });

    expect(detail).toMatchObject({
      result: {
        project: {
          authorityKind: 'cloud',
          coordination: {
            mainOid: COORDINATION.snapshot.project.mainOid,
            managerMemberIds: ['member-manager', 'member-manager-2'],
          },
          hostStatus: 'not-host',
          workspacePath: PROJECT.workspacePath,
        },
      },
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('hostMemberId');
    expect(serialized).not.toContain('managerSetGeneration');
    expect(serialized).not.toContain('personalRef');
    expect(serialized).not.toContain('providerSession');
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('credential');
  });

  it('fails closed when Project selection changes during a Project list read', async () => {
    const port = readPort();
    port.readProjectSelection.mockResolvedValue(success({
      projects: [{ id: 'project-other', name: 'Other' }],
      selectedProjectId: 'project-other',
    }));

    await expect(call(port, 'collab.projects.list', {})).resolves.toEqual({
      id: 'read-1',
      result: {
        projects: [{
          connectionStatus: 'connected',
          health: 'healthy',
          id: PROJECT.id,
          name: PROJECT.name,
          role: 'manager',
        }],
        selectedProjectId: null,
      },
    });
  });

  it('maps the effective Request review manifest, comments, and Ticket reads', async () => {
    const port = readPort();

    const requests = await call(port, 'collab.requests.list', { projectId: PROJECT.id });
    expect(requests).toMatchObject({
      result: {
        members: [
          { id: 'member-manager', role: 'manager' },
          { id: 'member-manager-2', role: 'manager' },
          { id: 'member-active', role: 'member' },
        ],
        requests: [{ id: REQUEST.id }],
        scope: 'open',
        source: 'online',
        sync: { eventSequence: 7, generation: 3, status: 'synchronized' },
      },
    });
    expect(JSON.stringify(requests)).not.toContain('member-pending');

    const request = await call(port, 'collab.requests.get', {
      projectId: PROJECT.id,
      requestId: REQUEST.id,
    });
    expect(request).toMatchObject({
      result: {
        changedFiles: [{ path: CHANGED_FILE.path }],
        comments: [
          { id: 'comment-1' },
          { id: 'comment-hidden' },
          { id: 'comment-general' },
        ],
        nextCommentCursor: 'request-comments-next',
        comparisonBaseOid: REQUEST_REVIEW.comparisonBaseOid,
        comparisonKind: REQUEST_REVIEW.comparisonKind,
        comparisonTargetOid: REQUEST_REVIEW.comparisonTargetOid,
        request: { id: REQUEST.id },
      },
    });
    expect(port.boundedQueries.prepareReview).toHaveBeenCalledWith(
      PROJECT.id,
      REQUEST.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(request)).not.toContain('private-working-tree-hash');
    expect(JSON.stringify(request)).not.toContain('private-raw-only-hash');
    expect(JSON.stringify(request)).not.toContain(RAW_ONLY_FILE.path);

    await expect(call(port, 'collab.tickets.list', {
      cursor: 'cursor-1',
      limit: 10,
      projectId: PROJECT.id,
      status: 'open',
    })).resolves.toMatchObject({
      result: {
        nextCursor: 'next-cursor',
        source: 'online',
        status: 'open',
        tickets: [{ id: 'ticket-1' }],
      },
    });
    expect(port.listTickets).toHaveBeenCalledWith({
      cursor: 'cursor-1',
      limit: 10,
      projectId: PROJECT.id,
      status: 'open',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    await expect(call(port, 'collab.tickets.get', {
      projectId: PROJECT.id,
      ticketId: 'ticket-1',
    })).resolves.toMatchObject({
      result: {
        acceptedRelations: [{ id: 'accepted-relation-1' }],
        body: 'Full Ticket body',
        comments: [{ id: 'ticket-comment-1' }],
        nextAcceptedRelationCursor: 'ticket-relations-next',
        nextCommentCursor: 'ticket-comments-next',
        source: 'cache',
        stale: true,
      },
    });

    await expect(call(port, 'collab.requests.comments.list', {
      cursor: 'request-comments-next',
      limit: 25,
      projectId: PROJECT.id,
      requestId: REQUEST.id,
    })).resolves.toMatchObject({
      result: {
        comments: [{ id: 'comment-1' }],
        nextCursor: 'request-comments-next-2',
        requestId: REQUEST.id,
      },
    });
    await expect(call(port, 'collab.tickets.comments.list', {
      cursor: 'ticket-comments-next',
      projectId: PROJECT.id,
      ticketId: 'ticket-1',
    })).resolves.toMatchObject({
      result: {
        comments: [{ id: 'ticket-comment-1' }],
        nextCursor: 'ticket-comments-next-2',
      },
    });
    await expect(call(port, 'collab.tickets.relations.list', {
      cursor: 'ticket-relations-next',
      projectId: PROJECT.id,
      ticketId: 'ticket-1',
    })).resolves.toMatchObject({
      result: {
        acceptedRelations: [{ id: 'accepted-relation-1' }],
        nextCursor: 'ticket-relations-next-2',
      },
    });
  });

  it('reports one request-owned conflict without duplicating its action in My Changes', async () => {
    const port = readPort();

    const changes = await call(port, 'collab.changes.mine', { projectId: PROJECT.id });
    expect(changes).toMatchObject({
      result: {
        changes: {
          action: 'none',
          unpublishedReview: { files: [{ path: CHANGED_FILE.path }] },
        },
      },
    });
    expect(JSON.stringify(changes)).not.toContain('conflictOperationId');
    expect(JSON.stringify(changes)).not.toContain('preparedPublication');
    expect(JSON.stringify(changes)).not.toContain('private-snapshot-id');

    const conflict = await call(port, 'collab.conflicts.get', { projectId: PROJECT.id });
    expect(conflict).toMatchObject({
      result: {
        conflict: {
          conflicts: [
            { kind: 'text', path: CHANGED_FILE.path },
            { kind: 'binary', path: 'assets/image.png' },
          ],
          location: 'request',
          operationId: 'operation-1',
          requestId: REQUEST.id,
        },
      },
    });
    const serialized = JSON.stringify(conflict);
    expect(serialized).not.toContain('private draft');
    expect(serialized).not.toContain('private proposal');
    expect(serialized).not.toContain('private-base-blob');
  });

  it('locates a conflict in My Changes when the current Member has no open Request', async () => {
    const port = readPort();
    port.inspectProject.mockResolvedValue(success({
      ...INSPECTION,
      coordination: {
        ...COORDINATION,
        snapshot: { ...COORDINATION.snapshot, openRequests: [] },
      },
    }));

    await expect(call(port, 'collab.conflicts.get', { projectId: PROJECT.id }))
      .resolves.toMatchObject({
        result: { conflict: { location: 'my-changes' } },
      });
    await expect(call(port, 'collab.changes.mine', { projectId: PROJECT.id }))
      .resolves.toMatchObject({
        result: {
          changes: {
            action: 'resolve-changes',
            conflictOperationId: 'operation-1',
            preparedPublication: { operationId: 'operation-1' },
          },
        },
      });
  });

  it('re-derives exact file identities and omits private hashes and binary bytes', async () => {
    const port = readPort();

    const requestFile = await call(port, 'collab.requests.file.get', {
      path: CHANGED_FILE.path,
      projectId: PROJECT.id,
      requestId: REQUEST.id,
    });
    expect(requestFile).toMatchObject({
      result: {
        comparisonBaseOid: 'comparison-base-oid',
        comparisonKind: 'candidate',
        comparisonTargetOid: 'comparison-target-oid',
        content: {
          kind: 'text',
          newText: 'before\ntarget\nafter\n',
          oldText: 'old text',
        },
      },
    });
    expect(port.readReviewFile).toHaveBeenCalledWith(expect.objectContaining({
      file: CHANGED_FILE,
      requestId: REQUEST.id,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(requestFile)).not.toContain('private-working-tree-hash');

    const personalFile = await call(port, 'collab.changes.file.get', {
      path: CHANGED_FILE.path,
      projectId: PROJECT.id,
    });
    expect(personalFile).toMatchObject({
      result: {
        baseOid: 'published-head-oid',
        content: { kind: 'binary' },
        headOid: 'head-oid',
      },
    });
    expect(port.readWorkingTreeReviewFile).toHaveBeenCalledWith(expect.objectContaining({
      file: CHANGED_FILE,
      snapshotId: 'private-snapshot-id',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(personalFile)).not.toContain('private-snapshot-id');
    expect(JSON.stringify(personalFile)).not.toContain('bytes');

    const conflictFile = await call(port, 'collab.conflicts.file.get', {
      path: CHANGED_FILE.path,
      projectId: PROJECT.id,
    });
    expect(conflictFile).toMatchObject({
      result: {
        content: {
          kind: 'text',
          segments: [
            { kind: 'common', text: 'shared\n' },
            { id: 'hunk-1', kind: 'conflict' },
          ],
        },
        location: 'request',
        operationId: 'operation-1',
        requestId: REQUEST.id,
      },
    });
    expect(port.readConflict).toHaveBeenCalledWith(
      'operation-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('maps opaque conflict versions without forwarding internal fields', async () => {
    const port = readPort();
    const privateBase = {
      bytes: 10,
      exists: true,
      internalPath: '/private/base',
      oid: 'private-base-oid',
      path: 'assets/image.png',
    };
    const privatePersonal = {
      bytes: 20,
      exists: true,
      oid: 'private-personal-oid',
      path: 'assets/image.png',
      preview: new Uint8Array([1, 2, 3]),
    };
    const privateAccepted = {
      bytes: 0,
      exists: false,
      oid: 'private-accepted-oid',
      path: 'assets/image.png',
    };
    port.readConflictFile.mockResolvedValue(success({
      accepted: privateAccepted,
      base: privateBase,
      kind: 'binary',
      path: 'assets/image.png',
      personal: privatePersonal,
    }));

    const response = await call(port, 'collab.conflicts.file.get', {
      path: 'assets/image.png',
      projectId: PROJECT.id,
    });

    expect(response).toMatchObject({
      result: {
        content: {
          accepted: { bytes: 0, exists: false, path: 'assets/image.png' },
          base: { bytes: 10, exists: true, path: 'assets/image.png' },
          kind: 'binary',
          personal: { bytes: 20, exists: true, path: 'assets/image.png' },
        },
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('private-');
    expect(serialized).not.toContain('preview');
  });

  it.each([
    ['collab.requests.file.get', { projectId: PROJECT.id, requestId: REQUEST.id, path: 'missing.md' }, 'readReviewFile'],
    ['collab.changes.file.get', { projectId: PROJECT.id, path: 'missing.md' }, 'readWorkingTreeReviewFile'],
    ['collab.conflicts.file.get', { projectId: PROJECT.id, path: 'missing.md' }, 'readConflictFile'],
  ] as const)('rejects an unknown manifest path before %s reads content', async (
    method,
    params,
    reader,
  ) => {
    const port = readPort();

    await expect(call(port, method, params)).resolves.toMatchObject({
      error: { code: 'path-invalid' },
      id: 'read-1',
    });
    expect(port[reader] as jest.Mock).not.toHaveBeenCalled();
  });

  it('sanitizes a path-like missing file before returning safe context', async () => {
    const port = readPort();

    const response = await call(port, 'collab.changes.file.get', {
      path: '/Users/private/secret.md',
      projectId: PROJECT.id,
    });

    expect(response).toMatchObject({
      error: {
        code: 'path-invalid',
        data: { safeContext: { path: '[PATH]', projectId: PROJECT.id } },
      },
    });
    expect(JSON.stringify(response)).not.toContain('/Users/private');
    expect(port.readWorkingTreeReviewFile).not.toHaveBeenCalled();
  });

  it('keeps the injected capability limited to the selected application surface', () => {
    const keys: readonly (keyof CollabAgentPort)[] = [
      'acceptRequest',
      'addComment',
      'addTicketComment',
      'closeTicket',
      'confirmPublish',
      'createTicket',
      'listProjects',
      'inspectProject',
      'readSnapshot',
      'boundedQueries',
      'readReviewFile',
      'readWorkingTreeReviewFile',
      'readConflict',
      'readConflictFile',
      'readProjectSelection',
      'listTickets',
      'publish',
      'reopenTicket',
      'updateTicketContent',
    ];
    expect(keys).toHaveLength(19);
    expect(keys).not.toEqual(expect.arrayContaining([
      'createInvitation',
      'demoteManager',
      'leaveProject',
      'promoteManager',
      'retireProject',
      'startHost',
      'stopHost',
    ] satisfies readonly (keyof CollabFeaturePort)[]));
  });
});
