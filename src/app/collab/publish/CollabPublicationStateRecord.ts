import { type CollabGitOid, type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

export const COLLAB_PUBLICATION_STATE_SCHEMA_VERSION = 1 as const;

export type CollabPublicationOperationPhase =
  | 'captured'
  | 'review-ready'
  | 'confirmed'
  | 'applied'
  | 'pushed';

export interface CollabPublicationOperationRecord {
  readonly candidateOid: CollabGitOid | null;
  readonly confirmed: boolean;
  readonly contributionHeadOid: CollabGitOid;
  readonly createdAt: string;
  readonly currentMainOid: CollabGitOid | null;
  readonly operationId: CollabOperationId;
  readonly phase: CollabPublicationOperationPhase;
  readonly updatedAt: string;
}

export interface CollabPublicationStateRecord {
  readonly baseMainOid: CollabGitOid;
  readonly operation: CollabPublicationOperationRecord | null;
  readonly projectId: CollabProjectId;
  readonly schemaVersion: typeof COLLAB_PUBLICATION_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STATE_KEYS = new Set([
  'baseMainOid',
  'operation',
  'projectId',
  'schemaVersion',
  'updatedAt',
]);
const OPERATION_KEYS = new Set([
  'candidateOid',
  'confirmed',
  'contributionHeadOid',
  'createdAt',
  'currentMainOid',
  'operationId',
  'phase',
  'updatedAt',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, expected: ReadonlySet<string>): void {
  if (
    Object.keys(value).length !== expected.size
    || Object.keys(value).some(key => !expected.has(key))
  ) {
    throw new TypeError('Unexpected publication state field');
  }
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

function oidField(value: UnknownRecord, key: string): CollabGitOid {
  return stringField(value, key, 64, OID_PATTERN);
}

function nullableOidField(value: UnknownRecord, key: string): CollabGitOid | null {
  return value[key] === null ? null : oidField(value, key);
}

function phaseField(value: unknown): CollabPublicationOperationPhase {
  if (
    value !== 'captured'
    && value !== 'review-ready'
    && value !== 'confirmed'
    && value !== 'applied'
    && value !== 'pushed'
  ) {
    throw new TypeError('Invalid publication phase');
  }
  return value;
}

function decodeOperation(value: unknown): CollabPublicationOperationRecord | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError('Invalid publication operation');
  exactKeys(value, OPERATION_KEYS);
  const confirmed = value.confirmed;
  if (typeof confirmed !== 'boolean') throw new TypeError('Invalid confirmed state');
  const phase = phaseField(value.phase);
  const candidateOid = nullableOidField(value, 'candidateOid');
  const currentMainOid = nullableOidField(value, 'currentMainOid');
  if (
    ((phase === 'captured' || phase === 'review-ready') && confirmed)
    || ((phase === 'confirmed' || phase === 'applied' || phase === 'pushed') && !confirmed)
    || (phase === 'captured' && (candidateOid !== null || currentMainOid !== null))
    || (phase !== 'captured' && (candidateOid === null || currentMainOid === null))
  ) {
    throw new TypeError('Publication confirmation phase mismatch');
  }
  return {
    candidateOid,
    confirmed,
    contributionHeadOid: oidField(value, 'contributionHeadOid'),
    createdAt: timestampField(value, 'createdAt'),
    currentMainOid,
    operationId: stringField(value, 'operationId', 128, ID_PATTERN),
    phase,
    updatedAt: timestampField(value, 'updatedAt'),
  };
}

export function decodeCollabPublicationStateRecord(
  value: unknown,
): CollabPublicationStateRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLAB_PUBLICATION_STATE_SCHEMA_VERSION
  ) {
    throw new TypeError('Invalid publication state record');
  }
  exactKeys(value, STATE_KEYS);
  const operation = decodeOperation(value.operation);
  return {
    baseMainOid: oidField(value, 'baseMainOid'),
    operation,
    projectId: stringField(value, 'projectId', 64, ID_PATTERN),
    schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
    updatedAt: timestampField(value, 'updatedAt'),
  };
}
