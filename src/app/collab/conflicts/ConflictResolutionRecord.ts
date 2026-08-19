import { Buffer } from 'node:buffer';

import { type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { type CollabConflictDecision, type CollabConflictDescriptor, type CollabConflictEntry } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

export const COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION = 1 as const;

export type ConflictResolutionPhase =
  | 'planned'
  | 'ready'
  | 'committed';

export interface ConflictResolutionRecord {
  readonly createdAt: string;
  readonly decisions: readonly CollabConflictDecision[];
  readonly descriptor: CollabConflictDescriptor;
  readonly operationId: CollabOperationId;
  readonly phase: ConflictResolutionPhase;
  readonly projectId: CollabProjectId;
  readonly resultCommitOid: string | null;
  readonly schemaVersion: typeof COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION;
  readonly updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONFLICT_KINDS = new Set([
  'text',
  'binary',
  'delete-modify',
  'rename-delete',
  'directory-file',
  'portability',
]);
const pathPolicy = new CollabPathPolicy();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
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
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return field;
}

function timestampField(value: UnknownRecord, key: string): string {
  const field = stringField(value, key, 64);
  if (Number.isNaN(Date.parse(field)) || new Date(field).toISOString() !== field) {
    throw new TypeError(`Invalid ${key}`);
  }
  return field;
}

function oidField(value: UnknownRecord, key: string): string {
  return stringField(value, key, 64, OID_PATTERN);
}

function relativePathField(value: UnknownRecord, key: string): string {
  const field = stringField(value, key, CLAUDIAN_COLLAB_LIMITS.maxRepositoryPathUtf16);
  if (!pathPolicy.validateRepositoryPath(field).ok) {
    throw new TypeError(`Invalid ${key}`);
  }
  return field;
}

function optionalPathField(value: UnknownRecord, key: string): string | undefined {
  return value[key] === undefined ? undefined : relativePathField(value, key);
}

function optionalOidField(value: UnknownRecord, key: string): string | undefined {
  return value[key] === undefined ? undefined : oidField(value, key);
}

function decodeConflictEntry(value: unknown): CollabConflictEntry {
  if (!isRecord(value) || !CONFLICT_KINDS.has(value.kind as string)) {
    throw new TypeError('Invalid conflict entry');
  }
  const kind = value.kind as CollabConflictEntry['kind'];
  const personalPath = optionalPathField(value, 'personalPath');
  const acceptedPath = optionalPathField(value, 'acceptedPath');
  const baseOid = optionalOidField(value, 'baseOid');
  const personalOid = optionalOidField(value, 'personalOid');
  const acceptedOid = optionalOidField(value, 'acceptedOid');
  return {
    ...(acceptedOid ? { acceptedOid } : {}),
    ...(acceptedPath ? { acceptedPath } : {}),
    ...(baseOid ? { baseOid } : {}),
    kind,
    path: relativePathField(value, 'path'),
    ...(personalOid ? { personalOid } : {}),
    ...(personalPath ? { personalPath } : {}),
  };
}

function decodeDescriptor(value: unknown): CollabConflictDescriptor {
  if (!isRecord(value) || !Array.isArray(value.conflicts)) {
    throw new TypeError('Invalid conflict descriptor');
  }
  if (
    value.conflicts.length === 0
    || value.conflicts.length > CLAUDIAN_COLLAB_LIMITS.maxChangedPaths
  ) {
    throw new TypeError('Invalid conflict count');
  }
  const conflicts = value.conflicts.map(decodeConflictEntry);
  const paths = new Set(conflicts.map(conflict => conflict.path));
  if (paths.size !== conflicts.length) throw new TypeError('Duplicate conflict path');
  return {
    conflicts,
    mergeBaseOid: oidField(value, 'mergeBaseOid'),
    operationId: stringField(value, 'operationId', 128, SAFE_ID_PATTERN),
    projectId: stringField(value, 'projectId', 64, SAFE_ID_PATTERN),
    startingMainOid: oidField(value, 'startingMainOid'),
    startingPersonalOid: oidField(value, 'startingPersonalOid'),
  };
}

function decisionText(value: UnknownRecord, key: 'draft' | 'proposal'): string {
  const text = value[key];
  if (
    typeof text !== 'string'
    || Buffer.byteLength(text, 'utf8') > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return text;
}

function decodeDecision(value: unknown): CollabConflictDecision {
  if (!isRecord(value)) throw new TypeError('Invalid conflict decision');
  const path = relativePathField(value, 'path');
  if (value.choice === 'keep-personal' || value.choice === 'use-accepted') {
    return { choice: value.choice, path };
  }
  if (value.choice === 'use-manual-draft') {
    return { choice: value.choice, draft: decisionText(value, 'draft'), path };
  }
  if (value.choice === 'use-agent-proposal') {
    return { choice: value.choice, path, proposal: decisionText(value, 'proposal') };
  }
  throw new TypeError('Invalid conflict decision choice');
}

function resolutionPhase(value: unknown): ConflictResolutionPhase {
  if (
    value !== 'planned'
    && value !== 'ready'
    && value !== 'committed'
  ) {
    throw new TypeError('Invalid conflict phase');
  }
  return value;
}

export function decodeConflictResolutionRecord(value: unknown): ConflictResolutionRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION
    || !Array.isArray(value.decisions)
  ) {
    throw new TypeError('Invalid conflict resolution record');
  }
  const operationId = stringField(value, 'operationId', 128, SAFE_ID_PATTERN);
  const projectId = stringField(value, 'projectId', 64, SAFE_ID_PATTERN);
  const descriptor = decodeDescriptor(value.descriptor);
  if (descriptor.operationId !== operationId || descriptor.projectId !== projectId) {
    throw new TypeError('Conflict resolution identity mismatch');
  }
  const decisions = value.decisions.map(decodeDecision);
  const decisionPaths = new Set(decisions.map(decision => decision.path));
  const conflictPaths = new Set(descriptor.conflicts.map(conflict => conflict.path));
  if (
    decisionPaths.size !== decisions.length
    || decisions.some(decision => !conflictPaths.has(decision.path))
  ) {
    throw new TypeError('Invalid conflict decisions');
  }
  const phase = resolutionPhase(value.phase);
  const resultCommitOid = value.resultCommitOid === null
    ? null
    : oidField(value, 'resultCommitOid');
  if (
    phase === 'committed'
    && (resultCommitOid === null || decisions.length !== descriptor.conflicts.length)
  ) {
    throw new TypeError('Incomplete committed conflict resolution');
  }
  if ((phase === 'planned' || phase === 'ready') && resultCommitOid !== null) {
    throw new TypeError('Premature conflict result commit');
  }
  return {
    createdAt: timestampField(value, 'createdAt'),
    decisions,
    descriptor,
    operationId,
    phase,
    projectId,
    resultCommitOid,
    schemaVersion: COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
    updatedAt: timestampField(value, 'updatedAt'),
  };
}
