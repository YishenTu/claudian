import type { Readable } from 'node:stream';

import {
  type AcceptCloudToLanTransferTargetRequest,
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabCheckpointAuthority,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectId,
  type CollabTransferredMembershipClaimBatch,
} from '@claudian-collab/protocol';

import {
  destroyAuthorityTransferArtifactBodies,
} from '@/app/collab/authority-transfer/AuthorityTransferArtifactBodies';
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
import {
  assertCloudToLanTargetHandle,
  type CloudToLanTargetEntryRecord,
  type CloudToLanTransferHandle,
  decodeCloudToLanTransferHandle,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  CollabAuthorityLifecyclePort,
} from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface CloudToLanDownloadedArtifact {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly body: Readable;
  readonly byteCount: number;
}

export interface CloudToLanTargetStageResult {
  readonly claimBatch: CollabTransferredMembershipClaimBatch;
  readonly checkpointSha256: string;
  readonly stageSha256: string;
  readonly targetAuthority: CollabCheckpointAuthority & { readonly kind: 'lan' };
  readonly targetHostMemberId: string;
  readonly targetProof: string;
}

export interface CloudToLanTargetEffects {
  dispose?(): Promise<void> | void;
  prepareTarget?(expectedEndpoint?: string): Promise<Readonly<{
    readonly caCertificatePem?: string;
    readonly caFingerprint?: string;
    readonly targetUrl: string;
  }>>;
  acceptanceRequest(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<AcceptCloudToLanTransferTargetRequest>;
  activate(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    options?: CollabOperationOptions,
  ): Promise<string>;
  cancelStaging(
    record: AuthorityTransferRecord,
    options?: CollabOperationOptions,
  ): Promise<void>;
  converge?(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    options?: CollabOperationOptions,
  ): Promise<void>;
  stage(
    record: AuthorityTransferRecord,
    artifacts: readonly CloudToLanDownloadedArtifact[],
    options?: CollabOperationOptions,
  ): Promise<CloudToLanTargetStageResult>;
}

export interface CloudToLanTargetCoordinatorOptions {
  readonly cloud: CollabAuthorityLifecyclePort;
  readonly installationKey: InstallationKey;
  readonly persistence: AuthorityTransferPersistence;
  readonly target: CloudToLanTargetEffects;
}

function targetError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function assertTargetStatus(
  status: CollabAuthorityTransferStatus,
  projectId: CollabProjectId,
): void {
  if (status.direction !== 'cloud-to-lan' || status.projectId !== projectId) {
    throw targetError('cloud-to-lan-status-mismatch');
  }
}

export class CloudToLanTargetCoordinator {
  constructor(private readonly options: CloudToLanTargetCoordinatorOptions) {}

  private assertOwnedRecord(record: AuthorityTransferRecord): void {
    if (record.ownerInstallationKey !== this.options.installationKey) {
      throw targetError('host-installation-recovery-owner-mismatch');
    }
  }

