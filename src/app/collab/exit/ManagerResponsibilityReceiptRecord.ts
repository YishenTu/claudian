import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';
import { collabControlOperationCodec, type CollabManagerResponsibilityOffer, type TransitionManagerResponsibilityOfferRequest } from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CloudMembershipBinding } from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import type {
  CollabManagerResponsibilityOfferStatus,
  CollabManagerResponsibilityPurpose,
} from '@/core/collab';

export const COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION = 2 as const;

export interface LanManagerResponsibilityReceiptRecord {
  readonly schemaVersion: typeof COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION;
  readonly kind: 'manager-responsibility-receipt';
  readonly projectId: CollabProjectId;
  readonly offerId: CollabOperationId;
  readonly sourceManagerMemberId: CollabMemberId;
  readonly targetMemberId: CollabMemberId;
  readonly purpose: CollabManagerResponsibilityPurpose;
  readonly status: CollabManagerResponsibilityOfferStatus;
  readonly offeredAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly acknowledgedAt: CollabIsoTimestamp | null;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface CloudManagerResponsibilityReceiptRecord extends CloudMembershipBinding {
  readonly schemaVersion: 3;
  readonly kind: 'manager-responsibility-receipt';
  readonly offer: CollabManagerResponsibilityOffer;
  readonly operation: 'acknowledgeManagerResponsibility' | 'declineManagerResponsibility' | null;
  readonly request: TransitionManagerResponsibilityOfferRequest | null;
  readonly phase: 'prepared' | 'submitted' | 'settled';
  readonly updatedAt: CollabIsoTimestamp;
}

export type ManagerResponsibilityReceiptRecord = LanManagerResponsibilityReceiptRecord | CloudManagerResponsibilityReceiptRecord;
export type ManagerResponsibilityReceiptState = Pick<LanManagerResponsibilityReceiptRecord, 'offerId' | 'status'>;

export function managerResponsibilityReceiptState(record: ManagerResponsibilityReceiptState | CloudManagerResponsibilityReceiptRecord): ManagerResponsibilityReceiptState {
  return 'offer' in record ? { offerId: record.offer.offerId, status: record.offer.state } : record;
}

type Value = Readonly<Record<string, unknown>>;
const KEYS = new Set(['schemaVersion', 'kind', 'projectId', 'offerId', 'sourceManagerMemberId', 'targetMemberId', 'purpose', 'status', 'offeredAt', 'expiresAt', 'acknowledgedAt', 'updatedAt']);
const STATUSES = new Set(['offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired']);
function input(value: unknown): Value {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Manager receipt');
  const result = value as Value;
  if (Object.keys(result).length !== KEYS.size || Object.keys(result).some(key => !KEYS.has(key))) throw new TypeError('Unexpected Manager receipt field');
  return result;
}
function id(
  value: Value,
  key: string,
  predicate: (candidate: unknown) => candidate is string,
): string {
  const field = value[key];
  if (!predicate(field)) throw new TypeError(`Invalid ${key}`);
  return field;
}
function time(value: Value, key: string, nullable = false): string | null {
  if (nullable && value[key] === null) return null;
  const field = value[key];
  if (typeof field !== 'string' || field.length > 64 || !Number.isFinite(Date.parse(field)) || new Date(field).toISOString() !== field) throw new TypeError(`Invalid ${key}`);
  return field;
}
export function decodeManagerResponsibilityReceiptRecord(value: unknown): ManagerResponsibilityReceiptRecord {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 3) {
    return decodeCloudManagerResponsibilityReceiptRecord(value);
  }
  const record = input(value);
  const schemaVersion = record.schemaVersion;
  if (
    (schemaVersion !== 1
      && schemaVersion !== COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION)
    || record.kind !== 'manager-responsibility-receipt'
  ) throw new TypeError('Invalid Manager receipt');
  const persistedPurpose = record.purpose;
  const purpose = schemaVersion === 1 && persistedPurpose === 'manager-transfer'
    ? 'manager-promotion'
    : persistedPurpose;
  const status = record.status;
  if (
    (schemaVersion === 1
      ? persistedPurpose !== 'manager-transfer' && persistedPurpose !== 'manager-leave'
      : purpose !== 'manager-promotion' && purpose !== 'manager-leave')
    || typeof status !== 'string'
    || !STATUSES.has(status)
  ) throw new TypeError('Invalid Manager receipt state');
  const offeredAt = time(record, 'offeredAt')!;
  const expiresAt = time(record, 'expiresAt')!;
  const acknowledgedAt = time(record, 'acknowledgedAt', true);
  const updatedAt = time(record, 'updatedAt')!;
  if (expiresAt <= offeredAt || updatedAt < offeredAt || ((status === 'acknowledged' || status === 'consumed') !== (acknowledgedAt !== null)) || (acknowledgedAt !== null && (acknowledgedAt < offeredAt || acknowledgedAt > expiresAt))) throw new TypeError('Impossible Manager receipt state');
  return {
    acknowledgedAt,
    expiresAt,
    kind: 'manager-responsibility-receipt',
    offerId: id(record, 'offerId', isCollabOpaqueId),
    offeredAt,
    projectId: id(record, 'projectId', isCollabProjectId),
    purpose: purpose as CollabManagerResponsibilityPurpose,
    schemaVersion: COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION,
    sourceManagerMemberId: id(record, 'sourceManagerMemberId', isCollabMemberId),
    status: status as CollabManagerResponsibilityOfferStatus,
    targetMemberId: id(record, 'targetMemberId', isCollabMemberId),
    updatedAt,
  };
}

