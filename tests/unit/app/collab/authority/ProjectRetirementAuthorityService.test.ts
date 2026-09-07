import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { ProjectRetirementAuthorityService } from '@/app/collab/authority/ProjectRetirementAuthorityService';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { createRetirementIntent } from '@/app/collab/retirement/RetirementIntent';
import { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';

const NOW = new Date('2026-08-13T08:00:00.000Z');

describe('ProjectRetirementAuthorityService', () => {
  let SQL: SqlJsStatic;
  let authorityDirectory: string;
  let root: string;
  let database: SqlJsProjectDatabase;
  let localProjects: CollabLocalProjectRepository;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-retirement-authority-'));
    authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: '2026-08-13T00:00:00.000Z',
        hostCredentialHash: new Uint8Array(32).fill(1),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      insertActiveMember(connection, 'member-second', new Uint8Array(32).fill(2));
      insertActiveMember(connection, 'member-third', new Uint8Array(32).fill(3));
      new ManagerSetRepository().promote(connection, {
        expectedGeneration: 0,
        targetMemberId: 'member-second',
      });
    });
    localProjects = new CollabLocalProjectRepository(root, { now: () => NOW });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('commits the minimum tombstone before projecting terminal authority success', async () => {
    const order: string[] = [];
    const tombstones = new RetirementTombstoneRepository(localProjects, {
      isRecoveryOwner: () => true,
      now: () => NOW,
    });
    const service = new ProjectRetirementAuthorityService(database, tombstones, {
      installationKey: TEST_INSTALLATION_A,
      now: () => NOW,
      onTombstoneCommitted: () => order.push('tombstone'),
      onAuthorityCommitted: () => order.push('authority'),
    });

    await expect(service.retire('member-host', request())).resolves.toEqual({
      projectId: 'project-alpha',
      retiredAt: NOW.toISOString(),
    });
    expect(order).toEqual(['tombstone', 'authority']);

    const tombstone = await localProjects.loadRetirementTombstone('project-alpha');
    expect(tombstone).toEqual(expect.objectContaining({
      expiresAt: '2026-09-12T08:00:00.000Z',
      formerMembers: [
        expect.objectContaining({ credentialHash: '01'.repeat(32), memberId: 'member-host' }),
        expect.objectContaining({ credentialHash: '02'.repeat(32), memberId: 'member-second' }),
        expect.objectContaining({ credentialHash: '03'.repeat(32), memberId: 'member-third' }),
      ],
      hostTransitionProofs: [],
      result: { projectId: 'project-alpha', retiredAt: NOW.toISOString() },
    }));
    await expect(database.read(connection => connection.get(
      'SELECT state FROM project WHERE singleton = 1',
    )?.state)).resolves.toBe('disabled');
    await expect(service.inspectDurableResult('member-host', request())).resolves.toEqual({
      matchesRequest: true,
      result: {
        projectId: 'project-alpha',
        retiredAt: NOW.toISOString(),
      },
    });
  });

  it('retires with an imported active Member still unbound', async () => {
    await database.mutate(connection => {
      connection.run(`
        UPDATE members
        SET access_state = 'unbound', credential_hash = NULL
        WHERE member_id = 'member-third' AND status = 'active'
      `);
    });
    const service = new ProjectRetirementAuthorityService(
      database,
      new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }),
      { installationKey: TEST_INSTALLATION_A, now: () => NOW },
    );

    await expect(service.retire('member-host', request())).resolves.toEqual({
      projectId: 'project-alpha',
      retiredAt: NOW.toISOString(),
    });

    await expect(localProjects.loadRetirementTombstone('project-alpha'))
      .resolves.toEqual(expect.objectContaining({
        formerMembers: [
          expect.objectContaining({ memberId: 'member-host' }),
          expect.objectContaining({ memberId: 'member-second' }),
        ],
      }));
  });

  it('allows an active Manager who is neither Host nor Project creator to Retire', async () => {
    const service = new ProjectRetirementAuthorityService(
      database,
      new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }),
      { installationKey: TEST_INSTALLATION_A, now: () => NOW },
    );

    await expect(service.retire('member-second', request('member-second'))).resolves.toEqual({
      projectId: 'project-alpha',
      retiredAt: NOW.toISOString(),
    });
    await expect(database.read(connection => connection.get(
      'SELECT actor_member_id, request_fingerprint FROM project_terminal_transitions',
    ))).resolves.toEqual({
      actor_member_id: 'member-second',
      request_fingerprint: request('member-second').requestFingerprint,
    });
  });

  it.each([false, true])(
    'resumes a v8 quiescing Retire with exact replay identity (tombstone written: %s)',
    async tombstoneWritten => {
      const legacyRequest = request('member-second');
      const openResult = await installLegacyV8Retirement(legacyRequest, tombstoneWritten);
      expect(openResult).toMatchObject({ migrated: true, source: 'primary' });
      await database.mutate(connection => {
        const managers = new ManagerSetRepository();
        const promoted = managers.promote(connection, {
          expectedGeneration: managers.read(connection).generation,
          targetMemberId: 'member-host',
        });
        managers.demote(connection, {
          expectedGeneration: promoted.generation,
          targetMemberId: 'member-second',
        });
      });
      const service = new ProjectRetirementAuthorityService(
        database,
        new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }),
        { installationKey: TEST_INSTALLATION_A, now: () => NOW },
      );

      await expect(service.retire('member-second', legacyRequest)).resolves.toEqual({
        projectId: 'project-alpha',
        retiredAt: NOW.toISOString(),
      });
      await expect(service.inspectDurableResult(
        'member-second',
        legacyRequest,
      )).resolves.toMatchObject({ matchesRequest: true });
      await expect(database.read(connection => ({
        project: connection.get('SELECT state FROM project WHERE singleton = 1'),
        transition: connection.get(`
          SELECT actor_member_id, idempotency_key, request_fingerprint, phase
          FROM project_terminal_transitions WHERE singleton = 1
        `),
      }))).resolves.toEqual({
        project: { state: 'disabled' },
        transition: {
          actor_member_id: 'member-second',
          idempotency_key: legacyRequest.idempotencyKey,
          phase: 'tombstone-committed',
          request_fingerprint: legacyRequest.requestFingerprint,
        },
      });
    },
  );

  it('copies the ordered public Host transition chain without private transfer state', async () => {
    await database.mutate(connection => insertHostTransition(connection));
    const service = new ProjectRetirementAuthorityService(
      database,
      new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }),
      { installationKey: TEST_INSTALLATION_A, now: () => NOW },
    );

    await service.retire('member-host', request());

    const tombstone = await localProjects.loadRetirementTombstone('project-alpha');
    expect(tombstone?.hostTransitionProofs).toEqual([{
      issuedAt: '2026-08-12T00:01:00.000Z',
      nextCaCertificatePem: '-----BEGIN CERTIFICATE-----\nnext\n-----END CERTIFICATE-----\n',
      nextCaFingerprint: 'b'.repeat(64),
      previousCaFingerprint: 'a'.repeat(64),
      projectId: 'project-alpha',
      schemaVersion: 1,
      signature: 'c'.repeat(64),
      signatureAlgorithm: 'rsa-pss-sha256',
      transferId: 'transfer-one',
    }]);
    expect(JSON.stringify(tombstone)).not.toMatch(/receiver|private|manifest/i);
  });

  it('resumes the same durable Retire intent without creating another result', async () => {
    const service = new ProjectRetirementAuthorityService(
      database,
      new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }),
      { installationKey: TEST_INSTALLATION_A, now: () => NOW },
    );

    const first = await service.retire('member-host', request());
    const replay = await service.retire('member-host', request());

    expect(replay).toEqual(first);
    await expect(database.read(connection => connection.all(
      'SELECT operation_id, phase FROM project_terminal_transitions',
    ))).resolves.toEqual([{ operation_id: 'retire-alpha', phase: 'tombstone-committed' }]);
  });

  it('reuses the prepared tombstone timestamp after a crash before authority commit', async () => {
    let current = NOW;
    let failAfterTombstone = true;
    const tombstones = new RetirementTombstoneRepository(localProjects, {
      isRecoveryOwner: () => true,
      now: () => current,
    });
    const interrupted = new ProjectRetirementAuthorityService(database, tombstones, {
      installationKey: TEST_INSTALLATION_A,
      now: () => current,
      onTombstoneCommitted: () => {
        if (failAfterTombstone) throw new Error('simulated crash');
      },
    });

    await expect(interrupted.retire('member-host', request()))
      .rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
    current = new Date('2026-08-13T08:05:00.000Z');
    failAfterTombstone = false;

    await expect(interrupted.retire('member-host', request())).resolves.toEqual({
      projectId: 'project-alpha',
      retiredAt: NOW.toISOString(),
    });
  });

  it('fails closed for stale responsibility or a competing terminal intent', async () => {
    const service = new ProjectRetirementAuthorityService(
      database,
      new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }),
      { installationKey: TEST_INSTALLATION_A, now: () => NOW },
    );

    await expect(service.retire('member-third', request('member-third')))
      .rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.retire('member-second', request()))
      .rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.retire('member-host', {
      ...request(),
      expectedHostMemberId: 'member-second',
    })).rejects.toMatchObject({ code: 'stale-project-selection' });

    await service.retire('member-host', request());
    await expect(service.retire('member-host', {
      ...request(),
      idempotencyKey: 'retire-key-two',
      operationId: 'retire-beta',
      requestFingerprint: 'b'.repeat(64),
    })).rejects.toMatchObject({ code: 'project-retired' });
  });

  async function installLegacyV8Retirement(
    legacyRequest: ReturnType<typeof request>,
    tombstoneWritten: boolean,
  ) {
    const bytes = await database.exportSnapshot();
    await database.close();
    const legacy = new SQL.Database(bytes);
    try {
      downgradeToV8Retirement(legacy, legacyRequest);
      await writeFile(path.join(authorityDirectory, 'collab.db'), legacy.export());
      await rm(path.join(authorityDirectory, 'collab.db.bak'), { force: true });
      await rm(path.join(authorityDirectory, 'collab.db.tmp'), { force: true });
    } finally {
      legacy.close();
    }
    if (tombstoneWritten) {
      await new RetirementTombstoneRepository(localProjects, { isRecoveryOwner: () => true, now: () => NOW }).savePrepared({
        expiresAt: '2026-09-12T08:00:00.000Z',
        formerMembers: [
          { acknowledgedAt: null, credentialHash: '01'.repeat(32), memberId: 'member-host' },
          { acknowledgedAt: null, credentialHash: '02'.repeat(32), memberId: 'member-second' },
          { acknowledgedAt: null, credentialHash: '03'.repeat(32), memberId: 'member-third' },
        ],
        hostTransitionProofs: [],
        kind: 'retirement-tombstone',
    ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: 'project-alpha',
        replay: {
          actorMemberId: 'member-second',
          idempotencyKey: legacyRequest.idempotencyKey,
          requestFingerprint: legacyRequest.requestFingerprint,
        },
        result: { projectId: 'project-alpha', retiredAt: NOW.toISOString() },
        retiredAt: NOW.toISOString(),
        schemaVersion: 2,
      });
    }
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    return database.open();
  }
});

