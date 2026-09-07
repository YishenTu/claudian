import {
  type CollabMemberId,
  type CollabProjectId,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type {
  AuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';

export const AUTHORITY_TRANSFER_CLAIM_COMMITMENT_SCHEMA_VERSION = 1 as const;

export interface AuthorityTransferClaimCommitment {
  readonly claimSha256: string;
  readonly memberId: CollabMemberId;
}

export interface AuthorityTransferClaimBatchCommitmentRecord {
  readonly schemaVersion: typeof AUTHORITY_TRANSFER_CLAIM_COMMITMENT_SCHEMA_VERSION;
  readonly kind: 'authority-transfer-claim-commitment';
  readonly batchRevision: number;
  readonly batchSha256: string;
  readonly claims: readonly AuthorityTransferClaimCommitment[];
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
  readonly transferId: string;
}

const RECORD_KEYS = new Set([
  'schemaVersion',
  'kind',
  'batchRevision',
  'batchSha256',
  'claims',
  'operationIntentId',
  'projectId',
  'transferId',
]);
const CLAIM_KEYS = new Set(['claimSha256', 'memberId']);
const SHA256 = /^[0-9a-f]{64}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

export function decodeAuthorityTransferClaimBatchCommitmentRecord(
  value: unknown,
): AuthorityTransferClaimBatchCommitmentRecord {
  if (
    !isRecord(value)
    || !exactKeys(value, RECORD_KEYS)
    || value.schemaVersion !== AUTHORITY_TRANSFER_CLAIM_COMMITMENT_SCHEMA_VERSION
    || value.kind !== 'authority-transfer-claim-commitment'
    || typeof value.projectId !== 'string'
    || !isCollabProjectId(value.projectId)
    || typeof value.transferId !== 'string'
    || !isCollabOpaqueId(value.transferId)
    || typeof value.operationIntentId !== 'string'
    || !isCollabOpaqueId(value.operationIntentId)
    || !Number.isSafeInteger(value.batchRevision)
    || (value.batchRevision as number) < 1
    || typeof value.batchSha256 !== 'string'
    || !SHA256.test(value.batchSha256)
    || !Array.isArray(value.claims)
  ) {
    throw new TypeError('Invalid authority transfer claim commitment');
  }
  const claims = value.claims.map(claim => {
    if (
      !isRecord(claim)
      || !exactKeys(claim, CLAIM_KEYS)
      || typeof claim.memberId !== 'string'
      || !isCollabMemberId(claim.memberId)
      || typeof claim.claimSha256 !== 'string'
      || !SHA256.test(claim.claimSha256)
    ) {
      throw new TypeError('Invalid authority transfer claim commitment');
    }
    return { claimSha256: claim.claimSha256, memberId: claim.memberId };
  });
  if (claims.some((claim, index) => (
    index > 0 && claims[index - 1].memberId.localeCompare(claim.memberId, 'en-US') >= 0
  ))) {
    throw new TypeError('Invalid authority transfer claim commitment order');
  }
  return {
    batchRevision: value.batchRevision as number,
    batchSha256: value.batchSha256,
    claims: Object.freeze(claims),
    kind: 'authority-transfer-claim-commitment',
    operationIntentId: value.operationIntentId,
    projectId: value.projectId,
    schemaVersion: AUTHORITY_TRANSFER_CLAIM_COMMITMENT_SCHEMA_VERSION,
    transferId: value.transferId,
  };
}

export function createAuthorityTransferClaimBatchCommitmentRecord(
  custody: AuthorityTransferClaimCustodyRecord,
): AuthorityTransferClaimBatchCommitmentRecord {
  return decodeAuthorityTransferClaimBatchCommitmentRecord({
    batchRevision: custody.batchRevision,
    batchSha256: custody.batchSha256,
    claims: custody.claims.map(claim => ({
      claimSha256: claim.claimSha256,
      memberId: claim.memberId,
    })),
    kind: 'authority-transfer-claim-commitment',
    operationIntentId: custody.operationIntentId,
    projectId: custody.projectId,
    schemaVersion: AUTHORITY_TRANSFER_CLAIM_COMMITMENT_SCHEMA_VERSION,
    transferId: custody.transferId,
  });
}
