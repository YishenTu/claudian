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
import type { CollabCloudProjectSnapshot, CollabProjectSnapshot } from '@/core/collab';

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
  it('restores from an exact recovery receipt without transfer status and preserves the local folder', async () => {
    let membership: CollabLocalMembershipRecord = { ...lanMembership(), hostOwnership: { autoStart: false, ownsAuthority: false } };
    const original = membership;
    const convergence = new AuthorityTransferLocalConvergence({
      settleLocalAuthorityAdvance: async () => undefined,
      activity: { transitionProject: async (_id, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate: async () => undefined },
      projects: { loadMembership: async () => membership, saveMembership: async next => { membership = next; },
        repairIndexFromMemberships: async () => ({ projects: [{ ...membership.project, authorityKind: membership.authority.kind }] as never,
          schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION, selectedProjectId: PROJECT_ID }) },
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const identity = { authorityGeneration: 4, project: { id: PROJECT_ID, name: 'Convergence' },
      currentMember: snapshot('cloud').currentMember, eventSequence: 12 };
    const record = { variant: 'project-recovery', projectId: PROJECT_ID, memberId: original.member.id,
      memberPersonalRef: original.member.personalRef, retainedAttempts: [], redemptionReceipt: { memberId: original.member.id },
      invitation: { link: { authorityGeneration: 4 } }, convergence: null } as never;
    const plan = await convergence.prepareProjectRecovery(record, { target: { kind: 'cloud', serverUrl: 'https://cloud.example.test/' }, identity });
    await convergence.restoreProjectRecovery({ ...record as object, convergence: plan } as never);
    expect(membership.project).toEqual(original.project);
    expect(membership.member).toMatchObject({ id: original.member.id, personalRef: original.member.personalRef });
    expect(membership.authority).toMatchObject({ kind: 'cloud', authorityGeneration: 4, serverUrl: 'https://cloud.example.test/' });
    await convergence.restoreProjectRecovery({ ...record as object, convergence: plan } as never);
  });

  it('retries requester settlement after the Cloud membership and index have converged', async () => {
    let membership = lanMembership();
    let settlementAvailable = false;
    let settledGeneration: number | null = null;
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: async (_id, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate: async () => undefined },
      projects: { loadMembership: async () => membership, saveMembership: async next => { membership = next; },
        repairIndexFromMemberships: async () => ({ projects: [{ ...membership.project, authorityKind: membership.authority.kind }] as never,
          schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION, selectedProjectId: PROJECT_ID }) },
      settleLocalAuthorityAdvance: async identity => {
        if (!settlementAvailable) throw new Error('requester storage unavailable');
        settledGeneration = identity.authorityGeneration;
      },
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const input = { status: completed('lan-to-cloud'), snapshot: snapshot('cloud') };
    await expect(convergence.lanToCloudHost(input)).rejects.toThrow('requester storage unavailable');
    expect(membership.authority).toMatchObject({ kind: 'cloud', authorityGeneration: 2 });
    settlementAvailable = true;
    await convergence.lanToCloudHost(input);
    expect(settledGeneration).toBe(2);
  });

  it.each(['lan', 'cloud'] as const)('restores an older %s membership directly to the current Cloud generation', async kind => {
    const local = { ...lanMembership(), hostOwnership: { ownsAuthority: false } };
    let membership: CollabLocalMembershipRecord = kind === 'lan' ? local : {
      ...local,
      authority: {
        authorityGeneration: 1, kind: 'cloud', bindingVersion: 10, wireVersion: 15,
        serverUrl: 'https://old-cloud.example.test/',
        gitRemoteUrl: `https://old-cloud.example.test/v10/projects/${PROJECT_ID}/repository.git`,
      },
      member: snapshot('cloud').currentMember,
    };
    const rotate = jest.fn(async () => undefined);
    const convergence = new AuthorityTransferLocalConvergence({
      settleLocalAuthorityAdvance: async () => undefined,
      activity: { transitionProject: async (_projectId, operation) => operation() },
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      git: { rotate },
      projects: {
        loadMembership: async () => membership,
        saveMembership: async next => { membership = next; },
        repairIndexFromMemberships: async () => ({
          projects: [{ ...membership.project, authorityKind: membership.authority.kind }] as never,
          schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION, selectedProjectId: PROJECT_ID,
        }),
      },
      workspace: { resolveManagedProjectPath: async () => '/vault/workspace/convergence' },
    });
    const targetSnapshot = snapshot('cloud') as CollabCloudProjectSnapshot;
    const status = completed('lan-to-cloud');
    await convergence.restoreCloudMembership({
      snapshot: { ...targetSnapshot, project: { ...targetSnapshot.project, authorityGeneration: 4 } },
      status: { ...status, sourceAuthority: { generation: 3, kind: 'lan' }, targetAuthority: { generation: 4, kind: 'cloud' } },
    });
    expect(membership).toMatchObject({
      authority: { authorityGeneration: 4, kind: 'cloud' },
      member: { id: local.member.id, personalRef: local.member.personalRef },
      project: local.project,
    });
    expect(rotate).toHaveBeenCalledWith(expect.objectContaining({ repositoryPath: '/vault/workspace/convergence' }));
  });

  it('holds the shared authority projection lane across origin and membership convergence', async () => {
    let membership = lanMembership();
    let releaseRotate!: () => void;
    let signalRotateStarted!: () => void;
    const observedRotate = new Promise<void>(resolve => { signalRotateStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseRotate = resolve; });
    const authorityProjectionTransitions = new AuthorityProjectionTransitionCoordinator();
    const convergence = new AuthorityTransferLocalConvergence({
      settleLocalAuthorityAdvance: async () => undefined,
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
      settleLocalAuthorityAdvance: async () => undefined,
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
        bindingVersion: 10,
        kind: 'cloud',
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 15,
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
      settleLocalAuthorityAdvance: async () => undefined,
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
        bindingVersion: 10,
        kind: 'cloud',
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 15,
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
        bindingVersion: 10 as const,
        gitRemoteUrl: `https://cloud.example.test/v10/projects/${PROJECT_ID}/repository.git`,
        kind: 'cloud' as const,
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 15 as const,
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
      settleLocalAuthorityAdvance: async () => undefined,
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

    const convergeHost = (candidate: typeof input) => convergence.cloudToLanHost({
      ...candidate,
      withEndpoint: operation => operation(candidate.endpoint),
    });
    await convergeHost(input);

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
    await expect(convergeHost(input)).resolves.toBeUndefined();
    expect(membership).toMatchObject({
      hostOwnership: { autoStart: false, ownsAuthority: true },
    });

    const relocated = { ...input, endpoint: 'https://192.168.2.20:54546' };
    await expect(convergeHost(relocated)).resolves.toBeUndefined();
    expect(membership).toMatchObject({
      authority: {
        authorityGeneration: 2,
        endpoint: 'https://192.168.2.20:54546',
        gitRemoteUrl: `https://192.168.2.20:54546/v1/git/${PROJECT_ID}/repository.git`,
        hostCaFingerprint: 'e'.repeat(64),
      },
      hostOwnership: { autoStart: false, ownsAuthority: true },
      member: { credential: memberCredential, id: 'member-host' },
    });

    membership = {
      ...membership,
      hostOwnership: { ownsAuthority: true },
    } as CollabLocalMembershipRecord;
    await expect(convergeHost(relocated)).rejects.toMatchObject({
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
      settleLocalAuthorityAdvance: async () => undefined,
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
        bindingVersion: 10 as const,
        gitRemoteUrl: `https://cloud.example.test/v10/projects/${PROJECT_ID}/repository.git`,
        kind: 'cloud' as const,
        serverUrl: 'https://cloud.example.test/',
        wireVersion: 15 as const,
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
      settleLocalAuthorityAdvance: async () => undefined,
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
      authority: {
        ...membership.authority, authorityGeneration: 2,
        endpoint: 'https://192.168.2.20:54546',
        gitRemoteUrl: `https://192.168.2.20:54546/v1/git/${PROJECT_ID}/repository.git`,
      },
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
