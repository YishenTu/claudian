import type { Readable } from 'node:stream';

import {
  type AcceptLanToCloudTransferTargetRequest,
  COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES,
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferCancellablePhase,
  type CollabAuthorityTransferStatus,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectId,
  type RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import {
  destroyAuthorityTransferArtifactBodies,
} from '@/app/collab/authority-transfer/AuthorityTransferArtifactBodies';
import {
  advanceThroughObservedAuthorityStatus,
} from '@/app/collab/authority-transfer/AuthorityTransferObservedStatus';
import {
  type AuthorityTransferRecord,
  createAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type {
  AuthorityTransferPersistence,
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
  acceptanceRequest(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<AcceptLanToCloudTransferTargetRequest>;
  acceptProposal(
    request: AcceptLanToCloudTransferTargetRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus>;
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
  requestProposal(
    request: RequestLanToCloudTransferRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus>;
  releaseSourceEndpoint?(record: AuthorityTransferRecord, endpoint: string): Promise<void>;
  sourceEndpoint?(record: AuthorityTransferRecord): Promise<string>;
}

export interface LanToCloudSourceCoordinatorOptions {
  readonly cloud: CollabAuthorityLifecyclePort;
  readonly installationKey: InstallationKey;
  readonly persistence: AuthorityTransferPersistence;
  readonly source: LanToCloudSourceEffects;
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

function cancellablePhase(
  phase: CollabAuthorityTransferStatus['phase'],
): CollabAuthorityTransferCancellablePhase {
  if (!COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES.includes(phase as never)) {
    throw new CollabError({ code: 'authority-transfer-cancellation-forbidden' });
  }
  return phase as CollabAuthorityTransferCancellablePhase;
}

function assertStatus(
  status: CollabAuthorityTransferStatus,
  direction: 'lan-to-cloud',
  projectId: CollabProjectId,
): void {
  if (status.direction !== direction || status.projectId !== projectId) {
    throw transferError('lan-to-cloud-status-mismatch');
  }
}

export class LanToCloudSourceCoordinator {
  constructor(private readonly options: LanToCloudSourceCoordinatorOptions) {}

  private assertOwnedRecord(record: AuthorityTransferRecord): void {
    if (record.ownerInstallationKey !== this.options.installationKey) {
      throw transferError('host-installation-recovery-owner-mismatch');
    }
  }

  async propose(
    request: RequestLanToCloudTransferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const status = await this.options.source.requestProposal(request, options);
    assertStatus(status, 'lan-to-cloud', request.projectId);
    await this.options.persistence.create(createAuthorityTransferRecord({
      lifecycleOwnership: 'proposal',
      localRole: 'source',
      operationIntentId: request.idempotencyKey,
      ownerInstallationKey: this.options.installationKey,
      stagingDirectoryName: stagingDirectory(status.transferId),
      status,
    }));
    return status;
  }

  async acceptAndTransfer(
    request: AcceptLanToCloudTransferTargetRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const existing = await this.options.persistence.load(request.projectId);
    if (!existing || existing.transferId !== request.transferId) {
      throw transferError('lan-to-cloud-proposal-missing');
    }
    this.assertOwnedRecord(existing);
    const sourceLanEndpoint = await this.options.source.sourceEndpoint?.(existing);
    if (!sourceLanEndpoint) {
      throw transferError('lan-to-cloud-source-endpoint-missing');
    }
    const owned = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: existing.operationIntentId,
      ownerInstallationKey: this.options.installationKey,
      sourceLanEndpoint,
      stagingDirectoryName: existing.stagingDirectoryName,
      status: existing.status,
    });
    try {
      const recoverableRequest = await this.options.source.acceptanceRequest(owned, options);
      if (JSON.stringify(recoverableRequest) !== JSON.stringify(request)) {
        throw transferError('lan-to-cloud-host-acceptance-mismatch');
      }
      await this.options.persistence.advance(owned, existing.status.phase);
    } catch (error) {
      let durable: AuthorityTransferRecord | null = null;
      let durableReadSucceeded = false;
      try {
        durable = await this.options.persistence.load(existing.projectId);
        if (durable) this.assertOwnedRecord(durable);
        durableReadSucceeded = true;
      } catch {
        // An ambiguous durable write must retain the runtime endpoint pin.
      }
      const proposalProven = durableReadSucceeded
        && durable?.transferId === existing.transferId
        && durable.lifecycleOwnership === 'proposal'
        && durable.sourceLanEndpoint === null;
      if (proposalProven && this.options.source.releaseSourceEndpoint) {
        await this.options.source.releaseSourceEndpoint(existing, sourceLanEndpoint)
          .catch(() => undefined);
      }
      throw error;
    }
    return this.resumeRecord(owned, options);
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
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const record = await this.options.persistence.load(projectId);
    if (!record || record.localRole !== 'source') {
      throw transferError('lan-to-cloud-record-missing');
    }
    this.assertOwnedRecord(record);
    if (record.status.relinquishmentProof !== null) {
      throw new CollabError({ code: 'authority-transfer-cancellation-forbidden' });
    }
    const cancelled = await this.options.cloud.authorityTransfer(
      'cancelProjectAuthorityTransfer',
      {
        expectedPhase: cancellablePhase(record.status.phase),
        idempotencyKey: `${record.operationIntentId}-cancel`,
        projectId: record.projectId,
        transferId: record.transferId,
      },
      options,
    );
    const settled = await advanceThroughObservedAuthorityStatus(
      this.options.persistence,
      record,
      cancelled,
    );
    if (settled.status.state === 'cancelled') {
      await this.options.source.reopenAfterCancellation(settled, options);
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
      if (record.status.state === 'cancelled') {
        await this.options.source.reopenAfterCancellation(record, options);
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
        record = await this.readAndAdvance(record, options);
        continue;
      }
      switch (record.status.phase) {
        case 'collecting-readiness': {
          const acceptance = await this.options.source.acceptanceRequest(record, options);
          const accepted = await this.options.source.acceptProposal(acceptance, options);
          assertStatus(accepted, 'lan-to-cloud', record.projectId);
          if (
            accepted.phase !== 'collecting-readiness'
            || JSON.stringify(accepted) !== JSON.stringify(record.status)
          ) {
            throw transferError('lan-to-cloud-host-acceptance-status-mismatch');
          }
          const captured = await this.options.source.capture(record, options);
          try {
            record = await advanceThroughObservedAuthorityStatus(
              this.options.persistence,
              record,
              await this.options.cloud.authorityTransfer(
                'beginLanToCloudTransfer',
                {
                  checkpointManifestSha256: captured.checkpointManifestSha256,
                  expectedSourceAuthorityGeneration: record.status.sourceAuthority.generation,
                  idempotencyKey: `${record.operationIntentId}-begin`,
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
                idempotencyKey: `${record.operationIntentId}-claims`,
                projectId: record.projectId,
                transferId: record.transferId,
              },
              options,
            );
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
              idempotencyKey: `${record.operationIntentId}-custody`,
              operationIntentId: record.operationIntentId,
              projectId: record.projectId,
              transferId: record.transferId,
            },
            options,
          );
          await this.options.persistence.acknowledgeClaimBatch(receipt);
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
                idempotencyKey: `${record.operationIntentId}-relinquish`,
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
    const next = await advanceThroughObservedAuthorityStatus(
      this.options.persistence,
      record,
      await this.readStatus(record, options),
    );
    if (next.status.phase === record.status.phase) {
      throw transferError('lan-to-cloud-authority-progress-pending');
    }
    return next;
  }

}
