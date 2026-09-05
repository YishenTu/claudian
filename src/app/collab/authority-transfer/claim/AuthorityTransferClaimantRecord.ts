import { createHash } from 'node:crypto';

import {
  type ClaimTransferredMembershipRequest,
  type CollabAuthorityTransferStatus,
  collabControlOperationCodec,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaim,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabAuthorityTransferOperationRequest,
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaim,
  decodeCollabTransferredMembershipRedemptionReceipt,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type ReissueTransferredMembershipClaimResponse,
} from '@claudian-collab/protocol';

import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import {
  type InstallationKey,
  parseInstallationKey,
} from '@/core/device/InstallationKey';

export const AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION = 3 as const;

export const SOURCE_ISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES = [
  'prepared',
  'claim-retained',
  'credential-persisted',
  'target-claimed',
  'source-acknowledged',
  'membership-converged',
  'completed',
] as const;

export const MANAGER_REISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES = [
  'redemption-prepared',
  'target-claimed',
  'target-confirmed',
  'membership-converged',
  'completed',
] as const;

export type SourceIssuedAuthorityTransferClaimantPhase =
  typeof SOURCE_ISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES[number];
export type ManagerReissuedAuthorityTransferClaimantPhase =
  typeof MANAGER_REISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES[number];
export type AuthorityTransferClaimantPhase =
  | SourceIssuedAuthorityTransferClaimantPhase
  | ManagerReissuedAuthorityTransferClaimantPhase;

export interface AuthorityTransferClaimantLanTarget {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
}

export interface CloudToLanManagerClaimantPredecessor {
  readonly initiatingPersonalRef: string;
  readonly operationIntentId: string;
  readonly ownerInstallationKey: InstallationKey;
  readonly preparationId: string;
  readonly selectedTargetMemberId: CollabMemberId;
  readonly sourceCloudUrl: string;
}

interface AuthorityTransferClaimantRecordBase {
  readonly cloudPrincipalId: string | null;
  readonly createdAt: CollabIsoTimestamp;
  readonly kind: 'authority-transfer-claimant';
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
  readonly schemaVersion: typeof AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface SourceIssuedAuthorityTransferClaimantRecord
  extends AuthorityTransferClaimantRecordBase {
  readonly claim: CollabTransferredMembershipClaim | null;
  readonly lanTarget: AuthorityTransferClaimantLanTarget | null;
  readonly managerPredecessor: CloudToLanManagerClaimantPredecessor | null;
  readonly phase: SourceIssuedAuthorityTransferClaimantPhase;
  readonly redemptionReceipt: CollabTransferredMembershipRedemptionReceipt | null;
  readonly status: CollabAuthorityTransferStatus;
  readonly targetCredential: string | null;
  readonly variant: 'source-issued';
}

export interface ManagerReissuedAuthorityTransferClaimantRecord
  extends AuthorityTransferClaimantRecordBase {
  readonly convergenceProof: 'receipt' | 'existing-binding' | null;
  readonly descriptor: ReissueTransferredMembershipClaimResponse;
  readonly memberPersonalRef: string;
  readonly phase: ManagerReissuedAuthorityTransferClaimantPhase;
  readonly redemptionReceipt: CollabTransferredMembershipRedemptionReceipt | null;
  readonly redemptionRequest: ClaimTransferredMembershipRequest;
  readonly serverUrl: string;
  readonly targetStatus: CollabAuthorityTransferStatus | null;
  readonly variant: 'manager-reissued';
}

export type AuthorityTransferClaimantRecord =
  | SourceIssuedAuthorityTransferClaimantRecord
  | ManagerReissuedAuthorityTransferClaimantRecord;

const SOURCE_KEYS = new Set([
  'cloudPrincipalId', 'claim', 'createdAt', 'kind', 'lanTarget', 'managerPredecessor', 'memberId',
  'operationIntentId', 'phase', 'projectId', 'redemptionReceipt', 'schemaVersion',
  'status', 'targetCredential', 'transferId', 'updatedAt', 'variant',
]);
const MANAGER_KEYS = new Set([
  'cloudPrincipalId', 'convergenceProof', 'createdAt', 'descriptor', 'kind', 'memberId',
  'memberPersonalRef', 'operationIntentId', 'phase', 'projectId', 'redemptionReceipt',
  'redemptionRequest', 'schemaVersion', 'serverUrl', 'targetStatus', 'transferId',
  'updatedAt', 'variant',
]);
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^(?:[A-Fa-f0-9]{64}|(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})$/;
const LAN_TARGET_KEYS = new Set(['caCertificatePem', 'caFingerprint', 'endpoint']);
const MANAGER_PREDECESSOR_KEYS = new Set([
  'initiatingPersonalRef',
  'operationIntentId',
  'ownerInstallationKey',
  'preparationId',
  'selectedTargetMemberId',
  'sourceCloudUrl',
]);

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

function assertKeys(source: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): void {
  if (
    Object.keys(source).length !== keys.size
    || Object.keys(source).some(key => !keys.has(key))
  ) throw new TypeError('Invalid authority-transfer claimant record');
}

function assertBase(source: Readonly<Record<string, unknown>>): void {
  if (
    source.schemaVersion !== AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION
    || source.kind !== 'authority-transfer-claimant'
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
}

function decodeCloudPrincipal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^vault-[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Invalid authority-transfer claimant Cloud principal');
  }
  return value;
}

function decodeLanTarget(
  value: unknown,
  status: CollabAuthorityTransferStatus,
): AuthorityTransferClaimantLanTarget | null {
  if (value === null) return null;
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== LAN_TARGET_KEYS.size
    || Object.keys(value).some(key => !LAN_TARGET_KEYS.has(key))
  ) throw new TypeError('Invalid authority-transfer claimant LAN target');
  const candidate = value as Readonly<Record<string, unknown>>;
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
  return Object.freeze({
    caCertificatePem: candidate.caCertificatePem,
    caFingerprint: candidate.caFingerprint.replaceAll(':', '').toLocaleLowerCase('en-US'),
    endpoint: candidate.endpoint,
  });
}

