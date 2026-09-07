import {
  decodeJoinProjectRecord,
  type JoinProjectRecord,
} from '@/app/collab/join/JoinProjectRecord';
import {
  type CollabProjectSetupRecord,
  decodeCollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CollabPendingProjectOperation =
  | {
    readonly kind: 'create-project';
    readonly projectId: string;
    readonly record: CollabProjectSetupRecord;
    readonly schemaVersion: number;
  }
  | {
    readonly kind: 'join-project';
    readonly projectId: string;
    readonly record: JoinProjectRecord;
    readonly schemaVersion: number;
  };

export function decodeCollabPendingProjectOperation(
  value: unknown,
): CollabPendingProjectOperation {
  if (isRecord(value) && value.operationKind === 'join-project') {
    const record = decodeJoinProjectRecord(value);
    return {
      kind: 'join-project',
      projectId: record.projectId,
      record,
      schemaVersion: record.schemaVersion,
    };
  }
  const record = decodeCollabProjectSetupRecord(value);
  return {
    kind: 'create-project',
    projectId: record.projectId,
    record,
    schemaVersion: record.schemaVersion,
  };
}
