import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  AuthorityTransferEntryRecord,
  AuthorityTransferRequesterEntryRecord,
  AuthorityTransferSourceEntryRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import { type AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type {
  CloudToLanManagerEntryRecord,
  CloudToLanTargetEntryRecord,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import type {
  AuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  type AuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
import type { RetainedAuthorityTransferRecord } from '@/app/collab/authority-transfer/persistence/RetainedAuthorityTransferRecord';

export interface AuthorityTransferRecordStorePort {
  listRetained(projectId: CollabProjectId): Promise<readonly RetainedAuthorityTransferRecord[]>;
  loadRetained(projectId: CollabProjectId, transferId: string): Promise<RetainedAuthorityTransferRecord | null>;
  saveRetained(retained: RetainedAuthorityTransferRecord): Promise<void>;
  listProjectIds(): Promise<readonly CollabProjectId[]>;
  scanProjectCatalog(): Promise<AuthorityTransferProjectCatalog>;
  load(projectId: CollabProjectId, transferId?: string): Promise<AuthorityTransferRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  removeExact(record: AuthorityTransferRecord): Promise<boolean>;
  save(record: AuthorityTransferRecord): Promise<void>;
}

export interface AuthorityTransferEntryStorePort {
  load(projectId: CollabProjectId): Promise<AuthorityTransferEntryRecord | null>;
  removeManager(record: CloudToLanManagerEntryRecord): Promise<boolean>;
  removeRequester(record: AuthorityTransferRequesterEntryRecord): Promise<boolean>;
  removeSource(record: AuthorityTransferSourceEntryRecord): Promise<boolean>;
  removeTarget(record: CloudToLanTargetEntryRecord): Promise<boolean>;
  saveManager(record: CloudToLanManagerEntryRecord): Promise<void>;
  saveRequester(record: AuthorityTransferRequesterEntryRecord): Promise<void>;
  saveSource(record: AuthorityTransferSourceEntryRecord): Promise<void>;
  saveTarget(record: CloudToLanTargetEntryRecord): Promise<void>;
}

export interface AuthorityTransferProjectCatalog {
  readonly invalidEntryCount: number;
  readonly projectIds: readonly CollabProjectId[];
}

export interface AuthorityTransferClaimCustodyStorePort {
  load(projectId: CollabProjectId, transferId?: string): Promise<AuthorityTransferClaimCustodyRecord | null>;
  remove(projectId: CollabProjectId, transferId?: string): Promise<boolean>;
  save(record: AuthorityTransferClaimCustodyRecord): Promise<void>;
}

export interface AuthorityTransferClaimCommitmentStorePort {
  load(projectId: CollabProjectId, transferId?: string): Promise<AuthorityTransferClaimBatchCommitmentRecord | null>;
  remove(projectId: CollabProjectId, transferId?: string): Promise<boolean>;
  save(record: AuthorityTransferClaimBatchCommitmentRecord): Promise<void>;
}

export interface AuthorityTransferPersistenceStores {
  readonly authorityTransferClaimCommitments: AuthorityTransferClaimCommitmentStorePort;
  readonly authorityTransferClaims: AuthorityTransferClaimCustodyStorePort;
  readonly authorityTransferEntries: AuthorityTransferEntryStorePort;
  readonly authorityTransferRecords: AuthorityTransferRecordStorePort;
}
