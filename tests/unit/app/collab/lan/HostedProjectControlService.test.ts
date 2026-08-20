import type { AcceptRequest, CreateCommentRequest, EnsureMyRequestRequest } from '@claudian/collab-protocol';

import {
  type HostedLifecycleControlPort,
  type HostedMembershipAdminPort,
  type HostedMembershipControlPort,
  HostedProjectControlService,
  type HostedRequestControlPort,
  type HostedTicketControlPort,
} from '@/app/collab/lan/HostedProjectControlService';

function createHostedService(
  membership: HostedMembershipControlPort,
  overrides: {
    readonly administration?: Partial<HostedMembershipAdminPort>;
    readonly admission?: { run<T>(operation: () => Promise<T>): Promise<T> };
    readonly lifecycle?: Partial<HostedLifecycleControlPort>;
    readonly requests?: Partial<HostedRequestControlPort>;
    readonly tickets?: Partial<HostedTicketControlPort>;
  } = {},
): HostedProjectControlService {
  const requests: HostedRequestControlPort = {
    accept: jest.fn(),
    createComment: jest.fn(),
    ensure: jest.fn(),
    read: jest.fn(),
    readComments: jest.fn(),
    updateMetadata: jest.fn(),
    ...overrides.requests,
  };
  const administration: HostedMembershipAdminPort = {
    demoteManager: jest.fn(),
    leaveProject: jest.fn(),
    promoteManager: jest.fn(),
    removeMember: jest.fn(),
    ...overrides.administration,
  };
  const tickets: HostedTicketControlPort = {
    close: jest.fn(),
    comment: jest.fn(),
    create: jest.fn(),
    list: jest.fn(),
    listAcceptedRelations: jest.fn(),
    listComments: jest.fn(),
    read: jest.fn(),
    reopen: jest.fn(),
    updateContent: jest.fn(),
    ...overrides.tickets,
  };
  const lifecycle: HostedLifecycleControlPort = {
    acceptHostTransfer: jest.fn(),
    acknowledgeManagerResponsibility: jest.fn(),
    cancelHostTransfer: jest.fn(),
    cancelManagerResponsibilityOffer: jest.fn(),
    createHostTransfer: jest.fn(),
    createManagerResponsibilityOffer: jest.fn(),
    declineHostTransfer: jest.fn(),
    declineManagerResponsibility: jest.fn(),
    getCurrentHostTransfer: jest.fn().mockResolvedValue(null),
    getCurrentManagerResponsibilityOffer: jest.fn().mockResolvedValue(null),
    getHostTransitions: jest.fn(),
    getManagerResponsibilityOffer: jest.fn(),
    retireProject: jest.fn(),
    ...overrides.lifecycle,
  };
  return new HostedProjectControlService(
    membership,
    requests,
    administration,
    tickets,
    lifecycle,
    overrides.admission,
  );
}

