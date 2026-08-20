import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import type {
  CollabManagerResponsibilityOfferStatus,
  CollabManagerResponsibilityPurpose,
} from '@/core/collab';

export const COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION = 2 as const;

export interface ManagerResponsibilityReceiptRecord {
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
