import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ManagerResponsibilityService } from '@/app/collab/authority/ManagerResponsibilityService';
import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { MembershipAdminService } from '@/app/collab/authority/MembershipAdminService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { LocalExitProjectStorePort } from '@/app/collab/exit/LocalExitStores';
import type { LocalProjectCleanupPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import { LocalProjectExitCoordinator } from '@/app/collab/exit/LocalProjectExitCoordinator';
import { PendingLeaveAuthorityService } from '@/app/collab/exit/PendingLeaveAuthorityService';
import {
  CollabLifecycleJournalStore,
  type PendingLeaveJournalPort,
} from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import type { LeaveProjectInput } from '@/app/collab/membership/MembershipControlClient';
import type { CollabLanProjectSnapshot } from '@/core/collab';
import { type CollabLocalCleanupStatus } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NOW = '2026-08-13T00:00:00.000Z';
const CREDENTIAL = 'c'.repeat(43);

describe('pending Leave commit-then-lost-response recovery', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let vaultRoot: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-pending-leave-recovery-'));
    const authorityDirectory = path.join(vaultRoot, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: NOW,
        hostCredentialHash: credentialHash('host-credential'),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('migrates schema-1 fingerprint material and replays a committed Leave as left', async () => {
    await database.mutate(connection => insertMember(connection, 'member-leaver'));
    const membership = new MembershipAdminService({
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    });
    await membership.leaveProject('member-leaver', {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-leaver',
      idempotencyKey: 'leave-stable',
      idempotencyManagerMemberId: 'member-host',
      projectId: 'project-alpha',
    });
    await writeLegacyPendingLeave(vaultRoot, 'member-leaver', 'member');
    const harness = recoveryHarness({
      database,
      localMembership: localMembership('member-leaver', 'member'),
      managerSetGeneration: 0,
      membership,
      vaultRoot,
    });

    await expect(harness.first.resume('project-alpha')).resolves.toEqual({ status: 'queued' });
    await expect(harness.store.load('project-alpha')).resolves.toMatchObject({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: 'member-host',
        managerResponsibilityOfferId: null,
      },
      localCleanupComplete: true,
      phase: 'queued',
      schemaVersion: 2,
    });
    await expect(readPendingLeaveJson(vaultRoot)).resolves.toMatchObject({
      authorityReplay: {
        idempotencyManagerMemberId: 'member-host',
      },
      schemaVersion: 2,
    });

    await expect(harness.restarted.resume('project-alpha'))
      .resolves.toEqual({ status: 'complete' });

    expect(harness.snapshotReadCount()).toBe(0);
    expect(harness.leaveAttemptCount()).toBe(2);
    expect(harness.cleanup.cleanup).toHaveBeenCalledTimes(1);
    await expect(memberStatus(database, 'member-leaver')).resolves.toBe('left');
    await expect(harness.store.load('project-alpha')).resolves.toBeNull();
  });

  it('replays an ordinary fresh Member Leave after a lost response', async () => {
    await database.mutate(connection => insertMember(connection, 'member-leaver'));
    const membership = new MembershipAdminService({
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    });
    const harness = recoveryHarness({
      database,
      localMembership: localMembership('member-leaver', 'member'),
      managerSetGeneration: 0,
      membership,
      vaultRoot,
    });

    await expect(harness.first.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toEqual({ status: 'queued' });
    await expect(harness.store.load('project-alpha')).resolves.toMatchObject({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: null,
      },
      localCleanupComplete: true,
      phase: 'queued',
    });

    await expect(harness.restarted.resume('project-alpha'))
      .resolves.toEqual({ status: 'complete' });
    expect(harness.snapshotReadCount()).toBe(1);
    await expect(memberStatus(database, 'member-leaver')).resolves.toBe('left');
  });

  it('leaves directly when another active Manager remains', async () => {
    await database.mutate(connection => {
      insertMember(connection, 'member-manager');
      const managers = new ManagerSetRepository();
      const initial = managers.read(connection);
      managers.promote(connection, {
        expectedGeneration: initial.generation,
        targetMemberId: 'member-manager',
      });
    });
    const membership = new MembershipAdminService({
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    });
    const harness = recoveryHarness({
      database,
      localMembership: localMembership('member-manager', 'manager'),
      managerSetGeneration: 1,
      membership,
      vaultRoot,
    });

    await expect(harness.first.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'operation-timeout' });
    await expect(harness.restarted.resume('project-alpha'))
      .resolves.toEqual({ status: 'complete' });

    await expect(activeManagers(database)).resolves.toEqual(['member-host']);
    await expect(memberStatus(database, 'member-manager')).resolves.toBe('left');
  });

  it('replays a Manager Leave with the exact accepted responsibility offer', async () => {
    await database.mutate(connection => {
      insertMember(connection, 'member-manager');
      insertMember(connection, 'member-successor');
      const managers = new ManagerSetRepository();
      const promoted = managers.promote(connection, {
        expectedGeneration: managers.read(connection).generation,
        targetMemberId: 'member-manager',
      });
      managers.demote(connection, {
        expectedGeneration: promoted.generation,
        targetMemberId: 'member-host',
      });
    });
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    const presence = { hasAuthenticatedPresence: () => true };
    const responsibilities = new ManagerResponsibilityService({
      database,
      events,
      idempotency,
      presence,
    }, {
      createOfferId: () => 'offer-accepted',
      now: () => new Date('2026-08-13T00:01:00.000Z'),
    });
    const offer = await responsibilities.create('member-manager', {
      idempotencyKey: 'create-offer',
      projectId: 'project-alpha',
      purpose: 'manager-leave',
      targetMemberId: 'member-successor',
    });
    await responsibilities.acknowledge('member-successor', {
      expectedTargetMemberId: 'member-successor',
      idempotencyKey: 'ack-offer',
      offerId: offer.offerId,
      projectId: 'project-alpha',
    });
    const membership = new MembershipAdminService({ database, events, idempotency }, {
      now: () => new Date('2026-08-13T00:02:00.000Z'),
      presence,
    });
    const harness = recoveryHarness({
      database,
      localMembership: localMembership('member-manager', 'manager'),
      managerSetGeneration: 2,
      membership,
      vaultRoot,
    });

    await expect(harness.first.leave({
      cleanupChoice: 'keep-files',
      managerResponsibilityOfferId: offer.offerId,
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'operation-timeout' });
    await expect(harness.store.load('project-alpha')).resolves.toMatchObject({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: 'offer-accepted',
      },
      localCleanupComplete: false,
      phase: 'recovery-required',
    });
    expect(harness.cleanup.cleanup).not.toHaveBeenCalled();

    await expect(harness.restarted.resume('project-alpha'))
      .resolves.toEqual({ status: 'complete' });

    expect(harness.snapshotReadCount()).toBe(1);
    expect(harness.leaveAttemptCount()).toBe(2);
    expect(harness.cleanup.cleanup).toHaveBeenCalledTimes(1);
    await expect(activeManagers(database)).resolves.toEqual(['member-successor']);
    await expect(memberStatus(database, 'member-manager')).resolves.toBe('left');
    await expect(harness.store.load('project-alpha')).resolves.toBeNull();
  });
});