function decodeManagerPredecessor(
  value: unknown,
  source: Readonly<Record<string, unknown>>,
  status: CollabAuthorityTransferStatus,
): CloudToLanManagerClaimantPredecessor | null {
  if (value === null) {
    if (status.direction === 'cloud-to-lan') {
      throw new TypeError('Invalid authority-transfer claimant Manager predecessor');
    }
    return null;
  }
  if (
    status.direction !== 'cloud-to-lan'
    || !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== MANAGER_PREDECESSOR_KEYS.size
    || Object.keys(value).some(key => !MANAGER_PREDECESSOR_KEYS.has(key))
  ) throw new TypeError('Invalid authority-transfer claimant Manager predecessor');
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.initiatingPersonalRef !== 'string'
    || candidate.initiatingPersonalRef.length === 0
    || Buffer.byteLength(candidate.initiatingPersonalRef, 'utf8') > 1024
    || typeof candidate.operationIntentId !== 'string'
    || !isCollabOpaqueId(candidate.operationIntentId)
    || typeof candidate.preparationId !== 'string'
    || !isCollabOpaqueId(candidate.preparationId)
    || !isCollabMemberId(candidate.selectedTargetMemberId)
    || typeof candidate.sourceCloudUrl !== 'string'
    || source.operationIntentId !== authorityTransferChildIdempotencyKey(
      candidate.operationIntentId,
      'claims',
    )
  ) throw new TypeError('Invalid authority-transfer claimant Manager predecessor');
  return Object.freeze({
    initiatingPersonalRef: candidate.initiatingPersonalRef,
    operationIntentId: candidate.operationIntentId,
    ownerInstallationKey: parseInstallationKey(candidate.ownerInstallationKey),
    preparationId: candidate.preparationId,
    selectedTargetMemberId: candidate.selectedTargetMemberId,
    sourceCloudUrl: validateCloudServerUrl(candidate.sourceCloudUrl, 'sourceCloudUrl'),
  });
}

function decodeCredential(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string'
    || !CREDENTIAL_PATTERN.test(value)
    || Buffer.from(value, 'base64url').byteLength !== 32
    || Buffer.from(value, 'base64url').toString('base64url') !== value
  ) throw new TypeError('Invalid authority-transfer claimant credential');
  return value;
}

function decodeReceipt(value: unknown): CollabTransferredMembershipRedemptionReceipt | null {
  return value === null
    ? null
    : decodeCollabTransferredMembershipRedemptionReceipt(value);
}

