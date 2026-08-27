import { createHash } from 'node:crypto';

import {
  type CollabAuthorityTransferReceiptVerifier,
  type CollabAuthorityTransferStatus,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaim,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabTransferredMembershipClaimBatch,
  decodeCollabTransferredMembershipClaimCustodyReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';

import {
  assertAuthorityTransferTransition,
  type AuthorityTransferRecord,
  decodeAuthorityTransferRecord,
  expireAuthorityTransferTerminalResponder,
  isAuthorityTransferProposal,
  isAuthorityTransferTerminal,
  markAuthorityTransferTerminalCleanupCompleted,
  pinAuthorityTransferReceiptVerifier,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type AuthorityTransferClaimBatchCommitmentRecord,
  createAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  type AuthorityTransferClaimCustodyPurpose,
  type AuthorityTransferClaimCustodyRecord,
  createAuthorityTransferClaimCustodyRecord,
  decodeAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
import {
  type AuthorityTransferPersistenceStores,
  type AuthorityTransferProjectCatalog,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistenceStores';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferPersistenceOptions {
  readonly now?: () => Date;
}

interface RetainClaimBatchInput {
  readonly batch: CollabTransferredMembershipClaimBatch;
  readonly operationIntentId: string;
  readonly purpose: AuthorityTransferClaimCustodyPurpose;
}

interface RotateClaimBatchInput extends RetainClaimBatchInput {
  readonly expectedBatchRevision: number;
  readonly expectedBatchSha256: string;
}

interface ScrubClaimInput {
  readonly acknowledgedAt: CollabIsoTimestamp;
  readonly receipt: CollabTransferredMembershipRedemptionReceipt;
}

interface CompleteTerminalCleanupInput {
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
  readonly stagingDirectoryName: string;
  readonly transferId: string;
}

function transferError(
  code:
    | 'authority-transfer-cancellation-forbidden'
    | 'authority-transfer-not-found'
    | 'authority-transfer-stale'
    | 'durable-progress-recovery-required'
    | 'membership-claim-already-redeemed'
    | 'membership-claim-expired'
    | 'membership-claim-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'durable-progress-recovery-required' ? ['resume'] : [],
    safeContext: { reason },
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameClaimBatch(
  left: AuthorityTransferClaimCustodyRecord,
  right: AuthorityTransferClaimCustodyRecord,
): boolean {
  return left.batchRevision === right.batchRevision
    && left.batchSha256 === right.batchSha256
    && left.checkpointSha256 === right.checkpointSha256
    && left.expiresAt === right.expiresAt
    && left.operationIntentId === right.operationIntentId
    && left.projectId === right.projectId
    && left.purpose === right.purpose
    && left.targetAuthorityGeneration === right.targetAuthorityGeneration
    && left.transferId === right.transferId
    && left.claims.length === right.claims.length
    && left.claims.every((claim, index) => (
      claim.memberId === right.claims[index].memberId
      && claim.claimSha256 === right.claims[index].claimSha256
    ));
}

function claimCustodyMatchesStatus(
  custody: AuthorityTransferClaimCustodyRecord,
  status: CollabAuthorityTransferStatus,
): boolean {
  return custody.batchRevision === status.batchRevision
    && custody.batchSha256 === status.batchSha256
    && custody.checkpointSha256 === status.checkpointSha256
    && custody.targetAuthorityGeneration === status.targetAuthority.generation
    && custody.custodyReceipt !== null
    && custody.custodyReceipt.custodyAuthority.kind === status.sourceAuthority.kind
    && custody.custodyReceipt.custodyAuthority.generation
      === status.sourceAuthority.generation;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function batchDigest(batch: CollabTransferredMembershipClaimBatch): string {
  return createHash('sha256')
    .update(encodeCollabTransferredMembershipClaimBatchDigestInput(batch), 'utf8')
    .digest('hex');
}

export class AuthorityTransferPersistence {
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private readonly enumerationQueue = new SerialTaskQueue();
  private readonly now: () => Date;
  private readonly projectQueues = new Map<CollabProjectId, SerialTaskQueue>();

  constructor(
    private readonly stores: AuthorityTransferPersistenceStores,
    options: AuthorityTransferPersistenceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  listProjectIds(): Promise<readonly CollabProjectId[]> {
    if (this.closed) return Promise.reject(this.closedError());
    return this.enumerationQueue.run(() => this.stores.authorityTransferRecords.listProjectIds());
  }

  scanProjectCatalog(): Promise<AuthorityTransferProjectCatalog> {
    if (this.closed) return Promise.reject(this.closedError());
    return this.enumerationQueue.run(
      () => this.stores.authorityTransferRecords.scanProjectCatalog(),
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.all([
      this.enumerationQueue.drain(),
      ...[...this.projectQueues.values()].map(queue => queue.drain()),
    ]).then(() => undefined);
    return this.closePromise;
  }

  inspectLifecycleOwner(
    projectId: CollabProjectId,
  ): Promise<'absent' | 'nonterminal' | 'proposal' | 'terminal'> {
    return this.runProject(projectId, async () => {
      const [record, custody, commitment] = await Promise.all([
        this.stores.authorityTransferRecords.load(projectId),
        this.stores.authorityTransferClaims.load(projectId),
        this.stores.authorityTransferClaimCommitments.load(projectId),
      ]);
      if (!record) return custody || commitment ? 'nonterminal' : 'absent';
      if (custody || commitment) {
        return 'nonterminal';
      }
      if (isAuthorityTransferProposal(record)) return 'proposal';
      return isAuthorityTransferTerminal(record) && record.terminalCleanupCompleted
        ? 'terminal'
        : 'nonterminal';
    });
  }

  recoverInterruptedClaimCommitment(projectId: CollabProjectId): Promise<void> {
    return this.runProject(projectId, async () => {
      const [record, custody, commitment] = await Promise.all([
        this.stores.authorityTransferRecords.load(projectId),
        this.stores.authorityTransferClaims.load(projectId),
        this.stores.authorityTransferClaimCommitments.load(projectId),
      ]);
      if (!custody) {
        if (!commitment) return;
        if (
          !record
          || !isAuthorityTransferTerminal(record)
          || record.terminalResponder?.state === 'active'
          || record.terminalResponder?.state === 'pending'
        ) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-claim-commitment-orphaned',
          );
        }
        await this.assertTerminalCleanupClaimOwner(record, null, commitment);
        await this.stores.authorityTransferClaimCommitments.remove(projectId);
        return;
      }
      const expected = createAuthorityTransferClaimBatchCommitmentRecord(custody);
      if (sameValue(commitment, expected)) return;
      await this.assertClaimBatchOwner(custody, undefined, false);
      const recoverablePredecessor = commitment === null
        ? custody.rotationPredecessor === null
        : this.isRotationPredecessorCommitment(commitment, custody);
      if (!recoverablePredecessor || !this.isCompleteUnacknowledgedBatch(custody)) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-claim-commitment-mismatch',
        );
      }
      await this.stores.authorityTransferClaimCommitments.save(expected);
    });
  }

  completeTerminalCleanup(input: CompleteTerminalCleanupInput): Promise<void> {
    // The direction owner calls this only after it has removed the exact
    // operation-owned staging directory named by the durable record. Commit
    // the terminal fence before removing claim files so a crash can only
    // leave recoverable residual custody, never an uncommitted terminal.
    return this.runProject(input.projectId, async () => {
      const record = await this.stores.authorityTransferRecords.load(input.projectId);
      if (
        !record
        || record.transferId !== input.transferId
        || record.operationIntentId !== input.operationIntentId
        || record.stagingDirectoryName !== input.stagingDirectoryName
        || !isAuthorityTransferTerminal(record)
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-terminal-cleanup-owner-stale',
        );
      }
      if (
        record.terminalResponder?.state === 'active'
        || record.terminalResponder?.state === 'pending'
      ) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-terminal-responder-active',
        );
      }
      const [custody, commitment] = await Promise.all([
        this.stores.authorityTransferClaims.load(input.projectId),
        this.stores.authorityTransferClaimCommitments.load(input.projectId),
      ]);
      await this.assertTerminalCleanupClaimOwner(record, custody, commitment);
      if (!record.terminalCleanupCompleted) {
        await this.stores.authorityTransferRecords.save(
          markAuthorityTransferTerminalCleanupCompleted(record),
        );
      }
      await this.stores.authorityTransferClaims.remove(input.projectId);
      await this.stores.authorityTransferClaimCommitments.remove(input.projectId);
    });
  }

  load(projectId: CollabProjectId): Promise<AuthorityTransferRecord | null> {
    return this.runProject(projectId, async () => {
      const record = await this.stores.authorityTransferRecords.load(projectId);
      const custody = await this.stores.authorityTransferClaims.load(projectId);
      const commitment = await this.stores.authorityTransferClaimCommitments.load(projectId);
      if (!record && (custody || commitment)) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-claim-custody-orphaned',
        );
      }
      if (commitment && !custody) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-claim-commitment-orphaned',
        );
      }
      if (record && custody) await this.assertClaimBatchOwner(custody, record);
      return record;
    });
  }

  pinReceiptVerifier(
    projectId: CollabProjectId,
    transferId: string,
    verifier: CollabAuthorityTransferReceiptVerifier,
  ): Promise<AuthorityTransferRecord> {
    return this.runProject(projectId, async () => {
      const record = await this.stores.authorityTransferRecords.load(projectId);
      if (!record || record.transferId !== transferId) {
        throw transferError(
          'authority-transfer-not-found',
          'authority-transfer-record-missing',
        );
      }
      let pinned: AuthorityTransferRecord;
      try {
        pinned = pinAuthorityTransferReceiptVerifier(record, verifier);
      } catch {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-receipt-verifier-stale',
        );
      }
      if (pinned !== record) {
        await this.stores.authorityTransferRecords.save(pinned);
      }
      return pinned;
    });
  }

  create(record: AuthorityTransferRecord): Promise<void> {
    return this.saveAbsent(record);
  }

  advance(
    record: AuthorityTransferRecord,
    expectedPhase: CollabAuthorityTransferStatus['phase'],
  ): Promise<void> {
    let decoded: AuthorityTransferRecord;
    try {
      decoded = decodeAuthorityTransferRecord(record);
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-record-invalid',
      ));
    }
    return this.runProject(decoded.projectId, async () => {
      const previous = await this.stores.authorityTransferRecords.load(decoded.projectId);
      if (!previous) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-record-missing');
      }
      if (previous.transferId !== decoded.transferId || previous.status.phase !== expectedPhase) {
        throw transferError('authority-transfer-stale', 'authority-transfer-expected-phase-stale');
      }
      try {
        assertAuthorityTransferTransition(previous, decoded);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        const cancellationForbidden = reason === 'Authority transfer cancellation is forbidden';
        throw transferError(
          cancellationForbidden
            ? 'authority-transfer-cancellation-forbidden'
            : 'authority-transfer-stale',
          cancellationForbidden
            ? 'authority-transfer-source-relinquished'
            : 'authority-transfer-phase-invalid',
        );
      }
      await this.assertClaimCustodyForStatus(decoded.status);
      await this.stores.authorityTransferRecords.save(decoded);
    });
  }

  retainClaimBatch(input: RetainClaimBatchInput): Promise<AuthorityTransferClaimCustodyRecord> {
    let record: AuthorityTransferClaimCustodyRecord;
    try {
      const batch = decodeCollabTransferredMembershipClaimBatch(input.batch);
      if (batchDigest(batch) !== batch.batchSha256) throw new TypeError();
      record = createAuthorityTransferClaimCustodyRecord({
        batch,
        createdAt: this.now().toISOString(),
        operationIntentId: input.operationIntentId,
        purpose: input.purpose,
      });
    } catch {
      return Promise.reject(transferError(
        'membership-claim-invalid',
        'authority-transfer-claim-batch-invalid',
      ));
    }
    return this.runProject(record.projectId, async () => {
      await this.assertClaimBatchOwner(record, undefined, false);
      const existing = await this.stores.authorityTransferClaims.load(record.projectId);
      if (existing) {
        if (sameClaimBatch(existing, record)) {
          await this.persistClaimCommitment(existing);
          return existing;
        }
        throw transferError('authority-transfer-stale', 'authority-transfer-claim-batch-conflict');
      }
      await this.stores.authorityTransferClaims.save(record);
      await this.persistClaimCommitment(record);
      return record;
    });
  }

  rotateClaimBatch(input: RotateClaimBatchInput): Promise<AuthorityTransferClaimCustodyRecord> {
    let batch: CollabTransferredMembershipClaimBatch;
    try {
      batch = decodeCollabTransferredMembershipClaimBatch(input.batch);
      if (batchDigest(batch) !== batch.batchSha256) throw new TypeError();
    } catch {
      return Promise.reject(transferError(
        'membership-claim-invalid',
        'authority-transfer-claim-batch-invalid',
      ));
    }
    return this.runProject(batch.projectId, async () => {
      const current = await this.requireClaimCustody(batch.projectId, batch.transferId);
      await this.assertClaimBatchOwner(current, undefined, false);
      const rotated = createAuthorityTransferClaimCustodyRecord({
        batch,
        createdAt: current.createdAt,
        operationIntentId: current.operationIntentId,
        purpose: current.purpose,
      });
      if (
        input.operationIntentId === current.operationIntentId
        && input.purpose === current.purpose
        && sameClaimBatch(current, rotated)
        && current.rotationPredecessor?.batchRevision === input.expectedBatchRevision
        && current.rotationPredecessor.batchSha256 === input.expectedBatchSha256
      ) {
        await this.persistClaimCommitment(current);
        return current;
      }
      await this.assertClaimBatchOwner(current);
      if (
        current.custodyReceipt !== null
        || current.claims.some(claim => claim.disposition !== 'retained')
        || current.batchRevision !== input.expectedBatchRevision
        || current.batchSha256 !== input.expectedBatchSha256
        || batch.batchRevision !== current.batchRevision + 1
        || batch.projectId !== current.projectId
        || batch.transferId !== current.transferId
        || batch.checkpointSha256 !== current.checkpointSha256
        || batch.targetAuthorityGeneration !== current.targetAuthorityGeneration
        || batch.expiresAt !== current.expiresAt
        || input.operationIntentId !== current.operationIntentId
        || input.purpose !== current.purpose
        || current.claims.length !== rotated.claims.length
        || current.claims.some((claim, index) => (
          claim.memberId !== rotated.claims[index].memberId
          || claim.claimSha256 === rotated.claims[index].claimSha256
        ))
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-claim-rotation-stale');
      }
      const updatedAt = this.now().toISOString();
      const persisted = decodeAuthorityTransferClaimCustodyRecord({
        ...rotated,
        rotationPredecessor: {
          batchRevision: current.batchRevision,
          batchSha256: current.batchSha256,
        },
        updatedAt: current.updatedAt < updatedAt
          ? updatedAt
          : current.updatedAt,
      });
      await this.stores.authorityTransferClaims.save(persisted);
      await this.persistClaimCommitment(persisted);
      return persisted;
    });
  }

  acknowledgeClaimBatch(
    value: CollabTransferredMembershipClaimCustodyReceipt,
  ): Promise<CollabTransferredMembershipClaimCustodyReceipt> {
    let receipt: CollabTransferredMembershipClaimCustodyReceipt;
    try {
      receipt = decodeCollabTransferredMembershipClaimCustodyReceipt(value);
    } catch {
      return Promise.reject(transferError(
        'membership-claim-invalid',
        'authority-transfer-custody-receipt-invalid',
      ));
    }
    return this.runProject(receipt.projectId, async () => {
      const current = await this.requireClaimCustody(receipt.projectId, receipt.transferId);
      const record = await this.stores.authorityTransferRecords.load(receipt.projectId);
      if (!record || record.transferId !== receipt.transferId) {
        throw transferError('authority-transfer-stale', 'authority-transfer-custody-owner-stale');
      }
      await this.assertClaimBatchOwner(current, record);
      if (current.custodyReceipt) {
        if (sameValue(current.custodyReceipt, receipt)) return current.custodyReceipt;
        throw transferError('authority-transfer-stale', 'authority-transfer-custody-receipt-stale');
      }
      if (
        current.operationIntentId !== receipt.operationIntentId
        || current.batchRevision !== receipt.batchRevision
        || current.batchSha256 !== receipt.batchSha256
        || current.checkpointSha256 !== receipt.checkpointSha256
        || current.targetAuthorityGeneration !== receipt.targetAuthorityGeneration
        || receipt.committedAt < current.createdAt
        || receipt.committedAt >= current.expiresAt
        || receipt.custodyAuthority.kind !== record.status.sourceAuthority.kind
        || receipt.custodyAuthority.generation !== record.status.sourceAuthority.generation
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-custody-receipt-stale');
      }
      const updated = decodeAuthorityTransferClaimCustodyRecord({
        ...current,
        custodyReceipt: receipt,
        updatedAt: current.updatedAt < receipt.committedAt
          ? receipt.committedAt
          : current.updatedAt,
      });
      await this.stores.authorityTransferClaims.save(updated);
      return receipt;
    });
  }

  loadClaim(
    projectId: CollabProjectId,
    transferId: string,
    memberId: CollabMemberId,
  ): Promise<CollabTransferredMembershipClaim> {
    return this.runProject(projectId, async () => {
      const current = await this.requireClaimCustody(projectId, transferId);
      const record = await this.stores.authorityTransferRecords.load(projectId);
      await this.assertClaimBatchOwner(current, record ?? undefined);
      if (
        !record
        || record.localRole !== 'source'
        || current.purpose !== 'source-terminal'
        || record.status.relinquishmentProof === null
        || record.terminalResponder?.state !== 'active'
        || !claimCustodyMatchesStatus(current, record.status)
      ) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-terminal-claim-unavailable',
        );
      }
      if (Date.parse(current.expiresAt) <= this.now().getTime()) {
        throw transferError('membership-claim-expired', 'authority-transfer-claim-expired');
      }
      const retained = current.claims.find(claim => claim.memberId === memberId);
      if (!retained) {
        throw transferError('membership-claim-invalid', 'authority-transfer-member-claim-missing');
      }
      if (retained.claim === null) {
        throw transferError(
          'membership-claim-already-redeemed',
          'authority-transfer-member-claim-scrubbed',
        );
      }
      return {
        claim: retained.claim,
        expiresAt: current.expiresAt,
        memberId,
        projectId,
        targetAuthorityGeneration: current.targetAuthorityGeneration,
        transferId,
      };
    });
  }

  loadRetainedClaimBatch(
    projectId: CollabProjectId,
    transferId: string,
  ): Promise<CollabTransferredMembershipClaimBatch | null> {
    return this.runProject(projectId, async () => {
      const current = await this.stores.authorityTransferClaims.load(projectId);
      if (!current) return null;
      if (current.transferId !== transferId) {
        throw transferError('authority-transfer-stale', 'authority-transfer-claim-owner-stale');
      }
      await this.assertClaimBatchOwner(current);
      if (current.claims.some(claim => claim.disposition !== 'retained' || claim.claim === null)) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-claim-batch-no-longer-replayable',
        );
      }
      const batch: CollabTransferredMembershipClaimBatch = {
        batchRevision: current.batchRevision,
        batchSha256: current.batchSha256,
        checkpointSha256: current.checkpointSha256,
        claims: current.claims.map(claim => ({
          claim: claim.claim!,
          memberId: claim.memberId,
        })),
        expiresAt: current.expiresAt,
        projectId: current.projectId,
        targetAuthorityGeneration: current.targetAuthorityGeneration,
        transferId: current.transferId,
      };
      if (batchDigest(batch) !== batch.batchSha256) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-claim-batch-digest-mismatch',
        );
      }
      return batch;
    });
  }

  /**
   * Persists a scrub after the direction owner verifies the receipt signature
   * against the pinned target key. This boundary revalidates every persisted
   * transfer and claim fact before removing the raw claim.
   */
  scrubClaimWithVerifiedReceipt(input: ScrubClaimInput): Promise<void> {
    let receipt: CollabTransferredMembershipRedemptionReceipt;
    try {
      receipt = decodeCollabTransferredMembershipRedemptionReceipt(input.receipt);
      if (!validTimestamp(input.acknowledgedAt)) throw new TypeError();
    } catch {
      return Promise.reject(transferError(
        'membership-claim-invalid',
        'authority-transfer-redemption-acknowledgement-invalid',
      ));
    }
    return this.runProject(receipt.projectId, async () => {
      const current = await this.requireClaimCustody(receipt.projectId, receipt.transferId);
      await this.assertClaimBatchOwner(current);
      const retained = current.claims.find(claim => claim.memberId === receipt.memberId);
      if (!retained) {
        throw transferError('membership-claim-invalid', 'authority-transfer-member-claim-missing');
      }
      if (retained.claim === null) {
        if (sameValue(retained.redemptionReceipt, receipt)) return;
        throw transferError(
          'membership-claim-already-redeemed',
          'authority-transfer-member-claim-scrubbed',
        );
      }
      if (
        retained.claimSha256 !== receipt.claimSha256
        || current.checkpointSha256 !== receipt.checkpointSha256
        || current.targetAuthorityGeneration !== receipt.targetAuthorityGeneration
        || receipt.redeemedAt >= current.expiresAt
        || input.acknowledgedAt < receipt.redeemedAt
      ) {
        throw transferError(
          'membership-claim-invalid',
          'authority-transfer-redemption-receipt-stale',
        );
      }
      const updated = decodeAuthorityTransferClaimCustodyRecord({
        ...current,
        claims: current.claims.map(claim => claim.memberId === receipt.memberId
          ? {
              ...claim,
              claim: null,
              disposition: 'redeemed',
              redemptionReceipt: receipt,
              scrubbedAt: input.acknowledgedAt,
            }
          : claim),
        updatedAt: current.updatedAt < input.acknowledgedAt
          ? input.acknowledgedAt
          : current.updatedAt,
      });
      await this.stores.authorityTransferClaims.save(updated);
    });
  }

  assertAuthorityRestartAllowed(projectId: CollabProjectId): Promise<void> {
    return this.runProject(projectId, () => this.assertAuthorityRestartAllowedUnlocked(projectId));
  }

  runWithAuthorityStartGuard<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runProject(projectId, async () => {
      await this.assertAuthorityRestartAllowedUnlocked(projectId);
      return operation();
    });
  }

  expireClaims(
    projectId: CollabProjectId,
    transferId: string,
  ): Promise<void> {
    return this.runProject(projectId, async () => {
      const current = await this.requireClaimCustody(projectId, transferId);
      const record = await this.stores.authorityTransferRecords.load(projectId);
      await this.assertClaimBatchOwner(current, record ?? undefined);
      if (!record || !claimCustodyMatchesStatus(current, record.status)) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-claim-custody-incomplete',
        );
      }
      const now = this.now();
      const expiredAt = now.toISOString();
      if (now.getTime() < Date.parse(current.expiresAt)) {
        throw transferError('authority-transfer-stale', 'authority-transfer-claim-expiry-early');
      }
      if (current.claims.every(claim => claim.disposition !== 'retained')) return;
      const updated = decodeAuthorityTransferClaimCustodyRecord({
        ...current,
        claims: current.claims.map(claim => claim.disposition === 'retained'
          ? {
              ...claim,
              claim: null,
              disposition: 'expired',
              redemptionReceipt: null,
              scrubbedAt: expiredAt,
            }
          : claim),
        updatedAt: current.updatedAt < expiredAt ? expiredAt : current.updatedAt,
      });
      await this.stores.authorityTransferClaims.save(updated);
    });
  }

  private async assertAuthorityRestartAllowedUnlocked(
    projectId: CollabProjectId,
  ): Promise<void> {
    const record = await this.stores.authorityTransferRecords.load(projectId);
    const custody = await this.stores.authorityTransferClaims.load(projectId);
    const commitment = await this.stores.authorityTransferClaimCommitments.load(projectId);
    if (!record && (custody || commitment)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-custody-orphaned',
      );
    }
    if (commitment && !custody) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-commitment-orphaned',
      );
    }
    if (record && custody) await this.assertClaimBatchOwner(custody, record);
    if (!record || record.restartFence === 'open') return;
    throw transferError(
      'durable-progress-recovery-required',
      record.restartFence === 'permanent'
        ? 'authority-transfer-source-relinquished'
        : 'authority-transfer-authority-quiesced',
    );
  }

  async expireTerminalResponder(
    projectId: CollabProjectId,
    transferId: string,
  ): Promise<void> {
    const hasClaimState = await this.runProject(projectId, async () => {
      const record = await this.stores.authorityTransferRecords.load(projectId);
      if (!record || record.transferId !== transferId) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-record-missing');
      }
      if (this.now().getTime() < Date.parse(record.status.expiresAt)) {
        throw transferError('authority-transfer-stale', 'authority-transfer-terminal-expiry-early');
      }
      if (record.terminalResponder?.state === 'expired') {
        const [custody, commitment] = await Promise.all([
          this.stores.authorityTransferClaims.load(projectId),
          this.stores.authorityTransferClaimCommitments.load(projectId),
        ]);
        return custody !== null || commitment !== null;
      }
      try {
        expireAuthorityTransferTerminalResponder(record);
      } catch {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-terminal-responder-not-expirable',
        );
      }
      return true;
    });
    if (hasClaimState) await this.expireClaims(projectId, transferId);
    await this.runProject(projectId, async () => {
      const record = await this.stores.authorityTransferRecords.load(projectId);
      if (!record || record.transferId !== transferId) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-record-missing');
      }
      if (record.terminalResponder?.state === 'expired') return;
      let expired: AuthorityTransferRecord;
      try {
        expired = expireAuthorityTransferTerminalResponder(record);
      } catch {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-terminal-responder-not-expirable',
        );
      }
      await this.stores.authorityTransferRecords.save(expired);
    });
  }

  private runProject<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError());
    let queue = this.projectQueues.get(projectId);
    if (!queue) {
      queue = new SerialTaskQueue();
      this.projectQueues.set(projectId, queue);
    }
    return queue.run(operation);
  }

  private closedError(): CollabError {
    return transferError(
      'durable-progress-recovery-required',
      'authority-transfer-persistence-closed',
    );
  }

  private saveAbsent(record: AuthorityTransferRecord): Promise<void> {
    let decoded: AuthorityTransferRecord;
    try {
      decoded = decodeAuthorityTransferRecord(record);
      if (decoded.status.phase !== 'collecting-readiness') throw new TypeError();
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-record-invalid',
      ));
    }
    return this.runProject(decoded.projectId, async () => {
      const existing = await this.stores.authorityTransferRecords.load(decoded.projectId);
      if (existing) {
        if (sameValue(existing, decoded)) return;
        if (
          existing.status.state !== 'cancelled'
          || !existing.terminalCleanupCompleted
          || existing.restartFence !== 'open'
        ) {
          throw transferError('authority-transfer-stale', 'authority-transfer-record-conflict');
        }
        const [custody, commitment] = await Promise.all([
          this.stores.authorityTransferClaims.load(decoded.projectId),
          this.stores.authorityTransferClaimCommitments.load(decoded.projectId),
        ]);
        if (custody || commitment) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-terminal-cleanup-incomplete',
          );
        }
      }
      await this.stores.authorityTransferRecords.save(decoded);
    });
  }

  private async assertClaimCustodyForStatus(status: CollabAuthorityTransferStatus): Promise<void> {
    if (status.batchRevision === null || status.batchSha256 === null) return;
    const custody = await this.requireClaimCustody(status.projectId, status.transferId);
    await this.assertClaimBatchOwner(custody);
    if (!claimCustodyMatchesStatus(custody, status)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-custody-incomplete',
      );
    }
  }

  private async assertClaimBatchOwner(
    custody: AuthorityTransferClaimCustodyRecord,
    knownRecord?: AuthorityTransferRecord,
    requireCommitment = true,
  ): Promise<void> {
    const record = knownRecord
      ?? await this.stores.authorityTransferRecords.load(custody.projectId);
    const checkpointMatches = record?.status.checkpointSha256 === null
      || record?.status.checkpointSha256 === custody.checkpointSha256;
    if (
      !record
      || record.transferId !== custody.transferId
      || record.operationIntentId !== custody.operationIntentId
      || !checkpointMatches
      || record.status.targetAuthority.generation !== custody.targetAuthorityGeneration
      || record.status.expiresAt !== custody.expiresAt
      || (record.localRole === 'source') !== (custody.purpose === 'source-terminal')
    ) {
      throw transferError(
        'authority-transfer-stale',
        'authority-transfer-claim-owner-stale',
      );
    }
    if (!requireCommitment) return;
    const commitment = await this.stores.authorityTransferClaimCommitments.load(
      custody.projectId,
    );
    const expected = createAuthorityTransferClaimBatchCommitmentRecord(custody);
    if (!commitment || !sameValue(commitment, expected)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-commitment-mismatch',
      );
    }
  }

  private async assertTerminalCleanupClaimOwner(
    record: AuthorityTransferRecord,
    custody: AuthorityTransferClaimCustodyRecord | null,
    commitment: AuthorityTransferClaimBatchCommitmentRecord | null,
  ): Promise<void> {
    if (custody) {
      await this.assertClaimBatchOwner(custody, record);
      if (
        custody.batchRevision !== record.status.batchRevision
        || custody.batchSha256 !== record.status.batchSha256
        || custody.checkpointSha256 !== record.status.checkpointSha256
        || custody.targetAuthorityGeneration !== record.status.targetAuthority.generation
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-claim-owner-stale');
      }
      return;
    }
    if (!commitment) return;
    if (
      commitment.projectId !== record.projectId
      || commitment.transferId !== record.transferId
      || commitment.operationIntentId !== record.operationIntentId
    ) {
      throw transferError('authority-transfer-stale', 'authority-transfer-claim-owner-stale');
    }
    if (
      commitment.batchRevision !== record.status.batchRevision
      || commitment.batchSha256 !== record.status.batchSha256
    ) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-commitment-mismatch',
      );
    }
  }

  private async persistClaimCommitment(
    custody: AuthorityTransferClaimCustodyRecord,
  ): Promise<void> {
    const expected = createAuthorityTransferClaimBatchCommitmentRecord(custody);
    const existing = await this.stores.authorityTransferClaimCommitments.load(
      custody.projectId,
    );
    if (sameValue(existing, expected)) return;
    if (existing && !this.isRotationPredecessorCommitment(existing, custody)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-commitment-mismatch',
      );
    }
    await this.stores.authorityTransferClaimCommitments.save(expected);
  }

  private isRotationPredecessorCommitment(
    commitment: AuthorityTransferClaimBatchCommitmentRecord,
    custody: AuthorityTransferClaimCustodyRecord,
  ): boolean {
    return custody.rotationPredecessor !== null
      && commitment.projectId === custody.projectId
      && commitment.transferId === custody.transferId
      && commitment.operationIntentId === custody.operationIntentId
      && commitment.batchRevision === custody.rotationPredecessor.batchRevision
      && commitment.batchSha256 === custody.rotationPredecessor.batchSha256;
  }

  private isCompleteUnacknowledgedBatch(
    custody: AuthorityTransferClaimCustodyRecord,
  ): boolean {
    if (
      custody.custodyReceipt !== null
      || custody.claims.some(claim => (
        claim.disposition !== 'retained'
        || claim.claim === null
        || claim.redemptionReceipt !== null
        || claim.scrubbedAt !== null
      ))
    ) {
      return false;
    }
    const batch: CollabTransferredMembershipClaimBatch = {
      batchRevision: custody.batchRevision,
      batchSha256: custody.batchSha256,
      checkpointSha256: custody.checkpointSha256,
      claims: custody.claims.map(claim => ({
        claim: claim.claim!,
        memberId: claim.memberId,
      })),
      expiresAt: custody.expiresAt,
      projectId: custody.projectId,
      targetAuthorityGeneration: custody.targetAuthorityGeneration,
      transferId: custody.transferId,
    };
    return batchDigest(batch) === custody.batchSha256;
  }

  private async requireClaimCustody(
    projectId: CollabProjectId,
    transferId: string,
  ): Promise<AuthorityTransferClaimCustodyRecord> {
    const current = await this.stores.authorityTransferClaims.load(projectId);
    if (!current || current.transferId !== transferId) {
      throw transferError('authority-transfer-not-found', 'authority-transfer-claim-custody-missing');
    }
    return current;
  }
}
