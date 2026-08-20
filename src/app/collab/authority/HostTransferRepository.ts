import { type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import {
  assertHostTransferTransition,
  type HostTransferDurablePhase,
} from '@/app/collab/host-transfer/HostTransferPhaseMachine';
import type { HostTransferActivationCertificate } from '@/app/collab/host-transfer/HostTrustTransitionService';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HostTransferAuthorityRecord {
  readonly transferId: CollabOperationId;
  readonly sourceHostMemberId: CollabMemberId;
  readonly targetHostMemberId: CollabMemberId;
  readonly phase: HostTransferDurablePhase;
  readonly offeredAt: string;
  readonly expiresAt: string;
  readonly targetEndpoint: string | null;
  readonly targetCaCertificatePem: string | null;
  readonly targetCaFingerprint: string | null;
  readonly receiverCredential: string | null;
  readonly manifestDigest: string | null;
  readonly activationCertificate: HostTransferActivationCertificate | null;
  readonly updatedAt: string;
}

interface HostTransferContext {
  readonly projectId: CollabProjectId;
  readonly hostMemberId: CollabMemberId;
}

function repositoryError(
  reason: string,
  code:
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'host-transfer-pending'
    | 'idempotency-conflict'
    | 'membership-revoked'
    | 'project-not-found'
    | 'stale-project-selection' = 'authority-integrity-error',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'authority-integrity-error' ? ['open-diagnostics'] : [],
    safeContext: { reason },
  });
}

function text(
  row: Readonly<Record<string, unknown>>,
  key: string,
  nullable = false,
): string | null {
  const value = row[key];
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw repositoryError('host-transfer-row-invalid');
  return value;
}

function timestamp(value: string, reason: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw repositoryError(reason);
  }
}

function identity(
  value: string,
  predicate: (candidate: unknown) => candidate is string,
  reason: string,
): void {
  if (!predicate(value)) throw repositoryError(reason);
}

function decodeActivation(value: string | null): HostTransferActivationCertificate | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(value) as HostTransferActivationCertificate;
    if (
      !decoded
      || typeof decoded !== 'object'
      || decoded.schemaVersion !== 1
      || decoded.signatureAlgorithm !== 'rsa-pss-sha256'
      || !isCollabProjectId(decoded.projectId)
      || !isCollabOpaqueId(decoded.transferId)
      || !isCollabMemberId(decoded.targetHostMemberId)
      || !DIGEST_PATTERN.test(decoded.targetCaFingerprint)
      || !DIGEST_PATTERN.test(decoded.manifestDigest)
      || typeof decoded.signature !== 'string'
    ) throw new Error('Invalid activation');
    timestamp(decoded.cutoverAt, 'host-transfer-activation-time-invalid');
    return Object.freeze({ ...decoded });
  } catch {
    throw repositoryError('host-transfer-activation-invalid');
  }
}

