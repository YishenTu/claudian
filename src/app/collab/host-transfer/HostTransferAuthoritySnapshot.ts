import { COLLAB_MAIN_REF, type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

import {
  assertAuthorityDatabaseIntegrity,
  migrateLegacyAuthorityDatabaseToCurrent,
} from '@/app/collab/authority/AuthoritySchema';
import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { HostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import {
  digestHostTransferPackageManifest,
  digestHostTransitionProofChain,
} from '@/app/collab/host-transfer/HostTransferPackage';
import type { HostTransferActivationCertificate } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface AuthoritySnapshotRow {
  readonly [key: string]: SqlValue;
}

export interface HostTransferAuthoritySnapshotOptions {
  readonly loadSqlJs?: () => Promise<SqlJsStatic>;
  readonly trust?: Pick<HostTrustTransitionService, 'verifyChain'>;
}

export interface InspectHostTransferAuthoritySnapshotResult {
  readonly expectedRefs: readonly string[];
  readonly eventSequence: number;
  readonly proofChain: readonly CollabHostTrustTransitionProof[];
}

function snapshotError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

async function loadDefaultSqlJs(): Promise<SqlJsStatic> {
  const [sqlJsModule, wasmModule] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm'),
  ]);
  return sqlJsModule.default({
    wasmBinary: Uint8Array.from(wasmModule.default).buffer,
  });
}