function decodeConvergenceProof(
  value: unknown,
): ManagerReissuedAuthorityTransferClaimantRecord['convergenceProof'] {
  if (value === null || value === 'receipt' || value === 'existing-binding') return value;
  throw new TypeError('Invalid Manager-reissued authority-transfer claimant proof');
}

function decodeSourceIssuedRecord(
  source: Readonly<Record<string, unknown>>,
): SourceIssuedAuthorityTransferClaimantRecord {
  assertKeys(source, SOURCE_KEYS);
  assertBase(source);
  const phase = source.phase;
  if (
    typeof phase !== 'string'
    || !SOURCE_ISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES.includes(phase as never)
  ) throw new TypeError('Invalid authority-transfer claimant phase');
  const status = decodeCollabAuthorityTransferStatus(source.status);
  if (
    status.projectId !== source.projectId
    || status.transferId !== source.transferId
    || status.state !== 'completed'
    || status.phase !== 'completed'
    || status.relinquishmentProof === null
  ) throw new TypeError('Invalid authority-transfer claimant status');
  const lanTarget = decodeLanTarget(source.lanTarget, status);
  if ((status.direction === 'cloud-to-lan') !== (lanTarget !== null)) {
    throw new TypeError('Invalid authority-transfer claimant LAN target direction');
  }
  const claim = source.claim === null
    ? null
    : decodeCollabTransferredMembershipClaim(source.claim);
  const cloudPrincipalId = decodeCloudPrincipal(source.cloudPrincipalId);
  if ((status.targetAuthority.kind === 'cloud') !== (cloudPrincipalId !== null)) {
    throw new TypeError('Invalid authority-transfer claimant Cloud principal');
  }
  const targetCredential = decodeCredential(source.targetCredential);
  const redemptionReceipt = decodeReceipt(source.redemptionReceipt);
  const managerPredecessor = decodeManagerPredecessor(
    source.managerPredecessor,
    source,
    status,
  );
  const index = SOURCE_ISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES.indexOf(phase as never);
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
    cloudPrincipalId,
    claim,
    createdAt: source.createdAt as CollabIsoTimestamp,
    kind: 'authority-transfer-claimant',
    lanTarget,
    managerPredecessor,
    memberId: source.memberId as CollabMemberId,
    operationIntentId: source.operationIntentId as string,
    phase: phase as SourceIssuedAuthorityTransferClaimantPhase,
    projectId: source.projectId,
    redemptionReceipt,
    schemaVersion: AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
    status,
    targetCredential,
    transferId: source.transferId,
    updatedAt: source.updatedAt as CollabIsoTimestamp,
    variant: 'source-issued',
  });
}

