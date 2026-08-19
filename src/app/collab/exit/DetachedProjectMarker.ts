import type { CollabIsoTimestamp, CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian/collab-protocol';

import type { LocalCleanupPurpose } from './LocalCleanupRecord';

export const COLLAB_DETACHED_PROJECT_MARKER_SCHEMA_VERSION = 1 as const;
export interface DetachedProjectMarker {
  readonly schemaVersion: typeof COLLAB_DETACHED_PROJECT_MARKER_SCHEMA_VERSION;
  readonly projectId: CollabProjectId;
  readonly memberId: CollabMemberId;
  readonly cleanupOperationId: CollabOperationId;
  readonly purpose: LocalCleanupPurpose;
  readonly createdAt: CollabIsoTimestamp;
  readonly nonce: string;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const KEYS = new Set(['schemaVersion', 'projectId', 'memberId', 'cleanupOperationId', 'purpose', 'createdAt', 'nonce']);
export function decodeDetachedProjectMarker(value: unknown): DetachedProjectMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid detached Project marker');
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).length !== KEYS.size || Object.keys(record).some(key => !KEYS.has(key)) || record.schemaVersion !== 1) throw new TypeError('Invalid detached Project marker');
  const get = (key: string, max: number, pattern: RegExp): string => {
    const field = record[key];
    if (typeof field !== 'string' || !field || field.length > max || !pattern.test(field)) throw new TypeError(`Invalid ${key}`);
    return field;
  };
  const createdAt = get('createdAt', 64, /^\d{4}-\d{2}-\d{2}T/);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new TypeError('Invalid createdAt');
  if (record.purpose !== 'leave' && record.purpose !== 'retire') throw new TypeError('Invalid purpose');
  return {
    cleanupOperationId: get('cleanupOperationId', 128, ID),
    createdAt,
    memberId: get('memberId', 64, ID),
    nonce: get('nonce', 43, NONCE),
    projectId: get('projectId', 64, ID),
    purpose: record.purpose,
    schemaVersion: 1,
  };
}
