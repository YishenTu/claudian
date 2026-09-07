import { createHash } from 'node:crypto';

import {
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabTransferredMembershipClaimBatch,
  decodeCollabTransferredMembershipClaimCustodyReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

export const AUTHORITY_TRANSFER_CLAIM_CUSTODY_SCHEMA_VERSION = 1 as const;

export type AuthorityTransferClaimCustodyPurpose = 'source-terminal' | 'target-delivery';

export interface AuthorityTransferRetainedClaim {
  readonly claim: string | null;
  readonly claimSha256: string;
  readonly disposition: 'expired' | 'redeemed' | 'retained';
  readonly memberId: CollabMemberId;
  readonly redemptionReceipt: CollabTransferredMembershipRedemptionReceipt | null;
  readonly scrubbedAt: CollabIsoTimestamp | null;
}

export interface AuthorityTransferClaimCustodyRecord {
  readonly schemaVersion: typeof AUTHORITY_TRANSFER_CLAIM_CUSTODY_SCHEMA_VERSION;
  readonly kind: 'authority-transfer-claim-custody';
  readonly batchRevision: number;
  readonly batchSha256: string;
  readonly checkpointSha256: string;
  readonly claims: readonly AuthorityTransferRetainedClaim[];
  readonly createdAt: CollabIsoTimestamp;
  readonly custodyReceipt: CollabTransferredMembershipClaimCustodyReceipt | null;
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
  readonly purpose: AuthorityTransferClaimCustodyPurpose;
  readonly rotationPredecessor: {
    readonly batchRevision: number;
    readonly batchSha256: string;
  } | null;
  readonly targetAuthorityGeneration: number;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

const RECORD_KEYS = new Set([
  'schemaVersion',
  'kind',
  'batchRevision',
  'batchSha256',
  'checkpointSha256',
  'claims',
  'createdAt',
  'custodyReceipt',
  'expiresAt',
  'operationIntentId',
  'projectId',
  'purpose',
  'rotationPredecessor',
  'targetAuthorityGeneration',
  'transferId',
  'updatedAt',
]);
const CLAIM_KEYS = new Set([
  'claim',
  'claimSha256',
  'disposition',
  'memberId',
  'redemptionReceipt',
  'scrubbedAt',
]);
const PREDECESSOR_KEYS = new Set(['batchRevision', 'batchSha256']);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

function timestamp(value: unknown): CollabIsoTimestamp {
  if (
    typeof value !== 'string'
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError('Invalid authority transfer timestamp');
  }
  return value;
}

function decodeClaim(value: unknown): AuthorityTransferRetainedClaim {
  if (!isRecord(value) || !exactKeys(value, CLAIM_KEYS)) throw new TypeError();
  const claim = value.claim;
  const claimSha256 = value.claimSha256;
  const disposition = value.disposition;
  const memberId = value.memberId;
  const redemptionReceipt = value.redemptionReceipt === null
    ? null
    : decodeCollabTransferredMembershipRedemptionReceipt(value.redemptionReceipt);
  const scrubbedAt = value.scrubbedAt === null ? null : timestamp(value.scrubbedAt);
  if (
    (claim !== null && (
      typeof claim !== 'string'
      || claim.length > 4096
      || !BASE64URL.test(claim)
    ))
    || typeof claimSha256 !== 'string'
    || !SHA256.test(claimSha256)
    || (disposition !== 'expired' && disposition !== 'redeemed' && disposition !== 'retained')
    || typeof memberId !== 'string'
    || !isCollabMemberId(memberId)
    || (disposition === 'retained') !== (claim !== null)
    || (disposition === 'retained') !== (scrubbedAt === null)
    || (disposition === 'redeemed') !== (redemptionReceipt !== null)
    || (claim !== null && createHash('sha256').update(claim, 'utf8').digest('hex') !== claimSha256)
    || (redemptionReceipt !== null && (
      redemptionReceipt.claimSha256 !== claimSha256
      || redemptionReceipt.memberId !== memberId
    ))
  ) {
    throw new TypeError('Invalid retained authority transfer claim');
  }
  return {
    claim,
    claimSha256,
    disposition,
    memberId,
    redemptionReceipt,
    scrubbedAt,
  };
}

export function decodeAuthorityTransferClaimCustodyRecord(
  value: unknown,
): AuthorityTransferClaimCustodyRecord {
  if (!isRecord(value) || !exactKeys(value, RECORD_KEYS)) {
    throw new TypeError('Invalid authority transfer claim custody');
  }
  if (value.schemaVersion !== 1 || value.kind !== 'authority-transfer-claim-custody') {
    throw new TypeError('Invalid authority transfer claim custody');
  }
  const projectId = value.projectId;
  const transferId = value.transferId;
  const operationIntentId = value.operationIntentId;
  const purpose = value.purpose;
  const batchRevision = value.batchRevision;
  const batchSha256 = value.batchSha256;
  const checkpointSha256 = value.checkpointSha256;
  const targetAuthorityGeneration = value.targetAuthorityGeneration;
  const rotationPredecessor = value.rotationPredecessor;
  if (
    typeof projectId !== 'string'
    || !isCollabProjectId(projectId)
    || typeof transferId !== 'string'
    || !isCollabOpaqueId(transferId)
    || typeof operationIntentId !== 'string'
    || !isCollabOpaqueId(operationIntentId)
    || (purpose !== 'source-terminal' && purpose !== 'target-delivery')
    || !Number.isSafeInteger(batchRevision)
    || (batchRevision as number) < 1
    || typeof batchSha256 !== 'string'
    || !SHA256.test(batchSha256)
    || typeof checkpointSha256 !== 'string'
    || !SHA256.test(checkpointSha256)
    || !Number.isSafeInteger(targetAuthorityGeneration)
    || (targetAuthorityGeneration as number) < 1
    || !Array.isArray(value.claims)
  ) {
    throw new TypeError('Invalid authority transfer claim identity');
  }
  let decodedRotationPredecessor: AuthorityTransferClaimCustodyRecord['rotationPredecessor'];
  if (rotationPredecessor === null) {
    decodedRotationPredecessor = null;
  } else {
    if (
      !isRecord(rotationPredecessor)
      || !exactKeys(rotationPredecessor, PREDECESSOR_KEYS)
      || !Number.isSafeInteger(rotationPredecessor.batchRevision)
      || rotationPredecessor.batchRevision !== (batchRevision as number) - 1
      || typeof rotationPredecessor.batchSha256 !== 'string'
      || !SHA256.test(rotationPredecessor.batchSha256)
    ) {
      throw new TypeError('Invalid authority transfer claim rotation predecessor');
    }
    decodedRotationPredecessor = {
      batchRevision: rotationPredecessor.batchRevision,
      batchSha256: rotationPredecessor.batchSha256,
    };
  }
  const claims = value.claims.map(decodeClaim);
  if (claims.some((claim, index) => (
    index > 0 && claims[index - 1].memberId.localeCompare(claim.memberId, 'en-US') >= 0
  )) || claims.some(claim => claim.redemptionReceipt !== null && (
    claim.redemptionReceipt.checkpointSha256 !== checkpointSha256
    || claim.redemptionReceipt.projectId !== projectId
    || claim.redemptionReceipt.targetAuthorityGeneration !== targetAuthorityGeneration
    || claim.redemptionReceipt.transferId !== transferId
  ))) {
    throw new TypeError('Invalid authority transfer claim ordering');
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (
    updatedAt < createdAt
    || (expiresAt <= updatedAt && claims.some(claim => claim.disposition === 'retained'))
  ) {
    throw new TypeError('Invalid authority transfer claim timestamps');
  }
  const custodyReceipt = value.custodyReceipt === null
    ? null
    : decodeCollabTransferredMembershipClaimCustodyReceipt(value.custodyReceipt);
  if (custodyReceipt !== null && (
    custodyReceipt.projectId !== projectId
    || custodyReceipt.transferId !== transferId
    || custodyReceipt.operationIntentId !== operationIntentId
    || custodyReceipt.batchRevision !== batchRevision
    || custodyReceipt.batchSha256 !== batchSha256
    || custodyReceipt.checkpointSha256 !== checkpointSha256
    || custodyReceipt.targetAuthorityGeneration !== targetAuthorityGeneration
  )) {
    throw new TypeError('Invalid authority transfer custody receipt');
  }
  return {
    batchRevision: batchRevision as number,
    batchSha256,
    checkpointSha256,
    claims: Object.freeze(claims),
    createdAt,
    custodyReceipt,
    expiresAt,
    kind: 'authority-transfer-claim-custody',
    operationIntentId,
    projectId,
    purpose,
    rotationPredecessor: decodedRotationPredecessor,
    schemaVersion: 1,
    targetAuthorityGeneration: targetAuthorityGeneration as number,
    transferId,
    updatedAt,
  };
}

export function createAuthorityTransferClaimCustodyRecord(input: {
  readonly batch: CollabTransferredMembershipClaimBatch;
  readonly createdAt: CollabIsoTimestamp;
  readonly operationIntentId: string;
  readonly purpose: AuthorityTransferClaimCustodyPurpose;
}): AuthorityTransferClaimCustodyRecord {
  const batch = decodeCollabTransferredMembershipClaimBatch(input.batch);
  return decodeAuthorityTransferClaimCustodyRecord({
    batchRevision: batch.batchRevision,
    batchSha256: batch.batchSha256,
    checkpointSha256: batch.checkpointSha256,
    claims: batch.claims.map(item => ({
      claim: item.claim,
      claimSha256: createHash('sha256').update(item.claim, 'utf8').digest('hex'),
      disposition: 'retained',
      memberId: item.memberId,
      redemptionReceipt: null,
      scrubbedAt: null,
    })),
    createdAt: input.createdAt,
    custodyReceipt: null,
    expiresAt: batch.expiresAt,
    kind: 'authority-transfer-claim-custody',
    operationIntentId: input.operationIntentId,
    projectId: batch.projectId,
    purpose: input.purpose,
    rotationPredecessor: null,
    schemaVersion: 1,
    targetAuthorityGeneration: batch.targetAuthorityGeneration,
    transferId: batch.transferId,
    updatedAt: input.createdAt,
  });
}
