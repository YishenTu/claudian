import { createHash, randomUUID } from 'node:crypto';

import { type CollabMemberId, type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import type { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import {
  type HostTransferAuthorityRecord,
  HostTransferRepository,
} from '@/app/collab/authority/HostTransferRepository';
import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type { HostTransferDurablePhase } from '@/app/collab/host-transfer/HostTransferPhaseMachine';
import type { HostTransferActivationCertificate } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import type {
  AcceptHostTransferRequest,
  CancelHostTransferRequest,
  CreateHostTransferRequest,
  DeclineHostTransferRequest,
} from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabHostTransferSummary, CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const HOST_TRANSFER_OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HostTransferAuthorityDatabasePort {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

export interface HostTransferAuthority {
  readonly database: HostTransferAuthorityDatabasePort;
  readonly events: AuthorityEventRepository;
}

export interface HostTransferAuthorityServiceOptions {
  readonly createTransferId?: () => CollabOperationId;
  readonly now?: () => Date;
}

export interface AdvanceHostTransferInput {
  readonly expectedPhase: HostTransferDurablePhase;
  readonly manifestDigest?: string;
  readonly nextPhase: HostTransferDurablePhase;
  readonly transferId: CollabOperationId;
}

export interface RelinquishHostAuthorityInput {
  readonly activationCertificate: HostTransferActivationCertificate;
  readonly previousCaCertificatePem: string;
  readonly projectId: CollabProjectId;
  readonly proof: CollabHostTrustTransitionProof;
  readonly transferId: CollabOperationId;
}

function serviceError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function publicPhase(phase: HostTransferDurablePhase): CollabHostTransferSummary['phase'] {
  if (
    phase === 'quiescing'
    || phase === 'staged'
    || phase === 'authority-relinquished'
    || phase === 'target-active'
  ) return 'transferring';
  return phase;
}

function summary(
  record: HostTransferAuthorityRecord,
  actorMemberId: CollabMemberId,
): CollabHostTransferSummary {
  const beforeRelinquishment = record.phase === 'offered'
    || record.phase === 'accepted'
    || record.phase === 'quiescing'
    || record.phase === 'staged';
  const beforeQuiescing = record.phase === 'offered' || record.phase === 'accepted';
  return Object.freeze({
    canAccept: record.phase === 'offered' && record.targetHostMemberId === actorMemberId,
    canCancel: beforeRelinquishment && record.sourceHostMemberId === actorMemberId,
    canDecline: beforeQuiescing && record.targetHostMemberId === actorMemberId,
    expiresAt: record.expiresAt,
    offeredAt: record.offeredAt,
    phase: publicPhase(record.phase),
    targetMemberId: record.targetHostMemberId,
    transferId: record.transferId,
  });
}

function decodeSummary(value: unknown): CollabHostTransferSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('host-transfer-idempotency-response-invalid');
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (
    typeof input.transferId !== 'string'
    || typeof input.targetMemberId !== 'string'
    || (input.phase !== 'offered'
      && input.phase !== 'accepted'
      && input.phase !== 'transferring'
      && input.phase !== 'recovery-required'
      && input.phase !== 'completed'
      && input.phase !== 'cancelled'
      && input.phase !== 'declined'
      && input.phase !== 'expired')
    || typeof input.offeredAt !== 'string'
    || typeof input.expiresAt !== 'string'
    || typeof input.canAccept !== 'boolean'
    || typeof input.canDecline !== 'boolean'
    || typeof input.canCancel !== 'boolean'
  ) throw serviceError('host-transfer-idempotency-response-invalid');
  return input as unknown as CollabHostTransferSummary;
}

function validateEndpoint(value: string): void {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) throw new Error('Invalid endpoint');
  } catch {
    throw serviceError('host-transfer-target-endpoint-invalid');
  }
}

export class HostTransferAuthorityService {
  private readonly createTransferId: () => CollabOperationId;
  private readonly now: () => Date;
  private readonly repository = new HostTransferRepository();
  private readonly trust = new HostTrustTransitionService();

