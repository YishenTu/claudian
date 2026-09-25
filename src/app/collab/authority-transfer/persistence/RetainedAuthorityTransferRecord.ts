import { createHash } from 'node:crypto';

import {
  type AuthorityTransferRecord,
  decodeAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type CloudToLANTargetEntryRecord,
  type CloudToLANTransferHandle,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLANTransferEntryRecord';
import {
  type AuthorityTransferClaimBatchCommitmentRecord,
  decodeAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  type AuthorityTransferClaimCustodyRecord,
  decodeAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';

/** Completed operation evidence. It carries no proposal or preparation ownership. */
export interface RetainedAuthorityTransferRecord {
  readonly schemaVersion: 2;
  readonly record: AuthorityTransferRecord;
  readonly custody: AuthorityTransferClaimCustodyRecord | null;
  readonly commitment: AuthorityTransferClaimBatchCommitmentRecord | null;
  readonly targetHandleSha256: string | null;
}

export function completedTargetHandleDigest(handle: CloudToLANTransferHandle): string {
  return createHash('sha256').update(JSON.stringify([
    handle.schemaVersion, handle.projectId, handle.preparationId, handle.operationIntentId,
    handle.transferId, handle.selectedTargetMemberId, handle.sourceAuthorityGeneration,
    handle.sourceCloudUrl, handle.targetUrl,
  ])).digest('hex');
}

export function completedTargetEntryDigest(entry: CloudToLANTargetEntryRecord): string {
  if (!entry.descriptor || !entry.successor || entry.phase !== 'handed-off') throw new TypeError();
  return completedTargetHandleDigest({
    schemaVersion: 1, projectId: entry.projectId, preparationId: entry.operationIntentId,
    operationIntentId: entry.successor.operationIntentId, transferId: entry.successor.transferId,
    selectedTargetMemberId: entry.selectedTargetMemberId,
    sourceAuthorityGeneration: entry.sourceAuthorityGeneration,
    sourceCloudUrl: entry.sourceCloudUrl, targetUrl: entry.descriptor.targetUrl,
  });
}

export function decodeRetainedAuthorityTransferRecord(value: unknown): RetainedAuthorityTransferRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 2 || Object.keys(input).length !== 5
    || !['schemaVersion', 'record', 'custody', 'commitment', 'targetHandleSha256'].every(key => Object.hasOwn(input, key))) throw new TypeError();
  const record = decodeAuthorityTransferRecord(input.record);
  const custody = input.custody === null ? null : decodeAuthorityTransferClaimCustodyRecord(input.custody);
  const commitment = input.commitment === null ? null : decodeAuthorityTransferClaimBatchCommitmentRecord(input.commitment);
  const targetHandleSha256 = input.targetHandleSha256;
  if (record.status.state !== 'completed' || !record.status.relinquishmentProof
    || (targetHandleSha256 !== null && (typeof targetHandleSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(targetHandleSha256)
      || record.localRole !== 'target' || record.status.direction !== 'cloud-to-lan'))
    || [custody, commitment].some(component => component !== null
      && (component.projectId !== record.projectId || component.transferId !== record.transferId))
    || (commitment !== null && custody === null)) throw new TypeError();
  return { schemaVersion: 2, record, custody, commitment, targetHandleSha256 };
}
