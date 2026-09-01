import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  type AcceptLanToCloudTransferTargetRequest,
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabCloudAuthorityTransferArtifact,
  type CollabMemberId,
  type CollabProjectId,
  decodeCollabAuthorityTransferOperationRequest,
  decodeCollabAuthorityTransferStatus,
  type RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import {
  destroyAuthorityTransferArtifactBodies,
} from '@/app/collab/authority-transfer/AuthorityTransferArtifactBodies';
import {
  authorityTransferEntryExpiresAt,
  createAuthorityTransferEntryRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import {
  advanceThroughObservedAuthorityStatus,
} from '@/app/collab/authority-transfer/AuthorityTransferObservedStatus';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import {
  type AuthorityTransferRecord,
  createAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type {
  AuthorityTransferPersistence,
  LanToCloudCancellationIntent,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  CollabAuthorityLifecyclePort,
} from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface LanToCloudCheckpointArtifact {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly body: Readable;
  readonly byteCount: number;
}

export interface LanToCloudCapturedCheckpoint {
  readonly artifacts: readonly LanToCloudCheckpointArtifact[];
  readonly checkpointManifestSha256: string;
  readonly sourceHostMemberId: string;
  readonly sourceProof: string;
}

export interface LanToCloudSourceEffects {
  activateTerminal(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<void>;
  capture(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<LanToCloudCapturedCheckpoint>;
  commitRelinquishmentFence(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityRelinquishmentProof>;
  reopenAfterCancellation(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<void>;
  releaseSourceEndpoint?(record: AuthorityTransferRecord, endpoint: string): Promise<void>;
  sourceEndpoint?(record: AuthorityTransferRecord): Promise<string>;
}

export interface LanToCloudSourceCoordinatorOptions {
  readonly cloud: CollabAuthorityLifecyclePort;
  readonly installationKey: InstallationKey;
  readonly persistence: AuthorityTransferPersistence;
  readonly source: LanToCloudSourceEffects;
}

export interface LanToCloudSourceProposalCoordinatorOptions {
  readonly createTransferId?: () => string;
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
  readonly persistence: AuthorityTransferPersistence;
}

function transferError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function stagingDirectory(transferId: string): string {
  return `.claudian-authority-transfer-${transferId}`;
}

export class LanToCloudSourceCoordinator {
  constructor(private readonly options: LanToCloudSourceCoordinatorOptions) {}

  private assertOwnedRecord(record: AuthorityTransferRecord): void {
    if (record.ownerInstallationKey !== this.options.installationKey) {
      throw transferError('host-installation-recovery-owner-mismatch');
    }
  }

  async acceptAndTransfer(
    request: AcceptLanToCloudTransferTargetRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const entry = await this.options.persistence.loadSourceEntry(request.projectId);
    if (
      !entry
      || entry.entryRole !== 'source'
      || entry.status.transferId !== request.transferId
    ) {
      throw transferError('lan-to-cloud-proposal-missing');
    }
    if (
      request.expectedAuthorityGeneration !== entry.request.expectedAuthorityGeneration
      || request.idempotencyKey !== authorityTransferChildIdempotencyKey(
        entry.request.idempotencyKey,
        'accept',
      )
      || request.targetUrl !== entry.request.targetUrl
    ) throw transferError('lan-to-cloud-host-acceptance-mismatch');
    const existing = await this.options.persistence.load(request.projectId);
    if (existing) {
      this.assertOwnedRecord(existing);
      if (
        existing.localRole !== 'source'
        || existing.transferId !== entry.status.transferId
        || existing.operationIntentId !== entry.request.idempotencyKey
        || existing.status.targetUrl !== entry.request.targetUrl
      ) throw transferError('lan-to-cloud-entry-successor-mismatch');
      return this.resumeRecord(existing, options);
    }
    if (entry.phase === 'handed-off') {
      throw transferError('lan-to-cloud-entry-successor-missing');
    }
    const candidate = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: entry.request.idempotencyKey,
      ownerInstallationKey: this.options.installationKey,
      stagingDirectoryName: stagingDirectory(entry.status.transferId),
      status: entry.status,
    });
    const sourceLanEndpoint = await this.options.source.sourceEndpoint?.(candidate);
    if (!sourceLanEndpoint) {
      throw transferError('lan-to-cloud-source-endpoint-missing');
    }
    const owned = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: entry.request.idempotencyKey,
      ownerInstallationKey: this.options.installationKey,
      sourceLanEndpoint,
      stagingDirectoryName: stagingDirectory(entry.status.transferId),
      status: entry.status,
    });
    try {
      await this.options.persistence.handoffEntry(entry, owned);
    } catch (error) {
      let durable: AuthorityTransferRecord | null = null;
      let durableReadSucceeded = false;
      try {
        durable = await this.options.persistence.load(entry.projectId);
        if (durable) this.assertOwnedRecord(durable);
        durableReadSucceeded = true;
      } catch {
        // An ambiguous durable write must retain the runtime endpoint pin.
      }
      const proposalProven = durableReadSucceeded && durable === null;
      if (proposalProven && this.options.source.releaseSourceEndpoint) {
        await this.options.source.releaseSourceEndpoint(candidate, sourceLanEndpoint)
          .catch(() => undefined);
      }
      throw error;
    }
    return this.resumeRecord(owned, options);
  }

  async restoreSourceEndpoint(record: AuthorityTransferRecord): Promise<void> {
    this.assertOwnedRecord(record);
    if (record.localRole !== 'source' || !record.sourceLanEndpoint) {
      throw transferError('lan-to-cloud-source-endpoint-missing');
    }
    const restored = await this.options.source.sourceEndpoint?.(record);
    if (!restored) throw transferError('lan-to-cloud-source-endpoint-missing');
    if (restored === record.sourceLanEndpoint) return;
    await this.options.source.releaseSourceEndpoint?.(record, restored).catch(() => undefined);
    throw transferError('lan-to-cloud-source-endpoint-mismatch');
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const record = await this.options.persistence.load(projectId);
    if (!record || record.localRole !== 'source') {
      throw transferError('lan-to-cloud-record-missing');
    }
    this.assertOwnedRecord(record);
    return this.resumeRecord(record, options);
  }

  async cancel(
    request: LanToCloudCancellationIntent,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const record = await this.options.persistence.prepareLanToCloudCancellation(request);
    this.assertOwnedRecord(record);
    if (record.status.state === 'cancelled') {
      if (!record.terminalCleanupCompleted) {
        await this.completeCancellation(record, options);
      }
      return record.status;
    }
    return this.resumeCancellation(record, request, options);
  }

  private async resumeCancellation(
    record: AuthorityTransferRecord,
    request: LanToCloudCancellationIntent,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    const sourceEntry = await this.options.persistence.loadSourceEntry(request.projectId);
    const cancellationIsLocallyProved = sourceEntry?.status.transferId === record.transferId
      && sourceEntry.beginSubmission !== 'possibly-sent'
      && (
        record.status.phase === 'collecting-readiness'
        || COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(record.status.phase as never)
      );
    if (
      record.status.phase === 'collecting-readiness'
      && sourceEntry?.status.transferId !== record.transferId
    ) {
      throw transferError('lan-to-cloud-entry-successor-missing');
    }
    if (cancellationIsLocallyProved) {
      const prepared = record.status.phase === 'collecting-readiness'
        ? await this.options.persistence.cancelUnbegunLanToCloudSource(request)
        : await this.options.persistence.resumeUnbegunLanToCloudCancellation(record);
      const settled = await this.completeLocalCancellation(prepared, options);
      return settled.status;
    }
    let settled: AuthorityTransferRecord;
    try {
      await this.options.persistence.markLanToCloudCancellationPossiblySent(request);
      const cancelled = await this.options.cloud.authorityTransfer(
        'cancelProjectAuthorityTransfer',
        {
          expectedPhase: request.expectedPhase,
          idempotencyKey: request.idempotencyKey,
          projectId: record.projectId,
          transferId: request.transferId,
        },
        options,
      );
      settled = await advanceThroughObservedAuthorityStatus(
        this.options.persistence,
        record,
        cancelled,
      );
    } catch (error) {
      if (
        error instanceof CollabError
        && error.code === 'authority-transfer-stale'
      ) {
        const observed = await this.retainObservedClaimBatch(
          record,
          await this.readStatus(record, options),
          options,
        );
        const reconciled = await advanceThroughObservedAuthorityStatus(
          this.options.persistence,
          record,
          observed,
        );
        if (reconciled.status.state === 'cancelled') {
          await this.completeCancellation(reconciled, options);
          return reconciled.status;
        }
        if (reconciled.status.phase !== request.expectedPhase) {
          await this.options.persistence.settleRejectedLanToCloudCancellation(
            request,
            reconciled,
          );
        }
        throw error;
      }
      if (
        record.status.phase !== 'collecting-readiness'
        || !(error instanceof CollabError)
        || error.code !== 'authority-transfer-not-found'
      ) throw error;
      const prepared = await this.options.persistence.cancelUnbegunLanToCloudSource(request, true);
      return (await this.completeLocalCancellation(prepared, options)).status;
    }
    if (settled.status.state === 'cancelled') {
      await this.completeCancellation(settled, options);
    }
    return settled.status;
  }

  private async resumeRecord(
    initial: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    if (initial.lifecycleOwnership !== 'owned') {
      throw transferError('lan-to-cloud-host-acceptance-required');
    }
    let record = initial;
    for (let step = 0; step < 16; step += 1) {
      const sourceEntry = await this.options.persistence.loadSourceEntry(record.projectId);
      if (sourceEntry?.cancellation) {
        const {
          submission: _submission,
          ...cancellationIntent
        } = sourceEntry.cancellation;
        if (record.status.state === 'cancelled') {
          await this.completeCancellation(record, options);
          return record.status;
        }
        return this.resumeCancellation(record, cancellationIntent, options);
      }
      if (record.status.state === 'cancelled') {
        await this.completeCancellation(record, options);
        return record.status;
      }
      if (
        record.status.phase !== 'collecting-readiness'
        && !COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(
          record.status.phase as never,
        )
      ) {
        record = await this.ensureReceiptVerifier(record, options);
      }
      if (record.status.state === 'completed') {
        await this.options.source.activateTerminal(record, options);
        return record.status;
      }
      if (COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(
        record.status.phase as never,
      )) {
        const entry = await this.options.persistence.loadSourceEntry(record.projectId);
        if (entry && entry.beginSubmission !== 'possibly-sent') {
          record = await this.options.persistence.resumeUnbegunLanToCloudCancellation(record);
          continue;
        }
        record = await this.readAndAdvance(record, options);
        continue;
      }
      switch (record.status.phase) {
        case 'collecting-readiness': {
          const captured = await this.options.source.capture(record, options);
          try {
            await this.options.persistence.markLanToCloudBeginPossiblySent(record);
            record = await advanceThroughObservedAuthorityStatus(
              this.options.persistence,
              record,
              await this.options.cloud.authorityTransfer(
                'beginLanToCloudTransfer',
                {
                  checkpointManifestSha256: captured.checkpointManifestSha256,
                  expectedSourceAuthorityGeneration: record.status.sourceAuthority.generation,
                  idempotencyKey: authorityTransferChildIdempotencyKey(
                    record.operationIntentId,
                    'begin',
                  ),
                  projectId: record.projectId,
                  sourceHostMemberId: captured.sourceHostMemberId,
                  sourceProof: captured.sourceProof,
                  targetUrl: record.status.targetUrl,
                  transferId: record.transferId,
                },
                options,
              ),
            );
          } finally {
            destroyAuthorityTransferArtifactBodies(captured.artifacts);
          }
          break;
        }
        case 'source-quiesced': {
          const captured = await this.options.source.capture(record, options);
          try {
            for (const artifact of captured.artifacts) {
              await this.options.cloud.uploadAuthorityTransferArtifact({
                ...artifact,
                projectId: record.projectId,
                transferId: record.transferId,
              }, options);
            }
          } finally {
            destroyAuthorityTransferArtifactBodies(captured.artifacts);
          }
          record = await this.readAndAdvance(record, options);
          break;
        }
        case 'checkpoint-received':
          record = await this.readAndAdvance(record, options);
          break;
        case 'checkpoint-validated': {
          const observed = record.status;
          if (
            observed.batchRevision === null
            || observed.batchSha256 === null
            || observed.checkpointSha256 === null
          ) throw transferError('lan-to-cloud-checkpoint-not-validated');
          const batch = await this.options.persistence.loadRetainedClaimBatch(
            record.projectId,
            record.transferId,
          );
          if (!batch) throw transferError('lan-to-cloud-claim-custody-missing');
          record = await this.readAndAdvance(record, options);
          break;
        }
        case 'claims-retained':
          record = await this.readAndAdvance(record, options);
          break;
        case 'repository-published': {
          const proof = await this.options.source.commitRelinquishmentFence(record, options);
          record = await advanceThroughObservedAuthorityStatus(
            this.options.persistence,
            record,
            await this.options.cloud.authorityTransfer(
              'commitLanToCloudRelinquishment',
              {
                idempotencyKey: authorityTransferChildIdempotencyKey(
                  record.operationIntentId,
                  'relinquish',
                ),
                projectId: record.projectId,
                proof,
                transferId: record.transferId,
              },
              options,
            ),
          );
          break;
        }
        case 'source-relinquished':
        case 'cloud-activated':
          record = await this.readAndAdvance(record, options);
          break;
        default:
          throw transferError('lan-to-cloud-phase-unhandled');
      }
    }
    throw transferError('lan-to-cloud-recovery-did-not-converge');
  }

  private readStatus(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.options.cloud.authorityTransfer('getProjectAuthorityTransfer', {
      projectId: record.projectId,
      transferId: record.transferId,
    }, options);
  }

  private async ensureReceiptVerifier(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<AuthorityTransferRecord> {
    if (record.receiptVerifier !== null) return record;
    const verifier = await this.options.cloud.authorityTransfer(
      'getAuthorityTransferReceiptVerifier',
      { projectId: record.projectId, transferId: record.transferId },
      options,
    );
    return this.options.persistence.pinReceiptVerifier(
      record.projectId,
      record.transferId,
      verifier,
    );
  }

  private async readAndAdvance(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<AuthorityTransferRecord> {
    const observed = await this.retainObservedClaimBatch(
      record,
      await this.readStatus(record, options),
      options,
    );
    const next = await advanceThroughObservedAuthorityStatus(
      this.options.persistence,
      record,
      observed,
    );
    if (next.status.phase === record.status.phase) {
      throw transferError('lan-to-cloud-authority-progress-pending');
    }
    return next;
  }

  private async retainObservedClaimBatch(
    record: AuthorityTransferRecord,
    observed: CollabAuthorityTransferStatus,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    if (
      record.status.batchRevision !== null
      || record.status.batchSha256 !== null
      || observed.batchRevision === null
      || observed.batchSha256 === null
      || observed.checkpointSha256 === null
    ) return observed;
    let batch = await this.options.persistence.loadRetainedClaimBatch(
      record.projectId,
      record.transferId,
    );
    if (!batch) {
      batch = await this.options.cloud.authorityTransfer(
        'rotateTransferredMembershipClaims',
        {
          expectedBatchRevision: observed.batchRevision,
          expectedBatchSha256: observed.batchSha256,
          idempotencyKey: authorityTransferChildIdempotencyKey(
            record.operationIntentId,
            'claims',
          ),
          projectId: record.projectId,
          transferId: record.transferId,
        },
        options,
      );
    }
    const sameObservedBatch = batch.batchRevision === observed.batchRevision
      && batch.batchSha256 === observed.batchSha256;
    const validSingleRotation = batch.batchRevision === observed.batchRevision + 1;
    if (
      (!sameObservedBatch && !validSingleRotation)
      || batch.checkpointSha256 !== observed.checkpointSha256
      || batch.projectId !== observed.projectId
      || batch.transferId !== observed.transferId
      || batch.targetAuthorityGeneration !== observed.targetAuthority.generation
      || batch.expiresAt !== observed.expiresAt
    ) throw transferError('lan-to-cloud-claim-batch-status-mismatch');
    if (!await this.options.persistence.loadRetainedClaimBatch(
      record.projectId,
      record.transferId,
    )) {
      await this.options.persistence.retainClaimBatch({
        batch,
        operationIntentId: record.operationIntentId,
        purpose: 'source-terminal',
      });
    }
    const receipt = await this.options.cloud.authorityTransfer(
      'acknowledgeTransferredMembershipClaimBatch',
      {
        batchRevision: batch.batchRevision,
        batchSha256: batch.batchSha256,
        idempotencyKey: authorityTransferChildIdempotencyKey(
          record.operationIntentId,
          'custody',
        ),
        operationIntentId: record.operationIntentId,
        projectId: record.projectId,
        transferId: record.transferId,
      },
      options,
    );
    await this.options.persistence.acknowledgeClaimBatch(receipt);
    return this.readStatus(record, options);
  }

  private async completeCancellation(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    await this.options.source.reopenAfterCancellation(record, options);
    await this.options.persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    });
  }

  private async completeLocalCancellation(
    prepared: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<AuthorityTransferRecord> {
    await this.options.source.reopenAfterCancellation(prepared, options);
    const settled = await this.options.persistence.completeUnbegunLanToCloudCancellation(
      prepared,
    );
    await this.options.persistence.completeTerminalCleanup({
      operationIntentId: settled.operationIntentId,
      projectId: settled.projectId,
      stagingDirectoryName: settled.stagingDirectoryName,
      transferId: settled.transferId,
    });
    return settled;
  }

}

/** Source-local proposal owner. It deliberately has no Cloud dependency. */
export class LanToCloudSourceProposalCoordinator {
  private readonly createTransferId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: LanToCloudSourceProposalCoordinatorOptions) {
    this.createTransferId = options.createTransferId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async cancel(
    request: LanToCloudCancellationIntent,
  ): Promise<CollabAuthorityTransferStatus> {
    return (await this.options.persistence.cancelSourceEntry(request)).status;
  }

  async propose(
    proposedByMemberId: CollabMemberId,
    value: RequestLanToCloudTransferRequest,
  ): Promise<CollabAuthorityTransferStatus> {
    const request = decodeCollabAuthorityTransferOperationRequest(
      'requestLanToCloudTransfer',
      value,
    );
    const proposedAt = this.now();
    const timestamp = proposedAt.toISOString();
    const status = decodeCollabAuthorityTransferStatus({
      batchRevision: null,
      batchSha256: null,
      checkpointSha256: null,
      createdAt: timestamp,
      direction: 'lan-to-cloud',
      expiresAt: authorityTransferEntryExpiresAt(timestamp),
      phase: 'collecting-readiness',
      projectId: request.projectId,
      relinquishmentProof: null,
      sourceAuthority: {
        generation: request.expectedAuthorityGeneration,
        kind: 'lan',
      },
      state: 'active',
      targetAuthority: {
        generation: request.expectedAuthorityGeneration + 1,
        kind: 'cloud',
      },
      targetUrl: request.targetUrl,
      transferId: this.createTransferId(),
      updatedAt: timestamp,
    });
    const entry = await this.options.persistence.proposeEntry(
      createAuthorityTransferEntryRecord({
        ownerInstallationKey: this.options.installationKey,
        proposedByMemberId,
        request,
        status,
      }),
    );
    return entry.status;
  }
}
