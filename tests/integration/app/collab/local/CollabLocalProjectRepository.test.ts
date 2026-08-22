import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type CollabLocalCloudMembershipRecord,
  type CollabLocalLanMembershipRecord,
  type CollabLocalMembershipRecord,
  type CollabLocalProjectIndexEntry,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  createHostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import {
  decodeRetirementRecord,
  type RetirementRecord,
} from '@/app/collab/retirement/RetirementRecord';
import {
  type RetirementTombstoneRecord,
} from '@/app/collab/retirement/RetirementTombstoneRecord';

const PROJECT_ID = 'project-alpha';
const MEMBER_CREDENTIAL = 'A'.repeat(43);

function indexEntry(
  overrides: Partial<CollabLocalProjectIndexEntry> = {},
): CollabLocalProjectIndexEntry {
  return {
    authorityKind: 'lan',
    createdAt: '2026-08-08T00:00:00.000Z',
    id: PROJECT_ID,
    name: 'Project Alpha',
    lifecycle: 'active',
    updatedAt: '2026-08-08T00:00:00.000Z',
    workspacePath: 'workspace/project-alpha',
    ...overrides,
  };
}

function membershipRecord(
  overrides: Partial<CollabLocalLanMembershipRecord> = {},
): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.20:54545',
      gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: [
        '-----BEGIN CERTIFICATE-----',
        'TEST CERTIFICATE DATA',
        '-----END CERTIFICATE-----',
      ].join('\n'),
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: '2026-08-08T00:00:00.000Z',
    hostOwnership: { ownsAuthority: true },
    lifecycle: 'active',
    lastEventSequence: 0,
    member: {
      credential: MEMBER_CREDENTIAL,
      displayName: 'Alice',
      id: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Project Alpha',
      workspacePath: 'workspace/project-alpha',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

function cloudMembershipRecord(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      bindingVersion: 1,
      developmentActorId: 'member-alice',
      gitRemoteUrl: `http://127.0.0.1:8787/v1/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'http://127.0.0.1:8787/',
      wireVersion: 4,
    },
    createdAt: '2026-08-08T00:00:00.000Z',
    lastEventSequence: 7,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Project Alpha',
      workspacePath: 'workspace/project-alpha',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-08T00:01:00.000Z',
  };
}

function durableRetirementRecord(): RetirementRecord {
  return decodeRetirementRecord({
    acknowledgedAt: null,
    acknowledgementStatus: 'pending',
    cleanupOperationId: 'cleanup-retired-project',
    cleanupStatus: 'failed',
    createdAt: '2026-08-08T00:01:00.000Z',
    hostCaCertificatePem: [
      '-----BEGIN CERTIFICATE-----',
      'TEST CERTIFICATE DATA',
      '-----END CERTIFICATE-----',
    ].join('\n'),
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.20:54545',
    kind: 'retirement',
    memberCredential: MEMBER_CREDENTIAL,
    memberId: 'member-retired',
    projectId: 'project-retired',
    retiredAt: '2026-08-08T00:00:00.000Z',
    schemaVersion: 1,
    updatedAt: '2026-08-08T00:02:00.000Z',
  });
}

describe('CollabLocalProjectRepository', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-collab-local-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('returns an empty index without creating folders when local state is missing', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await expect(repository.loadIndex()).resolves.toEqual({
      projects: [],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: null,
    });
    await expect(readdir(path.join(vaultRoot, '.claudian'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('migrates the development schema and persists the current shape', async () => {
    const stateDirectory = path.join(vaultRoot, '.claudian', 'collab');
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, 'index.json'), JSON.stringify({
      projects: [{
        id: PROJECT_ID,
        lifecycle: 'active',
        name: 'Project Alpha',
        workspacePath: 'workspace/project-alpha',
      }],
      schemaVersion: 0,
      selectedProjectId: PROJECT_ID,
    }));
    const repository = new CollabLocalProjectRepository(vaultRoot, {
      now: () => new Date('2026-08-08T01:00:00.000Z'),
    });

    const index = await repository.loadIndex();

    expect(index).toEqual({
      projects: [{
        authorityKind: 'lan',
        createdAt: '2026-08-08T01:00:00.000Z',
        id: PROJECT_ID,
        lifecycle: 'active',
        name: 'Project Alpha',
        updatedAt: '2026-08-08T01:00:00.000Z',
        workspacePath: 'workspace/project-alpha',
      }],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: PROJECT_ID,
    });
    expect(JSON.parse(await readFile(path.join(stateDirectory, 'index.json'), 'utf8')))
      .toEqual(index);
    expect(await readFile(path.join(stateDirectory, '.gitignore'), 'utf8')).toBe('/*\n');
  });

  it('migrates active v1 index and membership records to v3 without touching the workspace', async () => {
    const stateDirectory = path.join(vaultRoot, '.claudian', 'collab');
    const projectState = path.join(stateDirectory, 'projects', PROJECT_ID);
    const workspace = path.join(vaultRoot, 'workspace', PROJECT_ID);
    await mkdir(projectState, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'note.md'), 'preserved\n');
    const legacyIndex = {
      projects: [{
        authorityKind: 'lan',
        createdAt: '2026-08-08T00:00:00.000Z',
        id: PROJECT_ID,
        name: 'Project Alpha',
        updatedAt: '2026-08-08T00:00:00.000Z',
        workspacePath: `workspace/${PROJECT_ID}`,
      }],
      schemaVersion: 1,
      selectedProjectId: PROJECT_ID,
    };
    const currentMembership = membershipRecord();
    const { lifecycle: _lifecycle, ...legacyMembership } = currentMembership;
    await writeFile(path.join(stateDirectory, 'index.json'), JSON.stringify(legacyIndex));
    await writeFile(path.join(projectState, 'membership.json'), JSON.stringify({
      ...legacyMembership,
      schemaVersion: 1,
    }));

    const repository = new CollabLocalProjectRepository(vaultRoot);
    await expect(repository.loadIndex()).resolves.toMatchObject({
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      projects: [expect.objectContaining({ lifecycle: 'active' })],
    });
    await expect(repository.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      lifecycle: 'active',
    });
    expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe('preserved\n');
    expect(await readdir(workspace)).toEqual(['note.md']);
  });

  it('migrates v2 lifecycle projections without reactivating leaving or retired Projects', async () => {
    const stateDirectory = path.join(vaultRoot, '.claudian', 'collab');
    const projectState = path.join(stateDirectory, 'projects', PROJECT_ID);
    await mkdir(projectState, { recursive: true });
    const leavingMembership = {
      ...membershipRecord({ lifecycle: 'leaving' }),
      schemaVersion: 2,
    };
    await writeFile(
      path.join(projectState, 'membership.json'),
      JSON.stringify(leavingMembership),
    );
    await writeFile(path.join(stateDirectory, 'index.json'), JSON.stringify({
      projects: [{
        authorityKind: 'lan',
        cleanupStatus: 'running',
        createdAt: '2026-08-08T00:00:00.000Z',
        id: PROJECT_ID,
        lifecycle: 'leaving',
        name: 'Project Alpha',
        updatedAt: '2026-08-08T00:01:00.000Z',
        workspacePath: 'workspace/project-alpha',
      }, {
        authorityKind: 'lan',
        cleanupStatus: 'failed',
        createdAt: '2026-08-07T00:00:00.000Z',
        id: 'project-retired',
        lifecycle: 'retired',
        name: 'Retired Project',
        retiredAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:02:00.000Z',
        workspacePath: 'workspace/project-retired',
      }],
      schemaVersion: 2,
      selectedProjectId: PROJECT_ID,
    }));

    const repository = new CollabLocalProjectRepository(vaultRoot);

    await expect(repository.loadIndex()).resolves.toEqual({
      projects: [{
        authorityKind: 'lan',
        cleanupStatus: 'running',
        createdAt: '2026-08-08T00:00:00.000Z',
        id: PROJECT_ID,
        lifecycle: 'leaving',
        name: 'Project Alpha',
        updatedAt: '2026-08-08T00:01:00.000Z',
        workspacePath: 'workspace/project-alpha',
      }, {
        authorityKind: 'lan',
        cleanupStatus: 'failed',
        createdAt: '2026-08-07T00:00:00.000Z',
        id: 'project-retired',
        lifecycle: 'retired',
        name: 'Retired Project',
        retiredAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:02:00.000Z',
        workspacePath: 'workspace/project-retired',
      }],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: PROJECT_ID,
    });
    await expect(repository.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      lifecycle: 'leaving',
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    });
  });

  it('persists a strict Cloud membership without LAN authority or Host fields', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const record = cloudMembershipRecord();

    await repository.saveMembership(record);
    await repository.upsertProject(indexEntry({ authorityKind: 'cloud' }));

    await expect(repository.loadMembership(PROJECT_ID)).resolves.toEqual(record);
    await expect(repository.loadIndex()).resolves.toMatchObject({
      projects: [{ authorityKind: 'cloud', id: PROJECT_ID }],
    });
    const persisted = JSON.parse(await readFile(
      path.join(vaultRoot, '.claudian', 'collab', 'projects', PROJECT_ID, 'membership.json'),
      'utf8',
    ));
    expect(persisted).not.toHaveProperty('hostOwnership');
    expect(persisted.member).not.toHaveProperty('credential');
    expect(persisted.authority).not.toHaveProperty('hostCaCertificatePem');
  });

  it('rejects a Cloud development actor that differs from the current Member', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const record = cloudMembershipRecord();

    await expect(repository.saveMembership({
      ...record,
      authority: {
        ...record.authority,
        developmentActorId: 'member-bob',
      },
    })).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-record-corrupt' },
    });
  });

  it('reconstructs every active Project index entry from authoritative memberships', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const first = cloudMembershipRecord();
    const second = {
      ...membershipRecord(),
      member: {
        ...membershipRecord().member,
        id: 'member-bob',
        personalRef: 'refs/heads/members/member-bob',
      },
      project: {
        id: 'project-beta',
        name: 'Project Beta',
        workspacePath: 'workspace/project-beta',
      },
    };
    await repository.saveMembership(first);
    await repository.saveMembership(second);
    await writeFile(
      path.join(vaultRoot, '.claudian', 'collab', 'index.json'),
      '{corrupt',
    );

    await expect(repository.repairIndexFromMemberships()).resolves.toMatchObject({
      projects: [{ authorityKind: 'cloud', id: PROJECT_ID }, {
        authorityKind: 'lan',
        id: 'project-beta',
      }],
      selectedProjectId: null,
    });
    await expect(repository.loadIndex()).resolves.toMatchObject({
      projects: [{ id: PROJECT_ID }, { id: 'project-beta' }],
    });
  });

  it('fails closed before a corrupt index can erase a durable retired Project', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const retirement = durableRetirementRecord();
    await repository.upsertProject(indexEntry({
      cleanupStatus: 'failed',
      id: 'project-retired',
      lifecycle: 'retired',
      name: 'Retired Project',
      retiredAt: retirement.retiredAt,
      workspacePath: 'workspace/project-retired',
    }));
    await repository.transitionProjectToRetired(retirement);
    await repository.saveMembership(cloudMembershipRecord());
    const indexPath = path.join(vaultRoot, '.claudian', 'collab', 'index.json');
    await writeFile(indexPath, '{corrupt');

    await expect(repository.repairIndexFromMemberships()).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: {
        projectId: 'project-retired',
        reason: 'local-index-retirement-projection-unrecoverable',
      },
    });
    await expect(readFile(indexPath, 'utf8')).resolves.toBe('{corrupt');
  });

  it('reconstructs retired lifecycle state from the durable retirement owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const retirement = durableRetirementRecord();
    await repository.upsertProject(indexEntry({
      cleanupStatus: 'pending',
      id: retirement.projectId,
      lifecycle: 'retired',
      name: 'Retired Project',
      retiredAt: retirement.retiredAt,
      workspacePath: 'workspace/project-retired',
    }));
    await repository.transitionProjectToRetired(retirement);
    const indexPath = path.join(vaultRoot, '.claudian', 'collab', 'index.json');
    await writeFile(indexPath, JSON.stringify({
      projects: [indexEntry({
        cleanupStatus: 'pending',
        id: retirement.projectId,
        lifecycle: 'retired',
        name: 'Retired Project',
        retiredAt: '2026-08-08T00:00:30.000Z',
        updatedAt: '2026-08-08T00:01:30.000Z',
        workspacePath: 'workspace/project-retired',
      })],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: null,
    }));

    await expect(repository.repairIndexFromMemberships()).resolves.toEqual({
      projects: [{
        authorityKind: 'lan',
        cleanupStatus: retirement.cleanupStatus,
        createdAt: '2026-08-08T00:00:00.000Z',
        id: retirement.projectId,
        lifecycle: 'retired',
        name: 'Retired Project',
        retiredAt: retirement.retiredAt,
        updatedAt: retirement.updatedAt,
        workspacePath: 'workspace/project-retired',
      }],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: null,
    });
  });

  it('keeps durable Retirement terminal when cleanup has not removed stale membership', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const retirement = durableRetirementRecord();
    const staleMembership = membershipRecord({
      member: {
        ...membershipRecord().member,
        id: retirement.memberId,
        personalRef: `refs/heads/members/${retirement.memberId}`,
      },
      project: {
        id: retirement.projectId,
        name: 'Retired Project',
        workspacePath: 'workspace/project-retired',
      },
    });
    await repository.saveMembership(staleMembership);
    await repository.upsertProject(indexEntry({
      id: retirement.projectId,
      name: 'Retired Project',
      workspacePath: 'workspace/project-retired',
    }));
    await repository.transitionProjectToRetired(retirement);
    await repository.saveMembership(staleMembership);
    await repository.upsertProject(indexEntry({
      cleanupStatus: retirement.cleanupStatus,
      id: retirement.projectId,
      lifecycle: 'retired',
      name: 'Retired Project',
      retiredAt: retirement.retiredAt,
      updatedAt: retirement.updatedAt,
      workspacePath: 'workspace/project-retired',
    }));

    await expect(repository.repairIndexFromMemberships()).resolves.toMatchObject({
      projects: [{
        cleanupStatus: retirement.cleanupStatus,
        id: retirement.projectId,
        lifecycle: 'retired',
        retiredAt: retirement.retiredAt,
      }],
    });
    await expect(repository.loadMembership(retirement.projectId)).resolves.toEqual(
      staleMembership,
    );
  });

  it('persists lifecycle records and discovers tombstones without an active Project', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const tombstone: RetirementTombstoneRecord = {
      schemaVersion: 1,
      kind: 'retirement-tombstone',
      projectId: PROJECT_ID,
      retiredAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2026-09-12T00:00:00.000Z',
      result: { projectId: PROJECT_ID, retiredAt: '2026-08-13T00:00:00.000Z' },
      replay: {
        actorMemberId: 'member-alice',
        idempotencyKey: 'retire-one',
        requestFingerprint: 'b'.repeat(64),
      },
      hostTransitionProofs: [],
      formerMembers: [{
        memberId: 'member-alice',
        credentialHash: 'c'.repeat(64),
        acknowledgedAt: null,
      }],
    };

    await repository.saveRetirementTombstone(tombstone);
    await repository.removeProject(PROJECT_ID);

    const restarted = new CollabLocalProjectRepository(vaultRoot);
    await expect(restarted.listRetirementTombstoneProjectIds()).resolves.toEqual([
      PROJECT_ID,
    ]);
    await expect(restarted.loadRetirementTombstone(PROJECT_ID)).resolves.toEqual(tombstone);

    await restarted.removeRetirementTombstone(PROJECT_ID);
    await expect(restarted.listRetirementTombstoneProjectIds()).resolves.toEqual([]);
  });

  it('discovers no tombstones on empty state without writing to the filesystem', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await expect(repository.listRetirementTombstoneProjectIds()).resolves.toEqual([]);
    await expect(stat(path.join(vaultRoot, '.claudian'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('discovers valid tombstones when a legacy index is corrupt', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const tombstone: RetirementTombstoneRecord = {
      expiresAt: '2026-09-12T00:00:00.000Z',
      formerMembers: [{
        acknowledgedAt: null,
        credentialHash: 'c'.repeat(64),
        memberId: 'member-alice',
      }],
      hostTransitionProofs: [],
      kind: 'retirement-tombstone',
      projectId: PROJECT_ID,
      replay: {
        actorMemberId: 'member-alice',
        idempotencyKey: 'retire-one',
        requestFingerprint: 'b'.repeat(64),
      },
      result: { projectId: PROJECT_ID, retiredAt: '2026-08-13T00:00:00.000Z' },
      retiredAt: '2026-08-13T00:00:00.000Z',
      schemaVersion: 1,
    };
    await repository.saveRetirementTombstone(tombstone);
    await writeFile(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'retirement-tombstones',
      'index.json',
    ), 'not json');

    const restarted = new CollabLocalProjectRepository(vaultRoot);
    await expect(restarted.listRetirementTombstoneProjectIds()).resolves.toEqual([
      PROJECT_ID,
    ]);
    await expect(restarted.loadRetirementTombstone(PROJECT_ID)).resolves.toEqual(tombstone);
  });

  it('rediscovers a tombstone when a crash happens before its index update', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const tombstone: RetirementTombstoneRecord = {
      expiresAt: '2026-09-12T00:00:00.000Z',
      formerMembers: [{
        acknowledgedAt: null,
        credentialHash: 'c'.repeat(64),
        memberId: 'member-alice',
      }],
      hostTransitionProofs: [],
      kind: 'retirement-tombstone',
      projectId: PROJECT_ID,
      replay: {
        actorMemberId: 'member-alice',
        idempotencyKey: 'retire-one',
        requestFingerprint: 'b'.repeat(64),
      },
      result: { projectId: PROJECT_ID, retiredAt: '2026-08-13T00:00:00.000Z' },
      retiredAt: '2026-08-13T00:00:00.000Z',
      schemaVersion: 1,
    };
    await repository.saveRetirementTombstone(tombstone);
    // The physical tombstone file is the sole recovery authority: no index is
    // written, so a crash after the file commit is always recoverable.
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'retirement-tombstones',
      'index.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = new CollabLocalProjectRepository(vaultRoot);
    await expect(restarted.listRetirementTombstoneProjectIds()).resolves.toEqual([
      PROJECT_ID,
    ]);
    await expect(restarted.loadRetirementTombstone(PROJECT_ID)).resolves.toEqual(tombstone);
  });

  it('owns the Project-private local cleanup journal directly', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const record = {
      choice: 'keep-files' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
      kind: 'local-cleanup' as const,
      markerNonce: 'A'.repeat(43),
      memberId: 'member-alice',
      operationId: 'cleanup-one',
      phase: 'planned' as const,
      projectId: PROJECT_ID,
      purpose: 'leave' as const,
      schemaVersion: 1 as const,
      updatedAt: '2026-08-13T00:00:00.000Z',
      workspacePath: 'workspace/project-alpha',
    };

    await repository.localCleanup.save(record);
    await expect(repository.localCleanup.load(PROJECT_ID)).resolves.toEqual(record);
    await expect(repository.localCleanup.remove(PROJECT_ID)).resolves.toBe(true);
    await expect(repository.localCleanup.load(PROJECT_ID)).resolves.toBeNull();
  });

  it('owns the Project-private Host-transfer recovery journal directly', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const record = createHostTransferRecoveryRecord({
      createdAt: '2026-08-13T00:00:00.000Z',
      direction: 'incoming',
      projectId: PROJECT_ID,
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });

    await repository.hostTransferRecovery.save(record);
    await expect(repository.hostTransferRecovery.load(PROJECT_ID, 'incoming'))
      .resolves.toEqual(record);
    await expect(repository.hostTransferRecovery.load(PROJECT_ID, 'outgoing'))
      .resolves.toBeNull();
    await repository.hostTransferRecovery.remove(PROJECT_ID, 'outgoing');
    await expect(repository.hostTransferRecovery.load(PROJECT_ID, 'incoming'))
      .resolves.toEqual(record);
    await repository.hostTransferRecovery.remove(PROJECT_ID, 'incoming');
    await expect(repository.hostTransferRecovery.load(PROJECT_ID, 'incoming'))
      .resolves.toBeNull();
  });

  it('transitions active private state to a durable Retired projection without touching files', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const workspace = path.join(vaultRoot, 'workspace', PROJECT_ID);
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await writeFile(path.join(workspace, 'note.md'), 'preserved\n');
    await writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await repository.upsertProject(indexEntry());
    await repository.selectProject(PROJECT_ID);
    await repository.saveMembership(membershipRecord());
    for (const kind of ['cache', 'pending-operation', 'publication-state', 'request-draft'] as const) {
      await repository.saveProjectDocument(PROJECT_ID, kind, {
        projectId: PROJECT_ID,
        schemaVersion: 1,
        value: kind,
      });
    }
    const record: RetirementRecord = decodeRetirementRecord({
      acknowledgedAt: null,
      acknowledgementStatus: 'pending',
      cleanupOperationId: 'retire-local-one',
      cleanupStatus: 'pending',
      createdAt: '2026-08-13T00:00:00.000Z',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'a'.repeat(64),
      hostEndpoint: 'https://192.168.1.20:54545',
      kind: 'retirement',
      memberCredential: MEMBER_CREDENTIAL,
      memberId: 'member-alice',
      projectId: PROJECT_ID,
      retiredAt: '2026-08-13T00:00:00.000Z',
      schemaVersion: 1,
      updatedAt: '2026-08-13T00:00:00.000Z',
    });

    await repository.transitionProjectToRetired(record);
    await repository.transitionProjectToRetired(record);

    await expect(repository.loadIndex()).resolves.toMatchObject({
      projects: [{
        cleanupStatus: 'pending',
        id: PROJECT_ID,
        lifecycle: 'retired',
        retiredAt: record.retiredAt,
      }],
      selectedProjectId: PROJECT_ID,
    });
    await expect(repository.loadMembership(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.loadLifecycleProjectDocument(
      PROJECT_ID,
      'retirement',
      decodeRetirementRecord,
    )).resolves.toEqual(record);
    for (const kind of ['cache', 'pending-operation', 'publication-state', 'request-draft'] as const) {
      await expect(repository.loadProjectDocument(
        PROJECT_ID,
        kind,
        value => value as { projectId: string; schemaVersion: number },
      )).resolves.toBeNull();
    }
    expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe('preserved\n');
    expect(await readFile(path.join(workspace, '.git', 'HEAD'), 'utf8'))
      .toBe('ref: refs/heads/main\n');
  });

  it('finishes active-state scrubbing after a restart observes Retired projection', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const retirement = decodeRetirementRecord({
      acknowledgedAt: null,
      acknowledgementStatus: 'pending',
      cleanupOperationId: 'retire-local-one',
      cleanupStatus: 'pending',
      createdAt: '2026-08-13T00:00:00.000Z',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'a'.repeat(64),
      hostEndpoint: 'https://192.168.1.20:54545',
      kind: 'retirement',
      memberCredential: MEMBER_CREDENTIAL,
      memberId: 'member-alice',
      projectId: PROJECT_ID,
      retiredAt: '2026-08-13T00:00:00.000Z',
      schemaVersion: 1,
      updatedAt: '2026-08-13T00:00:00.000Z',
    });
    await repository.upsertProject(indexEntry({
      cleanupStatus: 'pending',
      lifecycle: 'retired',
      retiredAt: retirement.retiredAt,
      updatedAt: '2026-08-12T00:00:00.000Z',
    }));
    await repository.saveMembership(membershipRecord());
    await repository.saveLifecycleProjectDocument(
      PROJECT_ID,
      'retirement',
      retirement,
      decodeRetirementRecord,
    );
    await repository.saveProjectDocument(PROJECT_ID, 'cache', {
      projectId: PROJECT_ID,
      schemaVersion: 1,
    });

    await repository.transitionProjectToRetired(retirement);

    await expect(repository.loadMembership(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.loadProjectDocument(
      PROJECT_ID,
      'cache',
      value => value as { projectId: string; schemaVersion: number },
    )).resolves.toBeNull();
    await expect(repository.loadLifecycleProjectDocument(
      PROJECT_ID,
      'retirement',
      decodeRetirementRecord,
    )).resolves.toEqual(retirement);
    await expect(repository.loadIndex()).resolves.toMatchObject({
      projects: [{
        cleanupStatus: retirement.cleanupStatus,
        id: PROJECT_ID,
        retiredAt: retirement.retiredAt,
        updatedAt: retirement.updatedAt,
      }],
    });
  });

  it('recreates a terminal Retired projection after queued Leave removed the active index', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const retirement = decodeRetirementRecord({
      acknowledgedAt: null,
      acknowledgementStatus: 'pending',
      cleanupOperationId: 'retire-local-one',
      cleanupStatus: 'complete',
      createdAt: '2026-08-13T00:00:00.000Z',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'a'.repeat(64),
      hostEndpoint: 'https://192.168.1.20:54545',
      kind: 'retirement',
      memberCredential: MEMBER_CREDENTIAL,
      memberId: 'member-alice',
      projectId: PROJECT_ID,
      retiredAt: '2026-08-13T00:00:00.000Z',
      schemaVersion: 1,
      updatedAt: '2026-08-13T00:00:00.000Z',
    });

    await repository.transitionProjectToRetired(retirement, {
      authorityKind: 'lan',
      createdAt: '2026-08-08T00:00:00.000Z',
      name: 'Project Alpha',
      workspacePath: 'workspace/project-alpha',
    });

    await expect(repository.loadIndex()).resolves.toMatchObject({
      projects: [{
        cleanupStatus: 'complete',
        id: PROJECT_ID,
        lifecycle: 'retired',
      }],
    });
    await expect(repository.loadRetirementRecord(PROJECT_ID)).resolves.toEqual(retirement);
  });

  it('purges only the exact Project-private state directory', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    await repository.saveMembership(membershipRecord());
    await repository.saveProjectDocument(PROJECT_ID, 'cache', {
      projectId: PROJECT_ID,
      schemaVersion: 1,
    });
    const siblingId = 'project-sibling';
    await repository.saveMembership({
      ...membershipRecord(),
      member: {
        ...membershipRecord().member,
        personalRef: 'refs/heads/members/member-sibling',
        id: 'member-sibling',
      },
      project: {
        id: siblingId,
        name: 'Sibling',
        workspacePath: 'workspace/project-sibling',
      },
    });

    await expect(repository.purgeProjectPrivateState(PROJECT_ID)).resolves.toBe(true);

    await expect(repository.loadMembership(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.loadMembership(siblingId)).resolves.not.toBeNull();
    await expect(repository.purgeProjectPrivateState(PROJECT_ID)).resolves.toBe(false);
  });

  it('moves a pending retirement acknowledgement outside a finalized Project', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const retirement = decodeRetirementRecord({
      acknowledgedAt: null,
      acknowledgementStatus: 'pending',
      cleanupOperationId: 'retire-local-one',
      cleanupStatus: 'complete',
      createdAt: '2026-08-13T00:00:00.000Z',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'a'.repeat(64),
      hostEndpoint: 'https://192.168.1.20:54545',
      kind: 'retirement',
      memberCredential: MEMBER_CREDENTIAL,
      memberId: 'member-alice',
      projectId: PROJECT_ID,
      retiredAt: '2026-08-13T00:00:00.000Z',
      schemaVersion: 1,
      updatedAt: '2026-08-13T00:00:00.000Z',
    });
    await repository.transitionProjectToRetired(retirement, {
      authorityKind: 'lan',
      createdAt: '2026-08-08T00:00:00.000Z',
      name: 'Project Alpha',
      workspacePath: 'workspace/project-alpha',
    });

    await repository.finalizeRetiredProject(PROJECT_ID);
    await writeFile(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'retirement-acknowledgements',
      `.${PROJECT_ID}.json.00000000-0000-4000-8000-000000000000.tmp`,
    ), 'interrupted atomic write');

    await expect(repository.loadIndex()).resolves.toMatchObject({ projects: [] });
    await expect(repository.listRetirementAcknowledgementProjectIds())
      .resolves.toEqual([PROJECT_ID]);
    await expect(repository.loadRetirementRecord(PROJECT_ID)).resolves.toEqual(retirement);
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = new CollabLocalProjectRepository(vaultRoot);
    await expect(restarted.loadRetirementRecord(PROJECT_ID)).resolves.toEqual(retirement);
    await expect(restarted.removeRetirementAcknowledgement(PROJECT_ID)).resolves.toBe(true);
    await expect(restarted.loadRetirementRecord(PROJECT_ID)).resolves.toBeNull();
  });

  it('refuses to purge a Project-private state symlink boundary', async () => {
    const external = path.join(vaultRoot, 'external-private-state');
    const projectsDirectory = path.join(vaultRoot, '.claudian', 'collab', 'projects');
    await mkdir(external, { recursive: true });
    await mkdir(projectsDirectory, { recursive: true });
    await writeFile(path.join(external, 'secret.txt'), 'preserve\n');
    await symlink(external, path.join(projectsDirectory, PROJECT_ID));
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await expect(repository.purgeProjectPrivateState(PROJECT_ID)).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
    });

    await expect(readFile(path.join(external, 'secret.txt'), 'utf8')).resolves.toBe('preserve\n');
  });

  it('rejects corrupt records without leaking credential text or absolute paths', async () => {
    const stateDirectory = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    );
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, 'membership.json'), JSON.stringify({
      credential: 'FAKE_SECRET_MUST_NOT_LEAK',
      schemaVersion: 1,
    }));
    const repository = new CollabLocalProjectRepository(vaultRoot);

    let failure: unknown;
    try {
      await repository.loadMembership(PROJECT_ID);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-record-corrupt' },
    });
    expect(JSON.stringify(failure)).not.toContain('FAKE_SECRET_MUST_NOT_LEAK');
    expect(JSON.stringify(failure)).not.toContain(vaultRoot);
  });

  it('serializes index mutations so concurrent updates do not lose projects', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await Promise.all([
      repository.upsertProject(indexEntry()),
      repository.upsertProject(indexEntry({
        id: 'project-beta',
        name: 'Project Beta',
        workspacePath: 'workspace/project-beta',
      })),
    ]);
    await repository.selectProject('project-beta');

    const index = await repository.loadIndex();
    expect(index.projects.map(project => project.id)).toEqual([
      PROJECT_ID,
      'project-beta',
    ]);
    expect(index.selectedProjectId).toBe('project-beta');
  });

  it('accepts portable multi-segment completed Project paths', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const nested = indexEntry({
      workspacePath: 'Shared/Collab Projects/project-alpha',
    });

    await repository.upsertProject(nested);
    await repository.saveMembership(membershipRecord({
      project: {
        id: PROJECT_ID,
        name: 'Project Alpha',
        workspacePath: nested.workspacePath,
      },
    }));

    await expect(repository.loadIndex()).resolves.toMatchObject({
      projects: [expect.objectContaining({ workspacePath: nested.workspacePath })],
    });
    await expect(repository.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      project: { workspacePath: nested.workspacePath },
    });
  });

  it.each([
    '/absolute/project-alpha',
    '../outside/project-alpha',
    'Shared/.git/project-alpha',
    'Shared/Projects/project alpha',
  ])('rejects an unsafe completed Project path: %s', async (workspacePath) => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await expect(repository.upsertProject(indexEntry({ workspacePath })))
      .rejects.toMatchObject({
        code: 'operation-failed',
        safeContext: { reason: 'local-record-corrupt' },
      });
  });

  it('writes membership JSON atomically and leaves no temporary siblings', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const writes = Array.from({ length: 20 }, (_, sequence) => (
      repository.saveMembership(membershipRecord({ lastEventSequence: sequence }))
    ));

    await Promise.all(writes);

    await expect(repository.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      lastEventSequence: 19,
      member: { credential: MEMBER_CREDENTIAL },
    });
    const projectDirectory = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    );
    expect((await readdir(projectDirectory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(
      path.join(projectDirectory, 'membership.json'),
      'utf8',
    ))).toMatchObject({ lastEventSequence: 19 });
  });

  it('persists a stopped Host membership before a LAN route exists', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const record = membershipRecord({
      authority: {
        endpoint: null,
        gitRemoteUrl: null,
        hostCaCertificatePem: null,
        hostCaFingerprint: null,
        kind: 'lan',
      },
    });

    await repository.saveMembership(record);

    await expect(repository.loadMembership(PROJECT_ID)).resolves.toEqual(record);
  });

  it('rejects a partially configured LAN authority', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await expect(repository.saveMembership(membershipRecord({
      authority: {
        ...membershipRecord().authority,
        endpoint: null,
      },
    }))).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-record-corrupt' },
    });
  });

  it('rejects an invalid persisted Host auto-start intent', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const invalid = {
      ...membershipRecord(),
      hostOwnership: { autoStart: 'yes', ownsAuthority: true },
    } as unknown as CollabLocalMembershipRecord;

    await expect(repository.saveMembership(invalid)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-record-corrupt' },
    });
  });

  it('keeps private state ignored when the Vault becomes a Git repository later', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    await repository.saveMembership(membershipRecord());

    expect(spawnSync('git', ['init', '--quiet'], { cwd: vaultRoot }).status).toBe(0);
    const ignored = spawnSync(
      'git',
      ['check-ignore', '--quiet', `.claudian/collab/projects/${PROJECT_ID}/membership.json`],
      { cwd: vaultRoot },
    );

    expect(ignored.status).toBe(0);
  });

  it('adds the private-state guard before writing into an existing Vault repository', async () => {
    expect(spawnSync('git', ['init', '--quiet'], { cwd: vaultRoot }).status).toBe(0);
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await repository.saveMembership(membershipRecord());

    expect(spawnSync(
      'git',
      ['check-ignore', '--quiet', `.claudian/collab/projects/${PROJECT_ID}/membership.json`],
      { cwd: vaultRoot },
    ).status).toBe(0);
  });

  it('rejects a symlinked private-state boundary without exposing its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'claudian-collab-private-outside-'));
    try {
      await mkdir(path.join(vaultRoot, '.claudian'));
      await symlink(outside, path.join(vaultRoot, '.claudian', 'collab'), 'junction');
      const repository = new CollabLocalProjectRepository(vaultRoot);

      await expect(repository.saveMembership(membershipRecord())).rejects.toMatchObject({
        code: 'workspace-boundary-invalid',
      });
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it('uses private POSIX modes where supported', async () => {
    if (process.platform === 'win32') return;
    await chmod(vaultRoot, 0o755);
    const repository = new CollabLocalProjectRepository(vaultRoot);

    await repository.saveMembership(membershipRecord());

    const collabDirectory = await stat(path.join(vaultRoot, '.claudian', 'collab'));
    const projectDirectory = await stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    ));
    const membershipFile = await stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'membership.json',
    ));
    expect(collabDirectory.mode & 0o777).toBe(0o700);
    expect(projectDirectory.mode & 0o777).toBe(0o700);
    expect(membershipFile.mode & 0o777).toBe(0o600);
  });

  it('rejects credential-bearing remote URLs before persistence', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const invalid = membershipRecord({
      authority: {
        ...membershipRecord().authority,
        gitRemoteUrl: `https://member:${MEMBER_CREDENTIAL}@192.168.1.20/repository.git`,
      },
    });

    await expect(repository.saveMembership(invalid)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-record-corrupt' },
    });
    await expect(readdir(path.join(vaultRoot, '.claudian'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a legacy device identity as an unknown current-schema field', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    await expect(repository.saveMembership({
      ...membershipRecord(),
      deviceId: 'legacy-device-id',
    } as CollabLocalMembershipRecord)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-record-corrupt' },
    });
  });

  it('does not expose a cursor-only membership projection mutator', () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    expect(repository).not.toHaveProperty('updateMembershipEventSequence');
  });

  it('projects promotion and demotion monotonically with the event cursor', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot, {
      now: () => new Date('2026-08-08T01:00:00.000Z'),
    });
    await repository.saveMembership(membershipRecord({
      member: {
        ...membershipRecord().member,
        role: 'member',
      },
    }));

    await expect(repository.updateMembershipProjection(
      PROJECT_ID,
      'member-alice',
      'manager',
      3,
    )).resolves.toMatchObject({
      lastEventSequence: 3,
      member: { id: 'member-alice', role: 'manager' },
    });

    await expect(repository.updateMembershipProjection(
      PROJECT_ID,
      'member-alice',
      'member',
      4,
    )).resolves.toMatchObject({
      lastEventSequence: 4,
      member: { id: 'member-alice', role: 'member' },
      updatedAt: '2026-08-08T01:00:00.000Z',
    });
    await expect(repository.updateMembershipProjection(
      PROJECT_ID,
      'member-alice',
      'manager',
      3,
    )).resolves.toMatchObject({
      lastEventSequence: 4,
      member: { role: 'member' },
    });
    await expect(repository.updateMembershipProjection(
      PROJECT_ID,
      'member-other',
      'member',
      5,
    )).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'local-membership-member-mismatch' },
    });
  });

  it('stores cache and pending-operation documents only in guarded private state', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const cache = {
      projectId: PROJECT_ID,
      requestCount: 2,
      schemaVersion: 1,
    };
    const pending = {
      operationId: 'operation-create-alpha',
      projectId: PROJECT_ID,
      schemaVersion: 1,
    };

    await repository.saveProjectDocument(PROJECT_ID, 'cache', cache);
    await repository.saveProjectDocument(PROJECT_ID, 'pending-operation', pending);

    await expect(repository.loadProjectDocument(
      PROJECT_ID,
      'cache',
      value => value as typeof cache,
    )).resolves.toEqual(cache);
    await expect(repository.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      value => value as typeof pending,
    )).resolves.toEqual(pending);
    await expect(repository.removeProjectDocument(PROJECT_ID, 'pending-operation'))
      .resolves.toBe(true);
    await expect(repository.removeProjectDocument(PROJECT_ID, 'pending-operation'))
      .resolves.toBe(false);
  });

  it('discovers a pending operation before the Project index projection exists', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    await repository.saveProjectDocument(PROJECT_ID, 'pending-operation', {
      operationId: 'create-project-alpha',
      projectId: PROJECT_ID,
      schemaVersion: 1,
    });

    await expect(repository.loadIndex()).resolves.toMatchObject({ projects: [] });
    await expect(repository.listPendingOperationProjectIds())
      .resolves.toEqual([PROJECT_ID]);
  });

  it('removes the pending index projection before discarding its authority record', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    await repository.upsertProject(indexEntry());
    await repository.saveProjectDocument(PROJECT_ID, 'pending-operation', {
      operationId: 'create-project-alpha',
      projectId: PROJECT_ID,
      schemaVersion: 1,
    });
    const pendingPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'pending-operation.json',
    );
    await rm(pendingPath);
    await mkdir(pendingPath);

    await expect(repository.discardPendingOperation(PROJECT_ID)).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
    });

    await expect(repository.loadIndex()).resolves.toMatchObject({ projects: [] });
    await expect(stat(pendingPath)).resolves.toMatchObject({});
  });

  it('removes only the disposable cache document', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const membership = membershipRecord();
    await repository.saveMembership(membership);
    await repository.saveProjectDocument(PROJECT_ID, 'cache', {
      projectId: PROJECT_ID,
      schemaVersion: 2,
      snapshot: { project: { managerMemberId: 'member-alice' } },
    });
    for (const kind of ['pending-operation', 'publication-state', 'request-draft'] as const) {
      await repository.saveProjectDocument(PROJECT_ID, kind, {
        projectId: PROJECT_ID,
        schemaVersion: 1,
        value: kind,
      });
    }

    await expect(repository.removeProjectDocument(PROJECT_ID, 'cache')).resolves.toBe(true);

    await expect(repository.loadMembership(PROJECT_ID)).resolves.toEqual(membership);
    await expect(repository.loadProjectDocument(
      PROJECT_ID,
      'cache',
      value => value as { projectId: string; schemaVersion: number },
    )).resolves.toBeNull();
    for (const kind of ['pending-operation', 'publication-state', 'request-draft'] as const) {
      await expect(repository.loadProjectDocument(
        PROJECT_ID,
        kind,
        value => value as { projectId: string; schemaVersion: number; value: string },
      )).resolves.toEqual({ projectId: PROJECT_ID, schemaVersion: 1, value: kind });
    }
  });

  it('creates and repairs the managed empty Git config behind the private guard', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    const emptyConfigPath = await repository.ensureGitEmptyConfig();
    await writeFile(emptyConfigPath, '[credential]\nhelper = hostile\n');
    const repairedPath = await repository.ensureGitEmptyConfig();

    expect(repairedPath).toBe(emptyConfigPath);
    expect(await readFile(repairedPath, 'utf8')).toBe('');
    expect(await readFile(
      path.join(vaultRoot, '.claudian', 'collab', '.gitignore'),
      'utf8',
    )).toContain('/*');
  });

  it('creates a private authority directory through the local path owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);

    const authorityDirectory = await repository.ensureAuthorityDirectory(PROJECT_ID);

    expect(authorityDirectory).toBe(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ));
    const authorityStat = await stat(authorityDirectory);
    expect(authorityStat.isDirectory()).toBe(true);
    expect(process.platform === 'win32' || (authorityStat.mode & 0o777) === 0o700)
      .toBe(true);
    expect(JSON.parse(await readFile(
      path.join(authorityDirectory, '.claudian-authority.json'),
      'utf8',
    ))).toEqual({ projectId: PROJECT_ID, schemaVersion: 1 });

    await writeFile(path.join(authorityDirectory, 'authority.db'), 'private');
    await expect(repository.removeAuthorityDirectory(PROJECT_ID)).resolves.toBe(true);
    await expect(stat(authorityDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(repository.removeAuthorityDirectory(PROJECT_ID)).resolves.toBe(false);
  });

  it('refuses authority cleanup without its exact ownership marker', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const authorityDirectory = await repository.ensureAuthorityDirectory(PROJECT_ID);
    await rm(path.join(authorityDirectory, '.claudian-authority.json'));
    await writeFile(path.join(authorityDirectory, 'keep.db'), 'unowned');

    await expect(repository.removeAuthorityDirectory(PROJECT_ID)).rejects.toMatchObject({
      code: 'operation-failed',
    });
    await expect(readFile(path.join(authorityDirectory, 'keep.db'), 'utf8'))
      .resolves.toBe('unowned');
  });

  it('atomically retires a former Host authority into attempt-scoped inert storage', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const authorityDirectory = await repository.ensureAuthorityDirectory(PROJECT_ID);
    await writeFile(path.join(authorityDirectory, 'collab.db'), 'former-host');

    const retiredDirectory = await repository.retireAuthorityDirectory(
      PROJECT_ID,
      'bootstrap-attempt-one',
    );
    const replayedDirectory = await repository.retireAuthorityDirectory(
      PROJECT_ID,
      'bootstrap-attempt-one',
    );
    if (retiredDirectory === null) throw new Error('Expected retired authority directory');

    expect(retiredDirectory).toBe(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'retired-lan-authorities',
      PROJECT_ID,
      'bootstrap-attempt-one',
    ));
    expect(replayedDirectory).toBe(retiredDirectory);
    await expect(stat(authorityDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(retiredDirectory, 'collab.db'), 'utf8'))
      .resolves.toBe('former-host');
  });

  it('claims only a known legacy authority layout when Host ownership is proven', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const authorityDirectory = await repository.ensureAuthorityDirectory(PROJECT_ID);
    await rm(path.join(authorityDirectory, '.claudian-authority.json'));
    await writeFile(path.join(authorityDirectory, 'collab.db'), 'legacy');

    await expect(repository.ensureAuthorityDirectory(PROJECT_ID)).rejects.toMatchObject({
      code: 'operation-failed',
    });
    await expect(repository.ensureAuthorityDirectory(PROJECT_ID, {
      claimLegacyOwnedDirectory: true,
    })).resolves.toBe(authorityDirectory);
    expect(JSON.parse(await readFile(
      path.join(authorityDirectory, '.claudian-authority.json'),
      'utf8',
    ))).toEqual({ projectId: PROJECT_ID, schemaVersion: 1 });
  });

  it('refuses to claim a legacy authority directory containing an unknown entry', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const authorityDirectory = await repository.ensureAuthorityDirectory(PROJECT_ID);
    await rm(path.join(authorityDirectory, '.claudian-authority.json'));
    await writeFile(path.join(authorityDirectory, 'unknown.bin'), 'unowned');

    await expect(repository.ensureAuthorityDirectory(PROJECT_ID, {
      claimLegacyOwnedDirectory: true,
    })).rejects.toMatchObject({ code: 'operation-failed' });
    await expect(readFile(path.join(authorityDirectory, 'unknown.bin'), 'utf8'))
      .resolves.toBe('unowned');
  });
});
