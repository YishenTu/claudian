import {
  type CloudPendingLeaveAuthorityClientPort,
  type PendingLeaveAuthorityClientPort,
  PendingLeaveAuthorityService,
} from '@/app/collab/exit/PendingLeaveAuthorityService';
import type {
  CloudPendingLeaveRecord,
  LanPendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import type { MembershipTerminationResponse } from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabCloudProjectSnapshot, CollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

describe('PendingLeaveAuthorityService', () => {
  it('prepares exact Leave preconditions from an active snapshot', async () => {
    const client = clientPort();
    const service = new PendingLeaveAuthorityService({ createClient: () => client });

    await expect(service.prepare({ pending: record() })).resolves.toEqual({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: null,
      },
      memberRole: 'member',
    });

    expect(client.readSnapshot).toHaveBeenCalledWith(
      'project-alpha',
      'A'.repeat(43),
      {},
    );
    expect(client.leaveProject).not.toHaveBeenCalled();
  });

  it('replays the exact persisted Leave without requiring an active snapshot', async () => {
    const client = clientPort();
    client.readSnapshot.mockRejectedValue(new Error('membership revoked'));
    const service = new PendingLeaveAuthorityService({ createClient: () => client });

    await expect(service.settle({
      pending: record({
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: 'member-manager',
        managerResponsibilityOfferId: 'offer-one',
      }),
    })).resolves.toMatchObject({ status: 'left' });

    expect(client.readSnapshot).not.toHaveBeenCalled();
    expect(client.leaveProject).toHaveBeenCalledWith(expect.objectContaining({
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-alice',
      idempotencyKey: 'leave-one',
      idempotencyManagerMemberId: 'member-manager',
      managerResponsibilityOfferId: 'offer-one',
      memberCredential: 'A'.repeat(43),
      projectId: 'project-alpha',
    }));
  });

  it('refuses to mutate before replay preconditions are persisted', async () => {
    const client = clientPort();
    const service = new PendingLeaveAuthorityService({ createClient: () => client });

    await expect(service.settle({ pending: record() })).rejects.toMatchObject({
      code: 'authority-integrity-error',
    });

    expect(client.readSnapshot).not.toHaveBeenCalled();
    expect(client.leaveProject).not.toHaveBeenCalled();
  });

  it('does not trust a snapshot for another current Member', async () => {
    const client = clientPort();
    client.readSnapshot.mockResolvedValue({
      ...snapshot(),
      currentMember: { ...snapshot().currentMember, id: 'member-other' },
    });
    const service = new PendingLeaveAuthorityService({ createClient: () => client });

    await expect(service.prepare({ pending: record() })).rejects.toMatchObject({
      code: 'authority-integrity-error',
    });
    expect(client.leaveProject).not.toHaveBeenCalled();
  });

  it('resolves a moved Host without retrying a credentialed request in memory', async () => {
    const candidate = {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n',
      caFingerprint: 'b'.repeat(64),
      endpoint: 'https://10.0.0.8:54545',
      projectId: 'project-alpha',
    };
    const createClient = jest.fn(() => clientPort());
    const resolve = jest.fn(async () => candidate);
    const service = new PendingLeaveAuthorityService({
      createClient,
      hostTransitionCandidates: { resolve },
    });
    const pending = record({
      expectedHostMemberId: 'member-host',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId: null,
    });
    const failure = new CollabError({ code: 'endpoint-unreachable' });

    await expect(service.resolveHost({ failure, pending })).resolves.toEqual(candidate);

    expect(resolve).toHaveBeenCalledWith({
      failure,
      pinnedCaCertificatePem: pending.hostCaCertificatePem,
      projectId: pending.projectId,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refreshes the Host while preserving private legacy fingerprint material', async () => {
    const client = clientPort();
    client.readSnapshot.mockResolvedValue({
      ...snapshot(),
      project: {
        ...snapshot().project,
        hostMemberId: 'member-host-current',
      },
    });
    const service = new PendingLeaveAuthorityService({ createClient: () => client });

    await expect(service.refresh({
      pending: record({
        expectedHostMemberId: 'member-host-old',
        idempotencyManagerMemberId: 'member-manager-old',
        managerResponsibilityOfferId: null,
      }),
    })).resolves.toEqual({
      authorityReplay: {
        expectedHostMemberId: 'member-host-current',
        idempotencyManagerMemberId: 'member-manager-old',
        managerResponsibilityOfferId: null,
      },
      memberRole: 'member',
    });
  });

  it('does not infer last-Manager policy from a fresh snapshot', async () => {
    const client = clientPort();
    client.readSnapshot.mockResolvedValue({
      ...snapshot(),
      currentMember: { ...snapshot().currentMember, role: 'manager' },
      members: [{ ...snapshot().currentMember, role: 'manager' }],
    });
    const service = new PendingLeaveAuthorityService({ createClient: () => client });

    await expect(service.prepare({ pending: record() })).resolves.toEqual({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: null,
      },
      memberRole: 'manager',
    });
  });

  it('freezes a Cloud Member Leave from authenticated snapshot, member list, and personal ref', async () => {
    const client = cloudClientPort();
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });

    await expect(service.prepare({ pending: cloudRecord() })).resolves.toEqual({
      memberRole: 'member',
      request: {
        expectedManagerSetGeneration: 7,
        expectedMembershipRevision: 9,
        expectedOfferRevision: null,
        expectedPersonalRefOid: 'b'.repeat(40),
        idempotencyKey: 'leave-cloud-one',
        managerResponsibilityOfferId: null,
        projectId: 'project-alpha',
      },
    });
    expect(client.readPersonalRefOid).toHaveBeenCalledWith(
      'refs/heads/members/member-alice',
      {},
    );
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('accepts the protocol-hidden self binding when recovering a rejected Cloud Member Leave', async () => {
    const client = cloudClientPort();
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });

    await expect(service.recoverRejected({
      pending: submittedCloudRecord(),
    })).resolves.toEqual({ memberRole: 'member' });
  });

  it('replays a submitted Cloud Leave without active snapshot, member list, or Git', async () => {
    const client = cloudClientPort();
    client.readSnapshot.mockRejectedValue(new Error('membership is already gone'));
    client.listProjectMembers.mockRejectedValue(new Error('membership is already gone'));
    client.readPersonalRefOid.mockRejectedValue(new Error('working copy is gone'));
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });
    const pending = submittedCloudRecord();

    await expect(service.settle({ pending })).resolves.toMatchObject({
      memberId: 'member-alice',
      status: 'left',
    });

    expect(client.leaveProject).toHaveBeenCalledWith(pending.request, {});
    expect(client.readSnapshot).not.toHaveBeenCalled();
    expect(client.listProjectMembers).not.toHaveBeenCalled();
    expect(client.readPersonalRefOid).not.toHaveBeenCalled();
  });

  it('rejects a Cloud Leave response for a different Member tuple', async () => {
    const client = cloudClientPort();
    client.leaveProject.mockResolvedValueOnce({
      discardedRequestId: null,
      leftAt: '2026-08-13T00:00:00.000Z',
      managerSetGeneration: 8,
      memberId: 'member-other',
      projectId: 'project-alpha',
      promotedSuccessorMemberId: null,
      status: 'left',
    });
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });

    await expect(service.settle({ pending: submittedCloudRecord() })).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-pending-leave-response-mismatch' },
    });
  });

  it('keeps a rejected Cloud request frozen when the recovery barrier cannot prove the Member', async () => {
    const client = cloudClientPort();
    client.listProjectMembers.mockResolvedValueOnce({
      managerSetGeneration: 8,
      members: [],
      projectId: 'project-alpha',
    });
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });

    await expect(service.recoverRejected({
      pending: submittedCloudRecord(),
    })).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-pending-leave-recovery-member-mismatch' },
    });
    expect(client.readPersonalRefOid).not.toHaveBeenCalled();
  });

  it('requires an acknowledged successor only for the final Cloud Manager', async () => {
    const client = cloudClientPort('manager');
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });

    await expect(service.prepare({ pending: cloudRecord('manager') })).rejects.toMatchObject({
      code: 'manager-responsibility-pending',
      safeContext: { reason: 'cloud-pending-leave-successor-required' },
    });
    client.getManagerResponsibilityOffer.mockResolvedValueOnce({
      offer: {
        acknowledgedAt: '2026-08-12T01:00:00.000Z',
        expiresAt: '2026-08-14T00:00:00.000Z',
        managerSetGenerationAtOffer: 7,
        offeredAt: '2026-08-12T00:30:00.000Z',
        offerId: 'offer-successor',
        purpose: 'manager-leave',
        revision: 2,
        sourceManagerMemberId: 'member-alice',
        state: 'acknowledged',
        targetMemberId: 'member-bob',
        targetMembershipRevisionAtOffer: 5,
        terminalAt: null,
      },
    });

    await expect(service.prepare({
      managerResponsibilityOfferId: 'offer-successor',
      pending: cloudRecord('manager'),
    })).resolves.toMatchObject({
      memberRole: 'manager',
      request: {
        expectedOfferRevision: 2,
        managerResponsibilityOfferId: 'offer-successor',
      },
    });
  });

  it('uses null succession fields for a non-final Cloud Manager', async () => {
    const client = cloudClientPort('manager');
    const manager = {
      bindingState: 'bound' as const,
      displayName: 'Alice',
      importedClaimGeneration: null,
      importedClaimState: 'not-applicable' as const,
      memberId: 'member-alice' as const,
      membershipRevision: 9,
      role: 'manager' as const,
    };
    client.listProjectMembers.mockResolvedValueOnce({
      managerSetGeneration: 7,
      members: [manager, {
        ...manager,
        displayName: 'Carol',
        memberId: 'member-carol',
        membershipRevision: 6,
      }],
      projectId: 'project-alpha',
    });
    const service = new PendingLeaveAuthorityService({
      createCloudClient: async () => client,
    });

    await expect(service.prepare({ pending: cloudRecord('manager') })).resolves.toMatchObject({
      memberRole: 'manager',
      request: {
        expectedOfferRevision: null,
        managerResponsibilityOfferId: null,
      },
    });
    expect(client.getManagerResponsibilityOffer).not.toHaveBeenCalled();
  });
});

