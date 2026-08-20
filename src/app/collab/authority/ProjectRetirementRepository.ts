import { type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface ProjectRetirementPrepareInput {
  readonly actorMemberId: CollabMemberId;
  readonly expectedHostMemberId: CollabMemberId;
  readonly managerActorMemberId: CollabMemberId;
  readonly idempotencyKey: string;
  readonly operationId: CollabOperationId;
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
  readonly updatedAt: string;
}

export interface ProjectRetirementFormerMember {
  readonly credentialHash: string;
  readonly memberId: CollabMemberId;
}

export interface PreparedProjectRetirement {
  readonly actorMemberId: CollabMemberId;
  readonly formerMembers: readonly ProjectRetirementFormerMember[];
  readonly hostTransitionProofs: readonly CollabHostTrustTransitionProof[];
  readonly idempotencyKey: string;
  readonly operationId: CollabOperationId;
  readonly phase: 'quiescing' | 'tombstone-committed';
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
  readonly retiredAt: string | null;
}

function retirementError(
  code:
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'host-transfer-pending'
    | 'idempotency-conflict'
    | 'project-not-found'
    | 'project-retired'
    | 'stale-project-selection',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'authority-integrity-error'
      ? ['open-diagnostics']
      : code === 'stale-project-selection'
        ? ['retry']
        : [],
    safeContext: { reason },
  });
}

function assertId(
  value: string,
  predicate: (candidate: unknown) => candidate is string,
  reason: string,
): void {
  if (!predicate(value)) throw retirementError('authority-integrity-error', reason);
}

function assertTimestamp(value: string, reason: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw retirementError('authority-integrity-error', reason);
  }
}

function requiredText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw retirementError('authority-integrity-error', 'retirement-row-invalid');
  }
  return value;
}

function proofFromRow(
  row: Readonly<Record<string, unknown>>,
  projectId: CollabProjectId,
): CollabHostTrustTransitionProof {
  const issuedAt = requiredText(row, 'issued_at');
  const signatureAlgorithm = requiredText(row, 'signature_algorithm');
  if (signatureAlgorithm !== 'rsa-pss-sha256') {
    throw retirementError('authority-integrity-error', 'host-transition-proof-invalid');
  }
  assertTimestamp(issuedAt, 'host-transition-proof-invalid');
  const transferId = requiredText(row, 'transfer_id');
  assertId(transferId, isCollabOpaqueId, 'host-transition-proof-invalid');
  return {
    issuedAt,
    nextCaCertificatePem: requiredText(row, 'next_ca_certificate_pem'),
    nextCaFingerprint: requiredText(row, 'next_ca_fingerprint'),
    previousCaFingerprint: requiredText(row, 'previous_ca_fingerprint'),
    projectId,
    schemaVersion: 1,
    signature: requiredText(row, 'signature'),
    signatureAlgorithm,
    transferId,
  };
}

export class ProjectRetirementRepository {
  private readonly managers = new ManagerSetRepository();

  prepare(
    connection: AuthorityDatabaseConnection,
    input: ProjectRetirementPrepareInput,
  ): PreparedProjectRetirement {
    assertId(input.actorMemberId, isCollabMemberId, 'retirement-actor-invalid');
    assertId(input.expectedHostMemberId, isCollabMemberId, 'retirement-host-invalid');
    assertId(input.managerActorMemberId, isCollabMemberId, 'retirement-manager-invalid');
    assertId(input.operationId, isCollabOpaqueId, 'retirement-operation-invalid');
    assertId(input.projectId, isCollabProjectId, 'retirement-project-invalid');
    assertId(input.idempotencyKey, isCollabOpaqueId, 'retirement-idempotency-invalid');
    assertTimestamp(input.updatedAt, 'retirement-timestamp-invalid');
    if (!DIGEST_PATTERN.test(input.requestFingerprint)) {
      throw retirementError('authority-integrity-error', 'retirement-fingerprint-invalid');
    }
    if (input.managerActorMemberId !== input.actorMemberId) {
      throw retirementError('authorization-denied', 'retirement-actor-mismatch');
    }

    const existing = this.get(connection);
    if (existing) {
      if (
        existing.actorMemberId !== input.actorMemberId
        || existing.idempotencyKey !== input.idempotencyKey
        || existing.operationId !== input.operationId
      ) {
        throw retirementError('project-retired', 'retirement-already-started');
      }
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw retirementError('idempotency-conflict', 'retirement-intent-changed');
      }
      return existing;
    }

