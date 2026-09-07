import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import type { CollabLocalCleanupChoice } from '@/core/collab';
import { parseCollabProjectsFolder } from '@/core/collab';

export const COLLAB_PENDING_LEAVE_SCHEMA_VERSION = 2 as const;

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

export interface PendingLeaveRecord {
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

type RecordValue = Readonly<Record<string, unknown>>;
const WORKSPACE_CHILD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const KEYS = new Set([
  'schemaVersion', 'kind', 'projectId', 'memberId', 'operationId',
  'idempotencyKey', 'authorityReplay', 'cleanupChoice', 'phase', 'memberCredential',
  'hostEndpoint', 'hostCaCertificatePem', 'hostCaFingerprint',
  'cleanupMarkerNonce', 'localCleanupComplete', 'localRole', 'projectCreatedAt', 'projectName', 'workspacePath',
  'createdAt', 'updatedAt',
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

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid pending Leave record');
  const result = value as RecordValue;
  if (Object.keys(result).length !== KEYS.size || Object.keys(result).some(key => !KEYS.has(key))) {
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

export function decodePendingLeaveRecord(value: unknown): PendingLeaveRecord {
  const input = record(value);
  const schemaVersion = input.schemaVersion;
  if (
    (schemaVersion !== 1 && schemaVersion !== COLLAB_PENDING_LEAVE_SCHEMA_VERSION)
    || input.kind !== 'pending-leave'
  ) throw new TypeError('Invalid pending Leave record');
  const phase = input.phase;
  if (phase !== 'queued' && phase !== 'submitting' && phase !== 'confirmed' && phase !== 'recovery-required') throw new TypeError('Invalid phase');
  const cleanupChoice = input.cleanupChoice;
  if (cleanupChoice !== 'keep-files' && cleanupChoice !== 'delete-files') throw new TypeError('Invalid cleanupChoice');
  const certificate = text(input, 'hostCaCertificatePem', 64 * 1024);
  if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----') || certificate.includes('PRIVATE KEY')) throw new TypeError('Invalid Host CA certificate');
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
    authorityReplay: authorityReplay(input.authorityReplay, schemaVersion),
    cleanupChoice,
    cleanupMarkerNonce: text(input, 'cleanupMarkerNonce', 43, CREDENTIAL),
    createdAt,
    hostCaCertificatePem: certificate,
    hostCaFingerprint: text(input, 'hostCaFingerprint', 64, FINGERPRINT),
    hostEndpoint: endpoint(input),
    idempotencyKey: opaqueId(input, 'idempotencyKey'),
    kind: 'pending-leave',
    localCleanupComplete: input.localCleanupComplete,
    localRole: input.localRole,
    memberCredential: text(input, 'memberCredential', 43, CREDENTIAL),
    memberId: memberId(input, 'memberId'),
    operationId: opaqueId(input, 'operationId'),
    phase,
    projectCreatedAt,
    projectName: text(input, 'projectName', 200),
    projectId: projectId(input),
    schemaVersion: COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
    updatedAt,
    workspacePath: workspace(input),
  };
}