  constructor(
    private readonly authority: HostTransferAuthority,
    options: HostTransferAuthorityServiceOptions = {},
  ) {
    this.createTransferId = options.createTransferId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  create(
    actorMemberId: CollabMemberId,
    request: CreateHostTransferRequest,
  ): Promise<CollabHostTransferSummary> {
    return this.mutateIdempotently(actorMemberId, request, 'create', connection => {
      const now = this.now();
      const created = this.repository.createOffer(connection, {
        actorMemberId,
        expiresAt: new Date(now.getTime() + HOST_TRANSFER_OFFER_TTL_MS).toISOString(),
        offeredAt: now.toISOString(),
        projectId: request.projectId,
        targetHostMemberId: request.targetMemberId,
        transferId: this.createTransferId(),
      });
      if (created.sourceHostMemberId !== request.expectedHostMemberId) {
        throw new CollabError({
          code: 'stale-project-selection',
          recoveryActions: ['retry'],
          safeContext: { reason: 'host-transfer-host-changed' },
        });
      }
      return created;
    });
  }

  async getCurrent(
    actorMemberId: CollabMemberId,
    projectId: CollabProjectId,
  ): Promise<CollabHostTransferSummary | null> {
    return (await this.authority.database.mutate(connection => {
      this.repository.assertActiveActor(connection, projectId, actorMemberId);
      const currentAt = this.now().toISOString();
      const before = this.repository.getNonterminal(connection);
      const current = this.repository.expireOfferedDue(connection, currentAt);
      if (current?.phase === 'expired') {
        if (before?.phase === 'offered') this.appendEvent(connection, current, null);
        return null;
      }
      if (
        !current
        || (
          current.sourceHostMemberId !== actorMemberId
          && current.targetHostMemberId !== actorMemberId
        )
      ) return null;
      return summary(current, actorMemberId);
    })).value;
  }

  accept(
    actorMemberId: CollabMemberId,
    request: AcceptHostTransferRequest,
  ): Promise<CollabHostTransferSummary> {
    validateEndpoint(request.targetEndpoint);
    const targetCa = this.trust.inspectCaCertificate(request.targetCaCertificatePem);
    if (targetCa.fingerprint !== request.targetCaFingerprint) {
      throw serviceError('host-transfer-target-ca-mismatch');
    }
    if (!CREDENTIAL_PATTERN.test(request.receiverCredential)) {
      throw serviceError('host-transfer-receiver-credential-invalid');
    }
    const decodedCredential = Buffer.from(request.receiverCredential, 'base64url');
    if (
      decodedCredential.byteLength !== 32
      || decodedCredential.toString('base64url') !== request.receiverCredential
    ) throw serviceError('host-transfer-receiver-credential-invalid');
    return this.mutateIdempotently(actorMemberId, request, 'accept', connection => (
      this.repository.accept(connection, {
        actorMemberId,
        projectId: request.projectId,
        receiverCredential: request.receiverCredential,
        targetCaCertificatePem: targetCa.certificatePem,
        targetCaFingerprint: targetCa.fingerprint,
        targetEndpoint: request.targetEndpoint,
        transferId: request.transferId,
        updatedAt: this.now().toISOString(),
      })
    ));
  }

  decline(
    actorMemberId: CollabMemberId,
    request: DeclineHostTransferRequest,
  ): Promise<CollabHostTransferSummary> {
    if (request.expectedTargetMemberId !== actorMemberId) {
      return Promise.reject(new CollabError({
        code: 'stale-project-selection',
        recoveryActions: ['retry'],
        safeContext: { reason: 'host-transfer-target-changed' },
      }));
    }
    return this.mutateIdempotently(actorMemberId, request, 'decline', connection => (
      this.repository.terminateBeforeRelinquishment(connection, {
        actorMemberId,
        phase: 'declined',
        projectId: request.projectId,
        transferId: request.transferId,
        updatedAt: this.now().toISOString(),
      })
    ));
  }

  cancel(
    actorMemberId: CollabMemberId,
    request: CancelHostTransferRequest,
  ): Promise<CollabHostTransferSummary> {
    if (request.expectedHostMemberId !== actorMemberId) {
      return Promise.reject(new CollabError({
        code: 'stale-project-selection',
        recoveryActions: ['retry'],
        safeContext: { reason: 'host-transfer-host-changed' },
      }));
    }
    return this.mutateIdempotently(actorMemberId, request, 'cancel', connection => (
      this.repository.terminateBeforeRelinquishment(connection, {
        actorMemberId,
        phase: 'cancelled',
        projectId: request.projectId,
        transferId: request.transferId,
        updatedAt: this.now().toISOString(),
      })
    ));
  }

  async advance(input: AdvanceHostTransferInput): Promise<HostTransferAuthorityRecord> {
    return (await this.authority.database.mutate(connection => {
      const record = this.repository.advance(connection, {
        ...input,
        updatedAt: this.now().toISOString(),
      });
      this.appendEvent(connection, record, null);
      return record;
    })).value;
  }

  async relinquish(input: RelinquishHostAuthorityInput): Promise<HostTransferAuthorityRecord> {
    return (await this.authority.database.mutate(connection => {
      const record = this.repository.get(connection, input.transferId);
      if (!record || !record.manifestDigest || !record.targetCaFingerprint) {
        throw serviceError('host-transfer-relinquishment-state-invalid');
      }
      this.trust.verifyTransition(input.proof, input.previousCaCertificatePem, {
        projectId: input.projectId,
        transferId: input.transferId,
      });
      if (input.proof.nextCaFingerprint !== record.targetCaFingerprint) {
        throw serviceError('host-transfer-proof-target-mismatch');
      }
      this.trust.verifyActivation(
        input.activationCertificate,
        input.previousCaCertificatePem,
        {
          cutoverAt: input.activationCertificate.cutoverAt,
          manifestDigest: record.manifestDigest,
          projectId: input.projectId,
          targetCaFingerprint: record.targetCaFingerprint,
          targetHostMemberId: record.targetHostMemberId,
          transferId: input.transferId,
        },
      );
      const relinquished = this.repository.relinquishAuthority(connection, {
        activationCertificate: input.activationCertificate,
        projectId: input.projectId,
        proof: input.proof,
        sourceHostMemberId: record.sourceHostMemberId,
        targetHostMemberId: record.targetHostMemberId,
        transferId: input.transferId,
        updatedAt: this.now().toISOString(),
      });
      this.appendEvent(connection, relinquished, record.sourceHostMemberId);
      return relinquished;
    })).value;
  }

  listProofs(): Promise<readonly CollabHostTrustTransitionProof[]> {
    return this.authority.database.read(connection => this.repository.listProofs(connection));
  }

  private async mutateIdempotently(
    actorMemberId: CollabMemberId,
    request: { readonly idempotencyKey: string; readonly projectId: CollabProjectId },
    action: 'accept' | 'cancel' | 'create' | 'decline',
    mutation: (connection: AuthorityDatabaseConnection) => HostTransferAuthorityRecord,
  ): Promise<CollabHostTransferSummary> {
    const requestFingerprint = fingerprint({ action, ...request });
    return (await this.authority.database.mutate(connection => {
      this.repository.assertActiveActor(connection, request.projectId, actorMemberId);
      const replay = this.repository.findIdempotency<unknown>(connection, {
        actorMemberId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
      });
      if (replay) return decodeSummary(replay);
      const now = this.now().toISOString();
      const record = mutation(connection);
      const response = summary(record, actorMemberId);
      this.appendEvent(connection, record, actorMemberId);
      return this.repository.storeIdempotency(connection, {
        actorMemberId,
        createdAt: now,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        response,
      });
    })).value;
  }

  private appendEvent(
    connection: AuthorityDatabaseConnection,
    record: HostTransferAuthorityRecord,
    actorMemberId: CollabMemberId | null,
  ): void {
    this.authority.events.append(connection, {
      actorMemberId,
      createdAt: this.now().toISOString(),
      kind: 'host.transfer-changed',
      payload: {
        phase: record.phase,
        targetMemberId: record.targetHostMemberId,
        transferId: record.transferId,
      },
    });
  }
}
