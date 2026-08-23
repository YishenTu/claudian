import { type CollabGitOid, type CollabOperationId, type CollabProjectId, isCollabGitOid, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

export const COLLAB_PUBLICATION_STATE_SCHEMA_VERSION = 1 as const;

export type CollabPublicationOperationPhase =
  | 'captured'
  | 'review-ready'
  | 'confirmed'
  | 'applied'
  | 'pushed';

interface CollabPublicationOperationCommon {
  readonly contributionHeadOid: CollabGitOid;
  readonly createdAt: string;
  readonly operationId: CollabOperationId;
  readonly updatedAt: string;
}

interface CollabCapturedPublicationOperationRecord
  extends CollabPublicationOperationCommon {
  readonly candidateOid: null;
  readonly currentMainOid: null;
  readonly phase: 'captured';
}

interface CollabPreparedPublicationOperationRecord
  extends CollabPublicationOperationCommon {
  readonly candidateOid: CollabGitOid;
  readonly currentMainOid: CollabGitOid;
  readonly phase: Exclude<CollabPublicationOperationPhase, 'captured'>;
}

export type CollabPublicationOperationRecord =
  | CollabCapturedPublicationOperationRecord
  | CollabPreparedPublicationOperationRecord;

export interface CollabPublicationStateRecord {
  readonly baseMainOid: CollabGitOid;
  readonly operation: CollabPublicationOperationRecord | null;
  readonly projectId: CollabProjectId;
  readonly schemaVersion: typeof COLLAB_PUBLICATION_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const STATE_KEYS = new Set([
  'baseMainOid',
  'operation',
  'projectId',
  'schemaVersion',
  'updatedAt',
]);
const OPERATION_KEYS = new Set([
  'candidateOid',
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
  const field = stringField(value, key, 64);
  if (!isCollabGitOid(field)) throw new TypeError(`Invalid ${key}`);
  return field;
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
  const phase = phaseField(value.phase);
  const candidateOid = nullableOidField(value, 'candidateOid');
  const currentMainOid = nullableOidField(value, 'currentMainOid');
  if (
    (phase === 'captured' && (candidateOid !== null || currentMainOid !== null))
    || (phase !== 'captured' && (candidateOid === null || currentMainOid === null))
  ) {
    throw new TypeError('Publication phase state mismatch');
  }
  const contributionHeadOid = oidField(value, 'contributionHeadOid');
  const createdAt = timestampField(value, 'createdAt');
  const operationId = stringField(value, 'operationId', 128);
  const updatedAt = timestampField(value, 'updatedAt');
  if (!isCollabOpaqueId(operationId)) throw new TypeError('Invalid operationId');
  return phase === 'captured'
    ? {
        candidateOid: null,
        contributionHeadOid,
        createdAt,
        currentMainOid: null,
        operationId,
        phase,
        updatedAt,
      }
    : {
        candidateOid: candidateOid!,
        contributionHeadOid,
        createdAt,
        currentMainOid: currentMainOid!,
        operationId,
        phase,
        updatedAt,
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
  const projectId = stringField(value, 'projectId', 64);
  if (!isCollabProjectId(projectId)) throw new TypeError('Invalid projectId');
  return {
    baseMainOid: oidField(value, 'baseMainOid'),
    operation,
    projectId,
    schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
    updatedAt: timestampField(value, 'updatedAt'),
  };
}
