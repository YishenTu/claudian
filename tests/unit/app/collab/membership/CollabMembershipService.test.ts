import type {
  CollabLocalLanMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  type CollabMembershipControlClientPort,
  type CollabMembershipSafetyContext,
  CollabMembershipService,
  type CollabMembershipSnapshotPort,
} from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { type CollabCoordinationSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

function membership(
  overrides: Partial<CollabLocalLanMembershipRecord> = {},
): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: 'https://192.168.1.10:54545/v1/git/project-alpha/repository.git',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'ab'.repeat(32),
      kind: 'lan',
    },
    createdAt: CREATED_AT,
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 3,
    member: {
      credential: Buffer.alloc(32, 1).toString('base64url'),
      displayName: 'Alice',
      id: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      role: 'manager',
    },
    project: {
      id: 'project-alpha',
      name: 'Alpha',
      workspacePath: 'workspace/alpha',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

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

function client(): jest.Mocked<CollabMembershipControlClientPort> {
  return {
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
}

function safetyContext(
  overrides: Partial<CollabMembershipSafetyContext> = {},
): CollabMembershipSafetyContext {
  return {
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
  it('lists projected Members and uses pinned trust for a non-Host Manager', async () => {
    const membershipRecord = membership();
    const projects = {
      loadMembership: jest.fn().mockResolvedValue(membershipRecord),
    };
    const snapshot: jest.Mocked<CollabMembershipSnapshotPort> = {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    };
    const control = client();
    const createClient = jest.fn(() => control);
    const service = new CollabMembershipService(projects, snapshot, {
      createClient,
      createIdempotencyKey: kind => `${kind}-key`,
    }, safetyContext());

    await expect(service.listMembers('project-alpha')).resolves.toHaveLength(2);
    await expect(service.createInvitation('project-alpha')).resolves.toMatchObject({
      encodedInvitation: 'claudian-collab:v2:invite-alpha',
    });

    expect(createClient).toHaveBeenCalledWith({
      caCertificatePem: membershipRecord.authority.hostCaCertificatePem,
      caFingerprint: membershipRecord.authority.hostCaFingerprint,
      endpoint: membershipRecord.authority.endpoint,
      projectId: 'project-alpha',
    });
    expect(control.createInvitation).toHaveBeenCalledWith({
      idempotencyKey: 'create-invitation-key',
      memberCredential: membershipRecord.member.credential,
      projectId: 'project-alpha',
    });
  });

  it('routes administration with local identity and refreshes projection after mutations', async () => {
    const membershipRecord = membership();
    const projects = {
      loadMembership: jest.fn().mockResolvedValue(membershipRecord),
    };
    const snapshot: jest.Mocked<CollabMembershipSnapshotPort> = {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    };
    const control = client();
    const service = new CollabMembershipService(projects, snapshot, {
      createClient: () => control,
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

    expect(control.promoteManager).toHaveBeenCalledWith({
      idempotencyKey: 'promote-manager-key',
      managerResponsibilityOfferId: 'offer-transfer',
      memberCredential: membershipRecord.member.credential,
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    });
    expect(control.demoteManager).toHaveBeenCalledWith({
      idempotencyKey: 'demote-manager-key',
      memberCredential: membershipRecord.member.credential,
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    });
    expect(control.removeMember).toHaveBeenCalledWith({
      idempotencyKey: 'remove-member-key',
      memberCredential: membershipRecord.member.credential,
      memberId: 'member-a',
      projectId: 'project-alpha',
    });
    expect(snapshot.readCoordinationSnapshot).toHaveBeenCalledTimes(3);
  });

  it('reuses a caller mutation intent after a lost administration response', async () => {
    const control = client();
    control.demoteManager
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValueOnce({
        demotedMemberId: 'member-a',
        managerSetGeneration: 2,
        projectId: 'project-alpha',
      });
    const createIdempotencyKey = jest.fn((kind: string) => `${kind}-generated`);
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    }, {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    }, {
      createClient: () => control,
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

    expect(control.demoteManager.mock.calls.map(([input]) => input.idempotencyKey))
      .toEqual([
        'demote-manager-retry_same_demotion',
        'demote-manager-retry_same_demotion',
      ]);
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('maps every Manager administration intent to a stable operation-specific key', async () => {
    const control = client();
    control.createManagerResponsibilityOffer.mockResolvedValue({
      expiresAt: '2026-08-08T00:15:00.000Z',
      offeredAt: CREATED_AT,
      offerId: 'offer-one',
      purpose: 'manager-promotion',
      sourceManagerMemberId: 'member-manager',
      status: 'offered',
      targetMemberId: 'member-a',
    });
    const createIdempotencyKey = jest.fn((kind: string) => `${kind}-generated`);
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    }, {
      readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination()),
    }, {
      createClient: () => control,
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

    expect(control.createManagerResponsibilityOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manager-responsibility-offer-offer_intent',
      }),
    );
    expect(control.promoteManager).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'promote-manager-promote_intent',
    }));
    expect(control.demoteManager).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'demote-manager-demote_intent',
    }));
    expect(control.removeMember).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'remove-member-remove_intent',
    }));
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('fails closed before constructing a client when stored Host trust is absent', async () => {
    const record = membership({
      authority: {
        endpoint: null,
        gitRemoteUrl: null,
        hostCaCertificatePem: null,
        hostCaFingerprint: null,
        kind: 'lan',
      },
    });
    const createClient = jest.fn();
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(record),
    }, {
      readCoordinationSnapshot: jest.fn(),
    }, { createClient }, safetyContext());

    await expect(service.removeMember({
      memberId: 'member-a',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'host-stopped' });
    expect(createClient).not.toHaveBeenCalled();
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
    control.getManagerResponsibilityOffer.mockResolvedValue(acknowledged);
    const receipts = {
      load: jest.fn(async () => null),
      remove: jest.fn(async () => false),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership({
        member: {
          credential: Buffer.alloc(32, 1).toString('base64url'),
          displayName: 'Target',
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
        },
      })),
    }, {
      readCoordinationSnapshot: jest.fn(),
    }, { createClient: () => control }, safetyContext({
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
    expect(control.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
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
    control.getManagerResponsibilityOffer.mockResolvedValue(offered);
    control.acknowledgeManagerResponsibility.mockResolvedValue(acknowledged);
    const receipts = {
      load: jest.fn(async () => null),
      remove: jest.fn(async () => false),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership({
        member: {
          credential: Buffer.alloc(32, 1).toString('base64url'),
          displayName: 'Target',
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
        },
      })),
    }, { readCoordinationSnapshot: jest.fn() }, {
      createClient: () => control,
    }, safetyContext({ managerReceipts: receipts }));
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
    expect(control.acknowledgeManagerResponsibility).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'manager-ack-offer-one',
    }));
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
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    }, { readCoordinationSnapshot: jest.fn() }, {
      createClient: () => control,
    }, safetyContext({ managerReceipts: receipts }));
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
    expect(control.getManagerResponsibilityOffer).not.toHaveBeenCalled();
    expect(control.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
  });

  it('removes a receipt after the authority no longer projects its offer', async () => {
    const receipts = {
      load: jest.fn(async () => ({ offerId: 'offer-one', status: 'acknowledged' as const })),
      remove: jest.fn(async () => true),
      save: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership()),
    }, { readCoordinationSnapshot: jest.fn() }, {}, safetyContext({
      managerReceipts: receipts,
    }));

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
    control.declineManagerResponsibility.mockResolvedValue(declined);
    const service = new CollabMembershipService({
      loadMembership: jest.fn().mockResolvedValue(membership({
        member: {
          credential: Buffer.alloc(32, 1).toString('base64url'),
          displayName: 'Target',
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
        },
      })),
    }, { readCoordinationSnapshot: jest.fn() }, {
      createClient: () => control,
    }, safetyContext({
      pendingLeaves: { load: jest.fn().mockResolvedValue({ phase: 'queued' }) },
    }));
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
    expect(control.declineManagerResponsibility).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'manager-decline-offer-one',
    }));
    expect(control.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
  });
});