function decodeRow(row: Readonly<Record<string, unknown>>): HostTransferAuthorityRecord {
  const phase = text(row, 'phase');
  if (
    phase !== 'offered'
    && phase !== 'accepted'
    && phase !== 'quiescing'
    && phase !== 'staged'
    && phase !== 'authority-relinquished'
    && phase !== 'target-active'
    && phase !== 'completed'
    && phase !== 'cancelled'
    && phase !== 'declined'
    && phase !== 'expired'
  ) throw repositoryError('host-transfer-phase-invalid');
  const transferId = text(row, 'transfer_id')!;
  const sourceHostMemberId = text(row, 'source_host_member_id')!;
  const targetHostMemberId = text(row, 'target_host_member_id')!;
  const offeredAt = text(row, 'offered_at')!;
  const expiresAt = text(row, 'expires_at')!;
  const updatedAt = text(row, 'updated_at')!;
  identity(transferId, isCollabOpaqueId, 'host-transfer-id-invalid');
  identity(sourceHostMemberId, isCollabMemberId, 'host-transfer-source-invalid');
  identity(targetHostMemberId, isCollabMemberId, 'host-transfer-target-invalid');
  timestamp(offeredAt, 'host-transfer-offered-time-invalid');
  timestamp(expiresAt, 'host-transfer-expiry-invalid');
  timestamp(updatedAt, 'host-transfer-updated-time-invalid');
  const targetEndpoint = text(row, 'target_endpoint', true);
  const targetCaCertificatePem = text(row, 'target_ca_certificate_pem', true);
  const targetCaFingerprint = text(row, 'target_ca_fingerprint', true);
  const receiverCredential = text(row, 'receiver_credential', true);
  const manifestDigest = text(row, 'manifest_digest', true);
  if (
    (targetCaFingerprint !== null && !DIGEST_PATTERN.test(targetCaFingerprint))
    || (receiverCredential !== null && !CREDENTIAL_PATTERN.test(receiverCredential))
    || (manifestDigest !== null && !DIGEST_PATTERN.test(manifestDigest))
  ) throw repositoryError('host-transfer-private-state-invalid');
  const record = {
    activationCertificate: decodeActivation(text(row, 'activation_certificate', true)),
    expiresAt,
    manifestDigest,
    offeredAt,
    phase,
    sourceHostMemberId,
    targetCaCertificatePem,
    targetCaFingerprint,
    targetEndpoint,
    targetHostMemberId,
    transferId,
    updatedAt,
  } as Omit<HostTransferAuthorityRecord, 'receiverCredential'> & {
    receiverCredential?: string | null;
  };
  Object.defineProperty(record, 'receiverCredential', {
    configurable: false,
    enumerable: false,
    value: receiverCredential,
    writable: false,
  });
  Object.defineProperty(record, 'toJSON', {
    configurable: false,
    enumerable: false,
    value: () => ({
      expiresAt,
      offeredAt,
      phase,
      sourceHostMemberId,
      targetHostMemberId,
      transferId,
      updatedAt,
    }),
    writable: false,
  });
  return Object.freeze(record as HostTransferAuthorityRecord);
}

const SELECT_TRANSFER = `
  SELECT transfer_id, source_host_member_id, target_host_member_id, phase,
         offered_at, expires_at, target_endpoint, target_ca_certificate_pem,
         target_ca_fingerprint, receiver_credential, manifest_digest,
         activation_certificate, updated_at
  FROM host_transfer_operations
`;

export class HostTransferRepository {
  assertActiveActor(
    connection: AuthorityDatabaseConnection,
    projectId: CollabProjectId,
    actorMemberId: CollabMemberId,
  ): void {
    this.requireActiveActor(connection, projectId, actorMemberId);
  }