export function decodeCloudManagerResponsibilityReceiptRecord(value: unknown): CloudManagerResponsibilityReceiptRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Cloud Manager receipt');
  const record = value as Value;
  const keys = ['schemaVersion', 'kind', 'projectId', 'memberId', 'serverUrl', 'authorityGeneration', 'offer', 'operation', 'request', 'phase', 'updatedAt'];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))
    || record.schemaVersion !== 3 || record.kind !== 'manager-responsibility-receipt'
    || (record.phase !== 'prepared' && record.phase !== 'submitted' && record.phase !== 'settled')
    || (record.operation !== null && record.operation !== 'acknowledgeManagerResponsibility' && record.operation !== 'declineManagerResponsibility')
    || typeof record.authorityGeneration !== 'number' || !Number.isSafeInteger(record.authorityGeneration) || record.authorityGeneration < 1
    || typeof record.serverUrl !== 'string') throw new TypeError('Invalid Cloud Manager receipt identity');
  const projectId = id(record, 'projectId', isCollabProjectId);
  const memberId = id(record, 'memberId', isCollabMemberId);
  const { offer } = collabControlOperationCodec('getManagerResponsibilityOffer').decodeResponse({ offer: record.offer });
  const request = record.operation === null ? null : collabControlOperationCodec(record.operation).decodeRequest(record.request);
  const settledState = record.operation === 'declineManagerResponsibility'
    ? 'declined'
    : 'acknowledged';
  if ((record.operation === null && record.request !== null)
    || offer.targetMemberId !== memberId || (record.phase !== 'settled' && (request === null || offer.state !== 'offered'))
    || (record.phase === 'settled' && offer.state !== settledState)
    || (request === null && offer.state === 'offered')) throw new TypeError('Invalid Cloud Manager receipt state');
  if (request && (request.status !== 'ok' || request.value.projectId !== projectId || request.value.offerId !== offer.offerId
    || (record.phase !== 'settled' ? request.value.expectedOfferRevision !== offer.revision : request.value.expectedOfferRevision > offer.revision))) {
    throw new TypeError('Invalid Cloud Manager receipt request');
  }
  const updatedAt = time(record, 'updatedAt')!;
  if (updatedAt < offer.offeredAt) throw new TypeError('Invalid Cloud Manager receipt time');
  return {
    schemaVersion: 3, kind: 'manager-responsibility-receipt', projectId, memberId,
    serverUrl: validateCloudServerUrl(record.serverUrl, 'serverUrl'), authorityGeneration: record.authorityGeneration,
    offer, operation: record.operation, request: request?.status === 'ok' ? request.value : null, phase: record.phase, updatedAt,
  };
}
