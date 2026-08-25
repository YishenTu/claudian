import {
  createCloudBootstrapTransitionRecord,
  markCloudBootstrapHostStopped,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import {
  LocalCloudBootstrapBindingEffects,
} from '@/app/collab/bootstrap/LocalCloudBootstrapBindingEffects';
import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { CollabAuthorityAdapter } from '@/app/collab/remote-authority/CollabAuthoritySession';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  HOST_MEMBER_ID,
  HOST_OID,
  HOST_REF,
  MAIN_OID,
  MANIFEST_SHA256,
  PROJECT_ID,
} from './fixtures';

function activatedRecord() {
  const pending = createCloudBootstrapTransitionRecord({
    developmentActorId: HOST_MEMBER_ID,
    fenceId: 'bootstrap-fence-one',
    manifest: bootstrapManifest(),
    manifestSha256: MANIFEST_SHA256,
    memberId: HOST_MEMBER_ID,
    oldEndpoint: 'https://192.168.1.20:54545',
    oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
    serverUrl: 'https://cloud.example.test',
    timestamp: '2026-08-21T00:00:01.000Z',
  });
  return observeCloudBootstrapAttemptStatus(markCloudBootstrapHostStopped(
    pending,
    '2026-08-21T00:00:02.000Z',
    '2026-08-21T00:00:02.000Z',
  ), {
    activationPhase: 'completed',
    activationResult: {
      activatedAt: '2026-08-21T00:00:03.000Z',
      activationOperationId: 'activation-one',
      placementGeneration: 1,
      projectId: PROJECT_ID,
    },
    attemptId: ATTEMPT_ID,
    bundleState: 'validated',
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
    manifestSha256: MANIFEST_SHA256,
    projectId: PROJECT_ID,
    reporterMemberIds: [HOST_MEMBER_ID],
    state: 'activated',
  }, '2026-08-21T00:00:03.000Z');
}

function activationStatus(record: ReturnType<typeof activatedRecord>) {
  if (!record.activationResult) throw new Error('Activated fixture result missing');
  return {
    activationPhase: 'completed' as const,
    activationResult: record.activationResult,
    attemptId: record.attemptId,
    bundleState: 'validated' as const,
    createdAt: record.createdAt,
    expiresAt: '2026-08-22T00:00:00.000Z' as const,
    manifestSha256: record.manifestSha256,
    projectId: record.projectId,
    reporterMemberIds: [HOST_MEMBER_ID],
    state: 'activated' as const,
  };
}

