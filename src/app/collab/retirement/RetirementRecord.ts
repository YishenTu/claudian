import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import { canonicalCloudOrigin } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabLocalCleanupStatus } from '@/core/collab';

export const COLLAB_RETIREMENT_RECORD_SCHEMA_VERSION = 1 as const;
export type RetirementAcknowledgementStatus = 'pending' | 'acknowledged' | 'expired';
export interface RetirementRecord {
  readonly schemaVersion: typeof COLLAB_RETIREMENT_RECORD_SCHEMA_VERSION;
  readonly kind: 'retirement';
  readonly projectId: CollabProjectId;
  readonly memberId: CollabMemberId;
  readonly retiredAt: CollabIsoTimestamp;
  readonly cleanupOperationId: CollabOperationId;
  readonly cleanupStatus: CollabLocalCleanupStatus;
  readonly acknowledgementStatus: RetirementAcknowledgementStatus;
  readonly acknowledgedAt: CollabIsoTimestamp | null;
  readonly cloudDevelopmentActorId: string | null;
  readonly cloudRetirementId: CollabOperationId | null;
  readonly cloudServerUrl: string | null;
  readonly memberCredential: string | null;
  readonly hostEndpoint: string | null;
  readonly hostCaCertificatePem: string | null;
  readonly hostCaFingerprint: string | null;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}
type Value = Readonly<Record<string, unknown>>;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DEVELOPMENT_ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY_KEYS = new Set(['schemaVersion', 'kind', 'projectId', 'memberId', 'retiredAt', 'cleanupOperationId', 'cleanupStatus', 'acknowledgementStatus', 'acknowledgedAt', 'memberCredential', 'hostEndpoint', 'hostCaCertificatePem', 'hostCaFingerprint', 'createdAt', 'updatedAt']);
const KEYS = new Set([
  ...LEGACY_KEYS,
  'cloudDevelopmentActorId',
  'cloudRetirementId',
  'cloudServerUrl',
]);
function field(value: Value, key: string, max: number, pattern?: RegExp): string {
  const result = value[key];
  if (typeof result !== 'string' || !result || result.length > max || (pattern && !pattern.test(result))) throw new TypeError(`Invalid ${key}`);
  return result;
}
function nullable(value: Value, key: string, max: number, pattern?: RegExp): string | null {
  return value[key] === null ? null : field(value, key, max, pattern);
}
function timestamp(value: Value, key: string, nullableValue = false): string | null {
  if (nullableValue && value[key] === null) return null;
  const result = field(value, key, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new TypeError(`Invalid ${key}`);
  return result;
}
export function decodeRetirementRecord(value: unknown): RetirementRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid retirement record');
  const record = value as Value;
  const recordKeys = Object.keys(record);
  const currentShape = recordKeys.length === KEYS.size
    && recordKeys.every(key => KEYS.has(key));
  const legacyShape = recordKeys.length === LEGACY_KEYS.size
    && recordKeys.every(key => LEGACY_KEYS.has(key));
  if ((!currentShape && !legacyShape) || record.schemaVersion !== 1 || record.kind !== 'retirement') throw new TypeError('Invalid retirement record');
  const cleanupStatus = record.cleanupStatus;
  const acknowledgementStatus = record.acknowledgementStatus;
  if ((cleanupStatus !== 'pending' && cleanupStatus !== 'running' && cleanupStatus !== 'failed' && cleanupStatus !== 'complete') || (acknowledgementStatus !== 'pending' && acknowledgementStatus !== 'acknowledged' && acknowledgementStatus !== 'expired')) throw new TypeError('Invalid retirement state');
  const acknowledgedAt = timestamp(record, 'acknowledgedAt', true);
  const cloudDevelopmentActorId = legacyShape
    ? null
    : nullable(record, 'cloudDevelopmentActorId', 128, DEVELOPMENT_ACTOR);
  const cloudRetirementId = legacyShape
    ? null
    : nullable(record, 'cloudRetirementId', 128);
  const cloudServerUrl = legacyShape ? null : nullable(record, 'cloudServerUrl', 2_048);
  const memberCredential = nullable(record, 'memberCredential', 43, CREDENTIAL);
  const hostEndpoint = nullable(record, 'hostEndpoint', 2_048);
  const hostCaCertificatePem = nullable(record, 'hostCaCertificatePem', 64 * 1024);
  const hostCaFingerprint = nullable(record, 'hostCaFingerprint', 64, DIGEST);
  if (hostEndpoint !== null) {
    try {
      const parsed = new URL(hostEndpoint);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    } catch { throw new TypeError('Invalid hostEndpoint'); }
  }
  if (cloudServerUrl !== null) {
    try {
      canonicalCloudOrigin(cloudServerUrl, 'cloudServerUrl');
    } catch { throw new TypeError('Invalid cloudServerUrl'); }
  }
  const pending = acknowledgementStatus === 'pending';
  const lanAcknowledgement = memberCredential !== null
    && hostEndpoint !== null
    && hostCaCertificatePem !== null
    && hostCaFingerprint !== null;
  const cloudAcknowledgement = cloudDevelopmentActorId !== null
    && cloudRetirementId !== null
    && cloudServerUrl !== null;
  if (
    (acknowledgementStatus === 'acknowledged') !== (acknowledgedAt !== null)
    || (pending && lanAcknowledgement === cloudAcknowledgement)
    || (!pending && (lanAcknowledgement || cloudAcknowledgement))
    || (!lanAcknowledgement && (
      memberCredential !== null
      || hostEndpoint !== null
      || hostCaCertificatePem !== null
      || hostCaFingerprint !== null
    ))
    || (!cloudAcknowledgement && (
      cloudDevelopmentActorId !== null
      || cloudRetirementId !== null
      || cloudServerUrl !== null
    ))
  ) throw new TypeError('Impossible retirement acknowledgement state');
  if (hostCaCertificatePem !== null && (!hostCaCertificatePem.includes('-----BEGIN CERTIFICATE-----') || !hostCaCertificatePem.includes('-----END CERTIFICATE-----') || hostCaCertificatePem.includes('PRIVATE KEY'))) throw new TypeError('Invalid Host CA certificate');
  const retiredAt = timestamp(record, 'retiredAt')!;
  const createdAt = timestamp(record, 'createdAt')!;
  const updatedAt = timestamp(record, 'updatedAt')!;
  if (createdAt < retiredAt || updatedAt < createdAt || (acknowledgedAt !== null && acknowledgedAt < retiredAt)) throw new TypeError('Invalid retirement timestamps');
  const cleanupOperationId = field(record, 'cleanupOperationId', 128);
  const memberId = field(record, 'memberId', 64);
  const projectId = field(record, 'projectId', 64);
  if (
    !isCollabOpaqueId(cleanupOperationId)
    || (cloudRetirementId !== null && !isCollabOpaqueId(cloudRetirementId))
    || !isCollabMemberId(memberId)
    || !isCollabProjectId(projectId)
  ) throw new TypeError('Invalid retirement identity');
  return {
    acknowledgedAt,
    acknowledgementStatus,
    cleanupOperationId,
    cleanupStatus,
    cloudDevelopmentActorId,
    cloudRetirementId,
    cloudServerUrl,
    createdAt,
    hostCaCertificatePem,
    hostCaFingerprint,
    hostEndpoint,
    kind: 'retirement',
    memberCredential,
    memberId,
    projectId,
    retiredAt,
    schemaVersion: 1,
    updatedAt,
  };
}
