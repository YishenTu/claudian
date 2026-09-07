import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import type { CollabLocalCleanupChoice } from '@/core/collab';
import { parseCollabProjectsFolder } from '@/core/collab';

export const COLLAB_LOCAL_CLEANUP_SCHEMA_VERSION = 1 as const;
export type LocalCleanupPurpose = 'leave' | 'retire';
export type LocalCleanupPhase =
  | 'planned'
  | 'marked'
  | 'git-detaching'
  | 'detached'
  | 'marker-removing'
  | 'deleting'
  | 'choice-applied'
  | 'complete'
  | 'failed';
export interface LocalCleanupRecord {
  readonly schemaVersion: typeof COLLAB_LOCAL_CLEANUP_SCHEMA_VERSION;
  readonly kind: 'local-cleanup';
  readonly projectId: CollabProjectId;
  readonly memberId: CollabMemberId;
  readonly operationId: CollabOperationId;
  readonly workspacePath: string;
  readonly choice: CollabLocalCleanupChoice;
  readonly purpose: LocalCleanupPurpose;
  readonly phase: LocalCleanupPhase;
  readonly markerNonce: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}
type Value = Readonly<Record<string, unknown>>;
const WORKSPACE_CHILD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const KEYS = new Set(['schemaVersion', 'kind', 'projectId', 'memberId', 'operationId', 'workspacePath', 'choice', 'purpose', 'phase', 'markerNonce', 'createdAt', 'updatedAt']);
function text(value: Value, key: string, max: number, pattern?: RegExp): string {
  const result = value[key];
  if (typeof result !== 'string' || !result || result.length > max || (pattern && !pattern.test(result))) throw new TypeError(`Invalid ${key}`);
  return result;
}
function time(value: Value, key: string): string {
  const result = text(value, key, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new TypeError(`Invalid ${key}`);
  return result;
}
function workspace(value: Value): string {
  const result = text(value, 'workspacePath', 240);
  const split = result.lastIndexOf('/');
  if (split <= 0 || !parseCollabProjectsFolder(result.slice(0, split)).ok || !WORKSPACE_CHILD_PATTERN.test(result.slice(split + 1))) throw new TypeError('Invalid workspacePath');
  return result;
}
export function decodeLocalCleanupRecord(value: unknown): LocalCleanupRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid local cleanup record');
  const record = value as Value;
  if (Object.keys(record).length !== KEYS.size || Object.keys(record).some(key => !KEYS.has(key)) || record.schemaVersion !== 1 || record.kind !== 'local-cleanup') throw new TypeError('Invalid local cleanup record');
  const choice = record.choice;
  const purpose = record.purpose;
  const phase = record.phase;
  if (
    (choice !== 'keep-files' && choice !== 'delete-files')
    || (purpose !== 'leave' && purpose !== 'retire')
    || (
      phase !== 'planned'
      && phase !== 'marked'
      && phase !== 'git-detaching'
      && phase !== 'detached'
      && phase !== 'marker-removing'
      && phase !== 'deleting'
      && phase !== 'choice-applied'
      && phase !== 'complete'
      && phase !== 'failed'
    )
  ) throw new TypeError('Invalid local cleanup state');
  const createdAt = time(record, 'createdAt');
  const updatedAt = time(record, 'updatedAt');
  if (updatedAt < createdAt) throw new TypeError('Invalid local cleanup timestamps');
  const memberId = text(record, 'memberId', 64);
  const operationId = text(record, 'operationId', 128);
  const projectId = text(record, 'projectId', 64);
  if (
    !isCollabMemberId(memberId)
    || !isCollabOpaqueId(operationId)
    || !isCollabProjectId(projectId)
  ) throw new TypeError('Invalid local cleanup identity');
  return {
    choice,
    createdAt,
    kind: 'local-cleanup',
    markerNonce: text(record, 'markerNonce', 43, NONCE),
    memberId,
    operationId,
    phase,
    projectId,
    purpose,
    schemaVersion: 1,
    updatedAt,
    workspacePath: workspace(record),
  };
}