function recoveryHarness(input: {
  readonly database: SqlJsProjectDatabase;
  readonly localMembership: CollabLocalMembershipRecord;
  readonly managerSetGeneration: number;
  readonly membership: MembershipAdminService;
  readonly vaultRoot: string;
}): {
  readonly cleanup: jest.Mocked<LocalProjectCleanupPort>;
  readonly first: LocalProjectExitCoordinator;
  readonly leaveAttemptCount: () => number;
  readonly restarted: LocalProjectExitCoordinator;
  readonly snapshotReadCount: () => number;
  readonly store: PendingLeaveJournalPort;
} {
  let leaveAttempts = 0;
  let loseFirstResponse = true;
  let snapshotReads = 0;
  const store = new CollabLifecycleJournalStore(input.vaultRoot).pendingLeaves;
  const createAuthority = () => {
    const pendingAuthority = new PendingLeaveAuthorityService({
      createClient: () => ({
      leaveProject: async request => {
        leaveAttempts += 1;
        await expect(store.load(request.projectId)).resolves.toMatchObject({
          authorityReplay: {
            expectedHostMemberId: request.expectedHostMemberId,
            idempotencyManagerMemberId: request.idempotencyManagerMemberId,
            managerResponsibilityOfferId: request.managerResponsibilityOfferId ?? null,
          },
        });
        const result = await invokeLeave(input.membership, request);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new CollabError({ code: 'operation-timeout' });
        }
        return result;
      },
      readSnapshot: async (_projectId, _memberCredential, _options) => {
        snapshotReads += 1;
        const status = await memberStatus(input.database, input.localMembership.member.id);
        if (status !== 'active') throw new CollabError({ code: 'membership-revoked' });
        return snapshot(
          input.localMembership.member.id,
          input.localMembership.member.role,
          input.managerSetGeneration,
        );
      },
      }),
    });
    return {
      prepareLeave: pendingAuthority.prepare.bind(pendingAuthority),
      refreshLeave: pendingAuthority.refresh.bind(pendingAuthority),
      resolveLeaveHost: pendingAuthority.resolveHost.bind(pendingAuthority),
      settleLeave: pendingAuthority.settle.bind(pendingAuthority),
    };
  };
  const projects: jest.Mocked<LocalExitProjectStorePort> = {
    loadMembership: jest.fn(async (_projectId: string) => input.localMembership),
    markLeaving: jest.fn(async (
      _projectId: string,
      _cleanupStatus: CollabLocalCleanupStatus,
    ) => undefined),
    purgePrivateState: jest.fn(async (_projectId: string) => undefined),
    removeProject: jest.fn(async (_projectId: string) => undefined),
    restoreActive: jest.fn(async (_projectId: string) => undefined),
  };
  const cleanup: jest.Mocked<LocalProjectCleanupPort> = {
    completeRetiredFinalization: jest.fn(),
    cleanup: jest.fn(async (
      _intent: Parameters<LocalProjectCleanupPort['cleanup']>[0],
      _options?: Parameters<LocalProjectCleanupPort['cleanup']>[1],
    ) => ({
      filesPreserved: true,
      gitDataRemoved: true as const,
      markerRetained: false,
      status: 'complete' as const,
    })),
    finalizeRetiredChoice: jest.fn(),
    resume: jest.fn(),
  };
  const suspension = { projectId: 'project-alpha', token: Symbol('leave-suspension') };
  const activity = {
    completeProject: jest.fn(async () => undefined),
    resumeProject: jest.fn(async () => undefined),
    suspendProject: jest.fn(async () => suspension),
  };
  const managerResponsibilityOperations = new ManagerResponsibilityOperationCoordinator();
  const coordinator = () => new LocalProjectExitCoordinator(
    projects,
    store,
    createAuthority(),
    cleanup,
    activity,
    {
      createOperationId: () => 'leave-stable',
      managerReceipts: { load: jest.fn(async () => null) },
      managerResponsibilityOperations,
      now: () => new Date('2026-08-13T00:03:00.000Z'),
    },
  );
  return {
    cleanup,
    first: coordinator(),
    leaveAttemptCount: () => leaveAttempts,
    restarted: coordinator(),
    snapshotReadCount: () => snapshotReads,
    store,
  };
}

