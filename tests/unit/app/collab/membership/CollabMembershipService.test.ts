import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { decodeCloudManagementIntent } from '@/app/collab/membership/CloudManagementIntent';
import {
  type CollabMembershipSafetyContext,
  CollabMembershipService,
  type CollabMembershipSnapshotPort,
} from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import type {
  CollabAuthorityMembershipOperation,
  CollabAuthorityMembershipRouterPort,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import { type CollabCloudProjectSnapshot, type CollabCoordinationSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

function lanSnapshotPort(
  readCoordinationSnapshot = jest.fn(),
): jest.Mocked<CollabMembershipSnapshotPort> {
  return {
    readAuthoritySnapshot: jest.fn().mockRejectedValue(new Error('Unexpected Cloud authority read')),
    readCoordinationSnapshot,
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

type TestMembershipControl = jest.Mocked<CollabAuthorityMembershipRouterPort> & {
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
    cloudMembership: jest.fn(() => Promise.reject(new Error('Unexpected Cloud operation'))),
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
    cloudManagementAdmission: async (_projectId, operation) => operation(),
    projects,
    managerResponsibilityAdmission: async (_projectId, operation) => operation(),
    managerReceipts: {
      load: jest.fn(async () => null),
      remove: jest.fn(async () => false),
      save: jest.fn(async () => undefined),
      saveCloud: jest.fn(async () => undefined),
    },
    managerResponsibilityOperations: new ManagerResponsibilityOperationCoordinator(),
    pendingLeaves: { load: jest.fn(async () => null) },
    ...overrides,
  };
}

let projects: CollabLocalProjectRepository;
let vaultRoot: string;
beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-membership-service-'));
  projects = new CollabLocalProjectRepository(vaultRoot);
});
afterEach(async () => { await rm(vaultRoot, { recursive: true, force: true }); });

describe('CollabMembershipService', () => {
  it('admits Cloud management creation, recovery, and completion through the Project lifecycle', async () => {
    await projects.saveMembership({
      authority: {
        authorityGeneration: 7,
        bindingVersion: 4,
        gitRemoteUrl: 'https://cloud.example/v4/projects/project-alpha/repository.git',
        kind: 'cloud',
        serverUrl: 'https://cloud.example',
        wireVersion: 8,
      },
      createdAt: CREATED_AT,
      lastEventSequence: 7,
      lifecycle: 'active',
      member: {
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
      },
      project: {
        id: 'project-alpha',
        name: 'Alpha',
        workspacePath: 'Projects/alpha',
      },
      schemaVersion: 3,
      updatedAt: CREATED_AT,
    });
    const lifecycleError = new CollabError({
      code: 'durable-progress-recovery-required',
      recoveryActions: ['resume'],
      safeContext: { reason: 'lifecycle-owner-pending' },
    });
    const cloudManagementAdmission = jest.fn().mockRejectedValue(lifecycleError);
    const context = {
      ...safetyContext(),
      cloudManagementAdmission,
    };
    const control = client();
    const service = new CollabMembershipService(
      control,
      lanSnapshotPort(),
      {},
      context,
    );

    await expect(service.createInvitation('project-alpha')).rejects.toBe(lifecycleError);

    await projects.saveProjectDocument(
      'project-alpha',
      'cloud-management-intent',
      decodeCloudManagementIntent({
        authorityGeneration: 7,
        completionId: 'completion-pending',
        createdAt: CREATED_AT,
        kind: 'cloud-management-intent',
        memberId: 'member-manager',
        operation: 'demoteManager',
        phase: 'submitted',
        projectId: 'project-alpha',
        request: {
          expectedManagerSetGeneration: 4,
          expectedTargetMembershipRevision: 2,
          idempotencyKey: 'demote-private',
          projectId: 'project-alpha',
          targetMemberId: 'member-target',
        },
        response: null,
        schemaVersion: 1,
        serverUrl: 'https://cloud.example',
        updatedAt: CREATED_AT,
      }),
    );
    await expect(service.resumeManagementOperation('project-alpha')).rejects.toBe(lifecycleError);

    await projects.saveProjectDocument(
      'project-alpha',
      'cloud-management-intent',
      decodeCloudManagementIntent({
        authorityGeneration: 7,
        completionId: 'completion-retained',
        createdAt: CREATED_AT,
        kind: 'cloud-management-intent',
        memberId: 'member-manager',
        operation: 'demoteManager',
        phase: 'result-retained',
        projectId: 'project-alpha',
        request: {
          expectedManagerSetGeneration: 4,
          expectedTargetMembershipRevision: 2,
          idempotencyKey: 'demote-private',
          projectId: 'project-alpha',
          targetMemberId: 'member-target',
        },
        response: {
          demotedMemberId: 'member-target',
          managerSetGeneration: 5,
          membershipRevision: 3,
          projectId: 'project-alpha',
        },
        schemaVersion: 1,
        serverUrl: 'https://cloud.example',
        updatedAt: CREATED_AT,
      }),
    );
    await expect(service.completeManagementOperation({
      completionId: 'completion-retained',
      projectId: 'project-alpha',
    })).rejects.toBe(lifecycleError);

    expect(cloudManagementAdmission.mock.calls.map(([projectId]) => projectId))
      .toEqual(['project-alpha', 'project-alpha', 'project-alpha']);
    expect(control.cloudMembership).not.toHaveBeenCalled();
    await expect(service.readManagementOperation('project-alpha')).resolves.toMatchObject({
      completionId: 'completion-retained',
    });
  });

  it('retains the same frozen Cloud mutation after repeated synchronized stale rejections', async () => {
    await projects.saveMembership({
      authority: {
        authorityGeneration: 7,
        bindingVersion: 4,
        gitRemoteUrl: 'https://cloud.example/v4/projects/project-alpha/repository.git',
        kind: 'cloud',
        serverUrl: 'https://cloud.example',
        wireVersion: 8,
      },
      createdAt: CREATED_AT,
      lastEventSequence: 7,
      lifecycle: 'active',
      member: {
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
      },
      project: {
        id: 'project-alpha',
        name: 'Alpha',
        workspacePath: 'Projects/alpha',
      },
      schemaVersion: 3,
      updatedAt: CREATED_AT,
    });
    const currentMember = {
      activatedAt: CREATED_AT,
      createdAt: CREATED_AT,
      displayName: 'Manager',
      id: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      role: 'manager' as const,
      status: 'active' as const,
    };
    const cloudProjection: CollabCoordinationSnapshot = {
      snapshot: {
        currentMember,
        eventSequence: 7,
        members: [currentMember],
        openRequests: [],
        openTicketCount: 0,
        project: {
          authorityGeneration: 7,
          authorityKind: 'cloud',
          createdAt: CREATED_AT,
          id: 'project-alpha',
          mainOid: 'a'.repeat(40),
          mainRef: 'refs/heads/main',
          name: 'Alpha',
        },
        ticketHighlights: [],
      },
      source: 'online',
      stale: false,
      syncState: {
        eventSequence: 7,
        generation: 1,
        projectId: 'project-alpha',
        status: 'synchronized',
      },
    };
    const members = {
      managerSetGeneration: 4,
      members: [{
        bindingState: 'bound',
        displayName: 'Manager',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable',
        memberId: 'member-manager',
        membershipRevision: 3,
        role: 'manager',
      }, {
        bindingState: 'bound',
        displayName: 'Target',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable',
        memberId: 'member-target',
        membershipRevision: 5,
        role: 'manager',
      }],
      projectId: 'project-alpha',
    };
    const submittedKeys: string[] = [];
    const control = client();
    (control.cloudMembership as jest.Mock).mockImplementation(async (operation, request) => {
      if (operation === 'listProjectMembers') return members;
      if (operation !== 'demoteManager') throw new Error(`Unexpected ${String(operation)}`);
      submittedKeys.push(request.idempotencyKey);
      throw new CloudAuthorityRejection({ code: 'authority-not-synchronized' });
    });
    let keySequence = 0;
    const snapshots: jest.Mocked<CollabMembershipSnapshotPort> = {
      readAuthoritySnapshot: jest.fn().mockResolvedValue(cloudProjection),
      readCoordinationSnapshot: jest.fn().mockResolvedValue(cloudProjection),
    };
    const service = new CollabMembershipService(control, snapshots, {
      createIdempotencyKey: kind => `${kind}-${++keySequence}`,
    }, safetyContext());
    const request = {
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    } as const;

    await expect(service.demoteManager(request)).rejects.toMatchObject({
      result: { status: 'recovery-required' },
    });
    const resumedError = await service.resumeManagementOperation('project-alpha')
      .catch(error => error);
    expect(resumedError).toBeInstanceOf(Error);
    expect(resumedError).toHaveProperty('result', expect.objectContaining({
      durableProgress: true,
      status: 'recovery-required',
    }));
    await expect(service.readManagementOperation('project-alpha')).resolves.toMatchObject({
      action: 'demote-manager',
      status: 'pending',
    });
    await expect(service.demoteManager(request)).rejects.toMatchObject({
      result: { status: 'recovery-required' },
    });
    expect(submittedKeys).toEqual([
      'demote-manager-1',
      'demote-manager-1',
      'demote-manager-1',
    ]);
    expect(keySequence).toBe(1);
  });

  it('compare-and-removes only the exact retained Cloud management result', async () => {
    await projects.saveMembership({
      authority: {
        authorityGeneration: 7,
        bindingVersion: 4,
        gitRemoteUrl: 'https://cloud.example/v4/projects/project-alpha/repository.git',
        kind: 'cloud',
        serverUrl: 'https://cloud.example',
        wireVersion: 8,
      },
      createdAt: CREATED_AT,
      lastEventSequence: 7,
      lifecycle: 'active',
      member: {
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
      },
      project: {
        id: 'project-alpha',
        name: 'Alpha',
        workspacePath: 'Projects/alpha',
      },
      schemaVersion: 3,
      updatedAt: CREATED_AT,
    });
    const retained = (completionId: string, invitationId: string) => (
      decodeCloudManagementIntent({
        authorityGeneration: 7,
        completionId,
        createdAt: '2099-09-02T00:00:00.000Z',
        kind: 'cloud-management-intent',
        memberId: 'member-manager',
        operation: 'createProjectInvitation',
        phase: 'result-retained',
        projectId: 'project-alpha',
        request: {
          expectedManagerSetGeneration: 4,
          idempotencyKey: `private-${invitationId}`,
          projectId: 'project-alpha',
        },
        response: {
          createdAt: '2099-09-02T00:00:00.000Z',
          expiresAt: '2099-09-03T00:00:00.000Z',
          invitationId,
          issuedState: 'active',
          projectId: 'project-alpha',
          secret: 'A'.repeat(43),
          secretReplayExpiresAt: '2099-10-02T00:00:00.000Z',
        },
        schemaVersion: 1,
        serverUrl: 'https://cloud.example',
        updatedAt: '2099-09-02T00:00:00.000Z',
      })
    );
    const service = new CollabMembershipService(
      client(),
      lanSnapshotPort(),
      {},
      safetyContext(),
    );
    await projects.saveProjectDocument(
      'project-alpha',
      'cloud-management-intent',
      retained('completion-old', 'invitation-old'),
    );
    const oldView = await service.readManagementOperation('project-alpha');
    expect(oldView).toMatchObject({
      completionId: 'completion-old',
      secretAvailableUntil: '2099-09-03T00:00:00.000Z',
    });

    await projects.saveProjectDocument(
      'project-alpha',
      'cloud-management-intent',
      retained('completion-new', 'invitation-new'),
    );
    await expect(service.completeManagementOperation({
      completionId: oldView!.completionId,
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'cloud-management-completion-mismatch' },
    });
    await expect(service.readManagementOperation('project-alpha')).resolves.toMatchObject({
      completionId: 'completion-new',
      status: 'result-retained',
    });

    await service.completeManagementOperation({
      completionId: 'completion-new',
      projectId: 'project-alpha',
    });
    await expect(service.readManagementOperation('project-alpha')).resolves.toBeNull();
  });

  it.each([
    {
      completionId: 'completion-expired-invitation',
      operation: 'createProjectInvitation' as const,
      request: {
        expectedManagerSetGeneration: 4,
        idempotencyKey: 'private-expired-invitation',
        projectId: 'project-alpha',
      },
      response: {
        createdAt: '2020-09-02T00:00:00.000Z',
        expiresAt: '2020-09-03T00:00:00.000Z',
        invitationId: 'invitation-expired',
        issuedState: 'active' as const,
        projectId: 'project-alpha',
        secret: 'A'.repeat(43),
        secretReplayExpiresAt: '2020-10-02T00:00:00.000Z',
      },
      secretAvailableUntil: '2020-09-03T00:00:00.000Z',
    },
    {
      completionId: 'completion-expired-claim',
      operation: 'reissueTransferredMembershipClaim' as const,
      request: {
        expectedClaimGeneration: 3,
        expectedManagerSetGeneration: 4,
        expectedMembershipRevision: 2,
        idempotencyKey: 'private-expired-claim',
        memberId: 'member-imported',
        projectId: 'project-alpha',
      },
      response: {
        claim: `${'B'.repeat(42)}A`,
        claimGeneration: 4,
        createdAt: '2020-09-02T00:00:00.000Z',
        expiresAt: '2020-10-02T00:00:00.000Z',
        memberId: 'member-imported',
        projectId: 'project-alpha',
        secretReplayExpiresAt: '2020-10-02T00:00:00.000Z',
        targetAuthorityGeneration: 7,
        transferId: 'transfer-imported',
      },
      secretAvailableUntil: '2020-10-02T00:00:00.000Z',
    },
  ])('retains an expired $operation result until exact completion', async fixture => {
    await projects.saveMembership({
      authority: {
        authorityGeneration: 7,
        bindingVersion: 4,
        gitRemoteUrl: 'https://cloud.example/v4/projects/project-alpha/repository.git',
        kind: 'cloud',
        serverUrl: 'https://cloud.example',
        wireVersion: 8,
      },
      createdAt: CREATED_AT,
      lastEventSequence: 7,
      lifecycle: 'active',
      member: {
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
      },
      project: {
        id: 'project-alpha',
        name: 'Alpha',
        workspacePath: 'Projects/alpha',
      },
      schemaVersion: 3,
      updatedAt: CREATED_AT,
    });
    const retained = decodeCloudManagementIntent({
      authorityGeneration: 7,
      completionId: fixture.completionId,
      createdAt: '2020-09-02T00:00:00.000Z',
      kind: 'cloud-management-intent',
      memberId: 'member-manager',
      operation: fixture.operation,
      phase: 'result-retained',
      projectId: 'project-alpha',
      request: fixture.request,
      response: fixture.response,
      schemaVersion: 1,
      serverUrl: 'https://cloud.example',
      updatedAt: '2020-09-02T00:00:00.000Z',
    });
    await projects.saveProjectDocument(
      'project-alpha',
      'cloud-management-intent',
      retained,
    );
    const service = new CollabMembershipService(
      client(),
      lanSnapshotPort(),
      {},
      safetyContext(),
    );

    await expect(service.readManagementOperation('project-alpha')).resolves.toMatchObject({
      completionId: fixture.completionId,
      invitation: null,
      secretAvailableUntil: fixture.secretAvailableUntil,
      status: 'result-retained',
    });
    const replay = fixture.operation === 'createProjectInvitation'
      ? service.createInvitation('project-alpha')
      : service.reissueMemberClaim({
        memberId: 'member-imported',
        projectId: 'project-alpha',
      });
    await expect(replay).rejects.toMatchObject({
      result: {
        error: { code: 'invitation-expired' },
        status: 'recovery-required',
      },
    });
    await expect(service.completeManagementOperation({
      completionId: 'completion-stale',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      safeContext: { reason: 'cloud-management-completion-mismatch' },
    });
    await expect(service.readManagementOperation('project-alpha')).resolves.toMatchObject({
      completionId: fixture.completionId,
      invitation: null,
      status: 'result-retained',
    });

    await service.completeManagementOperation({
      completionId: fixture.completionId,
      projectId: 'project-alpha',
    });
    await expect(service.readManagementOperation('project-alpha')).resolves.toBeNull();
  });

  it('declines a Cloud responsibility against a pending Leave and replays the exact submitted request', async () => {
    await projects.saveMembership({
      schemaVersion: 3,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      lastEventSequence: 7,
      authority: {
        authorityGeneration: 7,
        bindingVersion: 4,
        gitRemoteUrl: 'https://cloud.example/v4/projects/project-alpha/repository.git',
        kind: 'cloud',
        serverUrl: 'https://cloud.example',
        wireVersion: 8,
      },
      member: {
        id: 'member-target',
        displayName: 'Target',
        role: 'member',
        personalRef: 'refs/heads/members/member-target',
      },
      project: { id: 'project-alpha', name: 'Alpha', workspacePath: 'Projects/alpha' },
    });
    const snapshot: CollabCloudProjectSnapshot = {
      currentMember: {
        activatedAt: CREATED_AT, createdAt: CREATED_AT, displayName: 'Target', id: 'member-target',
        personalRef: 'refs/heads/members/member-target', role: 'member', status: 'active',
      },
      eventSequence: 7,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 7, authorityKind: 'cloud', createdAt: CREATED_AT, id: 'project-alpha',
        mainOid: 'a'.repeat(40), mainRef: 'refs/heads/main', name: 'Alpha',
      },
      ticketHighlights: [],
    };
    const offered = {
      acknowledgedAt: null,
      expiresAt: '2026-08-09T00:00:00.000Z',
      managerSetGenerationAtOffer: 4,
      offeredAt: CREATED_AT,
      offerId: 'offer-cloud',
      purpose: 'manager-leave' as const,
      revision: 2,
      sourceManagerMemberId: 'member-source',
      state: 'offered' as const,
      targetMemberId: 'member-target',
      targetMembershipRevisionAtOffer: 3,
      terminalAt: null,
    };
    const submitted: unknown[] = [];
    let receipt: Parameters<NonNullable<CollabMembershipSafetyContext['managerReceipts']>['saveCloud']>[0] | null = null;
    const control = client();
    (control.cloudMembership as jest.Mock).mockImplementation(async (operation, input) => {
      if (operation === 'listCurrentManagerResponsibilityOffers') {
        return { offers: [offered], projectId: 'project-alpha' };
      }
      if (operation !== 'declineManagerResponsibility') throw new Error(`Unexpected ${String(operation)}`);
      expect(receipt).toMatchObject({ phase: 'submitted', request: input });
      submitted.push(input);
      if (submitted.length === 1) throw new CollabError({ code: 'endpoint-unreachable' });
      return { offer: { ...offered, revision: 3, state: 'declined', terminalAt: CREATED_AT } };
    });
    const receipts = {
      load: jest.fn(async () => receipt),
      remove: jest.fn(async () => { receipt = null; return true; }),
      save: jest.fn(async () => undefined),
      saveCloud: jest.fn(async value => { receipt = value; }),
    };
    const context = safetyContext({
      managerReceipts: receipts,
      pendingLeaves: { load: jest.fn(async () => ({ phase: 'queued' })) },
    });
    const first = new CollabMembershipService(control, lanSnapshotPort(), {}, context);

    await expect(first.reconcileManagerResponsibilitySnapshot(snapshot))
      .rejects.toMatchObject({ code: 'endpoint-unreachable' });
    const frozen = receipt;
    expect(frozen).toMatchObject({ phase: 'submitted', operation: 'declineManagerResponsibility' });

    const restarted = new CollabMembershipService(control, lanSnapshotPort(), {}, context);
    const membership = await projects.loadMembership('project-alpha');
    if (!membership || membership.authority.kind !== 'cloud') throw new Error('Expected Cloud membership');
    await projects.saveMembership({
      ...membership,
      authority: {
        ...membership.authority,
        gitRemoteUrl: 'https://other.example/v4/projects/project-alpha/repository.git',
        serverUrl: 'https://other.example',
      },
    });
    await expect(restarted.reconcileManagerResponsibilitySnapshot(snapshot))
      .rejects.toMatchObject({ code: 'authority-integrity-error' });
    expect(receipt).toBe(frozen);
    await projects.saveMembership(membership);
    await expect(restarted.reconcileManagerResponsibilitySnapshot(snapshot)).resolves.toBeNull();
    expect(submitted).toEqual([
      expect.objectContaining({ projectId: 'project-alpha', offerId: 'offer-cloud', expectedOfferRevision: 2 }),
      submitted[0],
    ]);
    expect(receipt).toBeNull();
    expect(control.operations.acknowledgeManagerResponsibility).not.toHaveBeenCalled();
  });

  it('routes invitations through shared authority control', async () => {
    const snapshot = lanSnapshotPort(jest.fn().mockResolvedValue(coordination()));
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
    const snapshot = lanSnapshotPort(jest.fn().mockResolvedValue(coordination()));
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
    const snapshot = lanSnapshotPort(jest.fn().mockResolvedValue(coordination()));
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

  it('reuses an application-owned LAN administration key after a lost response', async () => {
    const control = client();
    control.operations.demoteManager
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValueOnce({
        demotedMemberId: 'member-a',
        managerSetGeneration: 2,
        projectId: 'project-alpha',
      });
    const createIdempotencyKey = jest.fn((kind: string) => `${kind}-generated`);
    const service = new CollabMembershipService(control,
      lanSnapshotPort(jest.fn().mockResolvedValue(coordination())), {
      createIdempotencyKey,
    }, safetyContext());
    const request = {
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    } as const;

    await expect(service.demoteManager(request)).rejects.toMatchObject({
      code: 'endpoint-unreachable',
    });
    await expect(service.demoteManager(request)).resolves.toBeUndefined();

    expect(control.operations.demoteManager.mock.calls.map(([input]) => input.idempotencyKey))
      .toEqual([
        'demote-manager-generated',
        'demote-manager-generated',
      ]);
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('requires explicit project-scoped abandonment before replacing an uncertain LAN administration intent', async () => {
    const control = client();
    control.operations.demoteManager.mockRejectedValue(new CollabError({ code: 'endpoint-unreachable' }));
    const service = new CollabMembershipService(
      control,
      lanSnapshotPort(jest.fn().mockResolvedValue(coordination())), {
      createIdempotencyKey: kind => `${kind}-private`,
      }, safetyContext(),
    );

    await expect(service.demoteManager({ projectId: 'project-alpha', targetMemberId: 'member-a' }))
      .rejects.toMatchObject({ code: 'endpoint-unreachable' });
    await expect(service.removeMember({ projectId: 'project-alpha', memberId: 'member-a' }))
      .rejects.toMatchObject({ safeContext: { reason: 'lan-management-operation-pending' } });
    expect(control.operations.removeMember).not.toHaveBeenCalled();

    await service.completeManagementOperation({ projectId: 'project-alpha' });
    await expect(service.removeMember({ projectId: 'project-alpha', memberId: 'member-a' }))
      .resolves.toBeUndefined();
    expect(control.operations.removeMember).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'remove-member-private',
    }), {});
  });

  it('generates each completed LAN administration key inside the application owner', async () => {
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
    const service = new CollabMembershipService(control,
      lanSnapshotPort(jest.fn().mockResolvedValue(coordination())), {
      createIdempotencyKey,
    }, safetyContext());

    await service.createManagerResponsibilityOffer({
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-a',
    });
    await service.promoteManager({
      managerResponsibilityOfferId: 'offer-one',
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

    expect(control.operations.createManagerResponsibilityOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manager-responsibility-offer-generated',
      }),
      {},
    );
    expect(control.operations.promoteManager).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'promote-manager-generated',
    }), {});
    expect(control.operations.demoteManager).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'demote-manager-generated',
    }), {});
    expect(control.operations.removeMember).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'remove-member-generated',
    }), {});
    expect(createIdempotencyKey).toHaveBeenCalledTimes(4);
  });

  it('propagates shared authority control failures', async () => {
    const control = client();
    control.operations.removeMember.mockRejectedValue(new CollabError({ code: 'host-stopped' }));
    const service = new CollabMembershipService(control, lanSnapshotPort(), {}, safetyContext());

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
      saveCloud: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(control, lanSnapshotPort(), {}, safetyContext({
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
      saveCloud: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(
      control,
      lanSnapshotPort(),
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
      saveCloud: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(
      control,
      lanSnapshotPort(),
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
      saveCloud: jest.fn(async () => undefined),
    };
    const service = new CollabMembershipService(
      client(),
      lanSnapshotPort(),
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
      lanSnapshotPort(),
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
