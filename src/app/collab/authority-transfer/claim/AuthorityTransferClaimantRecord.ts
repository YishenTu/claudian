import { createHash } from 'node:crypto';

import {
  type CollabAuthorityTransferStatus,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaim,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaim,
  decodeCollabTransferredMembershipRedemptionReceipt,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

export const AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION = 1 as const;

export const AUTHORITY_TRANSFER_CLAIMANT_PHASES = [
  'prepared',
  'claim-retained',
  'credential-persisted',
  'target-claimed',
  'source-acknowledged',
  'membership-converged',
  'completed',
] as const;

export type AuthorityTransferClaimantPhase =
  typeof AUTHORITY_TRANSFER_CLAIMANT_PHASES[number];

export interface AuthorityTransferClaimantLanTarget {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
}

export interface AuthorityTransferClaimantRecord {
  readonly claim: CollabTransferredMembershipClaim | null;
  readonly createdAt: CollabIsoTimestamp;
  readonly kind: 'authority-transfer-claimant';
  readonly lanTarget: AuthorityTransferClaimantLanTarget | null;
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly phase: AuthorityTransferClaimantPhase;
  readonly projectId: CollabProjectId;
  readonly redemptionReceipt: CollabTransferredMembershipRedemptionReceipt | null;
  readonly schemaVersion: typeof AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION;
  readonly status: CollabAuthorityTransferStatus;
  readonly targetCredential: string | null;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

const KEYS = new Set([
  'claim',
  'createdAt',
  'kind',
  'lanTarget',
  'memberId',
  'operationIntentId',
  'phase',
  'projectId',
  'redemptionReceipt',
  'schemaVersion',
  'status',
  'targetCredential',
  'transferId',
  'updatedAt',
]);
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^(?:[A-Fa-f0-9]{64}|(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})$/;
const LAN_TARGET_KEYS = new Set(['caCertificatePem', 'caFingerprint', 'endpoint']);

export interface AuthorityTransferClaimantStore {
  listProjectIds(): Promise<readonly CollabProjectId[]>;
  load(projectId: CollabProjectId): Promise<AuthorityTransferClaimantRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(record: AuthorityTransferClaimantRecord): Promise<void>;
}

function timestamp(value: unknown): value is CollabIsoTimestamp {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function phaseIndex(phase: AuthorityTransferClaimantPhase): number {
  return AUTHORITY_TRANSFER_CLAIMANT_PHASES.indexOf(phase);
}

export function decodeAuthorityTransferClaimantRecord(
  value: unknown,
): AuthorityTransferClaimantRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid authority-transfer claimant record');
  }
  const source = value as Readonly<Record<string, unknown>>;
  const phase = source.phase;
  if (
    Object.keys(source).length !== KEYS.size
    || Object.keys(source).some(key => !KEYS.has(key))
    || source.schemaVersion !== AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION
    || source.kind !== 'authority-transfer-claimant'
    || typeof phase !== 'string'
    || !AUTHORITY_TRANSFER_CLAIMANT_PHASES.includes(phase as never)
    || !isCollabProjectId(source.projectId)
    || !isCollabMemberId(source.memberId)
    || typeof source.operationIntentId !== 'string'
    || !isCollabOpaqueId(source.operationIntentId)
    || typeof source.transferId !== 'string'
    || !isCollabOpaqueId(source.transferId)
    || !timestamp(source.createdAt)
    || !timestamp(source.updatedAt)
    || Date.parse(source.updatedAt) < Date.parse(source.createdAt)
  ) throw new TypeError('Invalid authority-transfer claimant identity');
  const status = decodeCollabAuthorityTransferStatus(source.status);
  if (
    status.projectId !== source.projectId
    || status.transferId !== source.transferId
    || status.state !== 'completed'
    || status.phase !== 'completed'
    || status.relinquishmentProof === null
  ) throw new TypeError('Invalid authority-transfer claimant status');
  const lanTargetValue = source.lanTarget;
  let lanTarget: AuthorityTransferClaimantLanTarget | null = null;
  if (lanTargetValue !== null) {
    if (
      !lanTargetValue
      || typeof lanTargetValue !== 'object'
      || Array.isArray(lanTargetValue)
      || Object.keys(lanTargetValue).length !== LAN_TARGET_KEYS.size
      || Object.keys(lanTargetValue).some(key => !LAN_TARGET_KEYS.has(key))
    ) throw new TypeError('Invalid authority-transfer claimant LAN target');
    const candidate = lanTargetValue as Readonly<Record<string, unknown>>;
    if (
      typeof candidate.caCertificatePem !== 'string'
      || candidate.caCertificatePem.length > 64 * 1024
      || !candidate.caCertificatePem.includes('-----BEGIN CERTIFICATE-----')
      || !candidate.caCertificatePem.includes('-----END CERTIFICATE-----')
      || candidate.caCertificatePem.includes('PRIVATE KEY')
      || typeof candidate.caFingerprint !== 'string'
      || !FINGERPRINT_PATTERN.test(candidate.caFingerprint)
      || typeof candidate.endpoint !== 'string'
      || candidate.endpoint !== status.targetUrl
    ) throw new TypeError('Invalid authority-transfer claimant LAN target');
    lanTarget = Object.freeze({
      caCertificatePem: candidate.caCertificatePem,
      caFingerprint: candidate.caFingerprint.replaceAll(':', '').toLocaleLowerCase('en-US'),
      endpoint: candidate.endpoint,
    });
  }
  if ((status.direction === 'cloud-to-lan') !== (lanTarget !== null)) {
    throw new TypeError('Invalid authority-transfer claimant LAN target direction');
  }
  const claim = source.claim === null
    ? null
    : decodeCollabTransferredMembershipClaim(source.claim);
  const credential = source.targetCredential;
  const targetCredential = credential === null
    ? null
    : typeof credential === 'string'
      && CREDENTIAL_PATTERN.test(credential)
      && Buffer.from(credential, 'base64url').byteLength === 32
      && Buffer.from(credential, 'base64url').toString('base64url') === credential
      ? credential
      : undefined;
  if (targetCredential === undefined) {
    throw new TypeError('Invalid authority-transfer claimant credential');
  }
  const redemptionReceipt = source.redemptionReceipt === null
    ? null
    : decodeCollabTransferredMembershipRedemptionReceipt(source.redemptionReceipt);
  const index = phaseIndex(phase as AuthorityTransferClaimantPhase);
  if (
    (index >= 1) !== (claim !== null)
    || (status.targetAuthority.kind === 'lan' && index >= 2) !== (targetCredential !== null)
    || (status.targetAuthority.kind === 'cloud' && targetCredential !== null)
    || (index >= 3) !== (redemptionReceipt !== null)
    || (claim !== null && (
      claim.memberId !== source.memberId
      || claim.projectId !== source.projectId
      || claim.transferId !== source.transferId
      || claim.targetAuthorityGeneration !== status.targetAuthority.generation
      || claim.expiresAt !== status.expiresAt
    ))
    || (redemptionReceipt !== null && (
      redemptionReceipt.memberId !== source.memberId
      || redemptionReceipt.projectId !== source.projectId
      || redemptionReceipt.transferId !== source.transferId
      || redemptionReceipt.targetAuthorityGeneration !== status.targetAuthority.generation
      || redemptionReceipt.operationIntentId !== source.operationIntentId
      || redemptionReceipt.checkpointSha256 !== status.checkpointSha256
      || Date.parse(redemptionReceipt.redeemedAt) < Date.parse(status.createdAt)
      || Date.parse(redemptionReceipt.redeemedAt) >= Date.parse(status.expiresAt)
      || claim === null
      || redemptionReceipt.claimSha256 !== createHash('sha256')
        .update(claim.claim, 'utf8')
        .digest('hex')
    ))
  ) throw new TypeError('Invalid authority-transfer claimant progress');
  return Object.freeze({
    claim,
    createdAt: source.createdAt,
    kind: 'authority-transfer-claimant',
    lanTarget,
    memberId: source.memberId,
    operationIntentId: source.operationIntentId,
    phase: phase as AuthorityTransferClaimantPhase,
    projectId: source.projectId,
    redemptionReceipt,
    schemaVersion: AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
    status,
    targetCredential,
    transferId: source.transferId,
    updatedAt: source.updatedAt,
  });
}

export function createAuthorityTransferClaimantRecord(input: {
  readonly createdAt: CollabIsoTimestamp;
  readonly lanTarget?: AuthorityTransferClaimantLanTarget | null;
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly status: CollabAuthorityTransferStatus;
}): AuthorityTransferClaimantRecord {
  return decodeAuthorityTransferClaimantRecord({
    claim: null,
    createdAt: input.createdAt,
    kind: 'authority-transfer-claimant',
    lanTarget: input.lanTarget ?? null,
    memberId: input.memberId,
    operationIntentId: input.operationIntentId,
    phase: 'prepared',
    projectId: input.status.projectId,
    redemptionReceipt: null,
    schemaVersion: AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
    status: input.status,
    targetCredential: null,
    transferId: input.status.transferId,
    updatedAt: input.createdAt,
  });
}

export function advanceAuthorityTransferClaimantRecord(
  previous: AuthorityTransferClaimantRecord,
  update: Partial<Pick<
    AuthorityTransferClaimantRecord,
    'claim' | 'redemptionReceipt' | 'targetCredential'
  >> & {
    readonly phase: AuthorityTransferClaimantPhase;
    readonly updatedAt: CollabIsoTimestamp;
  },
): AuthorityTransferClaimantRecord {
  if (phaseIndex(update.phase) !== phaseIndex(previous.phase) + 1) {
    throw new TypeError('Authority-transfer claimant phase is stale');
  }
  return decodeAuthorityTransferClaimantRecord({ ...previous, ...update });
}
