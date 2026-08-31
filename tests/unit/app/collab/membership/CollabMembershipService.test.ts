import {
  type CollabMembershipSafetyContext,
  CollabMembershipService,
  type CollabMembershipSnapshotPort,
} from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import type {
  CollabAuthorityMembershipControlPort,
  CollabAuthorityMembershipOperation,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import { type CollabCoordinationSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

function coordination(): CollabCoordinationSnapshot {
  const currentMember = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Alice',
    id: 'member-manager',
    personalRef: 'refs/heads/members/member-manager',
    role: 'manager' as const,
    status: 'active' as const,
  };
  const hostMember = {
    ...currentMember,
    displayName: 'Host operator',
    id: 'member-host',
    personalRef: 'refs/heads/members/member-host',
    role: 'member' as const,
  };
  return {
    snapshot: {
      currentMember,
      eventSequence: 4,
      members: [currentMember, hostMember],
      openTicketCount: 0,
      openRequests: [],
      project: {
        authorityKind: 'lan',
        createdAt: CREATED_AT,
        hostMemberId: hostMember.id,
        id: 'project-alpha',
        mainOid: 'a'.repeat(40),
        mainRef: 'refs/heads/main',
        managerSetGeneration: 0,
        name: 'Alpha',
      },
      ticketHighlights: [],
    },
    source: 'online',
    stale: false,
    syncState: {
      eventSequence: 4,
      generation: 1,
      projectId: 'project-alpha',
      status: 'synchronized',
    },
  };
}

type TestMembershipControl = jest.Mocked<CollabAuthorityMembershipControlPort> & {
  readonly operations: Record<CollabAuthorityMembershipOperation, jest.Mock>;
};

function client(): TestMembershipControl {
  const operations = {
    acknowledgeManagerResponsibility: jest.fn(),
    cancelManagerResponsibilityOffer: jest.fn(),
    createInvitation: jest.fn().mockResolvedValue({
      encodedInvitation: 'claudian-collab:v2:invite-alpha',
      expiresAt: '2026-08-08T00:15:00.000Z',
    }),
    createManagerResponsibilityOffer: jest.fn(),
    declineManagerResponsibility: jest.fn(),
    getManagerResponsibilityOffer: jest.fn(),
    removeMember: jest.fn().mockResolvedValue({
      discardedRequestId: 'request-member-a',
      memberId: 'member-a',
      projectId: 'project-alpha',
      status: 'revoked',
    }),
    revokeInvitation: jest.fn().mockResolvedValue(undefined),
    promoteManager: jest.fn().mockResolvedValue({
      managerSetGeneration: 1,
      promotedMemberId: 'member-a',
      projectId: 'project-alpha',
    }),
    demoteManager: jest.fn().mockResolvedValue({
      demotedMemberId: 'member-a',
      managerSetGeneration: 2,
      projectId: 'project-alpha',
    }),
  };
  return {
    membership: jest.fn((
      operation: CollabAuthorityMembershipOperation,
      input: unknown,
      options: unknown,
    ) => (
      operations[operation](input, options)
    )),
    operations,
  } as unknown as TestMembershipControl;
}

function safetyContext(
  overrides: Partial<CollabMembershipSafetyContext> = {},
): CollabMembershipSafetyContext {
  return {
    managerResponsibilityAdmission: async (_projectId, operation) => operation(),
    managerReceipts: {
      load: jest.fn(async () => null),
      remove: jest.fn(async () => false),
      save: jest.fn(async () => undefined),
    },
    managerResponsibilityOperations: new ManagerResponsibilityOperationCoordinator(),
    pendingLeaves: { load: jest.fn(async () => null) },
    ...overrides,
  };
}

describe('CollabMembershipService', () => {
  it('routes invitations through shared authority control', async () => {
    const snapshot: jest.Mocked<CollabMembershipSnapshotPort> = {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    };
    const control = client();
    const service = new CollabMembershipService(control, snapshot, {
      createIdempotencyKey: kind => `${kind}-key`,
    }, safetyContext());

    await expect(service.createInvitation('project-alpha')).resolves.toMatchObject({
      encodedInvitation: 'claudian-collab:v2:invite-alpha',
    });

    expect(control.operations.createInvitation).toHaveBeenCalledWith({
      idempotencyKey: 'create-invitation-key',
      projectId: 'project-alpha',
    }, {});
  });

  it('routes administration with local identity and refreshes projection after mutations', async () => {
    const snapshot: jest.Mocked<CollabMembershipSnapshotPort> = {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    };
    const control = client();
    const service = new CollabMembershipService(control, snapshot, {
      createIdempotencyKey: kind => `${kind}-key`,
    }, safetyContext());

    await service.promoteManager({
      managerResponsibilityOfferId: 'offer-transfer',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    });
    await service.demoteManager({
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    });
    await service.removeMember({
      memberId: 'member-a',
      projectId: 'project-alpha',
    });

    expect(control.operations.promoteManager).toHaveBeenCalledWith({
      idempotencyKey: 'promote-manager-key',
      managerResponsibilityOfferId: 'offer-transfer',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    }, {});
    expect(control.operations.demoteManager).toHaveBeenCalledWith({
      idempotencyKey: 'demote-manager-key',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    }, {});
    expect(control.operations.removeMember).toHaveBeenCalledWith({
      idempotencyKey: 'remove-member-key',
      memberId: 'member-a',
      projectId: 'project-alpha',
    }, {});
    expect(snapshot.readCoordinationSnapshot).toHaveBeenCalledTimes(3);
  });

  it('fails closed before promotion when another Project lifecycle owns admission', async () => {
    const control = client();
    const managerResponsibilityAdmission = jest.fn().mockRejectedValue(new CollabError({
      code: 'durable-progress-recovery-required',
      recoveryActions: ['resume'],
      safeContext: { reason: 'lifecycle-owner-pending' },
    }));
    const snapshot: jest.Mocked<CollabMembershipSnapshotPort> = {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    };
    const service = new CollabMembershipService(
      control,
      snapshot,
      {},
      safetyContext({ managerResponsibilityAdmission }),
    );

    await expect(service.promoteManager({
      managerResponsibilityOfferId: 'offer-transfer',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    })).rejects.toMatchObject({
      safeContext: { reason: 'lifecycle-owner-pending' },
    });

    expect(control.operations.promoteManager).not.toHaveBeenCalled();
    expect(snapshot.readCoordinationSnapshot).not.toHaveBeenCalled();
  });

  it('reuses a caller mutation intent after a lost administration response', async () => {
    const control = client();
    control.operations.demoteManager
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValueOnce({
        demotedMemberId: 'member-a',
        managerSetGeneration: 2,
        projectId: 'project-alpha',
      });
    const createIdempotencyKey = jest.fn((kind: string) => `${kind}-generated`);
    const service = new CollabMembershipService(control, {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    }, {
      createIdempotencyKey,
    }, safetyContext());
    const request = {
      intentId: 'retry_same_demotion',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    } as const;

    await expect(service.demoteManager(request)).rejects.toMatchObject({
      code: 'endpoint-unreachable',
    });
    await expect(service.demoteManager(request)).resolves.toBeUndefined();

    expect(control.operations.demoteManager.mock.calls.map(([input]) => input.idempotencyKey))
      .toEqual([
        'demote-manager-retry_same_demotion',
        'demote-manager-retry_same_demotion',
      ]);
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('maps every Manager administration intent to a stable operation-specific key', async () => {
    const control = client();
    control.operations.createManagerResponsibilityOffer.mockResolvedValue({
      expiresAt: '2026-08-08T00:15:00.000Z',
      offeredAt: CREATED_AT,
      offerId: 'offer-one',
      purpose: 'manager-promotion',
      sourceManagerMemberId: 'member-manager',
      status: 'offered',
      targetMemberId: 'member-a',
    });
    const createIdempotencyKey = jest.fn((kind: string) => `${kind}-generated`);
    const service = new CollabMembershipService(control, {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    }, {
      createIdempotencyKey,
    }, safetyContext());

    await service.createManagerResponsibilityOffer({
      intentId: 'offer_intent',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-a',
    });
    await service.promoteManager({
      intentId: 'promote_intent',
      managerResponsibilityOfferId: 'offer-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    });
    await service.demoteManager({
      intentId: 'demote_intent',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    });
    await service.removeMember({
      intentId: 'remove_intent',
      memberId: 'member-a',
      projectId: 'project-alpha',
    });

    expect(control.operations.createManagerResponsibilityOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manager-responsibility-offer-offer_intent',
      }),
      {},
    );
    expect(control.operations.promoteManager).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'promote-manager-promote_intent',
    }), {});
    expect(control.operations.demoteManager).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'demote-manager-demote_intent',
    }), {});
    expect(control.operations.removeMember).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'remove-member-remove_intent',
    }), {});
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('propagates shared authority control failures', async () => {
    const control = client();
    control.operations.removeMember.mockRejectedValue(new CollabError({ code: 'host-stopped' }));
    const service = new CollabMembershipService(control, {
      readCoordinationSnapshot: jest.fn(),
    }, {}, safetyContext());

    await expect(service.removeMember({
      memberId: 'member-a',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'host-stopped' });
  });

  it('recovers a lost Manager acknowledgement response without sending another mutation', async () => {
    const control = client();
    const offered = {
      expiresAt: '2026-08-08T00:10:00.000Z',
      offeredAt: '2026-08-08T00:00:00.000Z',
      offerId: 'offer-one',
      purpose: 'manager-leave' as const,
      sourceManagerMemberId: 'member-manager',
      status: 'offered' as const,
      targetMemberId: 'member-target',
    };
    const acknowledged = {
      ...offered,
      acknowledgedAt: '2026-08-08T00:01:00.000Z',
      status: 'acknowledged' as const,
    };
    control.operations.getManagerResponsibilityOffer.mockResolvedValue(acknowledged);
    const receipts = {
      load: jest.fn(async () => null),
      remove: jest.fn(async () => false),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(control, {
      readCoordinationSnapshot: jest.fn(),
    }, {}, safetyContext({
      managerReceipts: receipts,
    }));

    const projected = {
      ...coordination().snapshot,
      currentMember: {
        ...coordination().snapshot.currentMember,
        id: 'member-target',
        personalRef: 'refs/heads/members/member-target',
        role: 'member' as const,
      },
      managerResponsibilityOffer: offered,
    };

    await expect(service.reconcileManagerResponsibilitySnapshot(projected))
      .resolves.toEqual(acknowledged);
    expect(control.operations.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
    expect(receipts.save).toHaveBeenCalledWith('project-alpha', acknowledged);
  });

  it('automatically persists and acknowledges an offered Manager responsibility projection', async () => {
    const control = client();
    const offered = {
      expiresAt: '2026-08-08T00:10:00.000Z',
      offeredAt: CREATED_AT,
      offerId: 'offer-one',
      purpose: 'manager-leave' as const,
      sourceManagerMemberId: 'member-manager',
      status: 'offered' as const,
      targetMemberId: 'member-target',
    };
    const acknowledged = {
      ...offered,
      acknowledgedAt: '2026-08-08T00:01:00.000Z',
      status: 'acknowledged' as const,
    };
    control.operations.getManagerResponsibilityOffer.mockResolvedValue(offered);
    control.operations.acknowledgeManagerResponsibility.mockResolvedValue(acknowledged);
    const receipts = {
      load: jest.fn(async () => null),
      remove: jest.fn(async () => false),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(
      control,
      { readCoordinationSnapshot: jest.fn() },
      {},
      safetyContext({ managerReceipts: receipts }),
    );
    const projected = {
      ...coordination().snapshot,
      currentMember: {
        ...coordination().snapshot.currentMember,
        id: 'member-target',
        personalRef: 'refs/heads/members/member-target',
        role: 'member' as const,
      },
      managerResponsibilityOffer: offered,
    };

    await expect(service.reconcileManagerResponsibilitySnapshot(projected))
      .resolves.toEqual(acknowledged);
    expect(control.operations.acknowledgeManagerResponsibility).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'manager-ack-offer-one',
    }), {});
    expect(receipts.save).toHaveBeenNthCalledWith(1, 'project-alpha', offered);
    expect(receipts.save).toHaveBeenNthCalledWith(2, 'project-alpha', acknowledged);
  });

  it('reconciles an authority-acknowledged offer after the mutation response was lost', async () => {
    const control = client();
    const acknowledged = {
      acknowledgedAt: '2026-08-08T00:01:00.000Z',
      expiresAt: '2026-08-08T00:10:00.000Z',
      offeredAt: CREATED_AT,
      offerId: 'offer-current',
      purpose: 'manager-leave' as const,
      sourceManagerMemberId: 'member-manager',
      status: 'acknowledged' as const,
      targetMemberId: 'member-target',
    };
    const receipts = {
      load: jest.fn(async () => ({ offerId: 'offer-old', status: 'offered' as const })),
      remove: jest.fn(async () => true),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(
      control,
      { readCoordinationSnapshot: jest.fn() },
      {},
      safetyContext({ managerReceipts: receipts }),
    );
    const projected = {
      ...coordination().snapshot,
      currentMember: {
        ...coordination().snapshot.currentMember,
        id: 'member-target',
        personalRef: 'refs/heads/members/member-target',
        role: 'member' as const,
      },
      managerResponsibilityOffer: acknowledged,
    };

    await expect(service.reconcileManagerResponsibilitySnapshot(projected))
      .resolves.toEqual(acknowledged);
    expect(receipts.remove).toHaveBeenCalledWith('project-alpha');
    expect(receipts.save).toHaveBeenCalledWith('project-alpha', acknowledged);
    expect(control.operations.getManagerResponsibilityOffer).not.toHaveBeenCalled();
    expect(control.operations.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
  });

  it('removes a receipt after the authority no longer projects its offer', async () => {
    const receipts = {
      load: jest.fn(async () => ({ offerId: 'offer-one', status: 'acknowledged' as const })),
      remove: jest.fn(async () => true),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(
      client(),
      { readCoordinationSnapshot: jest.fn() },
      {},
      safetyContext({ managerReceipts: receipts }),
    );

    await expect(service.reconcileManagerResponsibilitySnapshot(coordination().snapshot))
      .resolves.toBeNull();
    expect(receipts.remove).toHaveBeenCalledWith('project-alpha');
  });

  it('automatically declines Manager responsibility when an offline Leave is pending', async () => {
    const control = client();
    const declined = {
      expiresAt: '2026-08-08T00:10:00.000Z',
      offeredAt: CREATED_AT,
      offerId: 'offer-one',
      purpose: 'manager-leave' as const,
      sourceManagerMemberId: 'member-manager',
      status: 'declined' as const,
      targetMemberId: 'member-target',
    };
    control.operations.declineManagerResponsibility.mockResolvedValue(declined);
    const service = new CollabMembershipService(
      control,
      { readCoordinationSnapshot: jest.fn() },
      {},
      safetyContext({
        pendingLeaves: { load: jest.fn().mockResolvedValue({ phase: 'queued' }) },
      }),
    );
    const projected = {
      ...coordination().snapshot,
      currentMember: {
        ...coordination().snapshot.currentMember,
        id: 'member-target',
        personalRef: 'refs/heads/members/member-target',
        role: 'member' as const,
      },
      managerResponsibilityOffer: { ...declined, status: 'offered' as const },
    };

    await expect(service.reconcileManagerResponsibilitySnapshot(projected))
      .resolves.toEqual(declined);
    expect(control.operations.declineManagerResponsibility).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'manager-decline-offer-one',
    }), {});
    expect(control.operations.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
  });
});
