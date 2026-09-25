import type { CollabAuthorityTransferStatus, CollabMemberId, CollabProjectId, RequestLanToCloudTransferRequest } from '@claudian-collab/protocol';

import { cloudToLANTransferHandle } from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLANTransferEntryRecord';
import type { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type { CollabCloudToLANTransferView } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface LANToCloudTransferView {
  readonly entryRole: 'requester' | 'source';
  readonly proposedByMemberId: CollabMemberId;
  readonly request: Readonly<RequestLanToCloudTransferRequest>;
  readonly status: CollabAuthorityTransferStatus | null;
}

function readModelError(reason: string): CollabError {
  return new CollabError({ code: 'durable-progress-recovery-required', recoveryActions: ['resume', 'open-diagnostics'], safeContext: { reason } });
}

/** Selects actionable transfer observations without deleting retained recovery evidence. */
export class AuthorityTransferReadModel {
  constructor(private readonly persistence: AuthorityTransferPersistence, private readonly installationKey: InstallationKey) {}

  async readLanToCloudTransfer(
    projectId: CollabProjectId,
    sourceAuthorityGeneration: number,
  ): Promise<LANToCloudTransferView | null> {
    const [retainedSource, retainedRequester] = await Promise.all([
      this.persistence.loadSourceEntry(projectId),
      this.persistence.loadRequesterEntry(projectId, this.installationKey),
    ]);
    const source = retainedSource?.request.expectedAuthorityGeneration === sourceAuthorityGeneration ? retainedSource : null;
    const requester = retainedRequester?.request.expectedAuthorityGeneration === sourceAuthorityGeneration ? retainedRequester : null;
    const entry = source ?? requester;
    if (!entry) return null;
    const record = source?.phase === 'handed-off'
      ? await this.persistence.load(projectId)
      : null;
    if (source?.phase === 'handed-off' && !record) {
      throw readModelError('authority-transfer-source-successor-missing');
    }
    if (
      source
      && record
      && (record.transferId !== source.status.transferId
        || record.operationIntentId !== source.request.idempotencyKey)
    ) throw readModelError('authority-transfer-source-successor-mismatch');
    return Object.freeze({
      entryRole: entry.entryRole,
      proposedByMemberId: entry.proposedByMemberId,
      request: entry.request,
      status: record?.status ?? entry.status,
    });
  }

  async readCloudToLanTransfer(
    projectId: CollabProjectId,
  ): Promise<CollabCloudToLANTransferView | null> {
    const [manager, target, physical] = await Promise.all([
      this.persistence.loadCloudToLanManagerEntry(projectId),
      this.persistence.loadCloudToLanTargetEntry(projectId),
      this.persistence.load(projectId),
    ]);
    const activeManager = manager
      && manager.phase !== 'rejected'
      && manager.phase !== 'settled'
      ? manager
      : null;
    const activeTarget = target && target.phase !== 'withdrawn' ? target : null;
    if (!activeManager && !activeTarget) return null;
    const targetHandle = activeTarget?.phase === 'handed-off'
      && activeTarget.descriptor
      && activeTarget.successor
      ? Object.freeze({
          operationIntentId: activeTarget.successor.operationIntentId,
          preparationId: activeTarget.descriptor.preparationId,
          projectId: activeTarget.projectId,
          schemaVersion: activeTarget.descriptor.schemaVersion,
          selectedTargetMemberId: activeTarget.selectedTargetMemberId,
          sourceAuthorityGeneration: activeTarget.sourceAuthorityGeneration,
          sourceCloudUrl: activeTarget.sourceCloudUrl,
          targetUrl: activeTarget.descriptor.targetUrl,
          transferId: activeTarget.successor.transferId,
        })
      : null;
    const targetStatus = targetHandle
      && physical?.transferId === targetHandle.transferId
      && physical.operationIntentId === targetHandle.operationIntentId
      ? physical.status
      : null;
    return Object.freeze({
      preparations: [],
      manager: activeManager
        ? Object.freeze({
            descriptor: activeManager.descriptor,
            handle: activeManager.status ? cloudToLANTransferHandle(activeManager) : null,
            status: activeManager.status,
          })
        : null,
      target: activeTarget
        ? Object.freeze({
            canWithdraw: activeTarget.phase === 'published',
            descriptor: activeTarget.descriptor,
            handle: targetHandle,
            status: targetStatus,
          })
        : null,
    });
  }

}