    const project = connection.get(`
      SELECT project_id, state, host_member_id
      FROM project WHERE singleton = 1
    `);
    if (!project || project.project_id !== input.projectId) {
      throw retirementError('project-not-found', 'retirement-project-missing');
    }
    if (project.state !== 'active') {
      throw retirementError('project-retired', 'retirement-project-inactive');
    }
    if (project.host_member_id !== input.expectedHostMemberId) {
      throw retirementError('stale-project-selection', 'retirement-responsibility-changed');
    }
    this.managers.requireActiveManager(connection, input.actorMemberId);
    const pendingHostTransfer = connection.get(`
      SELECT transfer_id FROM host_transfer_operations
      WHERE phase IN (
        'offered', 'accepted', 'quiescing', 'staged',
        'authority-relinquished', 'target-active'
      ) LIMIT 1
    `);
    if (pendingHostTransfer) {
      throw retirementError('host-transfer-pending', 'retirement-host-transfer-pending');
    }

    connection.run(`
      INSERT INTO project_terminal_transitions (
        singleton, operation_id, kind, actor_member_id, idempotency_key,
        request_fingerprint, phase, retired_at, updated_at
      ) VALUES (1, ?, 'retire', ?, ?, ?, 'quiescing', NULL, ?)
    `, [
      input.operationId,
      input.actorMemberId,
      input.idempotencyKey,
      input.requestFingerprint,
      input.updatedAt,
    ]);
    return this.get(connection)!;
  }

  get(connection: AuthorityDatabaseConnection): PreparedProjectRetirement | null {
    const row = connection.get(`
      SELECT operation_id, actor_member_id, idempotency_key,
             request_fingerprint, phase, retired_at
      FROM project_terminal_transitions WHERE singleton = 1
    `);
    if (!row) return null;
    const project = connection.get('SELECT project_id FROM project WHERE singleton = 1');
    if (!project || typeof project.project_id !== 'string') {
      throw retirementError('authority-integrity-error', 'retirement-project-row-invalid');
    }
    const projectId = project.project_id;
    const phase = row.phase;
    const retiredAt = row.retired_at;
    if (
      (phase !== 'quiescing' && phase !== 'tombstone-committed')
      || (typeof retiredAt !== 'string' && retiredAt !== null)
    ) {
      throw retirementError('authority-integrity-error', 'retirement-row-invalid');
    }
    const formerMembers = connection.all(`
      SELECT member_id, credential_hash
      FROM members WHERE status = 'active'
      ORDER BY created_at, member_id
    `).map(member => {
      if (
        typeof member.member_id !== 'string'
        || !(member.credential_hash instanceof Uint8Array)
        || member.credential_hash.byteLength !== 32
      ) {
        throw retirementError('authority-integrity-error', 'retirement-member-row-invalid');
      }
      return {
        credentialHash: Buffer.from(member.credential_hash).toString('hex'),
        memberId: member.member_id,
      };
    });
    if (formerMembers.length === 0) {
      throw retirementError('authority-integrity-error', 'retirement-member-set-empty');
    }
    const proofs = connection.all(`
      SELECT transfer_id, previous_ca_fingerprint, next_ca_certificate_pem,
             next_ca_fingerprint, issued_at, signature_algorithm, signature
      FROM host_transition_proofs ORDER BY sequence
    `).map(proof => proofFromRow(proof, projectId));
    return {
      actorMemberId: requiredText(row, 'actor_member_id'),
      formerMembers,
      hostTransitionProofs: proofs,
      idempotencyKey: requiredText(row, 'idempotency_key'),
      operationId: requiredText(row, 'operation_id'),
      phase,
      projectId,
      requestFingerprint: requiredText(row, 'request_fingerprint'),
      retiredAt,
    };
  }

  commit(
    connection: AuthorityDatabaseConnection,
    operationId: CollabOperationId,
    retiredAt: string,
  ): PreparedProjectRetirement {
    assertTimestamp(retiredAt, 'retirement-timestamp-invalid');
    const current = this.get(connection);
    if (!current || current.operationId !== operationId) {
      throw retirementError('authority-integrity-error', 'retirement-operation-missing');
    }
    if (current.phase === 'tombstone-committed') {
      if (current.retiredAt !== retiredAt) {
        throw retirementError('authority-integrity-error', 'retirement-result-mismatch');
      }
      return current;
    }
    connection.run(`
      UPDATE project_terminal_transitions
      SET phase = 'tombstone-committed', retired_at = ?, updated_at = ?
      WHERE singleton = 1 AND operation_id = ? AND phase = 'quiescing'
    `, [retiredAt, retiredAt, operationId]);
    connection.run("UPDATE project SET state = 'disabled' WHERE singleton = 1 AND state = 'active'");
    const committed = this.get(connection);
    if (!committed || committed.phase !== 'tombstone-committed') {
      throw retirementError('authority-integrity-error', 'retirement-commit-failed');
    }
    return committed;
  }
}