  async acceptPreparedTransfer(
    input: CloudToLanTransferHandle,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const handle = decodeCloudToLanTransferHandle(input);
    const entry = await this.options.persistence.loadCloudToLanTargetEntry(handle.projectId);
    this.assertPreparedHandle(entry, handle);
    if (entry.phase === 'handed-off') {
      const record = await this.options.persistence.load(handle.projectId);
      if (
        !record
        || record.localRole !== 'target'
        || record.ownerInstallationKey !== this.options.installationKey
        || record.operationIntentId !== handle.operationIntentId
        || record.transferId !== handle.transferId
      ) throw targetError('cloud-to-lan-target-successor-mismatch');
      return this.resumeRecord(record, options, entry.selectedTargetMemberId);
    }
    const proposed = await this.options.cloud.authorityTransfer(
      'getProjectAuthorityTransfer',
      { projectId: handle.projectId, transferId: handle.transferId },
      options,
    );
    assertTargetStatus(proposed, handle.projectId);
    if (
      proposed.transferId !== handle.transferId
      || proposed.sourceAuthority.kind !== 'cloud'
      || proposed.sourceAuthority.generation !== handle.sourceAuthorityGeneration
      || proposed.targetAuthority.kind !== 'lan'
      || proposed.targetAuthority.generation !== handle.sourceAuthorityGeneration + 1
      || proposed.targetUrl !== handle.targetUrl
    ) throw targetError('cloud-to-lan-prepared-status-mismatch');
    if (proposed.state === 'cancelled' && proposed.phase === 'cancelled') {
      await this.options.persistence.withdrawCloudToLanTargetEntry(entry);
      return proposed;
    }
    if (proposed.state !== 'active' || proposed.phase !== 'collecting-readiness') {
      throw targetError('cloud-to-lan-prepared-status-mismatch');
    }
    const record = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: handle.operationIntentId,
      ownerInstallationKey: this.options.installationKey,
      stagingDirectoryName: `.claudian-authority-transfer-${proposed.transferId}`,
      status: proposed,
    });
    const persisted = await this.options.persistence.handoffCloudToLanTargetEntry(
      entry,
      record,
    );
    return this.resumeRecord(persisted, options, handle.selectedTargetMemberId);
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const record = await this.options.persistence.load(projectId);
    if (!record || record.localRole !== 'target') {
      throw targetError('cloud-to-lan-record-missing');
    }
    this.assertOwnedRecord(record);
    const targetEntry = await this.options.persistence.loadCloudToLanTargetEntry(projectId);
    if (
      !targetEntry
      || targetEntry.phase !== 'handed-off'
      || targetEntry.ownerInstallationKey !== this.options.installationKey
      || targetEntry.successor?.operationIntentId !== record.operationIntentId
      || targetEntry.successor.ownerInstallationKey !== record.ownerInstallationKey
      || targetEntry.successor.transferId !== record.transferId
    ) throw targetError('cloud-to-lan-target-successor-mismatch');
    return this.resumeRecord(record, options, targetEntry.selectedTargetMemberId);
  }

  private async resumeRecord(
    initial: AuthorityTransferRecord,
    options: CollabOperationOptions,
    selectedTargetMemberId?: string,
  ): Promise<CollabAuthorityTransferStatus> {
    let record = initial;
    let activatedThisRun = false;
    for (let step = 0; step < 16; step += 1) {
      if (record.status.state === 'cancelled') {
        return this.completeCancellation(record, options);
      }
      if (record.status.state === 'completed') {
        const proof = record.status.relinquishmentProof;
        if (!proof) throw targetError('cloud-to-lan-relinquishment-proof-missing');
        if (this.options.target.converge) {
          await this.options.target.converge(record, proof, options);
        } else if (!activatedThisRun) {
          await this.options.target.activate(record, proof, options);
        }
        return record.status;
      }
      if (COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(
        record.status.phase as never,
      )) {
        await this.options.target.cancelStaging(record, options);
        record = await this.readAndAdvance(record, options);
        if (record.status.state === 'cancelled') {
          await this.options.persistence.completeTerminalCleanup({
            operationIntentId: record.operationIntentId,
            projectId: record.projectId,
            stagingDirectoryName: record.stagingDirectoryName,
            transferId: record.transferId,
          });
          return record.status;
        }
        continue;
      }
      if (record.status.phase === 'collecting-readiness') {
        const acceptance = await this.options.target.acceptanceRequest(record, options);
        if (
          acceptance.idempotencyKey !== authorityTransferChildIdempotencyKey(
            record.operationIntentId,
            'accept',
          )
          || acceptance.projectId !== record.projectId
          || acceptance.transferId !== record.transferId
          || (
            selectedTargetMemberId !== undefined
            && acceptance.targetHostMemberId !== selectedTargetMemberId
          )
        ) throw targetError('cloud-to-lan-target-acceptance-mismatch');
        const accepted = await this.options.cloud.authorityTransfer(
          'acceptCloudToLanTransferTarget',
          acceptance,
          options,
        );
        assertTargetStatus(accepted, record.projectId);
        record = await advanceThroughObservedAuthorityStatus(
          this.options.persistence,
          record,
          accepted,
        );
        continue;
      }
      if (record.status.phase === 'cloud-quiesced') {
        record = await this.readAndAdvance(record, options);
        continue;
      }
      if (record.status.phase === 'checkpoint-captured') {
        const artifacts: CloudToLanDownloadedArtifact[] = [];
        const stageOperationIntentId = authorityTransferChildIdempotencyKey(
          record.operationIntentId,
          'stage',
        );
        let staged: CloudToLanTargetStageResult;
        try {
          for (const artifact of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
            artifacts.push({
              artifact,
              ...await this.options.cloud.downloadAuthorityTransferArtifact({
                artifact,
                projectId: record.projectId,
                transferId: record.transferId,
              }, options),
            });
          }
          staged = await this.options.target.stage(record, artifacts, options);
        } finally {
          destroyAuthorityTransferArtifactBodies(artifacts);
        }
        if (
          selectedTargetMemberId === undefined
          || staged.targetHostMemberId !== selectedTargetMemberId
        ) throw targetError('cloud-to-lan-target-stage-member-mismatch');
        await this.options.persistence.retainClaimBatch({
          batch: staged.claimBatch,
          operationIntentId: stageOperationIntentId,
          purpose: 'target-delivery',
        });
        const receipt = await this.options.cloud.authorityTransfer(
          'reportCloudToLanTargetStaged',
          {
            checkpointSha256: staged.checkpointSha256,
            claimBatch: staged.claimBatch,
            idempotencyKey: stageOperationIntentId,
            projectId: record.projectId,
            stageSha256: staged.stageSha256,
            targetAuthority: staged.targetAuthority,
            targetProof: staged.targetProof,
            transferId: record.transferId,
          },
          options,
        );
        await this.options.persistence.acknowledgeClaimBatch(receipt);
        record = await this.readAndAdvance(record, options);
        continue;
      }
      if (record.status.phase === 'target-staged' || record.status.phase === 'claims-retained') {
        record = await this.readAndAdvance(record, options);
        continue;
      }
      if (record.status.phase === 'cloud-relinquished') {
        const proof = record.status.relinquishmentProof;
        if (!proof) throw targetError('cloud-to-lan-relinquishment-proof-missing');
        const targetActivationProof = await this.options.target.activate(record, proof, options);
        activatedThisRun = true;
        const completed = await this.options.cloud.authorityTransfer(
          'confirmCloudToLanTargetActive',
          {
            idempotencyKey: authorityTransferChildIdempotencyKey(
              record.operationIntentId,
              'activate',
            ),
            projectId: record.projectId,
            relinquishmentProof: proof,
            targetActivationProof,
            transferId: record.transferId,
          },
          options,
        );
        record = await advanceThroughObservedAuthorityStatus(
          this.options.persistence,
          record,
          completed,
        );
        continue;
      }
      if (record.status.phase === 'lan-activated') {
        const proof = record.status.relinquishmentProof;
        if (!proof) throw targetError('cloud-to-lan-relinquishment-proof-missing');
        await this.options.target.activate(record, proof, options);
        activatedThisRun = true;
        record = await this.readAndAdvance(record, options);
        continue;
      }
      throw targetError('cloud-to-lan-phase-unhandled');
    }
    throw targetError('cloud-to-lan-recovery-did-not-converge');
  }

  private assertPreparedHandle(
    entry: CloudToLanTargetEntryRecord | null,
    handle: CloudToLanTransferHandle,
  ): asserts entry is CloudToLanTargetEntryRecord {
    if (
      !entry
      || entry.ownerInstallationKey !== this.options.installationKey
    ) throw targetError('cloud-to-lan-target-handle-mismatch');
    try {
      assertCloudToLanTargetHandle(entry, handle);
    } catch {
      throw targetError('cloud-to-lan-target-handle-mismatch');
    }
  }

  private async completeCancellation(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    await this.options.target.cancelStaging(record, options);
    await this.options.persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    });
    return record.status;
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
      throw targetError('cloud-to-lan-authority-progress-pending');
    }
    return next;
  }
}