async function invokeLeave(
  membership: MembershipAdminService,
  input: LeaveProjectInput,
) {
  const { memberCredential: _memberCredential, signal: _signal, ...request } = input;
  return membership.leaveProject(input.expectedMemberId, request);
}

function localMembership(
  memberId: string,
  role: 'manager' | 'member',
): CollabLocalMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: 'https://192.168.1.10:54545/v1/git/project-alpha/repository.git',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: NOW,
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      credential: CREDENTIAL,
      displayName: 'Leaver',
      id: memberId,
      personalRef: `refs/heads/members/${memberId}`,
      role,
    },
    project: {
      id: 'project-alpha',
      name: 'Alpha',
      workspacePath: 'workspace/project-alpha',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: NOW,
  };
}

function snapshot(
  memberId: string,
  role: 'manager' | 'member',
  managerSetGeneration: number,
): CollabLanProjectSnapshot {
  return {
    currentMember: {
      activatedAt: NOW,
      createdAt: NOW,
      displayName: 'Leaver',
      id: memberId,
      personalRef: `refs/heads/members/${memberId}`,
      role,
      status: 'active',
    },
    eventSequence: 0,
    members: [],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'lan',
      createdAt: NOW,
      hostMemberId: 'member-host',
      id: 'project-alpha',
      managerSetGeneration,
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main',
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function insertMember(connection: AuthorityDatabaseConnection, memberId: string): void {
  connection.run(`
    INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      created_at, activated_at
    ) VALUES (?, 'Leaver', ?, 'member', 'active', ?, ?, ?)
  `, [
    memberId,
    `refs/heads/members/${memberId}`,
    credentialHash(CREDENTIAL),
    NOW,
    NOW,
  ]);
}

function credentialHash(credential: string): Uint8Array {
  return createHash('sha256').update(credential).digest();
}

function memberStatus(
  database: SqlJsProjectDatabase,
  memberId: string,
): Promise<unknown> {
  return database.read(connection => connection.get(
    'SELECT status FROM members WHERE member_id = ?',
    [memberId],
  )?.status);
}

function activeManagers(database: SqlJsProjectDatabase): Promise<readonly string[]> {
  return database.read(connection => connection.all(`
    SELECT member_id
    FROM members
    WHERE role = 'manager' AND status = 'active'
    ORDER BY member_id ASC
  `).map(row => String(row.member_id)));
}

async function writeLegacyPendingLeave(
  vaultRoot: string,
  memberId: string,
  localRole: 'manager' | 'member',
): Promise<void> {
  const directory = path.join(vaultRoot, '.claudian', 'collab', 'pending-leaves');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'project-alpha.json'), JSON.stringify({
    authorityReplay: {
      expectedHostMemberId: 'member-host',
      expectedManagerMemberId: 'member-host',
      managerResponsibilityOfferId: null,
    },
    cleanupChoice: 'keep-files',
    cleanupMarkerNonce: 'n'.repeat(43),
    createdAt: NOW,
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.10:54545',
    idempotencyKey: 'leave-stable',
    kind: 'pending-leave',
    localCleanupComplete: false,
    localRole,
    memberCredential: CREDENTIAL,
    memberId,
    operationId: 'leave-stable',
    phase: 'recovery-required',
    projectCreatedAt: NOW,
    projectId: 'project-alpha',
    projectName: 'Alpha',
    schemaVersion: 1,
    updatedAt: NOW,
    workspacePath: 'workspace/project-alpha',
  }));
}

async function readPendingLeaveJson(
  vaultRoot: string,
): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(await readFile(path.join(
    vaultRoot,
    '.claudian',
    'collab',
    'pending-leaves',
    'project-alpha.json',
  ), 'utf8')) as Readonly<Record<string, unknown>>;
}