function clientPort(): jest.Mocked<PendingLeaveAuthorityClientPort> {
  return {
    leaveProject: jest.fn(async (_input): Promise<MembershipTerminationResponse> => ({
      discardedRequestId: null,
      memberId: 'member-alice',
      projectId: 'project-alpha',
      status: 'left',
    })),
    readSnapshot: jest.fn(async (_projectId, _memberCredential, _options) => snapshot()),
  };
}

function record(
  authorityReplay: LanPendingLeaveRecord['authorityReplay'] = null,
): LanPendingLeaveRecord {
  return {
    authorityReplay,
    cleanupChoice: 'keep-files',
    cleanupMarkerNonce: 'n'.repeat(43),
    createdAt: '2026-08-13T00:00:00.000Z',
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.20:54545',
    idempotencyKey: 'leave-one',
    kind: 'pending-leave',
    localCleanupComplete: true,
    localRole: 'member',
    memberCredential: 'A'.repeat(43),
    memberId: 'member-alice',
    operationId: 'leave-one',
    phase: 'queued',
    projectCreatedAt: '2026-08-12T00:00:00.000Z',
    projectId: 'project-alpha',
    projectName: 'Alpha',
    schemaVersion: 2,
    updatedAt: '2026-08-13T00:00:00.000Z',
    workspacePath: 'workspace/project-alpha',
  };
}

