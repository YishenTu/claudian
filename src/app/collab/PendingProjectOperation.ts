import {
  decodeJoinProjectRecord,
  type JoinProjectRecord,
} from '@/app/collab/join/JoinProjectRecord';
import { type CloudProjectEntryRecord, decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import {
  type CollabProjectSetupRecord,
  decodeCollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';
import {
  type CloudRelocationRecord,
  decodeCloudRelocationRecord,
} from '@/app/collab/reconnect/CloudRelocationRecord';

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CollabPendingProjectOperation =
  | {
    readonly kind: 'cloud-relocation';
    readonly projectId: string;
    readonly record: CloudRelocationRecord;
    readonly schemaVersion: number;
  }
  | {
    readonly kind: 'cloud-entry';
    readonly projectId: string;
    readonly record: CloudProjectEntryRecord;
    readonly schemaVersion: number;
  }
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
  if (isRecord(value) && value.operationKind === 'cloud-relocation') {
    const record = decodeCloudRelocationRecord(value);
    return {
      kind: 'cloud-relocation',
      projectId: record.projectId,
      record,
      schemaVersion: record.schemaVersion,
    };
  }
  if (isRecord(value) && (value.operationKind === 'cloud-create-project' || value.operationKind === 'cloud-join-project' || value.operationKind === 'cloud-existing-project')) {
    const record = decodeCloudProjectEntryRecord(value);
    return { kind: 'cloud-entry', projectId: record.projectId, record, schemaVersion: record.schemaVersion };
  }
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
