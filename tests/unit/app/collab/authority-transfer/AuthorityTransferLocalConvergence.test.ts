import type {
  CollabAuthorityTransferStatus,
} from '@claudian-collab/protocol';

import { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import type {
  AuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { AuthorityProjectionTransitionCoordinator } from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import type {
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { CollabProjectSnapshot } from '@/core/collab';

const PROJECT_ID = 'project-convergence';
const CREATED_AT = '2026-08-27T00:00:00.000Z';

function completed(direction: 'cloud-to-lan' | 'lan-to-cloud'): CollabAuthorityTransferStatus {
  const sourceKind = direction === 'lan-to-cloud' ? 'lan' : 'cloud';
  const targetKind = direction === 'lan-to-cloud' ? 'cloud' : 'lan';
  return {
    batchRevision: 1,
    batchSha256: 'b'.repeat(64),
    checkpointSha256: 'a'.repeat(64),
    createdAt: CREATED_AT,
    direction,
    expiresAt: '2026-09-26T00:00:00.000Z',
    phase: 'completed',
    projectId: PROJECT_ID,
    relinquishmentProof: {
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
      certificate: Buffer.alloc(64, 2).toString('base64url'),
      certificateAlgorithm: 'ed25519',
      checkpointSha256: 'a'.repeat(64),
      committedAt: '2026-08-27T00:00:08.000Z',
      operationIntentId: 'intent-convergence',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 1, kind: sourceKind },
      sourceHostMemberId: sourceKind === 'lan' ? 'member-host' : null,
      targetAuthority: { generation: 2, kind: targetKind },
      transferId: 'transfer-convergence',
    } as never,
    sourceAuthority: { generation: 1, kind: sourceKind },
    state: 'completed',
    targetAuthority: { generation: 2, kind: targetKind },
    targetUrl: direction === 'lan-to-cloud'
      ? 'https://cloud.example.test/'
      : 'https://192.168.1.20:54545/',
    transferId: 'transfer-convergence',
    updatedAt: '2026-08-27T00:00:10.000Z',
  };
}

function snapshot(authorityKind: 'cloud' | 'lan'): CollabProjectSnapshot {
  const member = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Host',
    id: 'member-host',
    personalRef: 'refs/heads/members/member-host',
    role: 'manager' as const,
    status: 'active' as const,
  };
  return {
    currentMember: member,
    eventSequence: 5,
    members: [member],
    openRequests: [],
    openTicketCount: 0,
    project: {
      ...(authorityKind === 'cloud' ? { authorityGeneration: 2 } : {}),
      authorityKind,
      createdAt: CREATED_AT,
      id: PROJECT_ID,
      mainOid: 'c'.repeat(40),
      mainRef: 'refs/heads/main',
      managerSetGeneration: 1,
      name: 'Convergence',
    },
    ticketHighlights: [],
  } as CollabProjectSnapshot;
}

function lanMembership(): CollabLocalMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: `https://192.168.1.10:54545/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'd'.repeat(64),
      kind: 'lan',
    },
    createdAt: CREATED_AT,
    hostOwnership: { autoStart: true, ownsAuthority: true },
    lastEventSequence: 1,
    member: {
      credential: Buffer.alloc(32, 1).toString('base64url'),
      displayName: 'Host',
      id: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Convergence',
      workspacePath: 'workspace/convergence',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

describe('AuthorityTransferLocalConvergence', () => {
  it('holds the shared authority projection lane across origin and membership convergence', async () => {
    let membership = lanMembership();
    let releaseRotate!: () => void;
    let signalRotateStarted!: () => void;
    const observedRotate = new Promise<void>(resolve => { signalRotateStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseRotate = resolve; });
    const authorityProjectionTransitions = new AuthorityProjectionTransitionCoordinator();
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: async (_projectId, operation) => operation() },
      authorityProjectionTransitions,
      git: {
        rotate: jest.fn(async () => {
          signalRotateStarted();
          await release;
        }),
      },
      projects: {
        loadMembership: jest.fn(async () => membership),
        repairIndexFromMemberships: jest.fn(async () => ({
          projects: [{ authorityKind: membership.authority.kind, id: PROJECT_ID }],
          schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
          selectedProjectId: PROJECT_ID,
        })),
        saveMembership: jest.fn(async (next: CollabLocalMembershipRecord) => {
          membership = next;
        }),
      } as never,
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const pendingConvergence = convergence.lanToCloudHost({
      snapshot: snapshot('cloud'),
      status: completed('lan-to-cloud'),
    });
    await observedRotate;
    const competingProjection = jest.fn(async () => undefined);
    const pendingCompetingProjection = authorityProjectionTransitions.run(
      PROJECT_ID,
      competingProjection,
    );

    await Promise.resolve();
    expect(competingProjection).not.toHaveBeenCalled();
    releaseRotate();
    await pendingConvergence;
    await pendingCompetingProjection;
    expect(competingProjection).toHaveBeenCalledTimes(1);
  });

  it('replaces LAN Host membership, origin, index, and work-session projection idempotently', async () => {
    let membership = lanMembership();
    const rotate = jest.fn(async () => undefined);
    const transitionProject = jest.fn(async (
      _projectId: string,
      operation: () => Promise<void>,
    ) => operation());
    const projects = {
      loadMembership: jest.fn(async () => membership),
      repairIndexFromMemberships: jest.fn(async () => ({
        projects: [{ authorityKind: membership.authority.kind, id: PROJECT_ID }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: PROJECT_ID,
      })),
      saveMembership: jest.fn(async (next: CollabLocalMembershipRecord) => {
        membership = next;
      }),
    };
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate },
      now: () => new Date('2026-08-27T00:01:00.000Z'),
      projects: projects as never,
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const input = {
      snapshot: snapshot('cloud'),
      status: completed('lan-to-cloud'),
    };

    await convergence.lanToCloudHost(input);
    await convergence.lanToCloudHost(input);
    await convergence.recoverConvertedClaimant({
      lanTarget: null,
      memberId: 'member-host',
      projectId: PROJECT_ID,
      status: input.status,
      targetCredential: null,
      variant: 'source-issued',
    } as AuthorityTransferClaimantRecord);

    expect(membership).toMatchObject({
      authority: {
        authorityGeneration: 2,
        bindingVersion: 4,
        kind: 'cloud',
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 8,
      },
      lastEventSequence: 5,
      member: { id: 'member-host' },
    });
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(projects.repairIndexFromMemberships).toHaveBeenCalledTimes(3);
    expect(transitionProject).toHaveBeenCalledTimes(3);
  });

  it('converges a completed LAN Host offline from its relinquishment proof', async () => {
    let membership = lanMembership();
    const rotate = jest.fn(async () => undefined);
    const projects = {
      loadMembership: jest.fn(async () => membership),
      repairIndexFromMemberships: jest.fn(async () => ({
        projects: [{ authorityKind: membership.authority.kind, id: PROJECT_ID }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: PROJECT_ID,
      })),
      saveMembership: jest.fn(async (next: CollabLocalMembershipRecord) => {
        membership = next;
      }),
    };
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: async (_projectId, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate },
      projects: projects as never,
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const transferStatus = completed('lan-to-cloud');

    await convergence.lanToCloudHostOffline(transferStatus);
    await convergence.lanToCloudHostOffline(transferStatus);

    expect(membership).toMatchObject({
      authority: {
        authorityGeneration: 2,
        bindingVersion: 4,
        kind: 'cloud',
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 8,
      },
      lastEventSequence: 1,
      member: {
        displayName: 'Host',
        id: 'member-host',
        role: 'manager',
      },
    });
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(projects.repairIndexFromMemberships).toHaveBeenCalledTimes(2);
  });

  it('replaces Cloud target membership with the exact bound LAN Host identity', async () => {
    let membership = {
      ...lanMembership(),
      authority: {
        authorityGeneration: 2,
        bindingVersion: 4 as const,
        gitRemoteUrl: `https://cloud.example.test/v4/projects/${PROJECT_ID}/repository.git`,
        kind: 'cloud' as const,
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 8 as const,
      },
      member: {
        displayName: 'Host',
        id: 'member-host',
        personalRef: 'refs/heads/members/member-host',
        role: 'manager' as const,
      },
    } as CollabLocalMembershipRecord;
    const rotate = jest.fn(async () => undefined);
    const projects = {
      loadMembership: jest.fn(async () => membership),
      repairIndexFromMemberships: jest.fn(async () => ({
        projects: [{ authorityKind: membership.authority.kind, id: PROJECT_ID }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: PROJECT_ID,
      })),
      saveMembership: jest.fn(async (next: CollabLocalMembershipRecord) => {
        membership = next;
      }),
    };
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: async (_projectId, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate },
      projects: projects as never,
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const memberCredential = Buffer.alloc(32, 9).toString('base64url');

    const input = {
      endpoint: 'https://192.168.1.20:54545',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'e'.repeat(64),
      identity: {
        authorityGeneration: 2,
        currentMember: snapshot('lan').currentMember,
        eventSequence: snapshot('lan').eventSequence,
        project: snapshot('lan').project,
      },
      memberCredential,
      status: completed('cloud-to-lan'),
    };

    await convergence.cloudToLanHost(input);

    expect(membership).toMatchObject({
      authority: {
        endpoint: 'https://192.168.1.20:54545',
        kind: 'lan',
      },
      hostOwnership: { autoStart: true, ownsAuthority: true },
      member: { credential: memberCredential, id: 'member-host' },
    });
    expect(rotate).toHaveBeenCalledWith(expect.objectContaining({
      newRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
    }));

    membership = {
      ...membership,
      hostOwnership: { autoStart: false, ownsAuthority: true },
    } as CollabLocalMembershipRecord;
    await expect(convergence.cloudToLanHost(input)).resolves.toBeUndefined();
    expect(membership).toMatchObject({
      hostOwnership: { autoStart: false, ownsAuthority: true },
    });

    membership = {
      ...membership,
      hostOwnership: { ownsAuthority: true },
    } as CollabLocalMembershipRecord;
    await expect(convergence.cloudToLanHost(input)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-lan-membership-conflict' },
    });
  });

  it('converges an offline LAN Member to Cloud without granting Host ownership', async () => {
    let membership = {
      ...lanMembership(),
      hostOwnership: { ownsAuthority: false },
    } as CollabLocalMembershipRecord;
    const projects = {
      loadMembership: jest.fn(async () => membership),
      repairIndexFromMemberships: jest.fn(async () => ({
        projects: [{ authorityKind: membership.authority.kind, id: PROJECT_ID }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: PROJECT_ID,
      })),
      saveMembership: jest.fn(async (next: CollabLocalMembershipRecord) => { membership = next; }),
    };
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: async (_projectId, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate: jest.fn(async () => undefined) },
      projects: projects as never,
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });

    await convergence.lanToCloudMember({
      snapshot: snapshot('cloud'),
      status: completed('lan-to-cloud'),
    });

    expect(membership).toMatchObject({
      authority: { authorityGeneration: 2, kind: 'cloud' },
    });
    expect('hostOwnership' in membership).toBe(false);
  });

  it('converges an offline Cloud Member to LAN with its persisted claimant credential', async () => {
    let membership = {
      ...lanMembership(),
      authority: {
        authorityGeneration: 1,
        bindingVersion: 4 as const,
        gitRemoteUrl: `https://cloud.example.test/v4/projects/${PROJECT_ID}/repository.git`,
        kind: 'cloud' as const,
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 8 as const,
      },
      member: {
        displayName: 'Host',
        id: 'member-host',
        personalRef: 'refs/heads/members/member-host',
        role: 'manager' as const,
      },
    } as CollabLocalMembershipRecord;
    const projects = {
      loadMembership: jest.fn(async () => membership),
      repairIndexFromMemberships: jest.fn(async () => ({
        projects: [{ authorityKind: membership.authority.kind, id: PROJECT_ID }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: PROJECT_ID,
      })),
      saveMembership: jest.fn(async (next: CollabLocalMembershipRecord) => { membership = next; }),
    };
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: async (_projectId, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate: jest.fn(async () => undefined) },
      projects: projects as never,
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const credential = Buffer.alloc(32, 8).toString('base64url');

    await convergence.cloudToLanMember({
      endpoint: 'https://192.168.1.20:54545',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'e'.repeat(64),
      identity: {
        authorityGeneration: 2,
        currentMember: snapshot('lan').currentMember,
        eventSequence: snapshot('lan').eventSequence,
        project: snapshot('lan').project,
      },
      memberCredential: credential,
      status: completed('cloud-to-lan'),
    });
    const claimant = {
      lanTarget: {
        caCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
        caFingerprint: 'e'.repeat(64),
        endpoint: 'https://192.168.1.20:54545',
      },
      memberId: 'member-host',
      projectId: PROJECT_ID,
      status: completed('cloud-to-lan'),
      targetCredential: credential,
      variant: 'source-issued',
    } as AuthorityTransferClaimantRecord;
    membership = {
      ...membership,
      authority: { ...membership.authority, authorityGeneration: 1 },
    } as CollabLocalMembershipRecord;
    await expect(convergence.recoverConvertedClaimant(claimant)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-lan-membership-conflict' },
    });
    membership = {
      ...membership,
      authority: { ...membership.authority, authorityGeneration: 2 },
    } as CollabLocalMembershipRecord;
    await convergence.recoverConvertedClaimant(claimant);

    expect(membership).toMatchObject({
      authority: { kind: 'lan' },
      hostOwnership: { autoStart: false, ownsAuthority: false },
      member: { credential },
    });
    expect(projects.repairIndexFromMemberships).toHaveBeenCalledTimes(2);
  });
});