  findIdempotency<T>(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly idempotencyKey: string;
      readonly requestFingerprint: string;
    },
  ): T | null {
    this.assertIdempotency(input);
    const row = connection.get(
      `SELECT request_fingerprint, response_json
       FROM idempotency_results
       WHERE actor_member_id = ? AND operation_kind = 'transfer-host'
         AND idempotency_key = ?`,
      [input.actorMemberId, input.idempotencyKey],
    );
    if (!row) return null;
    if (row.request_fingerprint !== input.requestFingerprint) {
      throw repositoryError('host-transfer-idempotency-conflict', 'idempotency-conflict');
    }
    if (typeof row.response_json !== 'string') {
      throw repositoryError('host-transfer-idempotency-row-invalid');
    }
    try {
      return JSON.parse(row.response_json) as T;
    } catch {
      throw repositoryError('host-transfer-idempotency-row-invalid');
    }
  }

  storeIdempotency<T>(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly requestFingerprint: string;
      readonly response: T;
    },
  ): T {
    this.assertIdempotency(input);
    timestamp(input.createdAt, 'host-transfer-idempotency-time-invalid');
    const existing = this.findIdempotency<T>(connection, input);
    if (existing) return existing;
    let responseJson: string;
    try {
      responseJson = JSON.stringify(input.response);
    } catch {
      throw repositoryError('host-transfer-idempotency-response-invalid');
    }
    connection.run(
      `INSERT INTO idempotency_results (
        actor_member_id, operation_kind, idempotency_key, request_fingerprint,
        response_json, created_at
      ) VALUES (?, 'transfer-host', ?, ?, ?, ?)`,
      [
        input.actorMemberId,
        input.idempotencyKey,
        input.requestFingerprint,
        responseJson,
        input.createdAt,
      ],
    );
    return input.response;
  }

  get(
    connection: AuthorityDatabaseConnection,
    transferId: CollabOperationId,
  ): HostTransferAuthorityRecord | null {
    identity(transferId, isCollabOpaqueId, 'host-transfer-id-invalid');
    const row = connection.get(`${SELECT_TRANSFER} WHERE transfer_id = ?`, [transferId]);
    return row ? decodeRow(row) : null;
  }

  getNonterminal(connection: AuthorityDatabaseConnection): HostTransferAuthorityRecord | null {
    const row = connection.get(`${SELECT_TRANSFER}
      WHERE phase IN (
        'offered', 'accepted', 'quiescing', 'staged',
        'authority-relinquished', 'target-active'
      )
    `);
    return row ? decodeRow(row) : null;
  }

  expireOfferedDue(
    connection: AuthorityDatabaseConnection,
    expiredAt: string,
  ): HostTransferAuthorityRecord | null {
    timestamp(expiredAt, 'host-transfer-expiry-check-invalid');
    const current = this.getNonterminal(connection);
    if (
      !current
      || current.phase !== 'offered'
      || current.expiresAt > expiredAt
    ) return current;
    this.transition(
      connection,
      current.transferId,
      'offered',
      'expired',
      expiredAt,
      true,
    );
    return this.requirePhase(connection, current.transferId, 'expired');
  }

  createOffer(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly expiresAt: string;
      readonly offeredAt: string;
      readonly projectId: CollabProjectId;
      readonly targetHostMemberId: CollabMemberId;
      readonly transferId: CollabOperationId;
    },
  ): HostTransferAuthorityRecord {
    const context = this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    if (context.hostMemberId !== input.actorMemberId) {
      throw repositoryError('host-transfer-host-required', 'authorization-denied');
    }
    identity(input.transferId, isCollabOpaqueId, 'host-transfer-id-invalid');
    identity(input.targetHostMemberId, isCollabMemberId, 'host-transfer-target-invalid');
    timestamp(input.offeredAt, 'host-transfer-offered-time-invalid');
    timestamp(input.expiresAt, 'host-transfer-expiry-invalid');
    if (input.expiresAt <= input.offeredAt) throw repositoryError('host-transfer-expiry-invalid');
    if (this.getNonterminal(connection)) {
      throw repositoryError('host-transfer-already-pending', 'host-transfer-pending');
    }
    const target = connection.get(
      'SELECT status FROM members WHERE member_id = ?',
      [input.targetHostMemberId],
    );
    if (!target || target.status !== 'active') {
      throw repositoryError('host-transfer-target-not-active', 'membership-revoked');
    }
    if (input.targetHostMemberId === input.actorMemberId) {
      throw repositoryError('host-transfer-target-is-host', 'authorization-denied');
    }
    connection.run(
      `INSERT INTO host_transfer_operations (
        transfer_id, source_host_member_id, target_host_member_id, phase,
        offered_at, expires_at, target_endpoint, target_ca_certificate_pem,
        target_ca_fingerprint, receiver_credential, manifest_digest,
        activation_certificate, updated_at
      ) VALUES (?, ?, ?, 'offered', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        input.transferId,
        input.actorMemberId,
        input.targetHostMemberId,
        input.offeredAt,
        input.expiresAt,
        input.offeredAt,
      ],
    );
    return this.require(connection, input.transferId);
  }

  accept(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly projectId: CollabProjectId;
      readonly receiverCredential: string;
      readonly targetCaCertificatePem: string;
      readonly targetCaFingerprint: string;
      readonly targetEndpoint: string;
      readonly transferId: CollabOperationId;
      readonly updatedAt: string;
    },
  ): HostTransferAuthorityRecord {
    this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    const current = this.require(connection, input.transferId);
    if (current.targetHostMemberId !== input.actorMemberId) {
      throw repositoryError('host-transfer-target-required', 'authorization-denied');
    }
    if (current.phase === 'accepted') {
      if (
        current.targetEndpoint !== input.targetEndpoint
        || current.targetCaCertificatePem !== input.targetCaCertificatePem
        || current.targetCaFingerprint !== input.targetCaFingerprint
        || current.receiverCredential !== input.receiverCredential
      ) throw repositoryError('host-transfer-accept-replay-mismatch', 'stale-project-selection');
      return current;
    }
    assertHostTransferTransition(current.phase, 'accepted');
    if (input.updatedAt >= current.expiresAt) {
      this.transition(connection, input.transferId, current.phase, 'expired', input.updatedAt);
      return this.requirePhase(connection, input.transferId, 'expired');
    }
    connection.run(
      `UPDATE host_transfer_operations
       SET phase = 'accepted', target_endpoint = ?, target_ca_certificate_pem = ?,
           target_ca_fingerprint = ?, receiver_credential = ?, updated_at = ?
       WHERE transfer_id = ? AND phase = 'offered'`,
      [
        input.targetEndpoint,
        input.targetCaCertificatePem,
        input.targetCaFingerprint,
        input.receiverCredential,
        input.updatedAt,
        input.transferId,
      ],
    );
    return this.requirePhase(connection, input.transferId, 'accepted');
  }

  terminateBeforeRelinquishment(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly phase: 'cancelled' | 'declined';
      readonly projectId: CollabProjectId;
      readonly transferId: CollabOperationId;
      readonly updatedAt: string;
    },
  ): HostTransferAuthorityRecord {
    const context = this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    const current = this.require(connection, input.transferId);
    if (
      (input.phase === 'cancelled' && context.hostMemberId !== input.actorMemberId)
      || (input.phase === 'declined' && current.targetHostMemberId !== input.actorMemberId)
    ) throw repositoryError('host-transfer-actor-invalid', 'authorization-denied');
    if (current.phase === input.phase) return current;
    const canTerminate = current.phase === 'offered'
      || current.phase === 'accepted'
      || (input.phase === 'cancelled'
        && (current.phase === 'quiescing' || current.phase === 'staged'));
    if (!canTerminate) {
      throw repositoryError('host-transfer-user-cancel-unavailable', 'host-transfer-pending');
    }
    this.transition(connection, input.transferId, current.phase, input.phase, input.updatedAt, true);
    return this.requirePhase(connection, input.transferId, input.phase);
  }

  advance(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly expectedPhase: HostTransferDurablePhase;
      readonly manifestDigest?: string;
      readonly nextPhase: HostTransferDurablePhase;
      readonly transferId: CollabOperationId;
      readonly updatedAt: string;
    },
  ): HostTransferAuthorityRecord {
    const current = this.require(connection, input.transferId);
    if (current.phase === input.nextPhase) {
      if (input.manifestDigest !== undefined && current.manifestDigest !== input.manifestDigest) {
        throw repositoryError('host-transfer-manifest-replay-mismatch');
      }
      return current;
    }
    if (current.phase !== input.expectedPhase) {
      throw repositoryError('host-transfer-phase-stale', 'stale-project-selection');
    }
    assertHostTransferTransition(current.phase, input.nextPhase);
    if (input.nextPhase === 'staged') {
      if (!input.manifestDigest || !DIGEST_PATTERN.test(input.manifestDigest)) {
        throw repositoryError('host-transfer-manifest-digest-invalid');
      }
      connection.run(
        `UPDATE host_transfer_operations
         SET phase = ?, manifest_digest = ?, updated_at = ?
         WHERE transfer_id = ? AND phase = ?`,
        [input.nextPhase, input.manifestDigest, input.updatedAt, input.transferId, input.expectedPhase],
      );
    } else {
      this.transition(
        connection,
        input.transferId,
        input.expectedPhase,
        input.nextPhase,
        input.updatedAt,
        input.nextPhase === 'completed'
          || input.nextPhase === 'cancelled'
          || input.nextPhase === 'declined'
          || input.nextPhase === 'expired',
      );
    }
    return this.requirePhase(connection, input.transferId, input.nextPhase);
  }

  relinquishAuthority(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly activationCertificate: HostTransferActivationCertificate;
      readonly projectId: CollabProjectId;
      readonly proof: CollabHostTrustTransitionProof;
      readonly sourceHostMemberId: CollabMemberId;
      readonly targetHostMemberId: CollabMemberId;
      readonly transferId: CollabOperationId;
      readonly updatedAt: string;
    },
  ): HostTransferAuthorityRecord {
    const current = this.require(connection, input.transferId);
    if (current.phase === 'authority-relinquished') {
      const proof = connection.get(
        `SELECT previous_ca_fingerprint, next_ca_certificate_pem,
                next_ca_fingerprint, issued_at, signature_algorithm, signature
         FROM host_transition_proofs WHERE transfer_id = ?`,
        [input.transferId],
      );
      if (
        JSON.stringify(current.activationCertificate) !== JSON.stringify(input.activationCertificate)
        || proof?.previous_ca_fingerprint !== input.proof.previousCaFingerprint
        || proof?.next_ca_certificate_pem !== input.proof.nextCaCertificatePem
        || proof?.next_ca_fingerprint !== input.proof.nextCaFingerprint
        || proof?.issued_at !== input.proof.issuedAt
        || proof?.signature_algorithm !== input.proof.signatureAlgorithm
        || proof?.signature !== input.proof.signature
      ) throw repositoryError('host-transfer-relinquishment-replay-mismatch');
      return current;
    }
    if (
      current.phase !== 'staged'
      || current.sourceHostMemberId !== input.sourceHostMemberId
      || current.targetHostMemberId !== input.targetHostMemberId
      || input.proof.transferId !== input.transferId
      || input.proof.projectId !== input.projectId
      || input.activationCertificate.transferId !== input.transferId
      || input.activationCertificate.projectId !== input.projectId
      || input.activationCertificate.targetHostMemberId !== input.targetHostMemberId
      || input.activationCertificate.manifestDigest !== current.manifestDigest
    ) throw repositoryError('host-transfer-relinquishment-binding-invalid');
    assertHostTransferTransition(current.phase, 'authority-relinquished');
    connection.run(
      `INSERT INTO host_transition_proofs (
        transfer_id, source_host_member_id, target_host_member_id,
        previous_ca_fingerprint, next_ca_certificate_pem, next_ca_fingerprint,
        issued_at, signature_algorithm, signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.transferId,
        input.sourceHostMemberId,
        input.targetHostMemberId,
        input.proof.previousCaFingerprint,
        input.proof.nextCaCertificatePem,
        input.proof.nextCaFingerprint,
        input.proof.issuedAt,
        input.proof.signatureAlgorithm,
        input.proof.signature,
      ],
    );
    connection.run(
      `UPDATE project SET host_member_id = ?
       WHERE singleton = 1 AND project_id = ? AND host_member_id = ?`,
      [input.targetHostMemberId, input.projectId, input.sourceHostMemberId],
    );
    connection.run(
      `UPDATE host_transfer_operations
       SET phase = 'authority-relinquished', activation_certificate = ?, updated_at = ?
       WHERE transfer_id = ? AND phase = 'staged'`,
      [JSON.stringify(input.activationCertificate), input.updatedAt, input.transferId],
    );
    const project = connection.get(
      'SELECT host_member_id FROM project WHERE singleton = 1 AND project_id = ?',
      [input.projectId],
    );
    if (project?.host_member_id !== input.targetHostMemberId) {
      throw repositoryError('host-transfer-host-pointer-update-failed');
    }
    return this.requirePhase(connection, input.transferId, 'authority-relinquished');
  }

  listProofs(connection: AuthorityDatabaseConnection): readonly CollabHostTrustTransitionProof[] {
    return connection.all(
      `SELECT transfer_id, previous_ca_fingerprint, next_ca_certificate_pem,
              next_ca_fingerprint, issued_at, signature_algorithm, signature
       FROM host_transition_proofs ORDER BY sequence ASC`,
    ).map(row => {
      const signatureAlgorithm = text(row, 'signature_algorithm');
      if (signatureAlgorithm !== 'rsa-pss-sha256') {
        throw repositoryError('host-transition-proof-row-invalid');
      }
      return Object.freeze({
        issuedAt: text(row, 'issued_at')!,
        nextCaCertificatePem: text(row, 'next_ca_certificate_pem')!,
        nextCaFingerprint: text(row, 'next_ca_fingerprint')!,
        previousCaFingerprint: text(row, 'previous_ca_fingerprint')!,
        projectId: this.projectId(connection),
        schemaVersion: 1 as const,
        signature: text(row, 'signature')!,
        signatureAlgorithm,
        transferId: text(row, 'transfer_id')!,
      });
    });
  }

  private transition(
    connection: AuthorityDatabaseConnection,
    transferId: CollabOperationId,
    expectedPhase: HostTransferDurablePhase,
    nextPhase: HostTransferDurablePhase,
    updatedAt: string,
    clearCredential = false,
  ): void {
    timestamp(updatedAt, 'host-transfer-updated-time-invalid');
    assertHostTransferTransition(expectedPhase, nextPhase);
    connection.run(
      `UPDATE host_transfer_operations
       SET phase = ?, updated_at = ?${clearCredential ? ', receiver_credential = NULL' : ''}
       WHERE transfer_id = ? AND phase = ?`,
      [nextPhase, updatedAt, transferId, expectedPhase],
    );
  }

  private require(
    connection: AuthorityDatabaseConnection,
    transferId: CollabOperationId,
  ): HostTransferAuthorityRecord {
    const record = this.get(connection, transferId);
    if (!record) throw repositoryError('host-transfer-not-found', 'project-not-found');
    return record;
  }

  private requirePhase(
    connection: AuthorityDatabaseConnection,
    transferId: CollabOperationId,
    phase: HostTransferDurablePhase,
  ): HostTransferAuthorityRecord {
    const record = this.require(connection, transferId);
    if (record.phase !== phase) throw repositoryError('host-transfer-phase-update-failed');
    return record;
  }

  private requireActiveActor(
    connection: AuthorityDatabaseConnection,
    projectId: CollabProjectId,
    actorMemberId: CollabMemberId,
  ): HostTransferContext {
    identity(projectId, isCollabProjectId, 'host-transfer-project-invalid');
    identity(actorMemberId, isCollabMemberId, 'host-transfer-actor-invalid');
    const project = connection.get(
      'SELECT project_id, host_member_id, state FROM project WHERE singleton = 1',
    );
    if (!project || project.project_id !== projectId) {
      throw repositoryError('host-transfer-project-not-found', 'project-not-found');
    }
    if (project.state !== 'active') {
      throw repositoryError('host-transfer-project-inactive', 'authorization-denied');
    }
    const actor = connection.get(
      'SELECT status FROM members WHERE member_id = ?',
      [actorMemberId],
    );
    if (!actor || actor.status !== 'active') {
      throw repositoryError('host-transfer-actor-not-active', 'membership-revoked');
    }
    if (typeof project.host_member_id !== 'string') {
      throw repositoryError('host-transfer-project-row-invalid');
    }
    return { hostMemberId: project.host_member_id, projectId };
  }

  private projectId(connection: AuthorityDatabaseConnection): CollabProjectId {
    const projectId = connection.get('SELECT project_id FROM project WHERE singleton = 1')?.project_id;
    if (typeof projectId !== 'string') throw repositoryError('host-transfer-project-row-invalid');
    return projectId;
  }

  private assertIdempotency(input: {
    readonly actorMemberId: CollabMemberId;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  }): void {
    identity(input.actorMemberId, isCollabMemberId, 'host-transfer-idempotency-actor-invalid');
    if (
      input.idempotencyKey.length < 1
      || input.idempotencyKey.length > 128
      || input.idempotencyKey.includes('\u0000')
      || input.idempotencyKey.includes('\r')
      || input.idempotencyKey.includes('\n')
      || !DIGEST_PATTERN.test(input.requestFingerprint)
    ) throw repositoryError('host-transfer-idempotency-input-invalid');
  }
}
