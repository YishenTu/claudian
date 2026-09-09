import {
  type AuthorityTransferSourceEntryRecord,
  decodeAuthorityTransferEntryComponent,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import {
  type AuthorityTransferRecord,
  decodeAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type CloudToLanTargetEntryRecord,
  decodeCloudToLanTargetEntryRecord,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import {
  type AuthorityTransferClaimBatchCommitmentRecord,
  decodeAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  type AuthorityTransferClaimCustodyRecord,
  decodeAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';

export interface RetainedAuthorityTransferRecord {
  readonly schemaVersion: 1;
  readonly record: AuthorityTransferRecord;
  readonly custody: AuthorityTransferClaimCustodyRecord | null;
  readonly commitment: AuthorityTransferClaimBatchCommitmentRecord | null;
  readonly source: AuthorityTransferSourceEntryRecord | null;
  readonly target: CloudToLanTargetEntryRecord | null;
}

export function decodeRetainedAuthorityTransferRecord(value: unknown): RetainedAuthorityTransferRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || Object.keys(input).length !== 6) throw new TypeError();
  const record = decodeAuthorityTransferRecord(input.record);
  const custody = input.custody === null ? null : decodeAuthorityTransferClaimCustodyRecord(input.custody);
  const commitment = input.commitment === null ? null : decodeAuthorityTransferClaimBatchCommitmentRecord(input.commitment);
  const source = input.source === null ? null : decodeAuthorityTransferEntryComponent(input.source);
  const target = input.target === null ? null : decodeCloudToLanTargetEntryRecord(input.target);
  if (record.status.state !== 'completed' || !record.status.relinquishmentProof
    || (source && (source.entryRole !== 'source' || source.projectId !== record.projectId
      || source.status.transferId !== record.transferId || source.ownerInstallationKey !== record.ownerInstallationKey))
    || (target && (target.projectId !== record.projectId || target.successor?.operationIntentId !== record.operationIntentId
      || target.successor?.transferId !== record.transferId
      || target.ownerInstallationKey !== record.ownerInstallationKey))
    || [custody, commitment].some(component => component !== null
      && (component.projectId !== record.projectId || component.transferId !== record.transferId))
    || (commitment !== null && custody === null)) throw new TypeError();
  return { schemaVersion: 1, record, custody, commitment, source: source, target };
}
