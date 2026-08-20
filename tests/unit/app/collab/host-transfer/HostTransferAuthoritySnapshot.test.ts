import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import { HostTransferRepository } from '@/app/collab/authority/HostTransferRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  HostTransferAuthoritySnapshot,
} from '@/app/collab/host-transfer/HostTransferAuthoritySnapshot';
import {
  createHostTransferPackageManifest,
  digestHostTransferPackageManifest,
  digestHostTransitionProofChain,
} from '@/app/collab/host-transfer/HostTransferPackage';
import type { CollabHostTrustTransitionProof } from '@/core/collab';

const NOW = '2026-08-13T00:00:00.000Z';
const LATER = '2026-08-13T00:01:00.000Z';
const EXPIRY = '2026-08-14T00:00:00.000Z';
const proof: CollabHostTrustTransitionProof = {
  issuedAt: NOW,
  nextCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
  nextCaFingerprint: 'b'.repeat(64),
  previousCaFingerprint: 'a'.repeat(64),
  projectId: 'project-alpha',
  schemaVersion: 1,
  signature: 'c'.repeat(64),
  signatureAlgorithm: 'rsa-pss-sha256',
  transferId: 'transfer-alpha',
};

describe('HostTransferAuthoritySnapshot', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-host-transfer-snapshot-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: NOW,
        hostCredentialHash: new Uint8Array(32).fill(1),
        hostDisplayName: 'Source Host',
        hostMemberId: 'member-source',
        name: 'Project Alpha',
        projectId: 'project-alpha',
      });
      connection.run(
        `INSERT INTO members (
          member_id, display_name, personal_ref, role, status, credential_hash,
          join_attempt_id, created_at, activated_at, revoked_at
        ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
        [
          'member-target',
          'Target Host',
          'refs/heads/members/member-target',
          new Uint8Array(32).fill(2),
          NOW,
          NOW,
        ],
      );
      const transfers = new HostTransferRepository();
      transfers.createOffer(connection, {
        actorMemberId: 'member-source',
        expiresAt: EXPIRY,
        offeredAt: NOW,
        projectId: 'project-alpha',
        targetHostMemberId: 'member-target',
        transferId: 'transfer-alpha',
      });
      transfers.accept(connection, {
        actorMemberId: 'member-target',
        projectId: 'project-alpha',
        receiverCredential: Buffer.alloc(32, 3).toString('base64url'),
        targetCaCertificatePem: proof.nextCaCertificatePem,
        targetCaFingerprint: proof.nextCaFingerprint,
        targetEndpoint: 'https://192.168.1.20:27000',
        transferId: 'transfer-alpha',
        updatedAt: NOW,
      });
      transfers.advance(connection, {
        expectedPhase: 'accepted',
        nextPhase: 'quiescing',
        transferId: 'transfer-alpha',
        updatedAt: NOW,
      });
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates and validates an inert snapshot without mutating the live authority', async () => {
    const sourceGeneration = database.generation;
    const codec = new HostTransferAuthoritySnapshot({
      loadSqlJs: async () => SQL,
      trust: { verifyChain: jest.fn().mockReturnValue(proof.nextCaCertificatePem) },
    });
    const inert = await codec.createInert({
      bytes: await database.exportSnapshot(),
      createdAt: LATER,
      projectId: 'project-alpha',
      proof,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: '1'.repeat(40),
      authoritySnapshot: { byteCount: inert.byteLength, sha256: '2'.repeat(64) },
      createdAt: LATER,
      gitBundle: { byteCount: 1, sha256: '3'.repeat(64) },
      gitObjectFormat: 'sha1',
      projectId: 'project-alpha',
      proofChainDigest: digestHostTransitionProofChain([proof]),
      sourceAuthorityGeneration: sourceGeneration,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });

    await expect(codec.inspectInert({
      bytes: inert,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    })).resolves.toMatchObject({
      eventSequence: expect.any(Number),
      proofChain: [proof],
    });
    await expect(database.read(connection => ({
      host: connection.get('SELECT host_member_id FROM project')?.host_member_id,
      phase: connection.get(
        "SELECT phase FROM host_transfer_operations WHERE transfer_id = 'transfer-alpha'",
      )?.phase,
      proofs: connection.get('SELECT COUNT(*) AS count FROM host_transition_proofs')?.count,
    }))).resolves.toEqual({ host: 'member-source', phase: 'quiescing', proofs: 0 });
  });

  it('activates the exact manifest once and rejects a different replay', async () => {
    const codec = new HostTransferAuthoritySnapshot({
      loadSqlJs: async () => SQL,
      trust: { verifyChain: jest.fn().mockReturnValue(proof.nextCaCertificatePem) },
    });
    const inert = await codec.createInert({
      bytes: await database.exportSnapshot(),
      createdAt: LATER,
      projectId: 'project-alpha',
      proof,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: '1'.repeat(40),
      authoritySnapshot: { byteCount: inert.byteLength, sha256: '2'.repeat(64) },
      createdAt: LATER,
      gitBundle: { byteCount: 1, sha256: '3'.repeat(64) },
      gitObjectFormat: 'sha1',
      projectId: 'project-alpha',
      proofChainDigest: digestHostTransitionProofChain([proof]),
      sourceAuthorityGeneration: database.generation,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const activation = {
      cutoverAt: LATER,
      manifestDigest: digestHostTransferPackageManifest(manifest),
      projectId: 'project-alpha',
      schemaVersion: 1 as const,
      signature: 'd'.repeat(64),
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    };

    const activated = await codec.activate({
      activationCertificate: activation,
      bytes: inert,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    });
    const inspected = new SQL.Database(activated.bytes);
    expect(inspected.exec(`SELECT host_member_id FROM project`)[0]?.values[0]?.[0])
      .toBe('member-target');
    expect(inspected.exec(
      `SELECT phase, manifest_digest FROM host_transfer_operations`,
    )[0]?.values[0]).toEqual(['completed', activation.manifestDigest]);
    expect(activated.eventSequence).toBeGreaterThan(0);
    inspected.close();

    await expect(codec.activate({
      activationCertificate: { ...activation, manifestDigest: '5'.repeat(64) },
      bytes: activated.bytes,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('validates a bound raw v8 snapshot before migrating and activating it as current', async () => {
    const codec = new HostTransferAuthoritySnapshot({
      loadSqlJs: async () => SQL,
      trust: { verifyChain: jest.fn().mockReturnValue(proof.nextCaCertificatePem) },
    });
    const inertV9 = await codec.createInert({
      bytes: await database.exportSnapshot(),
      createdAt: LATER,
      projectId: 'project-alpha',
      proof,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const inertV8 = downgradeInertToV8(new SQL.Database(inertV9));
    const manifest = {
      ...createHostTransferPackageManifest({
        authorityMainOid: '1'.repeat(40),
        authoritySnapshot: { byteCount: inertV8.byteLength, sha256: '2'.repeat(64) },
        createdAt: LATER,
        gitBundle: { byteCount: 1, sha256: '3'.repeat(64) },
        gitObjectFormat: 'sha1',
        projectId: 'project-alpha',
        proofChainDigest: digestHostTransitionProofChain([proof]),
        sourceAuthorityGeneration: database.generation,
        targetCaFingerprint: proof.nextCaFingerprint,
        targetHostMemberId: 'member-target',
        transferId: 'transfer-alpha',
      }),
      authoritySchemaVersion: 8 as const,
    };

    await expect(codec.inspectInert({
      bytes: inertV8,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    })).resolves.toMatchObject({ expectedRefs: expect.arrayContaining(['refs/heads/main']) });
    await expect(codec.validateRecoveryMigration({
      bytes: inertV8,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    })).resolves.toBeUndefined();
    await expect(codec.inspectInert({
      bytes: inertV8,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-other',
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-transfer-authority-manifest-binding-invalid' },
    });
    await expect(codec.inspectInert({
      bytes: inertV8,
      manifest: { ...manifest, authoritySchemaVersion: 9 },
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-transfer-authority-schema-mismatch' },
    });
    const proofMemberMismatch = new SQL.Database(inertV8);
    proofMemberMismatch.run(`
      INSERT INTO members (
        member_id, display_name, personal_ref, role, status, credential_hash,
        join_attempt_id, created_at, activated_at, revoked_at
      ) VALUES (
        'member-other', 'Other', 'refs/heads/members/member-other', 'member',
        'active', X'0101010101010101010101010101010101010101010101010101010101010101',
        NULL, '${NOW}', '${NOW}', NULL
      )
    `);
    proofMemberMismatch.run(`
      UPDATE host_transition_proofs
      SET source_host_member_id = 'member-other'
      WHERE transfer_id = 'transfer-alpha'
    `);
    const proofMemberMismatchBytes = Uint8Array.from(proofMemberMismatch.export());
    proofMemberMismatch.close();
    await expect(codec.inspectInert({
      bytes: proofMemberMismatchBytes,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-transfer-authority-proof-chain-invalid' },
    });

    const activation = {
      cutoverAt: LATER,
      manifestDigest: digestHostTransferPackageManifest(manifest),
      projectId: 'project-alpha',
      schemaVersion: 1 as const,
      signature: 'd'.repeat(64),
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    };
    const activated = await codec.activate({
      activationCertificate: activation,
      bytes: inertV8,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    });
    expect(activated.legacyActivatedBytes).toBeInstanceOf(Uint8Array);
    const legacy = new SQL.Database(activated.legacyActivatedBytes!);
    expect(legacy.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
    legacy.close();
    const current = new SQL.Database(activated.bytes);
    expect(current.exec('PRAGMA user_version')[0]?.values[0]?.[0])
      .toBe(COLLAB_AUTHORITY_SCHEMA_VERSION);
    expect(current.exec('PRAGMA table_info(project)')[0]?.values.map(row => row[1]))
      .not.toContain('manager_member_id');
    expect(current.exec('SELECT phase FROM host_transfer_operations')[0]?.values[0]?.[0])
      .toBe('completed');
    current.close();
    const replay = await codec.activate({
      activationCertificate: activation,
      bytes: inertV8,
      manifest,
      pinnedSourceCaCertificatePem: 'source-ca',
      sourceHostMemberId: 'member-source',
    });
    expect(replay.legacyActivatedBytes).toEqual(activated.legacyActivatedBytes);
    expect(replay.bytes).toEqual(activated.bytes);
  });
});

function downgradeInertToV8(database: Database): Uint8Array {
  database.run('PRAGMA foreign_keys = OFF');
  database.run(`
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
    SELECT singleton, project_id, name, state, host_member_id,
      (SELECT member_id FROM members WHERE role = 'manager' AND status = 'active'),
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
    INSERT INTO accept_operations SELECT
      operation_id, request_id, expected_main_oid, expected_head_oid,
      result_commit_oid, state, idempotency_key, created_at, updated_at,
      expected_request_revision, expected_resolving_tickets_json
    FROM accept_operations_v9_fixture;
    DROP TABLE accept_operations_v9_fixture;

    DROP INDEX manager_responsibility_one_nonterminal_source;
    DROP INDEX manager_responsibility_one_nonterminal_target;
    ALTER TABLE manager_responsibility_offers
      RENAME TO manager_responsibility_offers_v9_fixture;
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
      status, offered_at, expires_at, acknowledged_at, consumed_at, updated_at
    FROM manager_responsibility_offers_v9_fixture;
    DROP TABLE manager_responsibility_offers_v9_fixture;
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
      ON manager_responsibility_offers((1))
      WHERE status IN ('offered', 'acknowledged');
    CREATE UNIQUE INDEX members_one_active_manager
      ON members(role) WHERE role = 'manager' AND status = 'active';
    PRAGMA user_version = 8;
  `);
  const bytes = Uint8Array.from(database.export());
  database.close();
  return bytes;
}