function decodeManagerReissuedRecord(
  source: Readonly<Record<string, unknown>>,
): ManagerReissuedAuthorityTransferClaimantRecord {
  assertKeys(source, MANAGER_KEYS);
  assertBase(source);
  const phase = source.phase;
  if (
    typeof phase !== 'string'
    || !MANAGER_REISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES.includes(phase as never)
  ) throw new TypeError('Invalid authority-transfer claimant phase');
  const cloudPrincipalId = decodeCloudPrincipal(source.cloudPrincipalId);
  if (cloudPrincipalId === null) {
    throw new TypeError('Invalid authority-transfer claimant Cloud principal');
  }
  const descriptor = collabControlOperationCodec(
    'reissueTransferredMembershipClaim',
  ).decodeResponse(source.descriptor);
  const redemptionRequest = decodeCollabAuthorityTransferOperationRequest(
    'claimTransferredMembership',
    source.redemptionRequest,
  );
  if (typeof source.serverUrl !== 'string') {
    throw new TypeError('Invalid Manager-reissued authority-transfer claimant endpoint');
  }
  const serverUrl = validateCloudServerUrl(source.serverUrl, 'serverUrl');
  const targetStatus = source.targetStatus === null
    ? null
    : decodeCollabAuthorityTransferStatus(source.targetStatus);
  const redemptionReceipt = decodeReceipt(source.redemptionReceipt);
  const convergenceProof = decodeConvergenceProof(source.convergenceProof);
  const index = MANAGER_REISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES.indexOf(phase as never);
  if (
    typeof source.memberPersonalRef !== 'string'
    || source.memberPersonalRef.length === 0
    || Buffer.byteLength(source.memberPersonalRef, 'utf8') > 1024
    || descriptor.createdAt !== source.createdAt
    || descriptor.projectId !== source.projectId
    || descriptor.memberId !== source.memberId
    || descriptor.transferId !== source.transferId
    || Date.parse(descriptor.expiresAt) <= Date.parse(descriptor.createdAt)
    || Date.parse(descriptor.secretReplayExpiresAt) < Date.parse(descriptor.expiresAt)
    || redemptionRequest.projectId !== descriptor.projectId
    || redemptionRequest.transferId !== descriptor.transferId
    || redemptionRequest.idempotencyKey !== source.operationIntentId
    || redemptionRequest.claim !== descriptor.claim
    || ('credentialHash' in redemptionRequest && redemptionRequest.credentialHash !== undefined)
    || (index === 0 && (redemptionReceipt !== null || targetStatus !== null || convergenceProof !== null))
    || (index === 1 && (redemptionReceipt === null || targetStatus !== null || convergenceProof !== null))
    || (index >= 2 && targetStatus === null)
    || (index >= 2 && convergenceProof !== 'receipt' && convergenceProof !== 'existing-binding')
    || (convergenceProof === 'receipt' && redemptionReceipt === null)
    || (convergenceProof === 'existing-binding' && redemptionReceipt !== null)
    || (redemptionReceipt !== null && (
      redemptionReceipt.memberId !== descriptor.memberId
      || redemptionReceipt.projectId !== descriptor.projectId
      || redemptionReceipt.transferId !== descriptor.transferId
      || redemptionReceipt.targetAuthorityGeneration !== descriptor.targetAuthorityGeneration
      || redemptionReceipt.operationIntentId !== source.operationIntentId
      || Date.parse(redemptionReceipt.redeemedAt) < Date.parse(descriptor.createdAt)
      || Date.parse(redemptionReceipt.redeemedAt) >= Date.parse(descriptor.expiresAt)
      || redemptionReceipt.claimSha256 !== createHash('sha256')
        .update(descriptor.claim, 'utf8')
        .digest('hex')
    ))
    || (targetStatus !== null && (
      targetStatus.direction !== 'lan-to-cloud'
      || targetStatus.phase !== 'completed'
      || targetStatus.state !== 'completed'
      || targetStatus.relinquishmentProof === null
      || targetStatus.projectId !== descriptor.projectId
      || targetStatus.transferId !== descriptor.transferId
      || targetStatus.targetAuthority.kind !== 'cloud'
      || targetStatus.targetAuthority.generation !== descriptor.targetAuthorityGeneration
      || validateCloudServerUrl(targetStatus.targetUrl, 'targetUrl') !== serverUrl
      || (redemptionReceipt !== null
        && redemptionReceipt.checkpointSha256 !== targetStatus.checkpointSha256)
    ))
  ) throw new TypeError('Invalid Manager-reissued authority-transfer claimant progress');
  return Object.freeze({
    cloudPrincipalId,
    convergenceProof,
    createdAt: source.createdAt,
    descriptor,
    kind: 'authority-transfer-claimant',
    memberId: source.memberId,
    memberPersonalRef: source.memberPersonalRef,
    operationIntentId: source.operationIntentId,
    phase: phase as ManagerReissuedAuthorityTransferClaimantPhase,
    projectId: source.projectId,
    redemptionReceipt,
    redemptionRequest,
    schemaVersion: AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
    serverUrl,
    targetStatus,
    transferId: source.transferId,
    updatedAt: source.updatedAt as CollabIsoTimestamp,
    variant: 'manager-reissued',
  });
}

export function decodeAuthorityTransferClaimantRecord(
  value: unknown,
): AuthorityTransferClaimantRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid authority-transfer claimant record');
  }
  const source = value as Readonly<Record<string, unknown>>;
  if (source.variant === 'source-issued') return decodeSourceIssuedRecord(source);
  if (source.variant === 'manager-reissued') return decodeManagerReissuedRecord(source);
  throw new TypeError('Invalid authority-transfer claimant variant');
}

