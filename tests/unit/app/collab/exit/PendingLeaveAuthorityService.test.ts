import {
  type PendingLeaveAuthorityClientPort,
  PendingLeaveAuthorityService,
} from '@/app/collab/exit/PendingLeaveAuthorityService';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import type { MembershipTerminationResponse } from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabProjectSnapshot } from '@/core/collab';
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
  authorityReplay: PendingLeaveRecord['authorityReplay'] = null,
): PendingLeaveRecord {
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

function snapshot(): CollabProjectSnapshot {
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