function downgradeToV8Retirement(
  database: Database,
  legacyRequest: ReturnType<typeof request>,
): void {
  database.run(`
    PRAGMA foreign_keys = OFF;

    UPDATE members
    SET role = CASE WHEN member_id = 'member-second' THEN 'manager' ELSE 'member' END;

    ALTER TABLE project RENAME TO project_v9_fixture;
    CREATE TABLE project (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      project_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'disabled')),
      host_member_id TEXT NOT NULL REFERENCES members(member_id),
      manager_member_id TEXT NOT NULL REFERENCES members(member_id),
      manager_generation INTEGER NOT NULL DEFAULT 0,
      main_ref TEXT NOT NULL CHECK(main_ref = 'refs/heads/main'),
      created_at TEXT NOT NULL,
      snapshot_generation INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO project (
      singleton, project_id, name, state, host_member_id, manager_member_id,
      manager_generation, main_ref, created_at, snapshot_generation
    )
    SELECT
      singleton, project_id, name, state, host_member_id, 'member-second',
      manager_set_generation, main_ref, created_at, snapshot_generation
    FROM project_v9_fixture;
    DROP TABLE project_v9_fixture;

    ALTER TABLE accept_operations RENAME TO accept_operations_v9_fixture;
    CREATE TABLE accept_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES change_requests(request_id),
      expected_main_oid TEXT NOT NULL,
      expected_head_oid TEXT NOT NULL,
      result_commit_oid TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared', 'ref_updated', 'completed')),
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expected_request_revision INTEGER NOT NULL DEFAULT 0,
      expected_resolving_tickets_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(expected_resolving_tickets_json))
    );
    DROP TABLE accept_operations_v9_fixture;

    DROP INDEX manager_responsibility_one_nonterminal_source;
    DROP INDEX manager_responsibility_one_nonterminal_target;
    ALTER TABLE manager_responsibility_offers
      RENAME TO manager_responsibility_offers_v10_fixture;
    CREATE TABLE manager_responsibility_offers (
      offer_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK(purpose IN ('manager-transfer', 'manager-leave')),
      source_manager_member_id TEXT NOT NULL REFERENCES members(member_id),
      source_manager_generation INTEGER NOT NULL,
      target_member_id TEXT NOT NULL REFERENCES members(member_id),
      status TEXT NOT NULL CHECK(status IN (
        'offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired'
      )),
      offered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      acknowledged_at TEXT,
      consumed_at TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO manager_responsibility_offers SELECT
      offer_id,
      CASE purpose WHEN 'manager-promotion' THEN 'manager-transfer' ELSE purpose END,
      source_manager_member_id,
      (SELECT manager_generation FROM project WHERE singleton = 1),
      target_member_id,
      status,
      offered_at,
      expires_at,
      acknowledged_at,
      consumed_at,
      updated_at
    FROM manager_responsibility_offers_v10_fixture;
    DROP TABLE manager_responsibility_offers_v10_fixture;
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
      ON manager_responsibility_offers((1))
      WHERE status IN ('offered', 'acknowledged');

    CREATE UNIQUE INDEX members_one_active_manager
      ON members(role) WHERE role = 'manager' AND status = 'active';
    PRAGMA user_version = 8;
  `);
  database.run(`
    INSERT INTO project_terminal_transitions (
      singleton, operation_id, kind, actor_member_id, idempotency_key,
      request_fingerprint, phase, retired_at, updated_at
    ) VALUES (1, ?, 'retire', ?, ?, ?, 'quiescing', NULL, ?)
  `, [
    legacyRequest.operationId,
    legacyRequest.managerActorMemberId,
    legacyRequest.idempotencyKey,
    legacyRequest.requestFingerprint,
    NOW.toISOString(),
  ]);
}