function query(database: Database, sql: string, params: readonly SqlValue[] = []): AuthoritySnapshotRow[] {
  const statement = database.prepare(sql);
  try {
    if (params.length > 0) statement.bind([...params]);
    const rows: AuthoritySnapshotRow[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function one(database: Database, sql: string, params: readonly SqlValue[] = []): AuthoritySnapshotRow {
  const rows = query(database, sql, params);
  if (rows.length !== 1) throw snapshotError('host-transfer-authority-row-invalid');
  return rows[0];
}

function exactTimestamp(value: string, reason: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw snapshotError(reason);
  }
}

function latestEventSequence(database: Database): number {
  const value = one(database, 'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').sequence;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw snapshotError('host-transfer-authority-event-sequence-invalid');
  }
  return value;
}

function decodeProofChain(
  database: Database,
  projectId: CollabProjectId,
): readonly CollabHostTrustTransitionProof[] {
  return query(database, `
    SELECT transfer_id, previous_ca_fingerprint, next_ca_certificate_pem,
           next_ca_fingerprint, issued_at, signature_algorithm, signature
    FROM host_transition_proofs
    ORDER BY sequence ASC
  `).map(row => {
    if (
      typeof row.transfer_id !== 'string'
      || typeof row.previous_ca_fingerprint !== 'string'
      || typeof row.next_ca_certificate_pem !== 'string'
      || typeof row.next_ca_fingerprint !== 'string'
      || typeof row.issued_at !== 'string'
      || row.signature_algorithm !== 'rsa-pss-sha256'
      || typeof row.signature !== 'string'
    ) throw snapshotError('host-transfer-authority-proof-invalid');
    return Object.freeze({
      issuedAt: row.issued_at,
      nextCaCertificatePem: row.next_ca_certificate_pem,
      nextCaFingerprint: row.next_ca_fingerprint,
      previousCaFingerprint: row.previous_ca_fingerprint,
      projectId,
      schemaVersion: 1 as const,
      signature: row.signature,
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      transferId: row.transfer_id,
    });
  });
}

function assertSchema(database: Database, expectedVersion: 8 | 9 | 10 | 11): void {
  const version = one(database, 'PRAGMA user_version').user_version;
  if (version !== expectedVersion) {
    throw snapshotError('host-transfer-authority-schema-mismatch');
  }
}

export class HostTransferAuthoritySnapshot {
  private readonly loadSqlJs: () => Promise<SqlJsStatic>;
  private readonly trust: Pick<HostTrustTransitionService, 'verifyChain'>;

  constructor(options: HostTransferAuthoritySnapshotOptions = {}) {
    this.loadSqlJs = options.loadSqlJs ?? loadDefaultSqlJs;
    this.trust = options.trust ?? new HostTrustTransitionService();
  }

  async createInert(input: {
    readonly bytes: Uint8Array;
    readonly createdAt: CollabIsoTimestamp;
    readonly projectId: CollabProjectId;
    readonly proof: CollabHostTrustTransitionProof;
    readonly targetHostMemberId: CollabMemberId;
    readonly transferId: CollabOperationId;
  }): Promise<Uint8Array> {
    exactTimestamp(input.createdAt, 'host-transfer-authority-time-invalid');
    const database = await this.openCurrent(input.bytes);
    try {
      const project = one(database, `
        SELECT project_id, host_member_id, state FROM project WHERE singleton = 1
      `);
      const transfer = one(database, `
        SELECT source_host_member_id, target_host_member_id, phase,
               target_ca_fingerprint, manifest_digest, activation_certificate
        FROM host_transfer_operations WHERE transfer_id = ?
      `, [input.transferId]);
      const target = one(database, `
        SELECT status, credential_hash FROM members WHERE member_id = ?
      `, [input.targetHostMemberId]);
      if (
        project.project_id !== input.projectId
        || project.state !== 'active'
        || project.host_member_id !== transfer.source_host_member_id
        || transfer.target_host_member_id !== input.targetHostMemberId
        || transfer.phase !== 'quiescing'
        || transfer.target_ca_fingerprint !== input.proof.nextCaFingerprint
        || transfer.manifest_digest !== null
        || transfer.activation_certificate !== null
        || input.proof.projectId !== input.projectId
        || input.proof.transferId !== input.transferId
        || target.status !== 'active'
        || !(target.credential_hash instanceof Uint8Array)
        || target.credential_hash.byteLength !== 32
      ) throw snapshotError('host-transfer-authority-source-binding-invalid');

      database.run('BEGIN IMMEDIATE');
      try {
        database.run(`
          INSERT INTO host_transition_proofs (
            transfer_id, source_host_member_id, target_host_member_id,
            previous_ca_fingerprint, next_ca_certificate_pem, next_ca_fingerprint,
            issued_at, signature_algorithm, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          input.transferId,
          transfer.source_host_member_id,
          input.targetHostMemberId,
          input.proof.previousCaFingerprint,
          input.proof.nextCaCertificatePem,
          input.proof.nextCaFingerprint,
          input.proof.issuedAt,
          input.proof.signatureAlgorithm,
          input.proof.signature,
        ]);
        database.run(
          `UPDATE project SET host_member_id = ? WHERE singleton = 1 AND project_id = ?`,
          [input.targetHostMemberId, input.projectId],
        );
        database.run(`
          UPDATE host_transfer_operations
          SET phase = 'staged', receiver_credential = NULL, updated_at = ?
          WHERE transfer_id = ? AND phase = 'quiescing'
        `, [input.createdAt, input.transferId]);
        database.run(`
          INSERT INTO events (event_kind, actor_member_id, payload_json, created_at)
          VALUES ('host.transfer-changed', ?, ?, ?)
        `, [
          transfer.source_host_member_id,
          JSON.stringify({
            phase: 'staged',
            targetMemberId: input.targetHostMemberId,
            transferId: input.transferId,
          }),
          input.createdAt,
        ]);
        assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true });
        database.run('COMMIT');
      } catch (error) {
        database.run('ROLLBACK');
        throw error;
      }
      return Uint8Array.from(database.export());
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw snapshotError('host-transfer-authority-snapshot-create-failed');
    } finally {
      database.close();
    }
  }

  async inspectInert(input: {
    readonly bytes: Uint8Array;
    readonly manifest: HostTransferPackageManifest;
    readonly pinnedSourceCaCertificatePem: string;
    readonly sourceHostMemberId: CollabMemberId;
  }): Promise<InspectHostTransferAuthoritySnapshotResult> {
    const database = await this.openRaw(
      input.bytes,
      input.manifest.authoritySchemaVersion,
    );
    try {
      if (input.manifest.authoritySchemaVersion === COLLAB_AUTHORITY_SCHEMA_VERSION) {
        assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true });
      }
      return this.inspectOpenInert(database, input);
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw snapshotError('host-transfer-authority-inspection-failed');
    } finally {
      database.close();
    }
  }

  async validateRecoveryMigration(input: {
    readonly bytes: Uint8Array;
    readonly manifest: HostTransferPackageManifest;
    readonly pinnedSourceCaCertificatePem: string;
    readonly sourceHostMemberId: CollabMemberId;
  }): Promise<void> {
    if (input.manifest.authoritySchemaVersion === COLLAB_AUTHORITY_SCHEMA_VERSION) return;
    const database = await this.openRaw(input.bytes, input.manifest.authoritySchemaVersion);
    try {
      this.inspectOpenInert(database, input);
      migrateLegacyAuthorityDatabaseToCurrent(database);
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw snapshotError('host-transfer-authority-migration-failed');
    } finally {
      database.close();
    }
  }

  async activate(input: {
    readonly activationCertificate: HostTransferActivationCertificate;
    readonly bytes: Uint8Array;
    readonly manifest: HostTransferPackageManifest;
    readonly pinnedSourceCaCertificatePem: string;
    readonly sourceHostMemberId: CollabMemberId;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly eventSequence: number;
    readonly legacyActivatedBytes?: Uint8Array;
  }> {
    const certificate = input.activationCertificate;
    if (
      certificate.projectId !== input.manifest.projectId
      || certificate.transferId !== input.manifest.transferId
      || certificate.targetHostMemberId !== input.manifest.targetHostMemberId
      || certificate.targetCaFingerprint !== input.manifest.targetCaFingerprint
      || certificate.manifestDigest !== digestHostTransferPackageManifest(input.manifest)
    ) throw snapshotError('host-transfer-authority-activation-binding-invalid');
    exactTimestamp(certificate.cutoverAt, 'host-transfer-authority-activation-time-invalid');
    const database = await this.openRaw(
      input.bytes,
      input.manifest.authoritySchemaVersion,
    );
    try {
      if (input.manifest.authoritySchemaVersion === COLLAB_AUTHORITY_SCHEMA_VERSION) {
        assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true });
      }
      this.inspectOpenInert(database, input);
      const legacy = input.manifest.authoritySchemaVersion !== COLLAB_AUTHORITY_SCHEMA_VERSION;
      let legacyActivatedBytes: Uint8Array | undefined;
      if (legacy) {
        const legacyDatabase = await this.openRaw(
          input.bytes,
          input.manifest.authoritySchemaVersion,
        );
        try {
          this.applyActivation(legacyDatabase, certificate, false);
          legacyActivatedBytes = Uint8Array.from(legacyDatabase.export());
        } finally {
          legacyDatabase.close();
        }
        migrateLegacyAuthorityDatabaseToCurrent(database);
      }
      this.applyActivation(database, certificate, true);
      return {
        bytes: Uint8Array.from(database.export()),
        eventSequence: latestEventSequence(database),
        ...(legacyActivatedBytes ? { legacyActivatedBytes } : {}),
      };
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw snapshotError('host-transfer-authority-activation-failed');
    } finally {
      database.close();
    }
  }

  private applyActivation(
    database: Database,
    certificate: HostTransferActivationCertificate,
    auditCurrentSchema: boolean,
  ): void {
    database.run('BEGIN IMMEDIATE');
    try {
      database.run(`
        UPDATE host_transfer_operations
        SET phase = 'completed', manifest_digest = ?, activation_certificate = ?,
            receiver_credential = NULL, updated_at = ?
        WHERE transfer_id = ? AND phase = 'staged'
      `, [
        certificate.manifestDigest,
        JSON.stringify(certificate),
        certificate.cutoverAt,
        certificate.transferId,
      ]);
      if (database.getRowsModified() !== 1) {
        throw snapshotError('host-transfer-authority-activation-update-failed');
      }
      database.run(`
        INSERT INTO events (event_kind, actor_member_id, payload_json, created_at)
        VALUES ('host.transfer-changed', NULL, ?, ?)
      `, [
        JSON.stringify({
          phase: 'completed',
          targetMemberId: certificate.targetHostMemberId,
          transferId: certificate.transferId,
        }),
        certificate.cutoverAt,
      ]);
      database.run(`
        UPDATE project SET snapshot_generation = snapshot_generation + 1
        WHERE singleton = 1
      `);
      if (auditCurrentSchema) {
        assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true });
      }
      database.run('COMMIT');
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  }

  private async openCurrent(bytes: Uint8Array): Promise<Database> {
    const database = await this.openRaw(bytes, COLLAB_AUTHORITY_SCHEMA_VERSION);
    try {
      assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true });
      return database;
    } catch (error) {
      database.close();
      if (error instanceof CollabError) throw error;
      throw snapshotError('host-transfer-authority-open-failed');
    }
  }

  private async openRaw(
    bytes: Uint8Array,
    expectedSchemaVersion: 8 | 9 | 10 | 11,
  ): Promise<Database> {
    if (bytes.byteLength < 16 || Buffer.from(bytes.subarray(0, 16)).toString('binary') !== 'SQLite format 3\u0000') {
      throw snapshotError('host-transfer-authority-header-invalid');
    }
    const SQL = await this.loadSqlJs().catch(() => {
      throw snapshotError('host-transfer-authority-sql-initialize-failed');
    });
    let database: Database | null = null;
    try {
      database = new SQL.Database(Uint8Array.from(bytes));
      database.run('PRAGMA foreign_keys = ON');
      assertSchema(database, expectedSchemaVersion);
      return database;
    } catch (error) {
      database?.close();
      if (error instanceof CollabError) throw error;
      throw snapshotError('host-transfer-authority-open-failed');
    }
  }

  private inspectOpenInert(
    database: Database,
    input: {
      readonly manifest: HostTransferPackageManifest;
      readonly pinnedSourceCaCertificatePem: string;
      readonly sourceHostMemberId: CollabMemberId;
    },
  ): InspectHostTransferAuthoritySnapshotResult {
    const project = one(database, `
      SELECT project_id, host_member_id, main_ref, snapshot_generation, state
      FROM project WHERE singleton = 1
    `);
    const transfer = one(database, `
      SELECT source_host_member_id, target_host_member_id, phase, target_ca_fingerprint,
             receiver_credential, manifest_digest, activation_certificate
      FROM host_transfer_operations WHERE transfer_id = ?
    `, [input.manifest.transferId]);
    const invalidCredential = query(database, `
      SELECT member_id FROM members
      WHERE status = 'active'
        AND (typeof(credential_hash) != 'blob' OR length(credential_hash) != 32)
      LIMIT 1
    `).length > 0;
    if (
      project.project_id !== input.manifest.projectId
      || project.host_member_id !== input.manifest.targetHostMemberId
      || project.main_ref !== COLLAB_MAIN_REF
      || project.state !== 'active'
      || project.snapshot_generation !== input.manifest.sourceAuthorityGeneration
      || transfer.source_host_member_id !== input.sourceHostMemberId
      || transfer.target_host_member_id !== input.manifest.targetHostMemberId
      || transfer.phase !== 'staged'
      || transfer.target_ca_fingerprint !== input.manifest.targetCaFingerprint
      || transfer.receiver_credential !== null
      || transfer.manifest_digest !== null
      || transfer.activation_certificate !== null
      || invalidCredential
    ) throw snapshotError('host-transfer-authority-manifest-binding-invalid');
    const proofChain = decodeProofChain(database, input.manifest.projectId);
    const currentProofBinding = one(database, `
      SELECT source_host_member_id, target_host_member_id
      FROM host_transition_proofs WHERE transfer_id = ?
    `, [input.manifest.transferId]);
    if (
      proofChain.length < 1
      || proofChain.at(-1)?.transferId !== input.manifest.transferId
      || proofChain.at(-1)?.nextCaFingerprint !== input.manifest.targetCaFingerprint
      || currentProofBinding.source_host_member_id !== input.sourceHostMemberId
      || currentProofBinding.target_host_member_id !== input.manifest.targetHostMemberId
      || digestHostTransitionProofChain(proofChain) !== input.manifest.proofChainDigest
    ) throw snapshotError('host-transfer-authority-proof-chain-invalid');
    this.trust.verifyChain({
      expectedCurrentCaFingerprint: input.manifest.targetCaFingerprint,
      pinnedCaCertificatePem: input.pinnedSourceCaCertificatePem,
      projectId: input.manifest.projectId,
      proofs: proofChain,
    });
    const memberRefs = query(database, `
      SELECT personal_ref FROM members
      WHERE status IN ('pending', 'active')
      ORDER BY personal_ref ASC
    `).map(row => {
      if (typeof row.personal_ref !== 'string') {
        throw snapshotError('host-transfer-authority-member-ref-invalid');
      }
      return row.personal_ref;
    });
    return Object.freeze({
      eventSequence: latestEventSequence(database),
      expectedRefs: Object.freeze([COLLAB_MAIN_REF, ...memberRefs]),
      proofChain,
    });
  }
}