describe('HostedProjectControlService', () => {
  it('augments membership snapshots with actor-visible lifecycle summaries', async () => {
    const snapshot = {
      currentMember: { id: 'member-host' },
      project: { id: 'project-a' },
    };
    const membership = {
      readSnapshot: jest.fn().mockResolvedValue(snapshot),
    } as unknown as HostedMembershipControlPort;
    const managerResponsibilityOffer = { offerId: 'offer-a' };
    const hostTransfer = { transferId: 'transfer-a' };
    const lifecycle = {
      getCurrentHostTransfer: jest.fn().mockResolvedValue(hostTransfer),
      getCurrentManagerResponsibilityOffer: jest.fn()
        .mockResolvedValue(managerResponsibilityOffer),
    };
    const service = createHostedService(membership, { lifecycle });

    await expect(service.readSnapshot('credential')).resolves.toEqual({
      ...snapshot,
      hostTransfer,
      managerResponsibilityOffer,
    });
    expect(lifecycle.getCurrentHostTransfer).toHaveBeenCalledWith(
      'member-host',
      'project-a',
    );
    expect(lifecycle.getCurrentManagerResponsibilityOffer).toHaveBeenCalledWith(
      'member-host',
      { projectId: 'project-a' },
    );
  });

  it('retries when membership changes while lifecycle summaries are read', async () => {
    const before = {
      currentMember: { id: 'member-target', role: 'member' as const },
      eventSequence: 4,
      project: { id: 'project-a', managerSetGeneration: 0 },
    };
    const after = {
      currentMember: { id: 'member-target', role: 'manager' as const },
      eventSequence: 5,
      project: { id: 'project-a', managerSetGeneration: 1 },
    };
    const membership = {
      readSnapshot: jest.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after)
        .mockResolvedValueOnce(after)
        .mockResolvedValueOnce(after),
    } as unknown as HostedMembershipControlPort;
    const lifecycle = {
      getCurrentHostTransfer: jest.fn().mockResolvedValue(null),
      getCurrentManagerResponsibilityOffer: jest.fn().mockResolvedValue(null),
    };
    const service = createHostedService(membership, { lifecycle });

    await expect(service.readSnapshot('credential')).resolves.toEqual(after);
    expect(membership.readSnapshot).toHaveBeenCalledTimes(4);
    expect(lifecycle.getCurrentManagerResponsibilityOffer).toHaveBeenCalledTimes(2);
  });

  it('authenticates an active Member before request ensure', async () => {
    const membership = {
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-a' },
      }),
    } as unknown as HostedMembershipControlPort;
    const requests = {
      accept: jest.fn(),
      createComment: jest.fn(),
      ensure: jest.fn().mockResolvedValue({ request: { id: 'request-a' } }),
      read: jest.fn(),
      readComments: jest.fn(),
      updateMetadata: jest.fn(),
    };
    const service = createHostedService(membership, { requests });
    const request: EnsureMyRequestRequest = {
      description: 'Published change',
      expectedMainOid: 'b'.repeat(40),
      headOid: 'a'.repeat(40),
      idempotencyKey: 'publish-head',
      projectId: 'project-a',
    };

    await expect(service.ensureMyRequest('credential', request)).resolves.toEqual({
      request: { id: 'request-a' },
    });
    expect(membership.authenticateMemberCredential).toHaveBeenCalledWith(
      'credential',
      ['active'],
    );
    expect(requests.ensure).toHaveBeenCalledWith('member-a', request);
  });

  it('authenticates active actors before ordinary membership administration', async () => {
    const membership = {
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-host' },
      }),
    } as unknown as HostedMembershipControlPort;
    const requests = {
      accept: jest.fn(),
      createComment: jest.fn(),
      ensure: jest.fn(),
      read: jest.fn(),
      readComments: jest.fn(),
      updateMetadata: jest.fn(),
    };
    const administration: HostedMembershipAdminPort = {
      leaveProject: jest.fn().mockResolvedValue({
        discardedRequestId: null,
        memberId: 'member-host',
        projectId: 'project-a',
        status: 'left',
      }),
      removeMember: jest.fn().mockResolvedValue({
        discardedRequestId: null,
        memberId: 'member-a',
        projectId: 'project-a',
        status: 'revoked',
      }),
      demoteManager: jest.fn().mockResolvedValue({
        demotedMemberId: 'member-a',
        managerSetGeneration: 2,
        projectId: 'project-a',
      }),
      promoteManager: jest.fn().mockResolvedValue({
        managerSetGeneration: 1,
        projectId: 'project-a',
        promotedMemberId: 'member-a',
      }),
    };
    const service = createHostedService(membership, { administration, requests });

    await service.removeMember('credential', {
      idempotencyKey: 'remove-key',
      memberId: 'member-a',
      projectId: 'project-a',
    });

    expect(membership.authenticateMemberCredential).toHaveBeenCalledTimes(1);
    expect(administration.removeMember).toHaveBeenCalledWith('member-host', {
      idempotencyKey: 'remove-key',
      memberId: 'member-a',
      projectId: 'project-a',
    });
  });

  it('allows an already-left credential to replay the exact Leave operation', async () => {
    const membership = {
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-a', status: 'left' },
      }),
    } as unknown as HostedMembershipControlPort;
    const administration: HostedMembershipAdminPort = {
      leaveProject: jest.fn().mockResolvedValue({
        discardedRequestId: null,
        memberId: 'member-a',
        projectId: 'project-a',
        status: 'left',
      }),
      demoteManager: jest.fn(),
      promoteManager: jest.fn(),
      removeMember: jest.fn(),
    };
    const run = jest.fn(async operation => operation());
    const service = createHostedService(membership, {
      administration,
      admission: { run },
    });
    const request = {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'leave-key',
      idempotencyManagerMemberId: null,
      projectId: 'project-a',
    };

    await expect(service.routing.lifecycle.execute({
      credential: 'credential',
      operation: 'leaveProject',
      request,
    })).resolves.toEqual({
      data: expect.objectContaining({ memberId: 'member-a', status: 'left' }),
    });
    expect(membership.authenticateMemberCredential).toHaveBeenCalledWith(
      'credential',
      ['active', 'left'],
    );
    expect(administration.leaveProject).toHaveBeenCalledWith('member-a', request);
    expect(service.routing.admission).toEqual({ run });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('authenticates an active Member before request reads and comments', async () => {
    const membership = {
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-a' },
      }),
    } as unknown as HostedMembershipControlPort;
    const requests = {
      accept: jest.fn(),
      createComment: jest.fn().mockResolvedValue({ comment: { id: 'comment-a' } }),
      ensure: jest.fn(),
      read: jest.fn().mockResolvedValue({ request: { id: 'request-a' } }),
      readComments: jest.fn(),
      updateMetadata: jest.fn(),
    };
    const service = createHostedService(membership, { requests });
    const comment: CreateCommentRequest = {
      body: 'Please revise',
      idempotencyKey: 'comment-key',
      projectId: 'project-a',
      requestId: 'request-a',
    };

    await expect(service.readRequest('credential', {
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual({
      request: { id: 'request-a' },
    });
    await expect(service.createComment('credential', comment)).resolves.toEqual({
      comment: { id: 'comment-a' },
    });
    expect(requests.read).toHaveBeenCalledWith('member-a', 'project-a', 'request-a');
    expect(requests.createComment).toHaveBeenCalledWith('member-a', comment);
    expect(membership.authenticateMemberCredential).toHaveBeenCalledTimes(2);
  });

  it('authenticates an active Member before dispatching exact-head Accept', async () => {
    const membership = {
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-host' },
      }),
    } as unknown as HostedMembershipControlPort;
    const requests = {
      accept: jest.fn().mockResolvedValue({ mainOid: 'c'.repeat(40) }),
      createComment: jest.fn(),
      ensure: jest.fn(),
      read: jest.fn(),
      readComments: jest.fn(),
      updateMetadata: jest.fn(),
    };
    const service = createHostedService(membership, { requests });
    const request: AcceptRequest = {
      expectedHeadOid: 'b'.repeat(40),
      expectedMainOid: 'a'.repeat(40),
      expectedRequestRevision: 0,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      projectId: 'project-a',
      requestId: 'request-a',
    };

    await expect(service.acceptRequest('credential', request)).resolves.toEqual({
      mainOid: 'c'.repeat(40),
    });
    expect(requests.accept).toHaveBeenCalledWith('member-host', request);
  });
});
