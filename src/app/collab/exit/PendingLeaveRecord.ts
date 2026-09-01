import {
  type CollabIsoTimestamp,
  type CollabMemberId,
  collabMemberRef,
  type CollabOperationId,
  type CollabProjectId,
  type CollabProjectMembershipOperationMap,
  decodeCollabProjectMembershipOperationRequest,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabLocalCleanupChoice } from '@/core/collab';
import { parseCollabProjectsFolder } from '@/core/collab';

export const COLLAB_PENDING_LEAVE_SCHEMA_VERSION = 2 as const;
export const COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION = 3 as const;

export type PendingLeavePhase =
  | 'queued'
  | 'submitting'
  | 'confirmed'
  | 'recovery-required';

export interface PendingLeaveAuthorityReplay {
  readonly expectedHostMemberId: CollabMemberId;
  readonly idempotencyManagerMemberId: CollabMemberId | null;
  readonly managerResponsibilityOfferId: CollabOperationId | null;
}

export interface LanPendingLeaveRecord {
  readonly schemaVersion: typeof COLLAB_PENDING_LEAVE_SCHEMA_VERSION;
  readonly kind: 'pending-leave';
  readonly projectId: CollabProjectId;
  readonly memberId: CollabMemberId;
  readonly operationId: CollabOperationId;
  readonly idempotencyKey: string;
  readonly authorityReplay: PendingLeaveAuthorityReplay | null;
  readonly cleanupChoice: CollabLocalCleanupChoice;
  readonly cleanupMarkerNonce: string;
  readonly localCleanupComplete: boolean;
  readonly localRole: 'manager' | 'member';
  readonly phase: PendingLeavePhase;
  readonly memberCredential: string;
  readonly hostEndpoint: string;
  readonly hostCaCertificatePem: string;
  readonly hostCaFingerprint: string;
  readonly projectCreatedAt: CollabIsoTimestamp;
  readonly projectName: string;
  readonly workspacePath: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}

export type CloudPendingLeavePhase =
  | 'queued'
  | 'submitted'
  | 'confirmed'
  | 'recovery-required';

interface CloudPendingLeaveRecordBase {
  readonly schemaVersion: typeof COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION;
  readonly kind: 'pending-leave';
  readonly authorityKind: 'cloud';
  readonly authorityGeneration: number;
  readonly projectId: CollabProjectId;
  readonly memberId: CollabMemberId;
  readonly operationId: CollabOperationId;
  readonly idempotencyKey: string;
  readonly cleanupChoice: CollabLocalCleanupChoice;
  readonly cleanupMarkerNonce: string;
  readonly localCleanupComplete: boolean;
  readonly localRole: 'manager' | 'member';
  readonly personalRef: string;
  readonly serverUrl: string;
  readonly projectCreatedAt: CollabIsoTimestamp;
  readonly projectName: string;
  readonly workspacePath: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}

export type CloudPendingLeaveRecord = CloudPendingLeaveRecordBase & (
  | {
    readonly phase: 'queued';
    readonly request: null;
  }
  | {
    readonly phase: Exclude<CloudPendingLeavePhase, 'queued'>;
    readonly request: CollabProjectMembershipOperationMap['leaveProject']['request'];
  }
);

export type PendingLeaveRecord = LanPendingLeaveRecord | CloudPendingLeaveRecord;

export function isCloudPendingLeaveRecord(
  record: PendingLeaveRecord,
): record is CloudPendingLeaveRecord {
  return 'authorityKind' in record && record.authorityKind === 'cloud';
}

export function isLanPendingLeaveRecord(
  record: PendingLeaveRecord,
): record is LanPendingLeaveRecord {
  return !isCloudPendingLeaveRecord(record);
}

type RecordValue = Readonly<Record<string, unknown>>;
const WORKSPACE_CHILD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const LAN_KEYS = new Set([
  'schemaVersion', 'kind', 'projectId', 'memberId', 'operationId',
  'idempotencyKey', 'authorityReplay', 'cleanupChoice', 'phase', 'memberCredential',
  'hostEndpoint', 'hostCaCertificatePem', 'hostCaFingerprint',
  'cleanupMarkerNonce', 'localCleanupComplete', 'localRole', 'projectCreatedAt', 'projectName', 'workspacePath',
  'createdAt', 'updatedAt',
]);
const CLOUD_KEYS = new Set([
  'schemaVersion', 'kind', 'authorityKind', 'authorityGeneration', 'projectId',
  'memberId', 'operationId', 'idempotencyKey', 'cleanupChoice', 'cleanupMarkerNonce',
  'localCleanupComplete', 'localRole', 'personalRef', 'serverUrl', 'phase',
  'request', 'projectCreatedAt', 'projectName', 'workspacePath', 'createdAt',
  'updatedAt',
]);
const REPLAY_KEYS = new Set([
  'expectedHostMemberId',
  'idempotencyManagerMemberId',
  'managerResponsibilityOfferId',
]);
const LEGACY_REPLAY_KEYS = new Set([
  'expectedHostMemberId',
  'expectedManagerMemberId',
  'managerResponsibilityOfferId',
]);

