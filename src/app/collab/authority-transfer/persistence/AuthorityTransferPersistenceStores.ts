import { type CollabProjectId } from '@claudian-collab/protocol';

import { type AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type {
  AuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  type AuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';

export interface AuthorityTransferRecordStorePort {
  listProjectIds(): Promise<readonly CollabProjectId[]>;
  scanProjectCatalog(): Promise<AuthorityTransferProjectCatalog>;
  load(projectId: CollabProjectId): Promise<AuthorityTransferRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(record: AuthorityTransferRecord): Promise<void>;
}

export interface AuthorityTransferProjectCatalog {
  readonly invalidEntryCount: number;
  readonly projectIds: readonly CollabProjectId[];
}

export interface AuthorityTransferClaimCustodyStorePort {
  load(projectId: CollabProjectId): Promise<AuthorityTransferClaimCustodyRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(record: AuthorityTransferClaimCustodyRecord): Promise<void>;
}

export interface AuthorityTransferClaimCommitmentStorePort {
  load(projectId: CollabProjectId): Promise<AuthorityTransferClaimBatchCommitmentRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(record: AuthorityTransferClaimBatchCommitmentRecord): Promise<void>;
}

export interface AuthorityTransferPersistenceStores {
  readonly authorityTransferClaimCommitments: AuthorityTransferClaimCommitmentStorePort;
  readonly authorityTransferClaims: AuthorityTransferClaimCustodyStorePort;
  readonly authorityTransferRecords: AuthorityTransferRecordStorePort;
}
