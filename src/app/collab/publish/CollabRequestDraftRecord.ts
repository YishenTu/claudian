import { type CollabGitOid, type CollabProjectId, type CollabRequestId, isCollabGitOid, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

export const COLLAB_REQUEST_DRAFT_SCHEMA_VERSION = 1 as const;

export type CollabRequestDraftSyncState = 'local' | 'syncing' | 'needs-attention';

export interface CollabRequestDraftRecord {
  readonly baseRequestRevision?: number;
  readonly createdAt: string;
  readonly description: string;
  readonly projectId: CollabProjectId;
  readonly requestId?: CollabRequestId;
  readonly schemaVersion: typeof COLLAB_REQUEST_DRAFT_SCHEMA_VERSION;
  readonly syncState: CollabRequestDraftSyncState;
  readonly targetHeadOid?: CollabGitOid;
  readonly updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const KEYS = new Set([
  'baseRequestRevision',
  'createdAt',
  'description',
  'projectId',
  'requestId',
  'schemaVersion',
  'syncState',
  'targetHeadOid',
  'updatedAt',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: UnknownRecord,
  key: string,
  maxLength: number,
  pattern?: RegExp,
): string {
  const field = value[key];
  if (
    typeof field !== 'string'
    || field.length === 0
    || field.length > maxLength
    || (pattern && !pattern.test(field))
  ) throw new TypeError(`Invalid ${key}`);
  return field;
}

function timestamp(value: UnknownRecord, key: string): string {
  const field = requiredString(value, key, 64);
  if (Number.isNaN(Date.parse(field)) || new Date(field).toISOString() !== field) {
    throw new TypeError(`Invalid ${key}`);
  }
  return field;
}

export function decodeCollabRequestDraftRecord(value: unknown): CollabRequestDraftRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLAB_REQUEST_DRAFT_SCHEMA_VERSION
    || Object.keys(value).some(key => !KEYS.has(key))
  ) throw new TypeError('Invalid request draft');
  const description = requiredString(
    value,
    'description',
    CLAUDIAN_COLLAB_LIMITS.maxRequestDescriptionBytes,
  );
  if (
    description.trim().length === 0
    || new TextEncoder().encode(description).byteLength
      > CLAUDIAN_COLLAB_LIMITS.maxRequestDescriptionBytes
  ) throw new TypeError('Invalid description');
  const baseRequestRevision = value.baseRequestRevision;
  if (
    baseRequestRevision !== undefined
    && (!Number.isSafeInteger(baseRequestRevision) || Number(baseRequestRevision) < 0)
  ) throw new TypeError('Invalid baseRequestRevision');
  const syncState = value.syncState;
  if (
    syncState !== 'local'
    && syncState !== 'syncing'
    && syncState !== 'needs-attention'
  ) throw new TypeError('Invalid syncState');
  const projectId = requiredString(value, 'projectId', 64);
  const requestId = value.requestId === undefined
    ? undefined
    : requiredString(value, 'requestId', 128);
  const targetHeadOid = value.targetHeadOid === undefined
    ? undefined
    : requiredString(value, 'targetHeadOid', 64);
  if (
    !isCollabProjectId(projectId)
    || (requestId !== undefined && !isCollabOpaqueId(requestId))
    || (targetHeadOid !== undefined && !isCollabGitOid(targetHeadOid))
  ) throw new TypeError('Invalid request draft identity');
  return {
    ...(baseRequestRevision === undefined
      ? {}
      : { baseRequestRevision: Number(baseRequestRevision) }),
    createdAt: timestamp(value, 'createdAt'),
    description,
    projectId,
    ...(value.requestId === undefined
      ? {}
      : { requestId }),
    schemaVersion: COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
    syncState,
    ...(value.targetHeadOid === undefined
      ? {}
      : { targetHeadOid }),
    updatedAt: timestamp(value, 'updatedAt'),
  };
}