function exactRecord(value: unknown, keys: ReadonlySet<string>): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid pending Leave record');
  const result = value as RecordValue;
  if (Object.keys(result).length !== keys.size || Object.keys(result).some(key => !keys.has(key))) {
    throw new TypeError('Unexpected pending Leave field');
  }
  return result;
}

function text(value: RecordValue, key: string, max: number, pattern?: RegExp): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0 || field.length > max || (pattern && !pattern.test(field))) {
    throw new TypeError(`Invalid ${key}`);
  }
  return field;
}

function timestamp(value: RecordValue, key: string): CollabIsoTimestamp {
  const field = text(value, key, 64);
  const milliseconds = Date.parse(field);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== field) throw new TypeError(`Invalid ${key}`);
  return field;
}

function endpoint(value: RecordValue): string {
  const field = text(value, 'hostEndpoint', 2_048);
  try {
    const parsed = new URL(field);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
  } catch { throw new TypeError('Invalid hostEndpoint'); }
  return field;
}

function workspace(value: RecordValue): string {
  const result = text(value, 'workspacePath', 240);
  const split = result.lastIndexOf('/');
  if (
    split <= 0
    || !parseCollabProjectsFolder(result.slice(0, split)).ok
    || !WORKSPACE_CHILD_PATTERN.test(result.slice(split + 1))
  ) throw new TypeError('Invalid workspacePath');
  return result;
}

function authorityReplay(
  value: unknown,
  schemaVersion: 1 | typeof COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
): PendingLeaveAuthorityReplay | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid authorityReplay');
  }
  const replay = value as RecordValue;
  const keys = schemaVersion === 1 ? LEGACY_REPLAY_KEYS : REPLAY_KEYS;
  if (
    Object.keys(replay).length !== keys.size
    || Object.keys(replay).some(key => !keys.has(key))
  ) {
    throw new TypeError('Invalid authorityReplay');
  }
  const offerId = replay.managerResponsibilityOfferId;
  if (offerId !== null && !isCollabOpaqueId(offerId)) {
    throw new TypeError('Invalid managerResponsibilityOfferId');
  }
  return {
    expectedHostMemberId: memberId(replay, 'expectedHostMemberId'),
    idempotencyManagerMemberId: schemaVersion === 1
      ? memberId(replay, 'expectedManagerMemberId')
      : nullableMemberId(replay.idempotencyManagerMemberId),
    managerResponsibilityOfferId: offerId,
  };
}

function nullableMemberId(value: unknown): CollabMemberId | null {
  if (value === null) return null;
  if (!isCollabMemberId(value)) {
    throw new TypeError('Invalid idempotencyManagerMemberId');
  }
  return value;
}

function memberId(value: RecordValue, key: string): CollabMemberId {
  const result = text(value, key, 64);
  if (!isCollabMemberId(result)) throw new TypeError(`Invalid ${key}`);
  return result;
}

function opaqueId(value: RecordValue, key: string): string {
  const result = text(value, key, 128);
  if (!isCollabOpaqueId(result)) throw new TypeError(`Invalid ${key}`);
  return result;
}

function projectId(value: RecordValue): CollabProjectId {
  const result = text(value, 'projectId', 64);
  if (!isCollabProjectId(result)) throw new TypeError('Invalid projectId');
  return result;
}

function commonFields(input: RecordValue): Pick<
  CloudPendingLeaveRecordBase,
  | 'cleanupChoice'
  | 'cleanupMarkerNonce'
  | 'createdAt'
  | 'localCleanupComplete'
  | 'localRole'
  | 'memberId'
  | 'operationId'
  | 'projectCreatedAt'
  | 'projectId'
  | 'projectName'
  | 'updatedAt'
  | 'workspacePath'
