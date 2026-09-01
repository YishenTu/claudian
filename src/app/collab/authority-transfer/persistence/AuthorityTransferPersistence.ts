import { createHash } from 'node:crypto';

import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  type CollabAuthorityTransferReceiptVerifier,
  type CollabAuthorityTransferStatus,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaim,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaimBatch,
  decodeCollabTransferredMembershipClaimCustodyReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';

import {
  type AuthorityTransferEntryRecord,
  type AuthorityTransferRequesterEntryRecord,
  type AuthorityTransferSourceCancellationIntent,
  type AuthorityTransferSourceEntryRecord,
  cancelAuthorityTransferSourceEntry,
  clearAuthorityTransferSourceCancellation,
  completeAuthorityTransferRequesterEntry,
  createAuthorityTransferEntryDocument,
  decodeAuthorityTransferEntryComponent,
  handoffAuthorityTransferEntry,
  markAuthorityTransferSourceBeginPossiblySent,
  markAuthorityTransferSourceCancellationPossiblySent,
  markAuthorityTransferSourceCloudAbsent,
  prepareAuthorityTransferSourceCancellation,
  settleAuthorityTransferSourceCancellation,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import {
  assertAuthorityTransferTransition,
  type AuthorityTransferRecord,
  bindLegacyAuthorityTransferSourceOwner,
  createAuthorityTransferRecord,
  decodeAuthorityTransferRecord,
  expireAuthorityTransferTerminalResponder,
  isAuthorityTransferProposal,
  isAuthorityTransferTerminal,
  markAuthorityTransferTerminalCleanupCompleted,
  pinAuthorityTransferReceiptVerifier,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type CloudToLanManagerEntryRecord,
  type CloudToLanTargetEntryRecord,
  type CloudToLanTargetPreparationDescriptor,
  decodeCloudToLanManagerEntryRecord,
  decodeCloudToLanTargetEntryRecord,
  handoffCloudToLanTargetEntry,
  markCloudToLanManagerBeginPossiblySent,
  markCloudToLanManagerCancellationPossiblySent,
  prepareCloudToLanManagerCancellation,
  publishCloudToLanTargetEntry,
  recordCloudToLanManagerStatus,
  rejectCloudToLanManagerEntry,
  withdrawCloudToLanTargetEntry,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
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
import type { InstallationKey } from '@/core/device/InstallationKey';

export type LanToCloudCancellationIntent = AuthorityTransferSourceCancellationIntent;

export interface AuthorityTransferPersistenceOptions {
  readonly isRecoveryOwner: (ownerInstallationKey: string | undefined) => boolean;
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
   #closePromise: Promise<void> | null = null;
  private closed = false;
   readonly #enumerationQueue = new SerialTaskQueue();
   readonly #isRecoveryOwner: AuthorityTransferPersistenceOptions['isRecoveryOwner'];
  private readonly now: () => Date;
   readonly #projectQueues = new Map<CollabProjectId, SerialTaskQueue>();

  constructor(
    private readonly stores: AuthorityTransferPersistenceStores,
    options: AuthorityTransferPersistenceOptions,
  ) {
    this.#isRecoveryOwner = options.isRecoveryOwner;
    this.now = options.now ?? (() => new Date());
  }

  listProjectIds(): Promise<readonly CollabProjectId[]> {
    if (this.closed) return Promise.reject(this.#closedError());
    return this.#enumerationQueue.run(() => this.stores.authorityTransferRecords.listProjectIds());
  }

  scanProjectCatalog(): Promise<AuthorityTransferProjectCatalog> {
    if (this.closed) return Promise.reject(this.#closedError());
    return this.#enumerationQueue.run(
      () => this.stores.authorityTransferRecords.scanProjectCatalog(),
    );
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.closed = true;
    this.#closePromise = Promise.all([
      this.#enumerationQueue.drain(),
      ...[...this.#projectQueues.values()].map(queue => queue.drain()),
    ]).then(() => undefined);
    return this.#closePromise;
  }

  inspectLifecycleOwner(
    projectId: CollabProjectId,
  ): Promise<'absent' | 'nonterminal' | 'proposal' | 'terminal'> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record, custody, commitment] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
        this.stores.authorityTransferClaims.load(projectId),
        this.stores.authorityTransferClaimCommitments.load(projectId),
      ]);
      const entry = await this.#removeExpiredEntry(loadedEntry, record);
      const source = entry?.source ?? null;
      const target = entry?.target ?? null;
      const manager = entry?.manager ?? null;
      const localSource = source !== null && this.#isLocalSourceEntry(source);
      const localTarget = target !== null && this.#isLocalTargetEntry(target);
      const foreignPhysical = record !== null && this.#isForeignPhysical(record);
      const managerMatchesLocalPhysical = manager !== null
        && record !== null
        && !foreignPhysical
        && this.#managerMatchesPhysical(manager, record);
      if (localSource && source.phase === 'handed-off' && foreignPhysical) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-entry-successor-owner-mismatch',
        );
      }
      if (
        localSource
        && source.phase !== 'cancelled'
        && record
        && !foreignPhysical
      ) {
        await this.#reconcileEntrySuccessor(source, record);
      }
      if (localTarget && target.phase === 'handed-off' && foreignPhysical) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-target-entry-successor-owner-mismatch',
        );
      }
      if (localTarget && record && !foreignPhysical && target.phase !== 'withdrawn') {
        await this.#reconcileTargetEntrySuccessor(target, record);
      }
      if (!record) {
        if (custody || commitment) return 'nonterminal';
        if (localTarget && target.phase === 'handed-off') {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-target-entry-successor-missing',
          );
        }
        if (localTarget && target.phase !== 'withdrawn') return 'nonterminal';
        if (!localSource || source.phase === 'cancelled') return 'absent';
        return source.phase === 'proposed' ? 'proposal' : 'nonterminal';
      }
      if (foreignPhysical) return 'absent';
      if (custody || commitment) {
        return 'nonterminal';
      }
      if (isAuthorityTransferProposal(record)) return 'proposal';
      return isAuthorityTransferTerminal(record)
        && record.terminalCleanupCompleted
        && (!localSource || source.phase === 'cancelled')
        && !localTarget
        && !managerMatchesLocalPhysical
        ? 'terminal'
        : 'nonterminal';
    });
  }

  loadRecoveryOwnerRecord(
    projectId: CollabProjectId,
  ): Promise<AuthorityTransferRecord | null> {
    return this.runProject(projectId, async () => {
      const [entry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      const source = entry?.source;
      const target = entry?.target;
      if (
        !record
        && source?.phase === 'handed-off'
        && this.#isLocalSourceEntry(source)
      ) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-entry-successor-missing',
        );
      }
      if (
        !record
        && target?.phase === 'handed-off'
        && this.#isLocalTargetEntry(target)
      ) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-target-entry-successor-missing',
        );
      }
      if (record && target && this.#isLocalTargetEntry(target)) {
        await this.#reconcileTargetEntrySuccessor(target, record);
      }
      return record;
    });
  }

  loadSourceEntry(projectId: CollabProjectId): Promise<AuthorityTransferSourceEntryRecord | null> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      const entry = await this.#removeExpiredEntry(loadedEntry, record);
      const source = entry?.source ?? null;
      if (
        source
        && this.#isLocalSourceEntry(source)
        && record
        && !this.#isForeignPhysical(record)
        && source.phase !== 'cancelled'
      ) {
        await this.#reconcileEntrySuccessor(source, record);
      }
      return source && this.#isLocalSourceEntry(source) ? source : null;
    });
  }

  loadRequesterEntry(
    projectId: CollabProjectId,
    installationKey: InstallationKey,
  ): Promise<AuthorityTransferRequesterEntryRecord | null> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      const entry = await this.#removeExpiredEntry(loadedEntry, record);
      return entry?.requesters[installationKey] ?? null;
    });
  }

  loadObservedSourceEntry(
    projectId: CollabProjectId,
  ): Promise<AuthorityTransferSourceEntryRecord | null> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      return (await this.#removeExpiredEntry(loadedEntry, record))?.source ?? null;
    });
  }

  loadCloudToLanTargetEntry(
    projectId: CollabProjectId,
  ): Promise<CloudToLanTargetEntryRecord | null> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      const entry = await this.#removeExpiredEntry(loadedEntry, record);
      const target = entry?.target ?? null;
      if (target && record && this.#isLocalTargetEntry(target)) {
        await this.#reconcileTargetEntrySuccessor(target, record);
      }
      return target;
    });
  }

  loadCloudToLanManagerEntry(
    projectId: CollabProjectId,
  ): Promise<CloudToLanManagerEntryRecord | null> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      return (await this.#removeExpiredEntry(loadedEntry, record))?.manager ?? null;
    });
  }

  prepareCloudToLanTargetEntry(
    entry: CloudToLanTargetEntryRecord,
  ): Promise<CloudToLanTargetEntryRecord> {
    let decoded: CloudToLanTargetEntryRecord;
    try {
      decoded = decodeCloudToLanTargetEntryRecord(entry);
    } catch {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-invalid',
      );
    }
    if (!this.#isRecoveryOwner(decoded.ownerInstallationKey)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-owner-mismatch',
      );
    }
    return this.runProject(decoded.projectId, async () => {
      const [loadedEntry, loadedRecord] = await Promise.all([
        this.stores.authorityTransferEntries.load(decoded.projectId),
        this.stores.authorityTransferRecords.load(decoded.projectId),
      ]);
      let record = loadedRecord;
      const document = await this.#removeExpiredEntry(loadedEntry, record);
      if (
        record
        && !this.#isForeignPhysical(record)
        && record.localRole === 'target'
        && record.status.direction === 'cloud-to-lan'
        && record.status.state === 'cancelled'
        && record.terminalCleanupCompleted
      ) {
        if (!await this.stores.authorityTransferRecords.removeExact(record)) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-physical-record-stale',
          );
        }
        record = null;
      }
      const existing = document?.target;
      const managerIsUnresolved = document?.manager !== null
        && document?.manager !== undefined
        && document.manager.phase !== 'settled';
      if (existing) {
        if (sameValue(existing, decoded)) return existing;
        if (
          existing.phase === 'withdrawn'
          && record === null
          && !managerIsUnresolved
        ) {
          await this.stores.authorityTransferEntries.saveTarget(decoded);
          return decoded;
        }
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-target-entry-conflict',
        );
      }
      if (
        record
        || managerIsUnresolved
        || (document?.source !== null && document?.source !== undefined)
      ) throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-conflict',
      );
      await this.stores.authorityTransferEntries.saveTarget(decoded);
      return decoded;
    });
  }

  publishCloudToLanTargetEntry(
    entry: CloudToLanTargetEntryRecord,
    descriptor: Pick<
      CloudToLanTargetPreparationDescriptor,
      'caCertificatePem' | 'caFingerprint' | 'publishedAt' | 'targetUrl'
    >,
  ): Promise<CloudToLanTargetEntryRecord> {
    let decoded: CloudToLanTargetEntryRecord;
    let published: CloudToLanTargetEntryRecord;
    try {
      decoded = decodeCloudToLanTargetEntryRecord(entry);
      published = publishCloudToLanTargetEntry(decoded, descriptor);
    } catch {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-publish-invalid',
      );
    }
    return this.runProject(decoded.projectId, async () => {
      const current = (await this.stores.authorityTransferEntries.load(decoded.projectId))?.target;
      if (!current || !sameValue(current, decoded)) {
        if (current && sameValue(current, published)) return current;
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-target-entry-stale',
        );
      }
      await this.stores.authorityTransferEntries.saveTarget(published);
      return published;
    });
  }

  withdrawCloudToLanTargetEntry(
    entry: CloudToLanTargetEntryRecord,
  ): Promise<CloudToLanTargetEntryRecord> {
    let decoded: CloudToLanTargetEntryRecord;
    let withdrawn: CloudToLanTargetEntryRecord;
    try {
      decoded = decodeCloudToLanTargetEntryRecord(entry);
      withdrawn = withdrawCloudToLanTargetEntry(decoded, this.now().toISOString());
    } catch {
      throw transferError(
        'authority-transfer-stale',
        'authority-transfer-target-withdrawal-invalid',
      );
    }
    return this.runProject(decoded.projectId, async () => {
      const [document, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(decoded.projectId),
        this.stores.authorityTransferRecords.load(decoded.projectId),
      ]);
      const current = document?.target;
      if (current && sameValue(current, withdrawn)) return current;
      if (!current || !sameValue(current, decoded) || record !== null) {
        throw transferError(
          'authority-transfer-cancellation-forbidden',
          'authority-transfer-target-withdrawal-stale',
        );
      }
      await this.stores.authorityTransferEntries.saveTarget(withdrawn);
      return withdrawn;
    });
  }

  handoffCloudToLanTargetEntry(
    entry: CloudToLanTargetEntryRecord,
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferRecord> {
    let decodedEntry: CloudToLanTargetEntryRecord;
    let decodedRecord: AuthorityTransferRecord;
    let handedOff: CloudToLanTargetEntryRecord;
    try {
      decodedEntry = decodeCloudToLanTargetEntryRecord(entry);
      decodedRecord = decodeAuthorityTransferRecord(record);
      handedOff = handoffCloudToLanTargetEntry(decodedEntry, decodedRecord);
    } catch {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-handoff-invalid',
      );
    }
    return this.runProject(decodedEntry.projectId, async () => {
      const [document, physical] = await Promise.all([
        this.stores.authorityTransferEntries.load(decodedEntry.projectId),
        this.stores.authorityTransferRecords.load(decodedEntry.projectId),
      ]);
      const current = document?.target;
      if (!current) throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-handoff-missing',
      );
      if (physical) {
        if (!sameValue(physical, decodedRecord)) throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-target-entry-successor-conflict',
        );
      } else {
        // The canonical physical record becomes durable before the logical
        // preparation records its successor. A crash between these writes is
        // recovered only by the exact entry/record linkage below.
        await this.stores.authorityTransferRecords.save(decodedRecord);
      }
      if (sameValue(current, handedOff)) return decodedRecord;
      if (!sameValue(current, decodedEntry)) throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-handoff-stale',
      );
      await this.stores.authorityTransferEntries.saveTarget(handedOff);
      return decodedRecord;
    });
  }

  prepareCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
  ): Promise<CloudToLanManagerEntryRecord> {
    let decoded: CloudToLanManagerEntryRecord;
    try {
      decoded = decodeCloudToLanManagerEntryRecord(entry);
    } catch {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-manager-entry-invalid',
      );
    }
    return this.runProject(decoded.projectId, async () => {
      const [document, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(decoded.projectId),
        this.stores.authorityTransferRecords.load(decoded.projectId),
      ]);
      const existing = document?.manager;
      if (existing) {
        if (sameValue(existing, decoded)) return existing;
        if (
          existing.phase === 'settled'
          && record === null
        ) {
          await this.stores.authorityTransferEntries.saveManager(decoded);
          return decoded;
        }
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-manager-entry-conflict',
        );
      }
      const target = document?.target;
      const compatibleSameDeviceTarget = target === undefined || target === null
        || (
          target.phase === 'published'
          && target.descriptor !== null
          && sameValue(target.descriptor, decoded.descriptor)
        );
      if (record || document?.source || !compatibleSameDeviceTarget) throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-manager-entry-conflict',
      );
      await this.stores.authorityTransferEntries.saveManager(decoded);
      return decoded;
    });
  }

  markCloudToLanManagerBeginPossiblySent(
    entry: CloudToLanManagerEntryRecord,
  ): Promise<CloudToLanManagerEntryRecord> {
    return this.#updateCloudToLanManagerEntry(
      entry,
      markCloudToLanManagerBeginPossiblySent(entry),
    );
  }

  recordCloudToLanManagerStatus(
    entry: CloudToLanManagerEntryRecord,
    status: CollabAuthorityTransferStatus,
  ): Promise<CloudToLanManagerEntryRecord> {
    return this.#updateCloudToLanManagerEntry(
      entry,
      recordCloudToLanManagerStatus(entry, status),
    );
  }

  prepareCloudToLanManagerCancellation(
    entry: CloudToLanManagerEntryRecord,
    request: Parameters<typeof prepareCloudToLanManagerCancellation>[1],
  ): Promise<CloudToLanManagerEntryRecord> {
    return this.#updateCloudToLanManagerEntry(
      entry,
      prepareCloudToLanManagerCancellation(entry, request),
    );
  }

  markCloudToLanManagerCancellationPossiblySent(
    entry: CloudToLanManagerEntryRecord,
  ): Promise<CloudToLanManagerEntryRecord> {
    return this.#updateCloudToLanManagerEntry(
      entry,
      markCloudToLanManagerCancellationPossiblySent(entry),
    );
  }

  rejectCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
  ): Promise<CloudToLanManagerEntryRecord> {
    return this.#updateCloudToLanManagerEntry(
      entry,
      rejectCloudToLanManagerEntry(entry),
    );
  }

  settleCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
  ): Promise<void> {
    if (entry.phase !== 'settled' && entry.phase !== 'rejected') {
      throw transferError(
        'authority-transfer-stale',
        'authority-transfer-manager-entry-not-settled',
      );
    }
    return this.runProject(entry.projectId, async () => {
      if (!await this.stores.authorityTransferEntries.removeManager(entry)) {
        const current = (await this.stores.authorityTransferEntries.load(entry.projectId))?.manager;
        if (current !== null && current !== undefined) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-manager-entry-stale',
          );
        }
      }
    });
  }

  #updateCloudToLanManagerEntry(
    expected: CloudToLanManagerEntryRecord,
    next: CloudToLanManagerEntryRecord,
  ): Promise<CloudToLanManagerEntryRecord> {
    return this.runProject(expected.projectId, async () => {
      const current = (await this.stores.authorityTransferEntries.load(expected.projectId))?.manager;
      if (!current || !sameValue(current, expected)) {
        if (current && sameValue(current, next)) return current;
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-manager-entry-stale',
        );
      }
      await this.stores.authorityTransferEntries.saveManager(next);
      return next;
    });
  }

  submitRequesterEntry(
    entry: AuthorityTransferRequesterEntryRecord,
  ): Promise<AuthorityTransferRequesterEntryRecord> {
    let decoded: AuthorityTransferRequesterEntryRecord;
    try {
      const candidate = decodeAuthorityTransferEntryComponent(entry);
      if (candidate.entryRole !== 'requester') throw new TypeError();
      decoded = candidate;
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-requester-entry-invalid',
      ));
    }
    return this.runProject(decoded.projectId, async () => {
      const [loadedEntry, physical] = await Promise.all([
        this.stores.authorityTransferEntries.load(decoded.projectId),
        this.stores.authorityTransferRecords.load(decoded.projectId),
      ]);
      const document = await this.#removeExpiredEntry(loadedEntry, physical);
      const existing = document?.requesters[decoded.requesterInstallationKey] ?? null;
      if (existing) {
        if (
          existing.proposedByMemberId === decoded.proposedByMemberId
          && sameValue(existing.request, decoded.request)
        ) return existing;
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-entry-conflict',
        );
      }
      await this.stores.authorityTransferEntries.saveRequester(decoded);
      return decoded;
    });
  }

  completeRequesterEntry(
    entry: AuthorityTransferRequesterEntryRecord,
    status: CollabAuthorityTransferStatus,
  ): Promise<AuthorityTransferRequesterEntryRecord> {
    let decoded: AuthorityTransferRequesterEntryRecord;
    let completed: AuthorityTransferRequesterEntryRecord;
    try {
      const candidate = decodeAuthorityTransferEntryComponent(entry);
      if (candidate.entryRole !== 'requester') throw new TypeError();
      decoded = candidate;
      completed = completeAuthorityTransferRequesterEntry(decoded, status);
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-requester-result-invalid',
      ));
    }
    return this.runProject(decoded.projectId, async () => {
      const [loadedEntry, physical] = await Promise.all([
        this.stores.authorityTransferEntries.load(decoded.projectId),
        this.stores.authorityTransferRecords.load(decoded.projectId),
      ]);
      const document = await this.#removeExpiredEntry(loadedEntry, physical);
      const current = document?.requesters[decoded.requesterInstallationKey] ?? null;
      if (
        !current
        || current.proposedByMemberId !== decoded.proposedByMemberId
        || !sameValue(current.request, decoded.request)
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-requester-entry-stale',
        );
      }
      if (current.status) {
        if (sameValue(current.status, status)) return current;
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-requester-result-conflict',
        );
      }
      await this.stores.authorityTransferEntries.saveRequester(completed);
      return completed;
    });
  }

  settleRequesterCancellation(
    entry: AuthorityTransferRequesterEntryRecord,
    status: CollabAuthorityTransferStatus,
  ): Promise<void> {
    let decoded: AuthorityTransferRequesterEntryRecord;
    let cancelled: CollabAuthorityTransferStatus;
    try {
      const candidate = decodeAuthorityTransferEntryComponent(entry);
      if (candidate.entryRole !== 'requester' || !candidate.status) throw new TypeError();
      decoded = candidate;
      const knownStatus = candidate.status;
      cancelled = decodeCollabAuthorityTransferStatus(status);
      if (
        cancelled.phase !== 'cancelled'
        || cancelled.state !== 'cancelled'
        || cancelled.projectId !== decoded.projectId
        || cancelled.transferId !== knownStatus.transferId
        || cancelled.direction !== knownStatus.direction
        || cancelled.sourceAuthority.generation
          !== knownStatus.sourceAuthority.generation
        || cancelled.targetAuthority.generation
          !== knownStatus.targetAuthority.generation
        || cancelled.targetUrl !== knownStatus.targetUrl
      ) throw new TypeError();
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-requester-cancellation-invalid',
      ));
    }
    return this.runProject(decoded.projectId, async () => {
      const document = await this.stores.authorityTransferEntries.load(decoded.projectId);
      const current = document?.requesters[decoded.requesterInstallationKey] ?? null;
      if (!current || !sameValue(current, decoded)) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-requester-entry-stale',
        );
      }
      if (!await this.stores.authorityTransferEntries.removeRequester(decoded)) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-requester-entry-stale',
        );
      }
    });
  }

  proposeEntry(
    record: AuthorityTransferSourceEntryRecord,
  ): Promise<AuthorityTransferSourceEntryRecord> {
    let decoded: AuthorityTransferSourceEntryRecord;
    try {
      const candidate = decodeAuthorityTransferEntryComponent(record);
      if (candidate.entryRole !== 'source') throw new TypeError();
      decoded = candidate;
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-entry-invalid',
      ));
    }
    if (!this.#isLocalSourceEntry(decoded)) {
      return Promise.reject(transferError(
        'durable-progress-recovery-required',
        'authority-transfer-source-entry-owner-mismatch',
      ));
    }
    return this.runProject(decoded.projectId, async () => {
      const [loadedEntry, physical] = await Promise.all([
        this.stores.authorityTransferEntries.load(decoded.projectId),
        this.stores.authorityTransferRecords.load(decoded.projectId),
      ]);
      const document = await this.#removeExpiredEntry(loadedEntry, physical);
      const existing = document?.source ?? null;
      if (existing) {
        if (!this.#isLocalSourceEntry(existing)) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-source-entry-owner-mismatch',
          );
        }
        if (
          existing.proposedByMemberId === decoded.proposedByMemberId
          && sameValue(existing.request, decoded.request)
        ) {
          return existing;
        }
        if (existing.phase === 'cancelled') {
          if (existing.request.idempotencyKey === decoded.request.idempotencyKey) {
            throw transferError(
              'authority-transfer-stale',
              'authority-transfer-entry-idempotency-key-reused',
            );
          }
          if (physical) {
            if (this.#isForeignPhysical(physical)) {
              throw transferError(
                'durable-progress-recovery-required',
                'authority-transfer-foreign-record-conflict',
              );
            }
            await this.#assertSafeCancelledPhysicalReplacement(physical);
            if (!await this.stores.authorityTransferRecords.removeExact(physical)) {
              throw transferError(
                'durable-progress-recovery-required',
                'authority-transfer-physical-record-stale',
              );
            }
          }
          await this.stores.authorityTransferEntries.saveSource(decoded);
          return decoded;
        }
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-entry-conflict',
        );
      }
      if (physical) {
        if (this.#isForeignPhysical(physical)) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-foreign-record-conflict',
          );
        }
        await this.#assertSafeCancelledPhysicalReplacement(physical);
        if (!await this.stores.authorityTransferRecords.removeExact(physical)) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-physical-record-stale',
          );
        }
      }
      await this.stores.authorityTransferEntries.saveSource(decoded);
      return decoded;
    });
  }

  cancelSourceEntry(
    request: LanToCloudCancellationIntent,
  ): Promise<AuthorityTransferSourceEntryRecord> {
    const projectId = request.projectId;
    return this.runProject(projectId, async () => {
      const [loadedEntry, physical] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
      ]);
      const document = await this.#removeExpiredEntry(loadedEntry, physical);
      const entry = document?.source;
      if (!entry || !this.#isLocalSourceEntry(entry)) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-entry-missing');
      }
      if (
        entry.status.transferId !== request.transferId
        || entry.request.expectedAuthorityGeneration !== request.expectedAuthorityGeneration
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-entry-cancel-stale');
      }
      let prepared: AuthorityTransferSourceEntryRecord;
      try {
        prepared = prepareAuthorityTransferSourceCancellation(entry, request);
      } catch {
        throw transferError('authority-transfer-stale', 'authority-transfer-entry-cancel-stale');
      }
      if (entry.phase === 'cancelled') return prepared;
      if (entry.status.phase !== request.expectedPhase) {
        throw transferError('authority-transfer-stale', 'authority-transfer-entry-cancel-stale');
      }
      if (physical || entry.phase === 'handed-off') {
        throw transferError('authority-transfer-stale', 'authority-transfer-entry-handed-off');
      }
      let cancelled: AuthorityTransferSourceEntryRecord;
      try {
        cancelled = cancelAuthorityTransferSourceEntry(
          prepared,
          request,
          this.now().toISOString(),
        );
      } catch {
        throw transferError('authority-transfer-stale', 'authority-transfer-entry-cancel-invalid');
      }
      await this.stores.authorityTransferEntries.saveSource(cancelled);
      return cancelled;
    });
  }

  prepareLanToCloudCancellation(
    request: LanToCloudCancellationIntent,
  ): Promise<AuthorityTransferRecord> {
    return this.runProject(request.projectId, async () => {
      const [document, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(request.projectId),
        this.stores.authorityTransferRecords.load(request.projectId),
      ]);
      const entry = document?.source;
      if (!entry || !this.#isLocalSourceEntry(entry) || !record) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-record-missing');
      }
      if (entry.phase === 'cancelled') {
        try {
          const replay = prepareAuthorityTransferSourceCancellation(entry, request);
          if (
            replay !== entry
            || record.localRole !== 'source'
            || record.status.state !== 'cancelled'
            || record.ownerInstallationKey !== entry.ownerInstallationKey
            || record.transferId !== entry.status.transferId
            || record.operationIntentId !== entry.request.idempotencyKey
          ) throw new TypeError();
          return record;
        } catch {
          throw transferError(
            'authority-transfer-stale',
            'authority-transfer-cancel-intent-stale',
          );
        }
      }
      await this.#reconcileEntrySuccessor(entry, record);
      if (
        entry.phase !== 'handed-off'
        || record.localRole !== 'source'
        || record.transferId !== request.transferId
        || record.status.sourceAuthority.generation !== request.expectedAuthorityGeneration
        || record.status.relinquishmentProof !== null
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-cancel-intent-stale');
      }
      let prepared: AuthorityTransferSourceEntryRecord;
      try {
        prepared = prepareAuthorityTransferSourceCancellation(entry, request);
      } catch {
        throw transferError('authority-transfer-stale', 'authority-transfer-cancel-intent-stale');
      }
      if (
        prepared === entry
        && record.status.state === 'cancelled'
      ) return record;
      if (
        entry.cancellation === null
        && record.status.phase !== request.expectedPhase
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-cancel-intent-stale');
      }
      if (prepared !== entry) {
        await this.stores.authorityTransferEntries.saveSource(prepared);
      }
      return record;
    });
  }

  markLanToCloudCancellationPossiblySent(
    request: LanToCloudCancellationIntent,
  ): Promise<void> {
    return this.runProject(request.projectId, async () => {
      const [document, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(request.projectId),
        this.stores.authorityTransferRecords.load(request.projectId),
      ]);
      const entry = document?.source;
      if (!entry || !this.#isLocalSourceEntry(entry) || !record) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-record-missing');
      }
      await this.#reconcileEntrySuccessor(entry, record);
      let prepared: AuthorityTransferSourceEntryRecord;
      try {
        prepared = prepareAuthorityTransferSourceCancellation(entry, request);
      } catch {
        throw transferError('authority-transfer-stale', 'authority-transfer-cancel-intent-stale');
      }
      const marked = markAuthorityTransferSourceCancellationPossiblySent(prepared);
      if (marked !== entry) await this.stores.authorityTransferEntries.saveSource(marked);
    });
  }

  settleRejectedLanToCloudCancellation(
    request: LanToCloudCancellationIntent,
    record: AuthorityTransferRecord,
  ): Promise<void> {
    return this.runProject(request.projectId, async () => {
      const [document, current] = await Promise.all([
        this.stores.authorityTransferEntries.load(request.projectId),
        this.stores.authorityTransferRecords.load(request.projectId),
      ]);
      const source = document?.source;
      const cancellation = source?.cancellation;
      if (
        !source
        || !this.#isLocalSourceEntry(source)
        || source.phase !== 'handed-off'
        || !cancellation
        || !current
        || !sameValue(current, record)
        || cancellation.expectedAuthorityGeneration !== request.expectedAuthorityGeneration
        || cancellation.expectedPhase !== request.expectedPhase
        || cancellation.idempotencyKey !== request.idempotencyKey
        || cancellation.projectId !== request.projectId
        || cancellation.transferId !== request.transferId
        || current.status.phase === request.expectedPhase
        || current.status.state === 'cancelled'
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-cancellation-rejection-stale',
        );
      }
      await this.stores.authorityTransferEntries.saveSource(
        clearAuthorityTransferSourceCancellation(source),
      );
    });
  }

  cancelUnbegunLanToCloudSource(
    request: LanToCloudCancellationIntent,
    cloudAbsenceProven = false,
  ): Promise<AuthorityTransferRecord> {
    return this.runProject(request.projectId, async () => {
      const [document, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(request.projectId),
        this.stores.authorityTransferRecords.load(request.projectId),
      ]);
      const entry = document?.source;
      if (!entry || !this.#isLocalSourceEntry(entry) || !record) {
        throw transferError('authority-transfer-not-found', 'authority-transfer-record-missing');
      }
      await this.#reconcileEntrySuccessor(entry, record);
      let prepared: AuthorityTransferSourceEntryRecord;
      try {
        prepared = prepareAuthorityTransferSourceCancellation(entry, request);
      } catch {
        throw transferError('authority-transfer-stale', 'authority-transfer-local-cancel-stale');
      }
      if (
        entry.phase !== 'handed-off'
        || (
          entry.beginSubmission !== 'not-sent'
          && !(cloudAbsenceProven && entry.beginSubmission === 'possibly-sent')
        )
        || record.localRole !== 'source'
        || record.transferId !== request.transferId
        || record.status.sourceAuthority.generation !== request.expectedAuthorityGeneration
        || record.status.phase !== request.expectedPhase
        || record.status.phase !== 'collecting-readiness'
        || record.status.relinquishmentProof !== null
      ) {
        throw transferError('authority-transfer-stale', 'authority-transfer-local-cancel-stale');
      }
      if (cloudAbsenceProven && entry.beginSubmission === 'possibly-sent') {
        await this.stores.authorityTransferEntries.saveSource(
          markAuthorityTransferSourceCloudAbsent(prepared),
        );
      } else if (prepared !== entry) {
        await this.stores.authorityTransferEntries.saveSource(prepared);
      }
      return this.#advanceUnbegunCancellation(record, 'target-cleaned');
    });
  }

  resumeUnbegunLanToCloudCancellation(
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferRecord> {
    return this.runProject(record.projectId, async () => {
      const [document, current] = await Promise.all([
        this.stores.authorityTransferEntries.load(record.projectId),
        this.stores.authorityTransferRecords.load(record.projectId),
      ]);
      const entry = document?.source;
      if (
        !entry
        || !this.#isLocalSourceEntry(entry)
        || entry.phase !== 'handed-off'
        || (
          entry.beginSubmission !== 'not-sent'
          && entry.beginSubmission !== 'cloud-absent'
        )
        || !current
        || !sameValue(current, record)
        || (
          !COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(
            current.status.phase as never,
          )
          && !(
            current.status.phase === 'collecting-readiness'
            && entry.beginSubmission === 'cloud-absent'
            && entry.cancellation !== null
          )
        )
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-local-cancel-stale',
        );
      }
      await this.#reconcileEntrySuccessor(entry, current);
      return this.#advanceUnbegunCancellation(current, 'target-cleaned');
    });
  }

  completeUnbegunLanToCloudCancellation(
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferRecord> {
    return this.runProject(record.projectId, async () => {
      const [document, current] = await Promise.all([
        this.stores.authorityTransferEntries.load(record.projectId),
        this.stores.authorityTransferRecords.load(record.projectId),
      ]);
      const entry = document?.source;
      if (
        !entry
        || !this.#isLocalSourceEntry(entry)
        || entry.phase !== 'handed-off'
        || entry.beginSubmission === 'possibly-sent'
        || entry.cancellation === null
        || !current
        || !sameValue(current, record)
        || (
          current.status.phase !== 'target-cleaned'
          && current.status.phase !== 'source-reopened'
          && current.status.phase !== 'cancelled'
        )
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-local-cancel-completion-stale',
        );
      }
      await this.#reconcileEntrySuccessor(entry, current);
      return this.#advanceUnbegunCancellation(current, 'cancelled');
    });
  }

  markLanToCloudBeginPossiblySent(
    record: AuthorityTransferRecord,
  ): Promise<void> {
    return this.runProject(record.projectId, async () => {
      const [document, current] = await Promise.all([
        this.stores.authorityTransferEntries.load(record.projectId),
        this.stores.authorityTransferRecords.load(record.projectId),
      ]);
      const source = document?.source;
      if (
        !document
        || !source
        || !this.#isLocalSourceEntry(source)
        || !current
        || !sameValue(current, record)
        || record.status.phase !== 'collecting-readiness'
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-begin-submission-stale',
        );
      }
      await this.#reconcileEntrySuccessor(source, current);
      let marked: AuthorityTransferSourceEntryRecord;
      try {
        marked = markAuthorityTransferSourceBeginPossiblySent(source);
      } catch {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-begin-submission-stale',
        );
      }
      if (marked === source) return;
      await this.stores.authorityTransferEntries.saveSource(marked);
    });
  }

  handoffEntry(
    entry: AuthorityTransferSourceEntryRecord,
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferRecord> {
    let decodedEntry: AuthorityTransferSourceEntryRecord;
    let decodedRecord: AuthorityTransferRecord;
    let handedOff: AuthorityTransferEntryRecord;
    try {
      const candidate = decodeAuthorityTransferEntryComponent(entry);
      if (candidate.entryRole !== 'source') throw new TypeError();
      decodedEntry = candidate;
      decodedRecord = decodeAuthorityTransferRecord(record);
      handedOff = createAuthorityTransferEntryDocument({
        projectId: decodedEntry.projectId,
        source: handoffAuthorityTransferEntry(decodedEntry, decodedRecord),
      });
    } catch {
      return Promise.reject(transferError(
        'authority-transfer-stale',
        'authority-transfer-entry-handoff-invalid',
      ));
    }
    return this.runProject(decodedEntry.projectId, async () => {
      const [loadedEntry, currentRecord] = await Promise.all([
        this.stores.authorityTransferEntries.load(decodedEntry.projectId),
        this.stores.authorityTransferRecords.load(decodedEntry.projectId),
      ]);
      const currentDocument = await this.#removeExpiredEntry(loadedEntry, currentRecord);
      const currentEntry = currentDocument?.source;
      if (
        !currentEntry
        || currentEntry.projectId !== decodedEntry.projectId
        || currentEntry.proposedByMemberId !== decodedEntry.proposedByMemberId
        || !sameValue(currentEntry.request, decodedEntry.request)
        || currentEntry.status.transferId !== decodedEntry.status.transferId
      ) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-entry-handoff-stale',
        );
      }
      if (currentRecord && !sameValue(currentRecord, decodedRecord)) {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-entry-successor-conflict',
        );
      }
      if (!currentRecord) {
        await this.stores.authorityTransferRecords.save(decodedRecord);
      }
      const handedOffSource = handedOff.source;
      if (!handedOffSource) throw new TypeError('Missing handed-off source entry');
      if (!sameValue(currentEntry, handedOffSource)) {
        await this.stores.authorityTransferEntries.saveSource(handedOffSource);
      }
      return decodedRecord;
    });
  }

  bindLegacySourceOwner(
    projectId: CollabProjectId,
    ownerInstallationKey: InstallationKey,
  ): Promise<void> {
    return this.runProject(projectId, async () => {
      const record = await this.stores.authorityTransferRecords.load(projectId);
      if (!record || record.localRole !== 'source') return;
      const bound = bindLegacyAuthorityTransferSourceOwner(record, ownerInstallationKey);
      if (bound !== record) await this.stores.authorityTransferRecords.save(bound);
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
        await this.#assertTerminalCleanupClaimOwner(record, null, commitment);
        await this.stores.authorityTransferClaimCommitments.remove(projectId);
        return;
      }
      const expected = createAuthorityTransferClaimBatchCommitmentRecord(custody);
      if (sameValue(commitment, expected)) return;
      await this.#assertClaimBatchOwner(custody, undefined, false);
      const recoverablePredecessor = commitment === null
        ? custody.rotationPredecessor === null
        : this.#isRotationPredecessorCommitment(commitment, custody);
      if (!recoverablePredecessor || !this.#isCompleteUnacknowledgedBatch(custody)) {
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
      const [entry, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(input.projectId),
        this.stores.authorityTransferRecords.load(input.projectId),
      ]);
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
      let source = entry?.source;
      let target = entry?.target;
      if (
        source
        && this.#isLocalSourceEntry(source)
        && source.phase !== 'cancelled'
      ) {
        await this.#reconcileEntrySuccessor(source, record);
        source = (await this.stores.authorityTransferEntries.load(input.projectId))?.source;
      }
      if (target && this.#isLocalTargetEntry(target)) {
        await this.#reconcileTargetEntrySuccessor(target, record);
        target = (await this.stores.authorityTransferEntries.load(input.projectId))?.target;
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
      await this.#assertTerminalCleanupClaimOwner(record, custody, commitment);
      if (!record.terminalCleanupCompleted) {
        await this.stores.authorityTransferRecords.save(
          markAuthorityTransferTerminalCleanupCompleted(record),
        );
      }
      await this.stores.authorityTransferClaims.remove(input.projectId);
      await this.stores.authorityTransferClaimCommitments.remove(input.projectId);
      if (entry && source && this.#isLocalSourceEntry(source)) {
        const settledSource = record.status.state === 'cancelled'
          ? settleAuthorityTransferSourceCancellation(source, record)
          : null;
        if (settledSource) {
          await this.stores.authorityTransferEntries.saveSource(settledSource);
        } else if (!await this.stores.authorityTransferEntries.removeSource(source)) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-entry-source-stale',
          );
        }
      }
      if (target && this.#isLocalTargetEntry(target)) {
        if (!await this.stores.authorityTransferEntries.removeTarget(target)) {
          throw transferError(
            'durable-progress-recovery-required',
            'authority-transfer-entry-target-stale',
          );
        }
      }
    });
  }

  load(projectId: CollabProjectId): Promise<AuthorityTransferRecord | null> {
    return this.runProject(projectId, async () => {
      const [loadedEntry, record, custody, commitment] = await Promise.all([
        this.stores.authorityTransferEntries.load(projectId),
        this.stores.authorityTransferRecords.load(projectId),
        this.stores.authorityTransferClaims.load(projectId),
        this.stores.authorityTransferClaimCommitments.load(projectId),
      ]);
      const entry = await this.#removeExpiredEntry(loadedEntry, record);
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
      if (record && custody && !this.#isForeignPhysical(record)) {
        await this.#assertClaimBatchOwner(custody, record);
      }
      const source = entry?.source;
      const target = entry?.target;
      if (
        source
        && this.#isLocalSourceEntry(source)
        && record
        && !this.#isForeignPhysical(record)
        && source.phase !== 'cancelled'
      ) {
        await this.#reconcileEntrySuccessor(source, record);
      }
      if (target && record && this.#isLocalTargetEntry(target)) {
        await this.#reconcileTargetEntrySuccessor(target, record);
      }
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
    return this.#saveAbsent(record);
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
      await this.#assertClaimCustodyForStatus(decoded.status);
      await this.stores.authorityTransferRecords.save(decoded);
    });
  }

  adoptLanToCloudCanonicalIdentity(
    record: AuthorityTransferRecord,
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
      try {
        if (
          previous.lifecycleOwnership !== 'owned'
          || previous.localRole !== 'source'
          || previous.ownerInstallationKey === undefined
          || previous.status.direction !== 'lan-to-cloud'
          || previous.status.phase !== 'collecting-readiness'
          || previous.status.state !== 'active'
          || previous.status.updatedAt !== previous.status.createdAt
          || previous.status.batchRevision !== null
          || previous.status.batchSha256 !== null
          || previous.status.checkpointSha256 !== null
          || previous.status.relinquishmentProof !== null
        ) throw new TypeError();
        const canonicalPrevious = createAuthorityTransferRecord({
          lifecycleOwnership: previous.lifecycleOwnership,
          localRole: previous.localRole,
          operationIntentId: previous.operationIntentId,
          ownerInstallationKey: previous.ownerInstallationKey,
          receiptVerifier: previous.receiptVerifier,
          sourceLanEndpoint: previous.sourceLanEndpoint,
          stagingDirectoryName: previous.stagingDirectoryName,
          status: {
            ...previous.status,
            createdAt: decoded.status.createdAt,
            expiresAt: decoded.status.expiresAt,
            updatedAt: decoded.status.createdAt,
          },
        });
        assertAuthorityTransferTransition(canonicalPrevious, decoded);
      } catch {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-canonical-identity-adoption-invalid',
        );
      }
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
      await this.#assertClaimBatchOwner(record, undefined, false);
      const existing = await this.stores.authorityTransferClaims.load(record.projectId);
      if (existing) {
        if (sameClaimBatch(existing, record)) {
          await this.#persistClaimCommitment(existing);
          return existing;
        }
        throw transferError('authority-transfer-stale', 'authority-transfer-claim-batch-conflict');
      }
      await this.stores.authorityTransferClaims.save(record);
      await this.#persistClaimCommitment(record);
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
      const current = await this.#requireClaimCustody(batch.projectId, batch.transferId);
      await this.#assertClaimBatchOwner(current, undefined, false);
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
        await this.#persistClaimCommitment(current);
        return current;
      }
      await this.#assertClaimBatchOwner(current);
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
      await this.#persistClaimCommitment(persisted);
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
      const current = await this.#requireClaimCustody(receipt.projectId, receipt.transferId);
      const record = await this.stores.authorityTransferRecords.load(receipt.projectId);
      if (!record || record.transferId !== receipt.transferId) {
        throw transferError('authority-transfer-stale', 'authority-transfer-custody-owner-stale');
      }
      await this.#assertClaimBatchOwner(current, record);
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
      const current = await this.#requireClaimCustody(projectId, transferId);
      const record = await this.stores.authorityTransferRecords.load(projectId);
      await this.#assertClaimBatchOwner(current, record ?? undefined);
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
      await this.#assertClaimBatchOwner(current);
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
      const current = await this.#requireClaimCustody(receipt.projectId, receipt.transferId);
      await this.#assertClaimBatchOwner(current);
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
    return this.runProject(projectId, () => this.#assertAuthorityRestartAllowedUnlocked(projectId));
  }

  runWithAuthorityStartGuard<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runProject(projectId, async () => {
      await this.#assertAuthorityRestartAllowedUnlocked(projectId);
      return operation();
    });
  }

  runWithLanToCloudCancellationRestartGuard<T>(
    input: Readonly<{
      operationIntentId: string;
      projectId: CollabProjectId;
      transferId: string;
    }>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runProject(input.projectId, async () => {
      const [document, record] = await Promise.all([
        this.stores.authorityTransferEntries.load(input.projectId),
        this.stores.authorityTransferRecords.load(input.projectId),
      ]);
      const source = document?.source;
      if (
        !record
        || !source
        || !this.#isLocalSourceEntry(source)
        || source.phase !== 'handed-off'
        || record.localRole !== 'source'
        || record.status.direction !== 'lan-to-cloud'
        || record.operationIntentId !== input.operationIntentId
        || record.transferId !== input.transferId
        || source.status.transferId !== input.transferId
        || source.request.idempotencyKey !== input.operationIntentId
        || source.cancellation === null
        || source.cancellation.projectId !== input.projectId
        || source.cancellation.transferId !== input.transferId
        || source.cancellation.expectedAuthorityGeneration
          !== record.status.sourceAuthority.generation
        || record.status.relinquishmentProof !== null
      ) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-cancellation-restart-stale',
        );
      }
      await this.#reconcileEntrySuccessor(source, record);
      const locallyProvedCancellation = source.beginSubmission !== 'possibly-sent'
        && COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(
          record.status.phase as never,
        );
      if (record.status.state !== 'cancelled' && !locallyProvedCancellation) {
        throw transferError(
          'durable-progress-recovery-required',
          'authority-transfer-cancellation-restart-stale',
        );
      }
      return operation();
    });
  }

  expireClaims(
    projectId: CollabProjectId,
    transferId: string,
  ): Promise<void> {
    return this.runProject(projectId, async () => {
      const current = await this.#requireClaimCustody(projectId, transferId);
      const record = await this.stores.authorityTransferRecords.load(projectId);
      await this.#assertClaimBatchOwner(current, record ?? undefined);
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

  async #assertAuthorityRestartAllowedUnlocked(
    projectId: CollabProjectId,
  ): Promise<void> {
    const [loadedEntry, record, custody, commitment] = await Promise.all([
      this.stores.authorityTransferEntries.load(projectId),
      this.stores.authorityTransferRecords.load(projectId),
      this.stores.authorityTransferClaims.load(projectId),
      this.stores.authorityTransferClaimCommitments.load(projectId),
    ]);
    const entry = await this.#removeExpiredEntry(loadedEntry, record);
    const source = entry?.source;
    const target = entry?.target;
    const localSource = source !== null
      && source !== undefined
      && this.#isLocalSourceEntry(source);
    const localTarget = target !== null
      && target !== undefined
      && this.#isLocalTargetEntry(target);
    if (
      localSource
      && source.phase === 'handed-off'
      && record
      && this.#isForeignPhysical(record)
    ) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-entry-successor-owner-mismatch',
      );
    }
    if (record && this.#isForeignPhysical(record)) return;
    if (localSource && record && source.phase !== 'cancelled') {
      await this.#reconcileEntrySuccessor(source, record);
    }
    if (localTarget && record && target.phase !== 'withdrawn') {
      await this.#reconcileTargetEntrySuccessor(target, record);
    }
    if (record && record.ownerInstallationKey === undefined) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-legacy-owner-missing',
      );
    }
    if (record && !this.#isRecoveryOwner(record.ownerInstallationKey)) return;
    if (!record && (custody || commitment)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-custody-orphaned',
      );
    }
    if (!record && localSource && source.phase === 'handed-off') {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-entry-successor-missing',
      );
    }
    if (!record && localTarget && target.phase === 'handed-off') {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-successor-missing',
      );
    }
    if (commitment && !custody) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-commitment-orphaned',
      );
    }
    if (record && custody) await this.#assertClaimBatchOwner(custody, record);
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
    if (this.closed) return Promise.reject(this.#closedError());
    let queue = this.#projectQueues.get(projectId);
    if (!queue) {
      queue = new SerialTaskQueue();
      this.#projectQueues.set(projectId, queue);
    }
    return queue.run(operation);
  }

  async #removeExpiredEntry(
    entry: AuthorityTransferEntryRecord | null,
    record: AuthorityTransferRecord | null,
  ): Promise<AuthorityTransferEntryRecord | null> {
    if (!entry) return null;
    const now = this.now().getTime();
    const expiredRequesters = Object.values(entry.requesters).filter(
      requester => now >= Date.parse(requester.expiresAt),
    );
    const sourceIsLocal = entry.source !== null && this.#isLocalSourceEntry(entry.source);
    const sourceHasSettledLocalPhysical = sourceIsLocal
      && entry.source?.phase === 'cancelled'
      && record !== null
      && !this.#isForeignPhysical(record)
      && record.status.state === 'cancelled'
      && record.terminalCleanupCompleted
      && record.transferId === entry.source.status.transferId
      && record.operationIntentId === entry.source.request.idempotencyKey;
    const sourceRemovalIsSafe = sourceIsLocal
      && (
        record === null
        || this.#isForeignPhysical(record)
        || sourceHasSettledLocalPhysical
      );
    const source = entry.source
      && (
        entry.source.phase === 'handed-off'
        || now < Date.parse(entry.source.expiresAt)
        || !sourceRemovalIsSafe
      )
      ? entry.source
      : null;
    const managerIsRemovable = entry.manager !== null
      && (entry.manager.phase === 'settled' || entry.manager.phase === 'rejected')
      && now >= Date.parse(entry.manager.expiresAt);
    const targetIsRemovable = entry.target !== null
      && entry.target.phase === 'withdrawn'
      && now >= Date.parse(entry.target.expiresAt);
    if (
      source === entry.source
      && expiredRequesters.length === 0
      && !managerIsRemovable
      && !targetIsRemovable
    ) return entry;
    for (const requester of expiredRequesters) {
      await this.stores.authorityTransferEntries.removeRequester(requester);
    }
    if (entry.source && source === null) {
      await this.stores.authorityTransferEntries.removeSource(entry.source);
    }
    if (managerIsRemovable && entry.manager) {
      await this.stores.authorityTransferEntries.removeManager(entry.manager);
    }
    if (targetIsRemovable && entry.target) {
      await this.stores.authorityTransferEntries.removeTarget(entry.target);
    }
    return this.stores.authorityTransferEntries.load(entry.projectId);
  }

  #isForeignPhysical(record: AuthorityTransferRecord): boolean {
    return record.ownerInstallationKey !== undefined
      && !this.#isRecoveryOwner(record.ownerInstallationKey);
  }

  #managerMatchesPhysical(
    manager: CloudToLanManagerEntryRecord,
    record: AuthorityTransferRecord,
  ): boolean {
    return manager.status !== null
      && record.localRole === 'target'
      && record.status.direction === 'cloud-to-lan'
      && manager.operationIntentId === record.operationIntentId
      && manager.projectId === record.projectId
      && manager.status.transferId === record.transferId
      && manager.status.createdAt === record.status.createdAt
      && manager.status.expiresAt === record.status.expiresAt
      && manager.descriptor.sourceAuthorityGeneration
        === record.status.sourceAuthority.generation
      && manager.descriptor.targetUrl === record.status.targetUrl;
  }

  #isLocalSourceEntry(entry: AuthorityTransferSourceEntryRecord): boolean {
    return this.#isRecoveryOwner(entry.ownerInstallationKey);
  }

  #isLocalTargetEntry(entry: CloudToLanTargetEntryRecord): boolean {
    return this.#isRecoveryOwner(entry.ownerInstallationKey);
  }

  async #reconcileEntrySuccessor(
    entry: AuthorityTransferSourceEntryRecord,
    record: AuthorityTransferRecord,
  ): Promise<void> {
    let expected: AuthorityTransferSourceEntryRecord;
    try {
      expected = handoffAuthorityTransferEntry(entry, record);
    } catch {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-entry-successor-mismatch',
      );
    }
    if (entry.phase === 'proposed') {
      await this.stores.authorityTransferEntries.saveSource(expected);
      return;
    }
    if (!sameValue(entry, expected)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-entry-successor-mismatch',
      );
    }
  }

  async #reconcileTargetEntrySuccessor(
    entry: CloudToLanTargetEntryRecord,
    record: AuthorityTransferRecord,
  ): Promise<void> {
    let expected: CloudToLanTargetEntryRecord;
    try {
      expected = handoffCloudToLanTargetEntry(entry, record);
    } catch {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-successor-mismatch',
      );
    }
    if (entry.phase === 'published') {
      await this.stores.authorityTransferEntries.saveTarget(expected);
      return;
    }
    if (!sameValue(entry, expected)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-target-entry-successor-mismatch',
      );
    }
  }

  async #advanceUnbegunCancellation(
    initial: AuthorityTransferRecord,
    finalPhase: typeof COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES[number],
  ): Promise<AuthorityTransferRecord> {
    const phases = COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES;
    const currentCancellationIndex = phases.indexOf(initial.status.phase as never);
    const startIndex = currentCancellationIndex >= 0 ? currentCancellationIndex + 1 : 0;
    const finalIndex = phases.indexOf(finalPhase);
    let record = initial;
    const timestamp = new Date(Math.max(
      this.now().getTime(),
      Date.parse(record.status.updatedAt),
    )).toISOString();
    for (let index = startIndex; index <= finalIndex; index += 1) {
      const phase = phases[index];
      if (!phase) continue;
      const next = decodeAuthorityTransferRecord({
        ...record,
        restartFence: phase === 'source-reopened' || phase === 'cancelled'
          ? 'open'
          : 'temporary',
        status: {
          ...record.status,
          phase,
          state: phase === 'cancelled' ? 'cancelled' : 'active',
          updatedAt: timestamp,
        },
      });
      try {
        assertAuthorityTransferTransition(record, next);
      } catch {
        throw transferError(
          'authority-transfer-stale',
          'authority-transfer-local-cancel-invalid',
        );
      }
      await this.stores.authorityTransferRecords.save(next);
      record = next;
    }
    return record;
  }

   #closedError(): CollabError {
    return transferError(
      'durable-progress-recovery-required',
      'authority-transfer-persistence-closed',
    );
  }

   #saveAbsent(record: AuthorityTransferRecord): Promise<void> {
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
        await this.#assertSafeCancelledPhysicalReplacement(existing);
      }
      await this.stores.authorityTransferRecords.save(decoded);
    });
  }

  async #assertSafeCancelledPhysicalReplacement(
    existing: AuthorityTransferRecord,
  ): Promise<void> {
    if (
      existing.status.state !== 'cancelled'
      || !existing.terminalCleanupCompleted
      || existing.restartFence !== 'open'
    ) {
      throw transferError('authority-transfer-stale', 'authority-transfer-record-conflict');
    }
    const [custody, commitment] = await Promise.all([
      this.stores.authorityTransferClaims.load(existing.projectId),
      this.stores.authorityTransferClaimCommitments.load(existing.projectId),
    ]);
    if (custody || commitment) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-terminal-cleanup-incomplete',
      );
    }
  }

   async #assertClaimCustodyForStatus(status: CollabAuthorityTransferStatus): Promise<void> {
    if (status.batchRevision === null || status.batchSha256 === null) return;
    const custody = await this.#requireClaimCustody(status.projectId, status.transferId);
    await this.#assertClaimBatchOwner(custody);
    if (!claimCustodyMatchesStatus(custody, status)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-custody-incomplete',
      );
    }
  }

   async #assertClaimBatchOwner(
    custody: AuthorityTransferClaimCustodyRecord,
    knownRecord?: AuthorityTransferRecord,
    requireCommitment = true,
  ): Promise<void> {
    const record = knownRecord
      ?? await this.stores.authorityTransferRecords.load(custody.projectId);
    const checkpointMatches = record?.status.checkpointSha256 === null
      || record?.status.checkpointSha256 === custody.checkpointSha256;
    const expectedOperationIntentId = record?.localRole === 'target'
      ? authorityTransferChildIdempotencyKey(record.operationIntentId, 'stage')
      : record?.operationIntentId;
    if (
      !record
      || record.transferId !== custody.transferId
      || expectedOperationIntentId !== custody.operationIntentId
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

   async #assertTerminalCleanupClaimOwner(
    record: AuthorityTransferRecord,
    custody: AuthorityTransferClaimCustodyRecord | null,
    commitment: AuthorityTransferClaimBatchCommitmentRecord | null,
  ): Promise<void> {
    if (custody) {
      await this.#assertClaimBatchOwner(custody, record);
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
      || commitment.operationIntentId !== (
        record.localRole === 'target'
          ? authorityTransferChildIdempotencyKey(record.operationIntentId, 'stage')
          : record.operationIntentId
      )
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

   async #persistClaimCommitment(
    custody: AuthorityTransferClaimCustodyRecord,
  ): Promise<void> {
    const expected = createAuthorityTransferClaimBatchCommitmentRecord(custody);
    const existing = await this.stores.authorityTransferClaimCommitments.load(
      custody.projectId,
    );
    if (sameValue(existing, expected)) return;
    if (existing && !this.#isRotationPredecessorCommitment(existing, custody)) {
      throw transferError(
        'durable-progress-recovery-required',
        'authority-transfer-claim-commitment-mismatch',
      );
    }
    await this.stores.authorityTransferClaimCommitments.save(expected);
  }

   #isRotationPredecessorCommitment(
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

   #isCompleteUnacknowledgedBatch(
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

   async #requireClaimCustody(
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