function snapshot(): CollabLanProjectSnapshot {
  return {
    currentMember: {
      activatedAt: '2026-08-12T00:00:00.000Z',
      createdAt: '2026-08-12T00:00:00.000Z',
      displayName: 'Alice',
      id: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      role: 'member',
      status: 'active',
    },
    eventSequence: 1,
    members: [],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'lan',
      createdAt: '2026-08-12T00:00:00.000Z',
      hostMemberId: 'member-host',
      id: 'project-alpha',
      managerSetGeneration: 0,
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main',
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function cloudRecord(
  localRole: 'manager' | 'member' = 'member',
): CloudPendingLeaveRecord {
  return {
    authorityGeneration: 4,
    authorityKind: 'cloud',
    cleanupChoice: 'keep-files',
    cleanupMarkerNonce: 'q'.repeat(43),
    createdAt: '2026-08-13T00:00:00.000Z',
    idempotencyKey: 'leave-cloud-one',
    kind: 'pending-leave',
    localCleanupComplete: false,
    localRole,
    memberId: 'member-alice',
    operationId: 'leave-cloud-one',
    personalRef: 'refs/heads/members/member-alice',
    phase: 'queued',
    projectCreatedAt: '2026-08-12T00:00:00.000Z',
    projectId: 'project-alpha',
    projectName: 'Alpha',
    request: null,
    schemaVersion: 3,
    serverUrl: 'https://cloud.example.test/base',
    updatedAt: '2026-08-13T00:00:00.000Z',
    workspacePath: 'workspace/project-alpha',
  };
}

function submittedCloudRecord(): CloudPendingLeaveRecord {
  return {
    ...cloudRecord(),
    phase: 'submitted',
    request: {
      expectedManagerSetGeneration: 7,
      expectedMembershipRevision: 9,
      expectedOfferRevision: null,
      expectedPersonalRefOid: 'b'.repeat(40),
      idempotencyKey: 'leave-cloud-one',
      managerResponsibilityOfferId: null,
      projectId: 'project-alpha',
    },
  };
}

function cloudSnapshot(role: 'manager' | 'member'): CollabCloudProjectSnapshot {
  const currentMember = {
    activatedAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    displayName: 'Alice',
    id: 'member-alice' as const,
    personalRef: 'refs/heads/members/member-alice',
    role,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 1,
    members: [currentMember],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityGeneration: 4,
      authorityKind: 'cloud',
      createdAt: '2026-08-12T00:00:00.000Z',
      id: 'project-alpha',
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main',
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function cloudClientPort(
  role: 'manager' | 'member' = 'member',
): jest.Mocked<CloudPendingLeaveAuthorityClientPort & { dispose(): void }> {
  const member = {
    bindingState: role === 'manager' ? 'bound' as const : 'hidden' as const,
    displayName: 'Alice',
    importedClaimGeneration: null,
    importedClaimState: 'not-applicable' as const,
    memberId: 'member-alice' as const,
    membershipRevision: 9,
    role,
  };
  return {
    dispose: jest.fn(),
    getManagerResponsibilityOffer: jest.fn<
      ReturnType<CloudPendingLeaveAuthorityClientPort['getManagerResponsibilityOffer']>,
      Parameters<CloudPendingLeaveAuthorityClientPort['getManagerResponsibilityOffer']>
    >(),
    leaveProject: jest.fn(async (
      ..._args: Parameters<CloudPendingLeaveAuthorityClientPort['leaveProject']>
    ): Promise<Awaited<ReturnType<CloudPendingLeaveAuthorityClientPort['leaveProject']>>> => ({
      discardedRequestId: null,
      leftAt: '2026-08-13T00:00:00.000Z',
      managerSetGeneration: 8,
      memberId: 'member-alice',
      projectId: 'project-alpha',
      promotedSuccessorMemberId: null,
      status: 'left' as const,
    })),
    listProjectMembers: jest.fn(async (
      ..._args: Parameters<CloudPendingLeaveAuthorityClientPort['listProjectMembers']>
    ): Promise<Awaited<ReturnType<CloudPendingLeaveAuthorityClientPort['listProjectMembers']>>> => ({
      managerSetGeneration: 7,
      members: role === 'manager'
        ? [member, {
          ...member,
          displayName: 'Bob',
          memberId: 'member-bob',
          membershipRevision: 5,
          role: 'member' as const,
        }]
        : [member, {
          ...member,
          displayName: 'Manager',
          memberId: 'member-manager',
          membershipRevision: 3,
          role: 'manager' as const,
        }],
      projectId: 'project-alpha',
    })),
    readPersonalRefOid: jest.fn(async (
      ..._args: Parameters<CloudPendingLeaveAuthorityClientPort['readPersonalRefOid']>
    ) => 'b'.repeat(40)),
    readSnapshot: jest.fn(async (
      ..._args: Parameters<CloudPendingLeaveAuthorityClientPort['readSnapshot']>
    ) => cloudSnapshot(role)),
  };
}
