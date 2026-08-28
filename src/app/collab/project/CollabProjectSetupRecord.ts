import { type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabGitOid, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import { parseCollabProjectsFolder } from '@/core/collab';
import { type InstallationKey, parseInstallationKey } from '@/core/device/InstallationKey';

export const COLLAB_PROJECT_SETUP_SCHEMA_VERSION = 3 as const;

export type CollabProjectSetupPhase =
  | 'planned'
  | 'staged'
  | 'committed'
  | 'clone-completed';

export interface CollabProjectSetupRecord {
  readonly schemaVersion: 2 | typeof COLLAB_PROJECT_SETUP_SCHEMA_VERSION;
  readonly ownerInstallationKey?: InstallationKey;
  readonly projectId: CollabProjectId;
  readonly operationId: CollabOperationId;
  readonly phase: CollabProjectSetupPhase;
  readonly name: string;
  readonly memberDisplayName: string;
  readonly memberId: CollabMemberId;
  readonly memberCredential: string;
  readonly projectsFolder: string;
  readonly slug: string;
  readonly seedDirectoryName: string;
  readonly cloneDirectoryName: string;
  readonly initialCommitOid: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Transient decoder flag; version-1 planned imports cannot be resumed as empty Projects. */
  readonly legacyImportPlanned?: true;
  /** Durable migration provenance retained until version-1 staging recovery completes. */
  readonly legacySetupRecord?: true;
}

type UnknownRecord = Record<string, unknown>;

const SAFE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

export function decodeCollabProjectSetupRecord(value: unknown): CollabProjectSetupRecord {
  if (
    !isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
  ) {
    throw new TypeError('Invalid Project setup record');
  }
  const legacy = value.schemaVersion === 1;
  if (
    value.schemaVersion !== COLLAB_PROJECT_SETUP_SCHEMA_VERSION
    && value.ownerInstallationKey !== undefined
  ) {
    throw new TypeError('Invalid Project setup owner');
  }
  const ownerInstallationKey = value.schemaVersion === COLLAB_PROJECT_SETUP_SCHEMA_VERSION
    ? parseInstallationKey(value.ownerInstallationKey)
    : undefined;
  const phase = value.phase;
  if (
    phase !== 'planned'
    && phase !== 'staged'
    && phase !== 'committed'
    && phase !== 'clone-completed'
  ) {
    throw new TypeError('Invalid setup phase');
  }
  if (legacy) {
    const sourcePaths: unknown = value.sourcePaths;
    if (!Array.isArray(sourcePaths) || !sourcePaths.every((entry: unknown): entry is string => (
      typeof entry === 'string' && entry.length > 0 && entry.length <= 240
    ))) {
      throw new TypeError('Invalid legacy setup source paths');
    }
  }
  const projectsFolder = legacy ? 'workspace' : value.projectsFolder;
  if (typeof projectsFolder !== 'string' || !parseCollabProjectsFolder(projectsFolder).ok) {
    throw new TypeError('Invalid Projects folder');
  }
  const initialCommitOid = value.initialCommitOid;
  if (initialCommitOid !== null && (
    !isCollabGitOid(initialCommitOid)
  )) {
    throw new TypeError('Invalid setup commit');
  }
  const projectId = stringField(value, 'projectId', 64);
  if (!isCollabProjectId(projectId)) throw new TypeError('Invalid projectId');
  const cloneDirectoryName = stringField(
    value,
    'cloneDirectoryName',
    120,
  );
  const seedDirectoryName = stringField(
    value,
    'seedDirectoryName',
    120,
  );
  if (
    cloneDirectoryName !== `.claudian-clone-${projectId}`
    || seedDirectoryName !== `.claudian-seed-${projectId}`
  ) {
    throw new TypeError('Invalid Project setup operation identity');
  }
  return {
    cloneDirectoryName,
    createdAt: timestampField(value, 'createdAt'),
    initialCommitOid,
    memberCredential: stringField(value, 'memberCredential', 43, CREDENTIAL_PATTERN),
    memberDisplayName: stringField(value, 'memberDisplayName', 200),
    memberId: (() => {
      const memberId = stringField(value, 'memberId', 64);
      if (!isCollabMemberId(memberId)) throw new TypeError('Invalid memberId');
      return memberId;
    })(),
    name: stringField(value, 'name', 200),
    operationId: (() => {
      const operationId = stringField(value, 'operationId', 128);
      if (!isCollabOpaqueId(operationId)) throw new TypeError('Invalid operationId');
      return operationId;
    })(),
    ...(ownerInstallationKey === undefined ? {} : { ownerInstallationKey }),
    phase,
    projectId,
    projectsFolder,
    schemaVersion: value.schemaVersion === COLLAB_PROJECT_SETUP_SCHEMA_VERSION
      ? COLLAB_PROJECT_SETUP_SCHEMA_VERSION
      : 2,
    seedDirectoryName,
    slug: stringField(value, 'slug', 64, SAFE_SLUG_PATTERN),
    updatedAt: timestampField(value, 'updatedAt'),
    ...(legacy || value.legacySetupRecord === true
      ? { legacySetupRecord: true as const }
      : {}),
    ...(legacy && phase === 'planned' ? { legacyImportPlanned: true as const } : {}),
  };
}

export function bindLegacyCollabProjectSetupOwner(
  record: CollabProjectSetupRecord,
  ownerInstallationKey: InstallationKey,
): CollabProjectSetupRecord {
  if (record.schemaVersion === COLLAB_PROJECT_SETUP_SCHEMA_VERSION) {
    if (record.ownerInstallationKey !== ownerInstallationKey) {
      throw new TypeError('Project setup owner changed');
    }
    return record;
  }
  return decodeCollabProjectSetupRecord({
    ...record,
    ownerInstallationKey,
    schemaVersion: COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
  });
}