describe('LocalCloudBootstrapBindingEffects', () => {
  it('verifies Cloud Git and atomically replaces secret-bearing LAN membership', async () => {
    const record = activatedRecord();
    let membership: CollabLocalMembershipRecord = {
      authority: {
        endpoint: record.oldAuthority.endpoint.replace(/\/$/u, ''),
        gitRemoteUrl: record.oldAuthority.gitRemoteUrl,
        hostCaCertificatePem: 'PRIVATE CA',
        hostCaFingerprint: record.oldAuthority.caFingerprint,
        kind: 'lan',
      },
      createdAt: '2026-08-19T00:00:00.000Z',
      hostOwnership: { autoStart: false, ownsAuthority: true },
      lastEventSequence: 12,
      lifecycle: 'active',
      member: {
        credential: 'A'.repeat(43),
        displayName: 'Alice',
        id: HOST_MEMBER_ID,
        personalRef: HOST_REF,
        role: 'member',
      },
      project: {
        id: PROJECT_ID,
        name: 'Project Alpha',
        workspacePath: 'workspace/project-alpha',
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    const snapshot = {
      currentMember: {
        activatedAt: bootstrapManifest().comparison.members[0].activatedAt,
        createdAt: bootstrapManifest().comparison.members[0].createdAt,
        displayName: 'Alice',
        id: HOST_MEMBER_ID,
        personalRef: HOST_REF,
        role: 'manager' as const,
        status: 'active' as const,
      },
      eventSequence: 18,
      members: bootstrapManifest().comparison.members,
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityKind: 'cloud' as const,
        createdAt: '2026-08-19T00:00:00.000Z',
        id: PROJECT_ID,
        mainOid: MAIN_OID,
        mainRef: 'refs/heads/main' as const,
        name: 'Project Alpha',
      },
      ticketHighlights: [],
    };
    const dispose = jest.fn();
    const adapter = {
      authorityKind: 'cloud' as const,
      create: jest.fn(async () => ({
        authorityKind: 'cloud' as const,
        control: { readSnapshot: jest.fn(async () => snapshot) },
        dispose,
        events: { connect: jest.fn() },
        git: {
          headers: [{ name: 'X-Claudian-Development-Actor', value: HOST_MEMBER_ID }],
          remoteUrl: record.newAuthority.gitRemoteUrl,
        },
        supports: (capability: string) => [
          'git-upload-pack',
          'project-events',
          'project-snapshot',
        ].includes(capability),
      })),
    } as unknown as CollabAuthorityAdapter;
    const fetchFromUrl = jest.fn(async () => undefined);
    const repairIndexFromMemberships = jest.fn(async () => ({
      projects: [{
        authorityKind: 'cloud' as const,
        createdAt: membership.createdAt,
        id: PROJECT_ID,
        lifecycle: 'active' as const,
        name: membership.project.name,
        updatedAt: '2026-08-21T00:02:00.000Z',
        workspacePath: membership.project.workspacePath,
      }],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: PROJECT_ID,
    }));
    const saveMembership = jest.fn(async (next: CollabLocalMembershipRecord) => {
      membership = next;
    });
    const getActivation = jest.fn(async () => activationStatus(record));
    const effects = new LocalCloudBootstrapBindingEffects({
      activation: { get: getActivation },
      authorityAdapter: adapter,
      authorityLifecycle: { closeAuthority: async () => undefined },
      git: {
        assertOrigin: jest.fn(async () => undefined),
        fetchFromUrl,
        network: jest.fn(async (_projectId, git) => ({ headers: git.headers })),
        resolveRefs: jest.fn(async () => new Map([
          ['refs/remotes/origin/main', MAIN_OID],
          ['refs/remotes/origin/members/member-alice', HOST_OID],
        ])),
        rotateOrigin: jest.fn(async () => undefined),
      },
      now: () => new Date('2026-08-21T00:02:00.000Z'),
      projects: {
        loadMembership: jest.fn(async () => membership),
        repairIndexFromMemberships,
        retireAuthorityDirectory: jest.fn(async () => '/retired'),
        saveMembership,
      },
      readiness: { collect: jest.fn(async () => ({
        clientReadiness: {} as never,
        observedPersonalRefOid: HOST_OID,
      })) },
      workspace: { resolveManagedProjectPath: jest.fn(async () => '/vault/workspace/project-alpha') },
    });

    await effects.confirmReadiness(record);
    await effects.verifyCloud(record);
    await effects.verifyActivation(record);
    await effects.replaceMembership(record);
    await effects.replaceMembership(record);
    await effects.repairIndex(record);

    expect(fetchFromUrl).toHaveBeenCalledWith(
      '/vault/workspace/project-alpha',
      record.newAuthority.gitRemoteUrl,
      expect.any(Array),
      {
        headers: [{ name: 'X-Claudian-Development-Actor', value: HOST_MEMBER_ID }],
      },
      undefined,
    );
    expect(membership.authority).toEqual({
      bindingVersion: 2,
      developmentActorId: HOST_MEMBER_ID,
      gitRemoteUrl: record.newAuthority.gitRemoteUrl,
      kind: 'cloud',
      serverUrl: record.newAuthority.serverUrl,
      wireVersion: 5,
    });
    expect(JSON.stringify(membership)).not.toContain('credential');
    expect(JSON.stringify(membership)).not.toContain('PRIVATE CA');
    expect(membership.lastEventSequence).toBe(18);
    expect(membership.member.role).toBe('manager');
    expect(saveMembership).toHaveBeenCalledTimes(2);
    expect(repairIndexFromMemberships).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(3);

    getActivation.mockResolvedValue({
      ...activationStatus(record),
      activationResult: {
        ...record.activationResult!,
        placementGeneration: record.activationResult!.placementGeneration + 1,
      },
    });
    await expect(effects.verifyActivation(record)).rejects.toMatchObject({
      safeContext: { reason: 'cloud-bootstrap-binding-activation-identity-mismatch' },
    });
  });

  it('rejects a tampered post-checkpoint origin before exposing the Cloud actor', async () => {
    const record = activatedRecord();
    const membership: CollabLocalMembershipRecord = {
      authority: {
        endpoint: record.oldAuthority.endpoint,
        gitRemoteUrl: record.oldAuthority.gitRemoteUrl,
        hostCaCertificatePem: 'PRIVATE CA',
        hostCaFingerprint: record.oldAuthority.caFingerprint,
        kind: 'lan',
      },
      createdAt: '2026-08-19T00:00:00.000Z',
      hostOwnership: { autoStart: false, ownsAuthority: true },
      lastEventSequence: 12,
      lifecycle: 'active',
      member: {
        credential: 'A'.repeat(43),
        displayName: 'Alice',
        id: HOST_MEMBER_ID,
        personalRef: HOST_REF,
        role: 'member',
      },
      project: {
        id: PROJECT_ID,
        name: 'Project Alpha',
        workspacePath: 'workspace/project-alpha',
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    const originTampered = new Error('origin changed after origin-rotated checkpoint');
    const assertOrigin = jest.fn(async () => { throw originTampered; });
    const create = jest.fn();
    const network = jest.fn();
    const fetchFromUrl = jest.fn();
    const effects = new LocalCloudBootstrapBindingEffects({
      activation: { get: jest.fn(async () => activationStatus(record)) },
      authorityAdapter: {
        authorityKind: 'cloud',
        create,
      } as unknown as CollabAuthorityAdapter,
      authorityLifecycle: { closeAuthority: async () => undefined },
      git: {
        assertOrigin,
        fetchFromUrl,
        network,
        resolveRefs: jest.fn(),
        rotateOrigin: jest.fn(),
      },
      projects: {
        loadMembership: jest.fn(async () => membership),
        repairIndexFromMemberships: jest.fn(),
        retireAuthorityDirectory: jest.fn(),
        saveMembership: jest.fn(),
      },
      readiness: { collect: jest.fn() },
      workspace: { resolveManagedProjectPath: jest.fn(async () => '/vault/workspace/project-alpha') },
    });

    await expect(effects.verifyCloud(record)).rejects.toBe(originTampered);

    expect(assertOrigin).toHaveBeenCalledWith(
      record,
      '/vault/workspace/project-alpha',
    );
    expect(create).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(fetchFromUrl).not.toHaveBeenCalled();
  });

  it('closes the former authority foundation before retiring its directory', async () => {
    const record = activatedRecord();
    const membership: CollabLocalMembershipRecord = {
      authority: {
        bindingVersion: record.newAuthority.bindingVersion,
        developmentActorId: record.developmentActorId,
        gitRemoteUrl: record.newAuthority.gitRemoteUrl,
        kind: 'cloud',
        serverUrl: record.newAuthority.serverUrl,
        wireVersion: record.newAuthority.wireVersion,
      },
      createdAt: '2026-08-19T00:00:00.000Z',
      lastEventSequence: 18,
      lifecycle: 'active',
      member: {
        displayName: 'Alice',
        id: HOST_MEMBER_ID,
        personalRef: HOST_REF,
        role: 'manager',
      },
      project: {
        id: PROJECT_ID,
        name: 'Project Alpha',
        workspacePath: 'workspace/project-alpha',
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-21T00:02:00.000Z',
    };
    const events: string[] = [];
    const effects = new LocalCloudBootstrapBindingEffects({
      activation: { get: jest.fn(async () => activationStatus(record)) },
      authorityAdapter: {} as Pick<CollabAuthorityAdapter, 'create'>,
      authorityLifecycle: {
        closeAuthority: async () => { events.push('close'); },
      },
      git: {
        assertOrigin: jest.fn(),
        fetchFromUrl: jest.fn(),
        network: jest.fn(),
        resolveRefs: jest.fn(),
        rotateOrigin: jest.fn(),
      },
      projects: {
        loadMembership: async () => membership,
        repairIndexFromMemberships: jest.fn(),
        retireAuthorityDirectory: async () => {
          events.push('retire');
          return '/retired';
        },
        saveMembership: jest.fn(),
      },
      readiness: { collect: jest.fn() },
      workspace: { resolveManagedProjectPath: jest.fn() },
    });

    await effects.retireLanAuthority(record);

    expect(events).toEqual(['close', 'retire']);
  });
});