function request(managerActorMemberId = 'member-host') {
  const intent = createRetirementIntent({
    expectedHostMemberId: 'member-host',
    managerActorMemberId,
    projectId: 'project-alpha',
  });
  return {
    expectedHostMemberId: 'member-host',
    managerActorMemberId,
    idempotencyKey: intent.idempotencyKey,
    operationId: 'retire-alpha',
    projectId: 'project-alpha',
    requestFingerprint: intent.requestFingerprint,
  } as const;
}

function insertActiveMember(
  connection: AuthorityDatabaseConnection,
  memberId: string,
  credentialHash: Uint8Array,
): void {
  connection.run(`
    INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)
  `, [
    memberId,
    'Second',
    `refs/heads/members/${memberId}`,
    credentialHash,
    '2026-08-13T00:00:00.000Z',
    '2026-08-13T00:00:00.000Z',
  ]);
}

function insertHostTransition(connection: AuthorityDatabaseConnection): void {
  connection.run(`
    INSERT INTO host_transfer_operations (
      transfer_id, source_host_member_id, target_host_member_id, phase,
      offered_at, expires_at, updated_at
    ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
  `, [
    'transfer-one',
    'member-host',
    'member-second',
    '2026-08-12T00:00:00.000Z',
    '2026-08-12T00:10:00.000Z',
    '2026-08-12T00:02:00.000Z',
  ]);
  connection.run(`
    INSERT INTO host_transition_proofs (
      transfer_id, source_host_member_id, target_host_member_id,
      previous_ca_fingerprint, next_ca_certificate_pem, next_ca_fingerprint,
      issued_at, signature_algorithm, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'rsa-pss-sha256', ?)
  `, [
    'transfer-one',
    'member-host',
    'member-second',
    'a'.repeat(64),
    '-----BEGIN CERTIFICATE-----\nnext\n-----END CERTIFICATE-----\n',
    'b'.repeat(64),
    '2026-08-12T00:01:00.000Z',
    'c'.repeat(64),
  ]);
}