> {
  const cleanupChoice = input.cleanupChoice;
  if (cleanupChoice !== 'keep-files' && cleanupChoice !== 'delete-files') {
    throw new TypeError('Invalid cleanupChoice');
  }
  const createdAt = timestamp(input, 'createdAt');
  const projectCreatedAt = timestamp(input, 'projectCreatedAt');
  const updatedAt = timestamp(input, 'updatedAt');
  if (updatedAt < createdAt || createdAt < projectCreatedAt) {
    throw new TypeError('Invalid pending Leave timestamps');
  }
  if (typeof input.localCleanupComplete !== 'boolean') {
    throw new TypeError('Invalid localCleanupComplete');
  }
  if (input.localRole !== 'manager' && input.localRole !== 'member') {
    throw new TypeError('Invalid localRole');
  }
  return {
    cleanupChoice,
    cleanupMarkerNonce: text(input, 'cleanupMarkerNonce', 43, CREDENTIAL),
    createdAt,
    localCleanupComplete: input.localCleanupComplete,
    localRole: input.localRole,
    memberId: memberId(input, 'memberId'),
    operationId: opaqueId(input, 'operationId'),
    projectCreatedAt,
    projectId: projectId(input),
    projectName: text(input, 'projectName', 200),
    updatedAt,
    workspacePath: workspace(input),
  };
}

function decodeCloudPendingLeaveRecord(value: unknown): CloudPendingLeaveRecord {
  const input = exactRecord(value, CLOUD_KEYS);
  if (
    input.schemaVersion !== COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION
    || input.kind !== 'pending-leave'
    || input.authorityKind !== 'cloud'
  ) throw new TypeError('Invalid Cloud pending Leave record');
  if (
    !Number.isSafeInteger(input.authorityGeneration)
    || (input.authorityGeneration as number) < 1
  ) throw new TypeError('Invalid authorityGeneration');
  const common = commonFields(input);
  const personalRef = text(input, 'personalRef', 256);
  if (personalRef !== collabMemberRef(common.memberId)) {
    throw new TypeError('Invalid personalRef');
  }
  const phase = input.phase;
  if (
    phase !== 'queued'
    && phase !== 'submitted'
    && phase !== 'confirmed'
    && phase !== 'recovery-required'
  ) throw new TypeError('Invalid phase');
  if ((phase === 'queued') !== (input.request === null)) {
    throw new TypeError('Invalid Cloud pending Leave request state');
  }
  const request = input.request === null
    ? null
    : decodeCollabProjectMembershipOperationRequest('leaveProject', input.request);
  if (request !== null && request.status !== 'ok') throw request.error;
  const decodedRequest = request?.value ?? null;
  const idempotencyKey = opaqueId(input, 'idempotencyKey');
  if (
    decodedRequest
    && (
      decodedRequest.projectId !== common.projectId
      || decodedRequest.idempotencyKey !== idempotencyKey
    )
  ) throw new TypeError('Cloud pending Leave request identity mismatch');
  const base: CloudPendingLeaveRecordBase = {
    ...common,
    authorityGeneration: input.authorityGeneration as number,
    authorityKind: 'cloud',
    idempotencyKey,
    kind: 'pending-leave',
    personalRef,
    schemaVersion: COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION,
    serverUrl: validateCloudServerUrl(text(input, 'serverUrl', 2_048), 'serverUrl'),
  };
  if (phase === 'queued') return { ...base, phase, request: null };
  if (!decodedRequest) throw new TypeError('Invalid Cloud pending Leave request state');
  return { ...base, phase, request: decodedRequest };
}

function decodeLanPendingLeaveRecord(value: unknown): LanPendingLeaveRecord {
  const input = exactRecord(value, LAN_KEYS);
  const schemaVersion = input.schemaVersion;
  if (
    (schemaVersion !== 1 && schemaVersion !== COLLAB_PENDING_LEAVE_SCHEMA_VERSION)
    || input.kind !== 'pending-leave'
  ) throw new TypeError('Invalid pending Leave record');
  const phase = input.phase;
  if (phase !== 'queued' && phase !== 'submitting' && phase !== 'confirmed' && phase !== 'recovery-required') throw new TypeError('Invalid phase');
  const common = commonFields(input);
  const certificate = text(input, 'hostCaCertificatePem', 64 * 1024);
  if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----') || certificate.includes('PRIVATE KEY')) throw new TypeError('Invalid Host CA certificate');
  return {
    ...common,
    authorityReplay: authorityReplay(input.authorityReplay, schemaVersion),
    hostCaCertificatePem: certificate,
    hostCaFingerprint: text(input, 'hostCaFingerprint', 64, FINGERPRINT),
    hostEndpoint: endpoint(input),
    idempotencyKey: opaqueId(input, 'idempotencyKey'),
    kind: 'pending-leave',
    memberCredential: text(input, 'memberCredential', 43, CREDENTIAL),
    phase,
    schemaVersion: COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
  };
}

export function decodePendingLeaveRecord(value: unknown): PendingLeaveRecord {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as RecordValue).authorityKind === 'cloud'
  ) return decodeCloudPendingLeaveRecord(value);
  return decodeLanPendingLeaveRecord(value);
}