export function createAuthorityTransferClaimantRecord(input: {
  readonly cloudPrincipalId: string | null;
  readonly createdAt: CollabIsoTimestamp;
  readonly lanTarget?: AuthorityTransferClaimantLanTarget | null;
  readonly managerPredecessor?: CloudToLanManagerClaimantPredecessor | null;
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly status: CollabAuthorityTransferStatus;
}): SourceIssuedAuthorityTransferClaimantRecord {
  return decodeAuthorityTransferClaimantRecord({
    cloudPrincipalId: input.cloudPrincipalId,
    claim: null,
    createdAt: input.createdAt,
    kind: 'authority-transfer-claimant',
    lanTarget: input.lanTarget ?? null,
    managerPredecessor: input.managerPredecessor ?? null,
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
    variant: 'source-issued',
  }) as SourceIssuedAuthorityTransferClaimantRecord;
}

export function createManagerReissuedAuthorityTransferClaimantRecord(input: {
  readonly cloudPrincipalId: string;
  readonly descriptor: ReissueTransferredMembershipClaimResponse;
  readonly memberPersonalRef: string;
  readonly operationIntentId: string;
  readonly serverUrl: string;
}): ManagerReissuedAuthorityTransferClaimantRecord {
  return decodeAuthorityTransferClaimantRecord({
    cloudPrincipalId: input.cloudPrincipalId,
    convergenceProof: null,
    createdAt: input.descriptor.createdAt,
    descriptor: input.descriptor,
    kind: 'authority-transfer-claimant',
    memberId: input.descriptor.memberId,
    memberPersonalRef: input.memberPersonalRef,
    operationIntentId: input.operationIntentId,
    phase: 'redemption-prepared',
    projectId: input.descriptor.projectId,
    redemptionReceipt: null,
    redemptionRequest: {
      claim: input.descriptor.claim,
      idempotencyKey: input.operationIntentId,
      projectId: input.descriptor.projectId,
      transferId: input.descriptor.transferId,
    },
    schemaVersion: AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
    serverUrl: input.serverUrl,
    targetStatus: null,
    transferId: input.descriptor.transferId,
    updatedAt: input.descriptor.createdAt,
    variant: 'manager-reissued',
  }) as ManagerReissuedAuthorityTransferClaimantRecord;
}

export function advanceAuthorityTransferClaimantRecord(
  previous: SourceIssuedAuthorityTransferClaimantRecord,
  update: AuthorityTransferClaimantRecordUpdate,
): SourceIssuedAuthorityTransferClaimantRecord;
export function advanceAuthorityTransferClaimantRecord(
  previous: ManagerReissuedAuthorityTransferClaimantRecord,
  update: AuthorityTransferClaimantRecordUpdate,
): ManagerReissuedAuthorityTransferClaimantRecord;
export function advanceAuthorityTransferClaimantRecord(
  previous: AuthorityTransferClaimantRecord,
  update: AuthorityTransferClaimantRecordUpdate,
): AuthorityTransferClaimantRecord {
  const phases: readonly AuthorityTransferClaimantPhase[] = previous.variant === 'source-issued'
    ? SOURCE_ISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES
    : MANAGER_REISSUED_AUTHORITY_TRANSFER_CLAIMANT_PHASES;
  const isExistingBindingRecovery = previous.variant === 'manager-reissued'
    && previous.phase === 'redemption-prepared'
    && update.phase === 'target-confirmed'
    && update.convergenceProof === 'existing-binding'
    && update.targetStatus !== null
    && update.targetStatus !== undefined;
  if (
    !isExistingBindingRecovery
    && phases.indexOf(update.phase) !== phases.indexOf(previous.phase) + 1
  ) {
    throw new TypeError('Authority-transfer claimant phase is stale');
  }
  return decodeAuthorityTransferClaimantRecord({ ...previous, ...update });
}

interface AuthorityTransferClaimantRecordUpdate {
  readonly claim?: CollabTransferredMembershipClaim | null;
  readonly convergenceProof?: 'receipt' | 'existing-binding' | null;
  readonly phase: AuthorityTransferClaimantPhase;
  readonly redemptionReceipt?: CollabTransferredMembershipRedemptionReceipt | null;
  readonly targetCredential?: string | null;
  readonly targetStatus?: CollabAuthorityTransferStatus | null;
  readonly updatedAt: CollabIsoTimestamp;
}

export function authorityTransferClaimantStatus(
  record: AuthorityTransferClaimantRecord,
): CollabAuthorityTransferStatus | null {
  return record.variant === 'source-issued' ? record.status : record.targetStatus;
}
