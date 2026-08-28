import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises';

import { COLLAB_CLOUD_BINDING_VERSION, COLLAB_PROTOCOL_VERSION, type CollabIsoTimestamp, type CollabMemberId, collabMemberRef, type CollabProjectId, type CollabRole, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import {
  decodeAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type AuthorityTransferClaimantStore,
  decodeAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  decodeAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  decodeAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
import type {
  AuthorityTransferClaimCommitmentStorePort,
  AuthorityTransferClaimCustodyStorePort,
  AuthorityTransferProjectCatalog,
  AuthorityTransferRecordStorePort,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistenceStores';
import {
  type CollabFilesystemDiagnosticSink,
  ensureCollabContainerGuard,
  ensureCollabVaultDirectory,
  removeCollabDirectoryDurably,
  removeCollabFileDurably,
  resolveCollabVaultPath,
  syncCollabVaultDirectoryDurably,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  decodeLocalCleanupRecord,
  type LocalCleanupRecord,
} from '@/app/collab/exit/LocalCleanupRecord';
import type { LocalCleanupRecordPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import type {
  HostTransferRecoveryStorePort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  decodeHostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import {
  canonicalCloudOrigin,
  canonicalCloudUrl,
  cloudProjectGitRemoteUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';
import {
  decodeRetirementRecord,
  type RetirementRecord,
} from '@/app/collab/retirement/RetirementRecord';
import {
  decodeRetirementTombstoneRecord,
  type RetirementTombstoneRecord,
} from '@/app/collab/retirement/RetirementTombstoneRecord';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabAuthorityKind } from '@/core/collab';
import { type CollabLocalCleanupStatus, type CollabProjectLifecycle, parseCollabProjectsFolder } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  type InstallationKey,
  isInstallationKey,
  parseInstallationKey,
} from '@/core/device/InstallationKey';

const PRIVATE_STATE_DIRECTORY = '.claudian/collab';
const RETIREMENT_ACKNOWLEDGEMENT_DIRECTORY = `${PRIVATE_STATE_DIRECTORY}/retirement-acknowledgements`;
const AUTHORITY_OWNERSHIP_MARKER = '.claudian-authority.json';
const LEGACY_AUTHORITY_OWNERSHIP_SCHEMA_VERSION = 1 as const;
const AUTHORITY_OWNERSHIP_SCHEMA_VERSION = 2 as const;
const AUTHORITY_OWNERSHIP_MARKER_MAX_BYTES = 1_024;
const LEGACY_AUTHORITY_ROOT_ENTRIES = new Set([
  'collab.db',
  'collab.db.bak',
  'collab.db.tmp',
  'repository.git',
]);
const PROJECT_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MEMBER_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^(?:[A-Fa-f0-9]{64}|(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})$/;

export interface CollabLocalProjectIndexEntry {
  readonly id: CollabProjectId;
  readonly name: string;
  readonly lifecycle?: CollabProjectLifecycle;
  readonly cleanupStatus?: CollabLocalCleanupStatus;
  readonly retiredAt?: CollabIsoTimestamp;
  readonly workspacePath: string;
  readonly authorityKind: CollabAuthorityKind;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface CollabLocalProjectIndex {
  readonly schemaVersion: typeof COLLAB_LOCAL_PROJECT_SCHEMA_VERSION;
  readonly selectedProjectId: CollabProjectId | null;
  readonly projects: readonly CollabLocalProjectIndexEntry[];
}

export type CollabRetiredProjectProjectionSeed = Pick<
  CollabLocalProjectIndexEntry,
  'authorityKind' | 'createdAt' | 'name' | 'workspacePath'
>;

interface CollabLocalMembershipRecordBase {
  readonly schemaVersion: typeof COLLAB_LOCAL_PROJECT_SCHEMA_VERSION;
  readonly project: {
    readonly id: CollabProjectId;
    readonly name: string;
    readonly workspacePath: string;
  };
  readonly member: {
    readonly id: CollabMemberId;
    readonly displayName: string;
    readonly role: CollabRole;
    readonly personalRef: string;
  };
  readonly lifecycle?: 'active' | 'leaving';
  readonly lastEventSequence: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface CollabLocalLanMembershipRecord
  extends CollabLocalMembershipRecordBase {
  readonly authority: {
    readonly kind: 'lan';
    readonly endpoint: string | null;
    readonly gitRemoteUrl: string | null;
    readonly hostCaCertificatePem: string | null;
    readonly hostCaFingerprint: string | null;
  };
  readonly member: {
    readonly id: CollabMemberId;
    readonly displayName: string;
    readonly role: CollabRole;
    readonly personalRef: string;
    readonly credential: string;
  };
  readonly hostOwnership: {
    readonly autoStart?: boolean;
    readonly ownsAuthority: boolean;
  };
}

export interface CollabLocalCloudMembershipRecord
  extends CollabLocalMembershipRecordBase {
  readonly authority: {
    readonly authorityGeneration?: number;
    readonly bindingVersion: typeof COLLAB_CLOUD_BINDING_VERSION;
    readonly developmentActorId: CollabMemberId;
    readonly gitRemoteUrl: string;
    readonly kind: 'cloud';
    readonly serverUrl: string;
    readonly wireVersion: typeof COLLAB_PROTOCOL_VERSION;
  };
}

export type CollabLocalMembershipRecord =
  | CollabLocalLanMembershipRecord
  | CollabLocalCloudMembershipRecord;

export function isCollabLocalLanMembership(
  membership: CollabLocalMembershipRecord,
): membership is CollabLocalLanMembershipRecord {
  return membership.authority?.kind === 'lan';
}

export function isCollabLocalCloudMembership(
  membership: CollabLocalMembershipRecord,
): membership is CollabLocalCloudMembershipRecord {
  return membership.authority?.kind === 'cloud';
}

export interface CollabLocalProjectPaths {
  readonly membership: string;
  readonly cache: string;
  readonly pendingOperation: string;
  readonly publicationState: string;
  readonly requestDraft: string;
  readonly authorityDirectory: string;
  readonly conflictDirectory: string;
  readonly hostTransferRecovery: string;
  readonly authorityTransfer: string;
  readonly authorityTransferClaimCommitment: string;
  readonly authorityTransferClaims: string;
  readonly authorityTransferClaimant: string;
  readonly localCleanup: string;
  readonly managerResponsibilityReceipt: string;
  readonly retirement: string;
}

export type CollabLocalProjectDocumentKind =
  | 'authority-transfer-claimant'
  | 'cache'
  | 'pending-operation'
  | 'publication-state'
  | 'request-draft';

export type CollabLifecycleProjectDocumentKind =
  | 'manager-responsibility-receipt'
  | 'local-cleanup'
  | 'host-transfer-recovery'
  | 'authority-transfer'
  | 'authority-transfer-claim-commitment'
  | 'authority-transfer-claims'
  | 'retirement';

export interface CollabLocalProjectDocumentBase {
  readonly schemaVersion: number;
  readonly projectId: CollabProjectId;
}

export interface CollabLocalProjectRepositoryOptions {
  readonly installationKey?: InstallationKey;
  readonly now?: () => Date;
  readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
}

export type CollabAuthorityInstallationStatus =
  | 'absent'
  | 'hosted-here'
  | 'hosted-elsewhere'
  | 'legacy-unbound';

export interface OwnedAuthorityDirectoryCapability {
  readonly authorityDirectory: string;
  readonly projectId: CollabProjectId;
}

export interface ProvisionalAuthorityDirectoryCapability {
  readonly authorityDirectory: string;
  readonly projectId: CollabProjectId;
}

interface LegacyAuthorityOwnershipMarker {
  readonly projectId: CollabProjectId;
  readonly schemaVersion: typeof LEGACY_AUTHORITY_OWNERSHIP_SCHEMA_VERSION;
}

interface AuthorityOwnershipMarker {
  readonly ownerInstallationKey: InstallationKey;
  readonly projectId: CollabProjectId;
  readonly schemaVersion: typeof AUTHORITY_OWNERSHIP_SCHEMA_VERSION;
}

type AnyAuthorityOwnershipMarker =
  | LegacyAuthorityOwnershipMarker
  | AuthorityOwnershipMarker;

interface DecodeResult<T> {
  readonly value: T;
  readonly migrated: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorityTransferLifecycleKind(
  kind: CollabLifecycleProjectDocumentKind,
): kind is 'authority-transfer' | 'authority-transfer-claim-commitment' | 'authority-transfer-claims' {
  return kind === 'authority-transfer'
    || kind === 'authority-transfer-claim-commitment'
    || kind === 'authority-transfer-claims';
}

function requireExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new TypeError('Unexpected record field');
  }
}

function localRecordError(
  reason: string,
  recordKind: CollabLocalProjectDocumentKind | 'index' | 'membership' | CollabLifecycleProjectDocumentKind | 'retirement-tombstone',
  projectId?: string,
): CollabError {
  return new CollabError({
    code: 'operation-failed',
    safeContext: {
      ...(projectId === undefined ? {} : { projectId }),
      reason,
      recordKind,
    },
    recoveryActions: ['open-diagnostics'],
  });
}

function schemaVersionError(recordKind: 'index' | 'membership'): CollabError {
  return new CollabError({
    code: 'schema-version-unsupported',
    safeContext: { recordKind },
    recoveryActions: ['open-diagnostics'],
  });
}

function requireString(
  record: UnknownRecord,
  key: string,
  options: { readonly maxLength: number; readonly pattern?: RegExp },
): string {
  const value = record[key];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > options.maxLength
    || (options.pattern && !options.pattern.test(value))
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function requireTimestamp(record: UnknownRecord, key: string): CollabIsoTimestamp {
  const value = requireString(record, key, { maxLength: 64 });
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function requireProjectId(record: UnknownRecord, key = 'id'): CollabProjectId {
  const value = requireString(record, key, { maxLength: 64 });
  if (!isCollabProjectId(value)) throw new TypeError(`Invalid ${key}`);
  return value;
}

function requireWorkspacePath(record: UnknownRecord): string {
  const workspacePath = requireString(record, 'workspacePath', { maxLength: 240 });
  const separatorIndex = workspacePath.lastIndexOf('/');
  if (separatorIndex <= 0 || separatorIndex === workspacePath.length - 1) {
    throw new TypeError('Invalid workspacePath');
  }
  const projectsFolder = workspacePath.slice(0, separatorIndex);
  const projectDirectoryName = workspacePath.slice(separatorIndex + 1);
  if (
    !parseCollabProjectsFolder(projectsFolder).ok
    || !PROJECT_DIRECTORY_PATTERN.test(projectDirectoryName)
  ) {
    throw new TypeError('Invalid workspacePath');
  }
  return workspacePath;
}

function requireHttpsUrl(
  record: UnknownRecord,
  key: string,
  options: { readonly endpointOnly?: boolean } = {},
): string {
  const value = requireString(record, key, { maxLength: 2_048 });
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Invalid ${key}`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || (options.endpointOnly && parsed.pathname !== '/')
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function requireNullableHttpsUrl(
  record: UnknownRecord,
  key: string,
  options: { readonly endpointOnly?: boolean } = {},
): string | null {
  return record[key] === null ? null : requireHttpsUrl(record, key, options);
}

function normalizeIndexEntry(value: unknown): CollabLocalProjectIndexEntry {
  if (!isRecord(value)) throw new TypeError('Invalid project index entry');
  const required = new Set([
    'authorityKind', 'createdAt', 'id', 'name', 'updatedAt', 'workspacePath',
  ]);
  const optional = new Set(['cleanupStatus', 'lifecycle', 'retiredAt']);
  if (
    [...required].some(key => !(key in value))
    || Object.keys(value).some(key => !required.has(key) && !optional.has(key))
  ) throw new TypeError('Unexpected project index entry field');
  const authorityKind = value.authorityKind;
  if (authorityKind !== 'lan' && authorityKind !== 'cloud') {
    throw new TypeError('Invalid authority kind');
  }
  const lifecycle = value.lifecycle ?? 'active';
  if (lifecycle !== 'active' && lifecycle !== 'leaving' && lifecycle !== 'retired') {
    throw new TypeError('Invalid Project lifecycle');
  }
  const cleanupStatus = value.cleanupStatus;
  if (
    cleanupStatus !== undefined
    && cleanupStatus !== 'pending'
    && cleanupStatus !== 'running'
    && cleanupStatus !== 'failed'
    && cleanupStatus !== 'complete'
  ) throw new TypeError('Invalid cleanup status');
  const retiredAt = value.retiredAt === undefined
    ? undefined
    : requireTimestamp(value, 'retiredAt');
  if (
    (lifecycle === 'active' && (cleanupStatus !== undefined || retiredAt !== undefined))
    || (lifecycle === 'leaving' && retiredAt !== undefined)
    || (lifecycle === 'retired' && (cleanupStatus === undefined || retiredAt === undefined))
  ) throw new TypeError('Invalid lifecycle projection');
  return {
    authorityKind,
    ...(cleanupStatus === undefined ? {} : { cleanupStatus }),
    createdAt: requireTimestamp(value, 'createdAt'),
    id: requireProjectId(value),
    lifecycle,
    name: requireString(value, 'name', { maxLength: 200 }),
    ...(retiredAt === undefined ? {} : { retiredAt }),
    updatedAt: requireTimestamp(value, 'updatedAt'),
    workspacePath: requireWorkspacePath(value),
  };
}

function normalizeIndex(value: unknown): CollabLocalProjectIndex {
  if (!isRecord(value) || value.schemaVersion !== COLLAB_LOCAL_PROJECT_SCHEMA_VERSION) {
    throw new TypeError('Invalid local Project index');
  }
  if (
    Object.keys(value).length !== 3
    || Object.keys(value).some(key => !['projects', 'schemaVersion', 'selectedProjectId'].includes(key))
  ) throw new TypeError('Unexpected local Project index field');
  if (!Array.isArray(value.projects)) throw new TypeError('Invalid Project list');
  const projects = value.projects.map(normalizeIndexEntry);
  const projectIds = new Set<string>();
  const workspaceKeys = new Set<string>();
  for (const project of projects) {
    const workspaceKey = project.workspacePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (projectIds.has(project.id) || workspaceKeys.has(workspaceKey)) {
      throw new TypeError('Duplicate local Project');
    }
    projectIds.add(project.id);
    workspaceKeys.add(workspaceKey);
  }
  const selectedProjectId = value.selectedProjectId;
  if (
    selectedProjectId !== null
    && (typeof selectedProjectId !== 'string' || !projectIds.has(selectedProjectId))
  ) {
    throw new TypeError('Invalid selected Project');
  }
  return {
    projects: [...projects].sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    )),
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    selectedProjectId,
  };
}

function migrateIndex(value: unknown, now: CollabIsoTimestamp): CollabLocalProjectIndex {
  if (
    !isRecord(value)
    || ![0, 1, 2].includes(value.schemaVersion as number)
    || !Array.isArray(value.projects)
  ) {
    throw new TypeError('Invalid legacy Project index');
  }
  if (value.schemaVersion === 2) {
    return normalizeIndex({
      ...value,
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    });
  }
  return normalizeIndex({
    projects: value.projects.map(project => {
      if (!isRecord(project)) throw new TypeError('Invalid legacy Project');
      return {
        authorityKind: value.schemaVersion === 0 ? 'lan' : project.authorityKind,
        createdAt: value.schemaVersion === 0 ? now : project.createdAt,
        id: project.id,
        lifecycle: 'active',
        name: project.name,
        updatedAt: value.schemaVersion === 0 ? now : project.updatedAt,
        workspacePath: project.workspacePath,
      };
    }),
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    selectedProjectId: value.selectedProjectId ?? null,
  });
}

function normalizeMembership(value: unknown): CollabLocalMembershipRecord {
  if (!isRecord(value)) throw new TypeError('Invalid membership record');
  if (value.schemaVersion !== COLLAB_LOCAL_PROJECT_SCHEMA_VERSION) {
    throw schemaVersionError('membership');
  }
  if (!isRecord(value.project) || !isRecord(value.authority) || !isRecord(value.member)) {
    throw new TypeError('Invalid membership sections');
  }
  const authorityKind = value.authority.kind;
  if (authorityKind !== 'lan' && authorityKind !== 'cloud') {
    throw new TypeError('Invalid authority kind');
  }
  requireExactKeys(
    value,
    authorityKind === 'lan'
      ? [
        'schemaVersion', 'project', 'authority', 'member', 'hostOwnership',
        'lastEventSequence', 'createdAt', 'updatedAt',
      ]
      : [
        'schemaVersion', 'project', 'authority', 'member',
        'lastEventSequence', 'createdAt', 'updatedAt',
      ],
    ['lifecycle'],
  );
  requireExactKeys(value.project, ['id', 'name', 'workspacePath']);
  const lifecycleValue = value.lifecycle ?? 'active';
  if (lifecycleValue !== 'active' && lifecycleValue !== 'leaving') {
    throw new TypeError('Invalid membership lifecycle');
  }
  const lifecycle: 'active' | 'leaving' = lifecycleValue;
  if (authorityKind === 'cloud' && lifecycle !== 'active') {
    throw new TypeError('Invalid Cloud membership lifecycle');
  }

  const projectId = requireProjectId(value.project);
  const memberId = requireString(value.member, 'id', { maxLength: 64 });
  if (!isCollabMemberId(memberId)) throw new TypeError('Invalid Member id');
  const roleValue = value.member.role;
  if (roleValue !== 'manager' && roleValue !== 'member') throw new TypeError('Invalid role');
  const role: CollabRole = roleValue;
  const personalRef = requireString(value.member, 'personalRef', { maxLength: 256 });
  if (personalRef !== collabMemberRef(memberId)) throw new TypeError('Invalid personal ref');
  const lastEventSequence = value.lastEventSequence;
  if (!Number.isSafeInteger(lastEventSequence) || (lastEventSequence as number) < 0) {
    throw new TypeError('Invalid event sequence');
  }
  const common = {
    createdAt: requireTimestamp(value, 'createdAt'),
    lastEventSequence: lastEventSequence as number,
    lifecycle,
    member: {
      displayName: requireString(value.member, 'displayName', { maxLength: 200 }),
      id: memberId,
      personalRef,
      role,
    },
    project: {
      id: projectId,
      name: requireString(value.project, 'name', { maxLength: 200 }),
      workspacePath: requireWorkspacePath(value.project),
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: requireTimestamp(value, 'updatedAt'),
  };

  if (authorityKind === 'cloud') {
    requireExactKeys(value.authority, [
      'bindingVersion', 'developmentActorId', 'gitRemoteUrl', 'kind',
      'serverUrl', 'wireVersion',
    ], ['authorityGeneration']);
    requireExactKeys(value.member, [
      'displayName', 'id', 'personalRef', 'role',
    ]);
    if (
      value.authority.bindingVersion !== COLLAB_CLOUD_BINDING_VERSION
      || value.authority.wireVersion !== COLLAB_PROTOCOL_VERSION
    ) {
      throw schemaVersionError('membership');
    }
    const developmentActorId = requireString(
      value.authority,
      'developmentActorId',
      { maxLength: 64 },
    );
    if (!isCollabMemberId(developmentActorId) || developmentActorId !== memberId) {
      throw new TypeError('Invalid development actor id');
    }
    const authorityGeneration = value.authority.authorityGeneration;
    if (authorityGeneration !== undefined && (
      !Number.isSafeInteger(authorityGeneration) || (authorityGeneration as number) < 1
    )) {
      throw new TypeError('Invalid authority generation');
    }
    const serverUrl = canonicalCloudOrigin(
      requireString(value.authority, 'serverUrl', { maxLength: 2_048 }),
      'serverUrl',
    );
    const gitRemoteUrl = canonicalCloudUrl(
      requireString(value.authority, 'gitRemoteUrl', { maxLength: 2_048 }),
      'gitRemoteUrl',
    );
    if (gitRemoteUrl !== cloudProjectGitRemoteUrl(serverUrl, projectId)) {
      throw new TypeError('Invalid Cloud Git URL');
    }
    const membership: CollabLocalCloudMembershipRecord = {
      ...common,
      authority: {
        ...(authorityGeneration === undefined
          ? {}
          : { authorityGeneration: authorityGeneration as number }),
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        developmentActorId,
        gitRemoteUrl,
        kind: 'cloud',
        serverUrl,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
    };
    return membership;
  }

  if (!isRecord(value.hostOwnership)) {
    throw new TypeError('Invalid Host ownership');
  }
  requireExactKeys(value.authority, [
    'endpoint', 'gitRemoteUrl', 'hostCaCertificatePem',
    'hostCaFingerprint', 'kind',
  ]);
  requireExactKeys(value.member, [
    'credential', 'displayName', 'id', 'personalRef', 'role',
  ]);
  requireExactKeys(value.hostOwnership, ['ownsAuthority'], ['autoStart']);
  const ownsAuthority = value.hostOwnership.ownsAuthority;
  if (typeof ownsAuthority !== 'boolean') throw new TypeError('Invalid Host ownership');
  const autoStart = value.hostOwnership.autoStart;
  if (autoStart !== undefined && typeof autoStart !== 'boolean') {
    throw new TypeError('Invalid Host auto-start intent');
  }
  const hostCaCertificatePem = value.authority.hostCaCertificatePem === null
    ? null
    : requireString(value.authority, 'hostCaCertificatePem', {
      maxLength: 64 * 1024,
    });
  if (hostCaCertificatePem !== null && (
    !hostCaCertificatePem.includes('-----BEGIN CERTIFICATE-----')
    || !hostCaCertificatePem.includes('-----END CERTIFICATE-----')
    || hostCaCertificatePem.includes('PRIVATE KEY')
  )) {
    throw new TypeError('Invalid Host CA certificate');
  }
  const hostCaFingerprint = value.authority.hostCaFingerprint === null
    ? null
    : requireString(value.authority, 'hostCaFingerprint', {
      maxLength: 95,
      pattern: FINGERPRINT_PATTERN,
    }).replaceAll(':', '').toLocaleLowerCase('en-US');
  const endpoint = requireNullableHttpsUrl(value.authority, 'endpoint', {
    endpointOnly: true,
  });
  const gitRemoteUrl = requireNullableHttpsUrl(value.authority, 'gitRemoteUrl');
  const networkFields = [endpoint, gitRemoteUrl, hostCaCertificatePem, hostCaFingerprint];
  if (networkFields.some(field => field === null) && networkFields.some(field => field !== null)) {
    throw new TypeError('Incomplete LAN authority configuration');
  }
  const membership: CollabLocalLanMembershipRecord = {
    ...common,
    authority: {
      endpoint,
      gitRemoteUrl,
      hostCaCertificatePem,
      hostCaFingerprint,
      kind: 'lan',
    },
    hostOwnership: {
      ...(autoStart === undefined ? {} : { autoStart }),
      ownsAuthority,
    },
    member: {
      ...common.member,
      credential: requireString(value.member, 'credential', {
        maxLength: 43,
        pattern: MEMBER_CREDENTIAL_PATTERN,
      }),
    },
  };
  return membership;
}

function migrateMembership(value: unknown): CollabLocalMembershipRecord {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new TypeError('Invalid legacy membership');
  }
  return normalizeMembership({
    ...value,
    ...(value.schemaVersion === 1 ? { lifecycle: 'active' } : {}),
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
  });
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const valid = value.every(item => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }
  if (!isRecord(value)) {
    seen.delete(value);
    return false;
  }
  const valid = Object.values(value).every(item => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export class CollabLocalProjectRepository {
  readonly authorityTransferClaimants: AuthorityTransferClaimantStore;
  readonly authorityTransferClaimCommitments: AuthorityTransferClaimCommitmentStorePort;
  readonly authorityTransferClaims: AuthorityTransferClaimCustodyStorePort;
  readonly authorityTransferRecords: AuthorityTransferRecordStorePort;
  readonly hostTransferRecovery: HostTransferRecoveryStorePort;
  readonly localCleanup: LocalCleanupRecordPort;
  private readonly now: () => Date;
   readonly #onDiagnostic?: CollabFilesystemDiagnosticSink;
   readonly #operationQueue = new SerialTaskQueue();
   readonly #ownedAuthorityCapabilities = new WeakSet<object>();
   readonly #provisionalAuthorityCapabilities = new WeakSet<object>();
   readonly #installationKey?: InstallationKey;

  constructor(
    private readonly vaultRoot: string,
    options: CollabLocalProjectRepositoryOptions = {},
  ) {
    this.#installationKey = options.installationKey === undefined
      ? undefined
      : parseInstallationKey(options.installationKey);
    this.now = options.now ?? (() => new Date());
    this.#onDiagnostic = options.onDiagnostic;
    const authorityTransferRecords: AuthorityTransferRecordStorePort = {
      listProjectIds: () => this.listAuthorityTransferProjectIds(),
      scanProjectCatalog: () => this.scanAuthorityTransferProjectCatalog(),
      load: projectId => this.loadLifecycleProjectDocument(
        projectId,
        'authority-transfer',
        decodeAuthorityTransferRecord,
      ),
      remove: projectId => this.removeLifecycleProjectDocument(
        projectId,
        'authority-transfer',
      ),
      save: record => this.saveLifecycleProjectDocument(
        record.projectId,
        'authority-transfer',
        record,
        decodeAuthorityTransferRecord,
      ),
    };
    this.authorityTransferRecords = Object.freeze(authorityTransferRecords);
    const authorityTransferClaimCommitments: AuthorityTransferClaimCommitmentStorePort = {
      load: projectId => this.loadLifecycleProjectDocument(
        projectId,
        'authority-transfer-claim-commitment',
        decodeAuthorityTransferClaimBatchCommitmentRecord,
      ),
      remove: projectId => this.removeLifecycleProjectDocument(
        projectId,
        'authority-transfer-claim-commitment',
      ),
      save: record => this.saveLifecycleProjectDocument(
        record.projectId,
        'authority-transfer-claim-commitment',
        record,
        decodeAuthorityTransferClaimBatchCommitmentRecord,
      ),
    };
    this.authorityTransferClaimCommitments = Object.freeze(
      authorityTransferClaimCommitments,
    );
    const authorityTransferClaims: AuthorityTransferClaimCustodyStorePort = {
      load: projectId => this.loadLifecycleProjectDocument(
        projectId,
        'authority-transfer-claims',
        decodeAuthorityTransferClaimCustodyRecord,
      ),
      remove: projectId => this.removeLifecycleProjectDocument(
        projectId,
        'authority-transfer-claims',
      ),
      save: record => this.saveLifecycleProjectDocument(
        record.projectId,
        'authority-transfer-claims',
        record,
        decodeAuthorityTransferClaimCustodyRecord,
      ),
    };
    this.authorityTransferClaims = Object.freeze(authorityTransferClaims);
    const authorityTransferClaimants: AuthorityTransferClaimantStore = {
      listProjectIds: () => this.listAuthorityTransferClaimantProjectIds(),
      load: projectId => this.loadProjectDocument(
        projectId,
        'authority-transfer-claimant',
        decodeAuthorityTransferClaimantRecord,
      ),
      remove: projectId => this.removeProjectDocument(
        projectId,
        'authority-transfer-claimant',
      ),
      save: record => this.saveProjectDocument(
        record.projectId,
        'authority-transfer-claimant',
        record,
      ),
    };
    this.authorityTransferClaimants = Object.freeze(authorityTransferClaimants);
    const hostTransferRecovery: HostTransferRecoveryStorePort = {
      load: async (projectId, direction) => {
        const record = await this.loadLifecycleProjectDocument(
          projectId,
          'host-transfer-recovery',
          decodeHostTransferRecoveryRecord,
        );
        return record?.direction === direction ? record : null;
      },
      remove: async (projectId, direction) => {
        const record = await this.hostTransferRecovery.load(projectId, direction);
        if (!record) return;
        await this.removeLifecycleProjectDocument(projectId, 'host-transfer-recovery');
      },
      save: record => this.saveLifecycleProjectDocument(
        record.projectId,
        'host-transfer-recovery',
        record,
        decodeHostTransferRecoveryRecord,
      ),
    };
    this.hostTransferRecovery = Object.freeze(hostTransferRecovery);
    this.localCleanup = Object.freeze({
      load: (projectId: CollabProjectId): Promise<LocalCleanupRecord | null> => (
        this.loadLifecycleProjectDocument(
          projectId,
          'local-cleanup',
          decodeLocalCleanupRecord,
        )
      ),
      remove: (projectId: CollabProjectId): Promise<boolean> => (
        this.removeLifecycleProjectDocument(projectId, 'local-cleanup')
      ),
      save: (record: LocalCleanupRecord): Promise<void> => (
        this.saveLifecycleProjectDocument(
          record.projectId,
          'local-cleanup',
          record,
          decodeLocalCleanupRecord,
        )
      ),
    });
  }

  loadIndex(): Promise<CollabLocalProjectIndex> {
    return this.#operationQueue.run(() => this.#loadIndexUnlocked(true));
  }

  repairIndexFromMemberships(): Promise<CollabLocalProjectIndex> {
    return this.#operationQueue.run(async () => {
      let existing: CollabLocalProjectIndex | null;
      try {
        existing = await this.#loadIndexUnlocked(false);
      } catch (error) {
        if (
          !(error instanceof CollabError)
          || error.safeContext.recordKind !== 'index'
          || error.safeContext.reason !== 'local-record-corrupt'
        ) {
          throw error;
        }
        existing = null;
      }
      const projectsRelativePath = `${PRIVATE_STATE_DIRECTORY}/projects`;
      const projectsPath = await resolveCollabVaultPath(this.vaultRoot, projectsRelativePath);
      const entries = await readdir(projectsPath, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw localRecordError('local-record-read-failed', 'index');
      });
      const membershipProjects: CollabLocalProjectIndexEntry[] = [];
      const recoveredRetiredProjects: CollabLocalProjectIndexEntry[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (
          !isCollabProjectId(entry.name)
          || !entry.isDirectory()
          || entry.isSymbolicLink()
        ) {
          throw localRecordError('local-project-directory-invalid', 'index');
        }
        const retirement = await this.#loadRetirementRecordUnlocked(entry.name);
        if (retirement) {
          const terminal = existing?.projects.find(project => project.id === entry.name);
          if (!terminal || terminal.lifecycle !== 'retired') {
            throw localRecordError(
              'local-index-retirement-projection-unrecoverable',
              'index',
              entry.name,
            );
          }
          recoveredRetiredProjects.push({
            ...terminal,
            cleanupStatus: retirement.cleanupStatus,
            lifecycle: 'retired',
            retiredAt: retirement.retiredAt,
            updatedAt: retirement.updatedAt,
          });
          continue;
        }
        const membership = await this.#loadMembershipUnlocked(entry.name, true);
        if (!membership) continue;
        membershipProjects.push({
          authorityKind: membership.authority.kind,
          createdAt: membership.createdAt,
          id: membership.project.id,
          lifecycle: membership.lifecycle ?? 'active',
          name: membership.project.name,
          updatedAt: membership.updatedAt,
          workspacePath: membership.project.workspacePath,
        });
      }
      const membershipProjectIds = new Set(membershipProjects.map(project => project.id));
      const recoveredRetiredProjectIds = new Set(
        recoveredRetiredProjects.map(project => project.id),
      );
      const retainedNonActiveProjects = (existing?.projects ?? []).filter(project => (
        !membershipProjectIds.has(project.id)
        && !recoveredRetiredProjectIds.has(project.id)
        && project.lifecycle !== 'active'
      ));
      const projects = [
        ...membershipProjects,
        ...recoveredRetiredProjects,
        ...retainedNonActiveProjects,
      ].sort((left, right) => left.id.localeCompare(right.id));
      const selectedProjectId = projects.some(project => (
        project.id === existing?.selectedProjectId
      ))
        ? existing?.selectedProjectId ?? null
        : null;
      const repaired: CollabLocalProjectIndex = {
        projects,
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId,
      };
      await this.#saveIndexUnlocked(repaired);
      return repaired;
    });
  }

  upsertProject(entry: CollabLocalProjectIndexEntry): Promise<void> {
    let normalized: CollabLocalProjectIndexEntry;
    try {
      normalized = normalizeIndexEntry(entry);
    } catch {
      return Promise.reject(localRecordError('local-record-corrupt', 'index'));
    }
    return this.#operationQueue.run(async () => {
      const index = await this.#loadIndexUnlocked(false);
      const projects = index.projects.filter(project => project.id !== normalized.id);
      projects.push(normalized);
      await this.#saveIndexUnlocked({
        ...index,
        projects,
      });
    });
  }

  selectProject(projectId: CollabProjectId | null): Promise<void> {
    return this.#operationQueue.run(async () => {
      const index = await this.#loadIndexUnlocked(false);
      if (projectId !== null && !index.projects.some(project => project.id === projectId)) {
        throw new CollabError({
          code: 'project-not-found',
          safeContext: { projectId },
        });
      }
      await this.#saveIndexUnlocked({ ...index, selectedProjectId: projectId });
    });
  }

  removeProject(projectId: CollabProjectId): Promise<void> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const index = await this.#loadIndexUnlocked(false);
      await this.#saveIndexUnlocked({
        ...index,
        projects: index.projects.filter(project => project.id !== projectId),
        selectedProjectId: index.selectedProjectId === projectId
          ? null
          : index.selectedProjectId,
      });
    });
  }

  discardPendingOperation(projectId: CollabProjectId): Promise<void> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const index = await this.#loadIndexUnlocked(false);
      if (
        index.selectedProjectId === projectId
        || index.projects.some(project => project.id === projectId)
      ) {
        await this.#saveIndexUnlocked({
          ...index,
          projects: index.projects.filter(project => project.id !== projectId),
          selectedProjectId: index.selectedProjectId === projectId
            ? null
            : index.selectedProjectId,
        });
      }
      await removeCollabFileDurably(
        this.vaultRoot,
        this.#projectDocumentPath(projectId, 'pending-operation'),
        this.#onDiagnostic,
      );
    });
  }

  purgeProjectPrivateState(projectId: CollabProjectId): Promise<boolean> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(() => removeCollabDirectoryDurably(
      this.vaultRoot,
      `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`,
      this.#onDiagnostic,
    ));
  }

  pruneProjectPrivateDirectoryIfEmpty(projectId: CollabProjectId): Promise<boolean> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`;
      const absoluteDirectory = await resolveCollabVaultPath(
        this.vaultRoot,
        relativeDirectory,
      );
      const entries = await readdir(absoluteDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('local-record-read-failed', 'index', projectId);
      });
      if (entries === null || entries.length > 0) return false;
      await rm(absoluteDirectory, { recursive: true }).catch(() => {
        throw localRecordError('local-record-remove-failed', 'index', projectId);
      });
      return true;
    });
  }

  finalizeRetiredProject(projectId: CollabProjectId): Promise<void> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const index = await this.#loadIndexUnlocked(false);
      const entry = index.projects.find(project => project.id === projectId);
      if (
        !entry
        || entry.lifecycle !== 'retired'
        || entry.cleanupStatus !== 'complete'
      ) {
        throw entry
          ? localRecordError('local-retirement-not-finalizable', 'retirement', projectId)
          : new CollabError({
              code: 'project-not-found',
              safeContext: { projectId, reason: 'local-retirement-projection-missing' },
            });
      }
      const record = await this.#loadRetirementRecordUnlocked(projectId);
      if (record?.acknowledgementStatus === 'pending') {
        await ensureCollabVaultDirectory(
          this.vaultRoot,
          RETIREMENT_ACKNOWLEDGEMENT_DIRECTORY,
          { mode: 0o700, onDiagnostic: this.#onDiagnostic },
        );
        await writeCollabFileAtomically(
          this.vaultRoot,
          this.#retirementAcknowledgementPath(projectId),
          serializeJson(record),
          { mode: 0o600, onDiagnostic: this.#onDiagnostic },
        );
      } else {
        await removeCollabFileDurably(
          this.vaultRoot,
          this.#retirementAcknowledgementPath(projectId),
          this.#onDiagnostic,
        );
      }
      await removeCollabDirectoryDurably(
        this.vaultRoot,
        `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`,
        this.#onDiagnostic,
      );
      await this.#saveIndexUnlocked({
        ...index,
        projects: index.projects.filter(project => project.id !== projectId),
        selectedProjectId: index.selectedProjectId === projectId
          ? null
          : index.selectedProjectId,
      });
    });
  }

  transitionProjectToRetired(
    record: RetirementRecord,
    projectionSeed?: CollabRetiredProjectProjectionSeed,
  ): Promise<void> {
    let retirement: RetirementRecord;
    try {
      retirement = decodeRetirementRecord(record);
    } catch {
      return Promise.reject(localRecordError(
        'local-record-corrupt',
        'retirement',
        record.projectId,
      ));
    }
    const projectId = retirement.projectId;
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const index = await this.#loadIndexUnlocked(false);
      const entry = index.projects.find(project => project.id === projectId);
      const existingValue = await this.#readJson(
        this.#lifecycleDocumentPath(projectId, 'retirement'),
        'retirement',
        projectId,
      );
      let existing: RetirementRecord | null = null;
      if (existingValue !== null) {
        try {
          existing = decodeRetirementRecord(existingValue);
        } catch {
          throw localRecordError('local-record-corrupt', 'retirement', projectId);
        }
      }
      if (existing && (
        existing.memberId !== retirement.memberId
        || existing.retiredAt !== retirement.retiredAt
        || existing.cleanupOperationId !== retirement.cleanupOperationId
      )) {
        throw localRecordError('local-retirement-identity-conflict', 'retirement', projectId);
      }
      const authoritative = existing ?? retirement;
      let retiredEntry: CollabLocalProjectIndexEntry;
      try {
        retiredEntry = entry ?? normalizeIndexEntry({
          ...projectionSeed,
          cleanupStatus: authoritative.cleanupStatus,
          id: projectId,
          lifecycle: 'retired',
          retiredAt: authoritative.retiredAt,
          updatedAt: authoritative.updatedAt,
        });
      } catch {
        throw localRecordError('local-project-missing', 'index', projectId);
      }
      if (
        entry !== undefined
        && entry.lifecycle !== 'active'
        && entry.lifecycle !== 'leaving'
        && entry.lifecycle !== 'retired'
      ) {
        throw localRecordError('local-project-not-active', 'index', projectId);
      }
      await this.#ensurePrivateProjectDirectory(projectId);
      if (!existing) {
        await writeCollabFileAtomically(
          this.vaultRoot,
          this.#lifecycleDocumentPath(projectId, 'retirement'),
          serializeJson(authoritative),
          { mode: 0o600, onDiagnostic: this.#onDiagnostic },
        );
      }
      await this.#saveIndexUnlocked({
        ...index,
        projects: entry
          ? index.projects.map(project => project.id === projectId
            ? {
                ...project,
                cleanupStatus: authoritative.cleanupStatus,
                lifecycle: 'retired' as const,
                retiredAt: authoritative.retiredAt,
                updatedAt: authoritative.updatedAt,
              }
            : project)
          : [...index.projects, retiredEntry],
      });

      const activeDocuments = [
        this.getProjectPaths(projectId).membership,
        this.getProjectPaths(projectId).cache,
        this.getProjectPaths(projectId).pendingOperation,
        this.getProjectPaths(projectId).publicationState,
        this.getProjectPaths(projectId).requestDraft,
        this.getProjectPaths(projectId).authorityTransferClaimant,
        this.getProjectPaths(projectId).managerResponsibilityReceipt,
        this.getProjectPaths(projectId).hostTransferRecovery,
      ];
      for (const relativePath of activeDocuments) {
        await removeCollabFileDurably(this.vaultRoot, relativePath, this.#onDiagnostic);
      }
    });
  }

  updateRetirementRecord(
    projectId: CollabProjectId,
    update: (record: RetirementRecord) => RetirementRecord,
  ): Promise<RetirementRecord> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const activePath = this.#lifecycleDocumentPath(projectId, 'retirement');
      const activeValue = await this.#readJson(activePath, 'retirement', projectId);
      const relativePath = activeValue === null
        ? this.#retirementAcknowledgementPath(projectId)
        : activePath;
      const value = activeValue ?? await this.#readJson(relativePath, 'retirement', projectId);
      if (value === null) throw localRecordError('local-retirement-missing', 'retirement', projectId);
      let current: RetirementRecord;
      let next: RetirementRecord;
      try {
        current = decodeRetirementRecord(value);
        next = decodeRetirementRecord(update(current));
      } catch {
        throw localRecordError('local-record-corrupt', 'retirement', projectId);
      }
      if (
        next.projectId !== current.projectId
        || next.memberId !== current.memberId
        || next.retiredAt !== current.retiredAt
        || next.cleanupOperationId !== current.cleanupOperationId
      ) {
        throw localRecordError('local-retirement-identity-conflict', 'retirement', projectId);
      }
      await writeCollabFileAtomically(
        this.vaultRoot,
        relativePath,
        serializeJson(next),
        { mode: 0o600, onDiagnostic: this.#onDiagnostic },
      );
      const index = await this.#loadIndexUnlocked(false);
      if (index.projects.some(project => project.id === projectId && project.lifecycle === 'retired')) {
        await this.#saveIndexUnlocked({
          ...index,
          projects: index.projects.map(project => project.id === projectId
            ? { ...project, cleanupStatus: next.cleanupStatus, updatedAt: next.updatedAt }
            : project),
        });
      }
      return next;
    });
  }

  loadRetirementRecord(projectId: CollabProjectId): Promise<RetirementRecord | null> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(() => this.#loadRetirementRecordUnlocked(projectId));
  }

  listRetirementAcknowledgementProjectIds(): Promise<readonly CollabProjectId[]> {
    return this.#operationQueue.run(async () => {
      const directory = await resolveCollabVaultPath(
        this.vaultRoot,
        RETIREMENT_ACKNOWLEDGEMENT_DIRECTORY,
      );
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw localRecordError('retirement-acknowledgement-list-failed', 'retirement');
      });
      return entries.sort((left, right) => left.name.localeCompare(right.name)).flatMap(entry => {
        if (/^\..+\.json\.[0-9a-f-]+\.tmp$/.test(entry.name)) return [];
        const match = /^(.+)\.json$/.exec(entry.name);
        if (!match || !isCollabProjectId(match[1]) || !entry.isFile() || entry.isSymbolicLink()) {
          throw localRecordError('retirement-acknowledgement-directory-invalid', 'retirement');
        }
        return [match[1]];
      });
    });
  }

  removeRetirementAcknowledgement(projectId: CollabProjectId): Promise<boolean> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(() => removeCollabFileDurably(
      this.vaultRoot,
      this.#retirementAcknowledgementPath(projectId),
      this.#onDiagnostic,
    ));
  }

  async loadWorkspacePath(projectId: CollabProjectId): Promise<string | null> {
    this.#requireProjectId(projectId);
    const index = await this.loadIndex();
    return index.projects.find(project => project.id === projectId)?.workspacePath ?? null;
  }

  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(() => this.#loadMembershipUnlocked(projectId, true));
  }

  saveMembership(record: CollabLocalMembershipRecord): Promise<void> {
    let normalized: CollabLocalMembershipRecord;
    try {
      normalized = normalizeMembership(record);
    } catch (error) {
      if (error instanceof CollabError) return Promise.reject(error);
      return Promise.reject(localRecordError(
        'local-record-corrupt',
        'membership',
        isRecord(record.project) && typeof record.project.id === 'string'
          ? record.project.id
          : undefined,
      ));
    }
    return this.#operationQueue.run(async () => {
      await this.#ensurePrivateProjectDirectory(normalized.project.id);
      await writeCollabFileAtomically(
        this.vaultRoot,
        this.getProjectPaths(normalized.project.id).membership,
        serializeJson(normalized),
        { mode: 0o600, onDiagnostic: this.#onDiagnostic },
      );
    });
  }

  updateMembershipProjection(
    projectId: CollabProjectId,
    memberId: CollabMemberId,
    role: CollabRole,
    sequence: number,
  ): Promise<CollabLocalMembershipRecord> {
    this.#requireProjectId(projectId);
    if (!isCollabMemberId(memberId)) {
      return Promise.reject(localRecordError(
        'local-membership-member-invalid',
        'membership',
        projectId,
      ));
    }
    if (role !== 'manager' && role !== 'member') {
      return Promise.reject(localRecordError(
        'local-membership-role-invalid',
        'membership',
        projectId,
      ));
    }
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return Promise.reject(localRecordError(
        'local-event-sequence-invalid',
        'membership',
        projectId,
      ));
    }
    return this.#updateMembershipProjectionFields(projectId, {
      memberId,
      role,
      sequence,
    });
  }

   #updateMembershipProjectionFields(
    projectId: CollabProjectId,
    projection: {
      readonly memberId: CollabMemberId;
      readonly role: CollabRole;
      readonly sequence: number;
    },
  ): Promise<CollabLocalMembershipRecord> {
    return this.#operationQueue.run(async () => {
      const relativePath = this.getProjectPaths(projectId).membership;
      const value = await this.#readJson(relativePath, 'membership', projectId);
      if (value === null) {
        throw localRecordError('local-membership-missing', 'membership', projectId);
      }
      let membership: CollabLocalMembershipRecord;
      try {
        membership = normalizeMembership(value);
      } catch (error) {
        if (error instanceof CollabError) throw error;
        throw localRecordError('local-record-corrupt', 'membership', projectId);
      }
      if (membership.project.id !== projectId) {
        throw localRecordError('local-record-corrupt', 'membership', projectId);
      }
      if (projection.memberId !== membership.member.id) {
        throw localRecordError(
          'local-membership-member-mismatch',
          'membership',
          projectId,
        );
      }
      if (projection.sequence < membership.lastEventSequence) return membership;
      if (
        projection.sequence === membership.lastEventSequence
        && projection.role === membership.member.role
      ) {
        return membership;
      }
      const updated: CollabLocalMembershipRecord = isCollabLocalLanMembership(membership)
        ? {
          ...membership,
          lastEventSequence: projection.sequence,
          member: { ...membership.member, role: projection.role },
          updatedAt: this.now().toISOString(),
        }
        : {
          ...membership,
          lastEventSequence: projection.sequence,
          member: { ...membership.member, role: projection.role },
          updatedAt: this.now().toISOString(),
        };
      await this.#ensurePrivateProjectDirectory(projectId);
      await writeCollabFileAtomically(
        this.vaultRoot,
        relativePath,
        serializeJson(updated),
        { mode: 0o600, onDiagnostic: this.#onDiagnostic },
      );
      return updated;
    });
  }

  loadProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: CollabProjectId,
    kind: CollabLocalProjectDocumentKind,
    decode: (value: unknown) => T,
  ): Promise<T | null> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const value = await this.#readJson(this.#projectDocumentPath(projectId, kind), kind, projectId);
      if (value === null) return null;
      try {
        const decoded = decode(value);
        if (
          !isRecord(decoded)
          || decoded.projectId !== projectId
          || !Number.isSafeInteger(decoded.schemaVersion)
          || decoded.schemaVersion < 1
        ) {
          throw new TypeError('Invalid local Project document');
        }
        return decoded;
      } catch {
        throw localRecordError('local-record-corrupt', kind, projectId);
      }
    });
  }

  listPendingOperationProjectIds(): Promise<readonly CollabProjectId[]> {
    return this.#operationQueue.run(async () => {
      const kind = 'pending-operation' as const;
      const projectsDirectory = await resolveCollabVaultPath(
        this.vaultRoot,
        `${PRIVATE_STATE_DIRECTORY}/projects`,
      );
      const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw localRecordError('local-project-directory-read-failed', kind);
      });
      const projectIds: CollabProjectId[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) {
          if (entry.isSymbolicLink()) {
            throw localRecordError('local-project-directory-invalid', kind, entry.name);
          }
          continue;
        }
        if (!isCollabProjectId(entry.name)) {
          throw localRecordError('local-project-directory-invalid', kind, entry.name);
        }
        const projectId = entry.name;
        const value = await this.#readJson(
          this.#projectDocumentPath(projectId, kind),
          kind,
          projectId,
        );
        if (value !== null) projectIds.push(projectId);
      }
      return projectIds;
    });
  }

  listAuthorityTransferClaimantProjectIds(): Promise<readonly CollabProjectId[]> {
    return this.#listProjectDocumentProjectIds('authority-transfer-claimant');
  }

  listAuthorityTransferProjectIds(): Promise<readonly CollabProjectId[]> {
    return this.#operationQueue.run(async () => {
      const catalog = await this.#scanAuthorityTransferProjectCatalogUnlocked();
      if (catalog.invalidEntryCount > 0) {
        throw localRecordError('local-project-directory-invalid', 'authority-transfer');
      }
      return catalog.projectIds;
    });
  }

  scanAuthorityTransferProjectCatalog(): Promise<AuthorityTransferProjectCatalog> {
    return this.#operationQueue.run(() => this.#scanAuthorityTransferProjectCatalogUnlocked());
  }

   async #scanAuthorityTransferProjectCatalogUnlocked(
  ): Promise<AuthorityTransferProjectCatalog> {
    const projectsDirectory = await resolveCollabVaultPath(
      this.vaultRoot,
      `${PRIVATE_STATE_DIRECTORY}/projects`,
    );
    const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw localRecordError('local-project-directory-read-failed', 'authority-transfer');
    });
    const projectIds: CollabProjectId[] = [];
    let invalidEntryCount = 0;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          invalidEntryCount += 1;
        }
        continue;
      }
      if (!isCollabProjectId(entry.name)) {
        invalidEntryCount += 1;
        continue;
      }
      let documentNames: readonly string[];
      try {
        const projectDirectory = await resolveCollabVaultPath(
          this.vaultRoot,
          `${PRIVATE_STATE_DIRECTORY}/projects/${entry.name}`,
        );
        documentNames = await readdir(projectDirectory);
      } catch {
        // Preserve the valid Project ID so its ordinary per-Project load can
        // fail closed without preventing recovery of the rest of the catalog.
        projectIds.push(entry.name);
        invalidEntryCount += 1;
        continue;
      }
      if (documentNames.some(name => (
        name === 'authority-transfer.json'
        || name === 'authority-transfer-claims.json'
        || name === 'authority-transfer-claim-commitment.json'
      ))) {
        projectIds.push(entry.name);
      }
    }
    return { invalidEntryCount, projectIds };
  }

  saveProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: CollabProjectId,
    kind: CollabLocalProjectDocumentKind,
    document: T,
  ): Promise<void> {
    this.#requireProjectId(projectId);
    if (
      document.projectId !== projectId
      || !Number.isSafeInteger(document.schemaVersion)
      || document.schemaVersion < 1
      || !isJsonValue(document)
    ) {
      return Promise.reject(localRecordError('local-record-corrupt', kind, projectId));
    }
    const serialized = serializeJson(document);
    return this.#operationQueue.run(async () => {
      await this.#ensurePrivateProjectDirectory(projectId);
      await writeCollabFileAtomically(
        this.vaultRoot,
        this.#projectDocumentPath(projectId, kind),
        serialized,
        { mode: 0o600, onDiagnostic: this.#onDiagnostic },
      );
    });
  }

  removeProjectDocument(
    projectId: CollabProjectId,
    kind: CollabLocalProjectDocumentKind,
  ): Promise<boolean> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(() => removeCollabFileDurably(
      this.vaultRoot,
      this.#projectDocumentPath(projectId, kind),
      this.#onDiagnostic,
    ));
  }

  loadLifecycleProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: CollabProjectId,
    kind: CollabLifecycleProjectDocumentKind,
    decode: (value: unknown) => T,
  ): Promise<T | null> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const value = await this.#readJson(this.#lifecycleDocumentPath(projectId, kind), kind, projectId);
      if (value === null) return null;
      try {
        const decoded = decode(value);
        if (decoded.projectId !== projectId) throw new TypeError('Lifecycle Project mismatch');
        return decoded;
      } catch {
        throw localRecordError('local-record-corrupt', kind, projectId);
      }
    });
  }

  saveLifecycleProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: CollabProjectId,
    kind: CollabLifecycleProjectDocumentKind,
    document: T,
    decode: (value: unknown) => T,
  ): Promise<void> {
    this.#requireProjectId(projectId);
    let decoded: T;
    try {
      decoded = decode(document);
      if (decoded.projectId !== projectId || !isJsonValue(decoded)) throw new TypeError();
    } catch {
      return Promise.reject(localRecordError('local-record-corrupt', kind, projectId));
    }
    return this.#operationQueue.run(async () => {
      const durable = isAuthorityTransferLifecycleKind(kind);
      await this.#ensurePrivateProjectDirectory(projectId, durable);
      await writeCollabFileAtomically(
        this.vaultRoot,
        this.#lifecycleDocumentPath(projectId, kind),
        serializeJson(decoded),
        { mode: 0o600, onDiagnostic: this.#onDiagnostic },
      );
      if (durable) {
        await syncCollabVaultDirectoryDurably(
          this.vaultRoot,
          `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`,
        );
      }
    });
  }

  removeLifecycleProjectDocument(
    projectId: CollabProjectId,
    kind: CollabLifecycleProjectDocumentKind,
  ): Promise<boolean> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const removed = await removeCollabFileDurably(
        this.vaultRoot,
        this.#lifecycleDocumentPath(projectId, kind),
        this.#onDiagnostic,
      );
      if (removed && isAuthorityTransferLifecycleKind(kind)) {
        await syncCollabVaultDirectoryDurably(
          this.vaultRoot,
          `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`,
        );
      }
      return removed;
    });
  }

  loadRetirementTombstone(
    projectId: CollabProjectId,
  ): Promise<RetirementTombstoneRecord | null> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const value = await this.#readJson(
        this.#retirementTombstonePath(projectId),
        'retirement-tombstone',
        projectId,
      );
      if (value === null) return null;
      try {
        const decoded = decodeRetirementTombstoneRecord(value);
        if (decoded.projectId !== projectId) throw new TypeError();
        return decoded;
      } catch {
        throw localRecordError('local-record-corrupt', 'retirement-tombstone', projectId);
      }
    });
  }

  saveRetirementTombstone(record: RetirementTombstoneRecord): Promise<void> {
    let decoded: RetirementTombstoneRecord;
    try {
      decoded = decodeRetirementTombstoneRecord(record);
    } catch {
      return Promise.reject(localRecordError('local-record-corrupt', 'retirement-tombstone'));
    }
    return this.#operationQueue.run(async () => {
      await this.#ensureRetirementTombstoneDirectory();
      await writeCollabFileAtomically(
        this.vaultRoot,
        this.#retirementTombstonePath(decoded.projectId),
        serializeJson(decoded),
        { mode: 0o600, onDiagnostic: this.#onDiagnostic },
      );
    });
  }

  removeRetirementTombstone(projectId: CollabProjectId): Promise<boolean> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      return removeCollabFileDurably(
        this.vaultRoot,
        this.#retirementTombstonePath(projectId),
        this.#onDiagnostic,
      );
    });
  }

  listRetirementTombstoneProjectIds(): Promise<readonly CollabProjectId[]> {
    return this.#operationQueue.run(async () => {
      const directory = await resolveCollabVaultPath(
        this.vaultRoot,
        `${PRIVATE_STATE_DIRECTORY}/retirement-tombstones`,
      );
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          throw localRecordError('retirement-tombstone-directory-invalid', 'retirement-tombstone');
        }
        throw error;
      }
      const discovered: CollabProjectId[] = [];
      for (const entry of entries) {
        // A legacy index.json is ignored, never consulted, and never deleted;
        // the physical tombstone records are the sole recovery authority.
        if (entry.name === 'index.json' || /^\..+\.[0-9a-f-]+\.tmp$/.test(entry.name)) {
          continue;
        }
        const match = /^(.+)\.json$/.exec(entry.name);
        if (!match || !isCollabProjectId(match[1]) || !entry.isFile() || entry.isSymbolicLink()) {
          throw localRecordError('retirement-tombstone-directory-invalid', 'retirement-tombstone');
        }
        discovered.push(match[1]);
      }
      return [...new Set(discovered)].sort();
    });
  }

  getProjectPaths(projectId: CollabProjectId): CollabLocalProjectPaths {
    this.#requireProjectId(projectId);
    const projectDirectory = `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`;
    return {
      authorityDirectory: `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`,
      authorityTransfer: `${projectDirectory}/authority-transfer.json`,
      authorityTransferClaimCommitment: `${projectDirectory}/authority-transfer-claim-commitment.json`,
      authorityTransferClaims: `${projectDirectory}/authority-transfer-claims.json`,
      authorityTransferClaimant: `${projectDirectory}/authority-transfer-claimant.json`,
      cache: `${projectDirectory}/cache.json`,
      conflictDirectory: this.getConflictDirectoryPath(),
      hostTransferRecovery: `${projectDirectory}/host-transfer-recovery.json`,
      localCleanup: `${projectDirectory}/local-cleanup.json`,
      managerResponsibilityReceipt: `${projectDirectory}/manager-responsibility-receipt.json`,
      membership: `${projectDirectory}/membership.json`,
      pendingOperation: `${projectDirectory}/pending-operation.json`,
      publicationState: `${projectDirectory}/publication-state.json`,
      requestDraft: `${projectDirectory}/request-draft.json`,
      retirement: `${projectDirectory}/retirement.json`,
    };
  }

  getConflictDirectoryPath(): string {
    return `${PRIVATE_STATE_DIRECTORY}/conflicts`;
  }

  async ensurePrivateStateContainer(): Promise<void> {
    await ensureCollabContainerGuard(this.vaultRoot, PRIVATE_STATE_DIRECTORY, {
      onDiagnostic: this.#onDiagnostic,
      privateContainer: true,
    });
  }

  inspectAuthorityInstallation(
    projectId: CollabProjectId,
  ): Promise<CollabAuthorityInstallationStatus> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(() => this.#inspectAuthorityInstallationUnlocked(projectId));
  }

  createOwnedAuthorityDirectory(
    projectId: CollabProjectId,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const installationKey = this.#requireInstallationKey();
      await this.ensurePrivateStateContainer();
      const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
      const unresolvedDirectory = await resolveCollabVaultPath(this.vaultRoot, relativeDirectory);
      const existingDirectory = await lstat(unresolvedDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
      });
      if (
        existingDirectory
        && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())
      ) {
        throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
      }
      if (existingDirectory) {
        const marker = await this.#loadAuthorityOwnershipMarker(
          `${relativeDirectory}/${AUTHORITY_OWNERSHIP_MARKER}`,
        );
        if (
          marker?.schemaVersion === AUTHORITY_OWNERSHIP_SCHEMA_VERSION
          && marker.projectId === projectId
          && marker.ownerInstallationKey === installationKey
        ) {
          return this.#issueOwnedAuthorityCapability(projectId, unresolvedDirectory);
        }
        if (marker !== null || !await this.#isEmptyDirectory(unresolvedDirectory)) {
          throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
        }
      }
      const authorityDirectory = await ensureCollabVaultDirectory(
        this.vaultRoot,
        relativeDirectory,
        { mode: 0o700, onDiagnostic: this.#onDiagnostic },
      );
      await this.#writeCurrentAuthorityOwnershipMarker(projectId, installationKey);
      return this.#issueOwnedAuthorityCapability(projectId, authorityDirectory);
    });
  }

  prepareProvisionalAuthorityDirectory(
    projectId: CollabProjectId,
  ): Promise<ProvisionalAuthorityDirectoryCapability> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      this.#requireInstallationKey();
      await this.ensurePrivateStateContainer();
      const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
      const authorityDirectory = await ensureCollabVaultDirectory(
        this.vaultRoot,
        relativeDirectory,
        { mode: 0o700, onDiagnostic: this.#onDiagnostic },
      );
      const marker = await this.#loadAuthorityOwnershipMarker(
        `${relativeDirectory}/${AUTHORITY_OWNERSHIP_MARKER}`,
      );
      if (marker !== null) {
        throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
      }
      await this.#assertProvisionalAuthorityDirectory(authorityDirectory, projectId);
      return this.#issueProvisionalAuthorityCapability(projectId, authorityDirectory);
    });
  }

  recoverProvisionalAuthorityDirectory(
    projectId: CollabProjectId,
  ): Promise<ProvisionalAuthorityDirectoryCapability | null> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      this.#requireInstallationKey();
      const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
      const authorityDirectory = await resolveCollabVaultPath(this.vaultRoot, relativeDirectory);
      const directoryStat = await lstat(authorityDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
      });
      if (directoryStat === null) return null;
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
      }
      const marker = await this.#loadAuthorityOwnershipMarker(
        `${relativeDirectory}/${AUTHORITY_OWNERSHIP_MARKER}`,
      );
      if (marker !== null) {
        throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
      }
      await this.#assertProvisionalAuthorityDirectory(authorityDirectory, projectId, true);
      return this.#issueProvisionalAuthorityCapability(projectId, authorityDirectory);
    });
  }

  bindProvisionalAuthorityDirectory(
    capability: ProvisionalAuthorityDirectoryCapability,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    return this.#operationQueue.run(async () => {
      this.#assertIssuedProvisionalAuthorityCapability(capability);
      const marker = await this.#loadAuthorityOwnershipMarker(
        `${PRIVATE_STATE_DIRECTORY}/authorities/${capability.projectId}/${AUTHORITY_OWNERSHIP_MARKER}`,
      );
      if (marker !== null) {
        throw localRecordError(
          'authority-ownership-marker-mismatch',
          'index',
          capability.projectId,
        );
      }
      await this.#assertProvisionalAuthorityDirectory(
        capability.authorityDirectory,
        capability.projectId,
        true,
      );
      await this.#writeCurrentAuthorityOwnershipMarker(
        capability.projectId,
        this.#requireInstallationKey(),
      );
      return this.#issueOwnedAuthorityCapability(
        capability.projectId,
        capability.authorityDirectory,
      );
    });
  }

  removeProvisionalAuthorityDirectory(
    capability: ProvisionalAuthorityDirectoryCapability,
  ): Promise<boolean> {
    return this.#operationQueue.run(async () => {
      this.#assertIssuedProvisionalAuthorityCapability(capability);
      const marker = await this.#loadAuthorityOwnershipMarker(
        `${PRIVATE_STATE_DIRECTORY}/authorities/${capability.projectId}/${AUTHORITY_OWNERSHIP_MARKER}`,
      );
      if (marker !== null) {
        throw localRecordError(
          'authority-ownership-marker-mismatch',
          'index',
          capability.projectId,
        );
      }
      await this.#assertProvisionalAuthorityDirectory(
        capability.authorityDirectory,
        capability.projectId,
      );
      await rm(capability.authorityDirectory, { recursive: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw localRecordError(
          'authority-directory-remove-failed',
          'index',
          capability.projectId,
        );
      });
      return true;
    });
  }

  assertOwnedAuthorityDirectory(
    projectId: CollabProjectId,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const installationKey = this.#requireInstallationKey();
      const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
      const authorityDirectory = await resolveCollabVaultPath(this.vaultRoot, relativeDirectory);
      const directoryStat = await lstat(authorityDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
      });
      if (directoryStat === null) {
        throw localRecordError('authority-directory-missing', 'index', projectId);
      }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
      }
      const marker = await this.#loadAuthorityOwnershipMarker(
        `${relativeDirectory}/${AUTHORITY_OWNERSHIP_MARKER}`,
      );
      if (
        marker?.schemaVersion !== AUTHORITY_OWNERSHIP_SCHEMA_VERSION
        || marker.projectId !== projectId
        || marker.ownerInstallationKey !== installationKey
      ) {
        throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
      }
      return this.#issueOwnedAuthorityCapability(projectId, authorityDirectory);
    });
  }

  assertOwnedAuthorityRetirement(
    projectId: CollabProjectId,
    attemptId: string,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    this.#requireProjectId(projectId);
    if (!isCollabOpaqueId(attemptId)) {
      return Promise.reject(localRecordError(
        'authority-directory-boundary-invalid',
        'index',
        projectId,
      ));
    }
    return this.#operationQueue.run(async () => {
      const { source } = await this.#inspectOwnedAuthorityRetirement(projectId, attemptId);
      return this.#issueOwnedAuthorityCapability(projectId, source);
    });
  }

  claimLegacyAuthorityDirectory(
    projectId: CollabProjectId,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    this.#requireProjectId(projectId);
    return this.#operationQueue.run(async () => {
      const installationKey = this.#requireInstallationKey();
      const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
      const authorityDirectory = await resolveCollabVaultPath(this.vaultRoot, relativeDirectory);
      const directoryStat = await lstat(authorityDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
      });
      if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
      }
      const marker = await this.#loadAuthorityOwnershipMarker(
        `${relativeDirectory}/${AUTHORITY_OWNERSHIP_MARKER}`,
      );
      if (
        marker?.schemaVersion === AUTHORITY_OWNERSHIP_SCHEMA_VERSION
        && marker.projectId === projectId
        && marker.ownerInstallationKey === installationKey
      ) {
        return this.#issueOwnedAuthorityCapability(projectId, authorityDirectory);
      }
      if (
        marker?.schemaVersion !== LEGACY_AUTHORITY_OWNERSHIP_SCHEMA_VERSION
        || marker.projectId !== projectId
      ) {
        throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
      }
      await this.#assertLegacyAuthorityDirectoryClaimable(authorityDirectory, projectId);
      await this.#writeCurrentAuthorityOwnershipMarker(projectId, installationKey);
      return this.#issueOwnedAuthorityCapability(projectId, authorityDirectory);
    });
  }

  removeOwnedAuthorityDirectory(
    capability: OwnedAuthorityDirectoryCapability,
  ): Promise<boolean> {
    return this.#operationQueue.run(async () => {
      this.#assertIssuedAuthorityCapability(capability);
      const current = await this.#inspectAuthorityInstallationUnlocked(capability.projectId);
      if (current !== 'hosted-here') {
        throw localRecordError(
          'authority-ownership-marker-mismatch',
          'index',
          capability.projectId,
        );
      }
      const directoryStat = await lstat(capability.authorityDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError(
          'authority-directory-inspection-failed',
          'index',
          capability.projectId,
        );
      });
      if (directoryStat === null) return false;
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw localRecordError(
          'authority-directory-boundary-invalid',
          'index',
          capability.projectId,
        );
      }
      await rm(capability.authorityDirectory, { recursive: true }).catch(() => {
        throw localRecordError(
          'authority-directory-remove-failed',
          'index',
          capability.projectId,
        );
      });
      return true;
    });
  }

  retireOwnedAuthorityDirectory(
    capability: OwnedAuthorityDirectoryCapability,
    attemptId: string,
  ): Promise<string | null> {
    this.#assertIssuedAuthorityCapability(capability);
    const projectId = capability.projectId;
    if (!isCollabOpaqueId(attemptId)) {
      return Promise.reject(localRecordError(
        'authority-directory-boundary-invalid',
        'index',
        projectId,
      ));
    }
    return this.#operationQueue.run(async () => {
      const {
        retired,
        retiredExists,
        retiredParentRelative,
        source,
        sourceExists,
      } = await this.#inspectOwnedAuthorityRetirement(projectId, attemptId);
      if (retiredExists) return retired;
      if (!sourceExists) return null;
      await ensureCollabVaultDirectory(this.vaultRoot, retiredParentRelative, {
        durable: true,
        mode: 0o700,
        onDiagnostic: this.#onDiagnostic,
      });
      await rename(source, retired).catch(() => {
        throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
      });
      await syncCollabVaultDirectoryDurably(
        this.vaultRoot,
        `${PRIVATE_STATE_DIRECTORY}/authorities`,
      );
      await syncCollabVaultDirectoryDurably(this.vaultRoot, retiredParentRelative);
      return retired;
    });
  }

  async #inspectOwnedAuthorityRetirement(
    projectId: CollabProjectId,
    attemptId: string,
  ): Promise<{
    readonly retired: string;
    readonly retiredExists: boolean;
    readonly retiredParentRelative: string;
    readonly source: string;
    readonly sourceExists: boolean;
  }> {
    const installationKey = this.#requireInstallationKey();
    const sourceRelative = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
    const retiredParentRelative = `${PRIVATE_STATE_DIRECTORY}/retired-lan-authorities/${projectId}`;
    const retiredRelative = `${retiredParentRelative}/${attemptId}`;
    const source = await resolveCollabVaultPath(this.vaultRoot, sourceRelative);
    const retired = await resolveCollabVaultPath(this.vaultRoot, retiredRelative);
    const inspect = async (absolutePath: string, relativePath: string) => {
      const info = await lstat(absolutePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
      });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) {
        throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
      }
      if (info) {
        const marker = await this.#loadAuthorityOwnershipMarker(
          `${relativePath}/${AUTHORITY_OWNERSHIP_MARKER}`,
        );
        if (
          marker?.schemaVersion !== AUTHORITY_OWNERSHIP_SCHEMA_VERSION
          || marker.projectId !== projectId
          || marker.ownerInstallationKey !== installationKey
        ) {
          throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
        }
      }
      return info !== null;
    };
    const [sourceExists, retiredExists] = await Promise.all([
      inspect(source, sourceRelative),
      inspect(retired, retiredRelative),
    ]);
    if (sourceExists && retiredExists) {
      throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
    }
    return {
      retired,
      retiredExists,
      retiredParentRelative,
      source,
      sourceExists,
    };
  }

  async ensureGitEmptyConfig(): Promise<string> {
    return this.#operationQueue.run(async () => {
      await this.ensurePrivateStateContainer();
      const relativePath = `${PRIVATE_STATE_DIRECTORY}/git-empty-config`;
      const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
      const contents = await readFile(absolutePath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw localRecordError('local-record-read-failed', 'index');
      });
      if (contents !== '') {
        await writeCollabFileAtomically(
          this.vaultRoot,
          relativePath,
          '',
          { mode: 0o600, onDiagnostic: this.#onDiagnostic },
        );
      }
      return absolutePath;
    });
  }

   async #ensurePrivateProjectDirectory(
    projectId: CollabProjectId,
    durable = false,
  ): Promise<void> {
    await this.ensurePrivateStateContainer();
    await ensureCollabVaultDirectory(
      this.vaultRoot,
      `${PRIVATE_STATE_DIRECTORY}/projects/${projectId}`,
      { durable, mode: 0o700, onDiagnostic: this.#onDiagnostic },
    );
  }

   async #loadRetirementRecordUnlocked(
    projectId: CollabProjectId,
  ): Promise<RetirementRecord | null> {
    const active = await this.#readJson(
      this.#lifecycleDocumentPath(projectId, 'retirement'),
      'retirement',
      projectId,
    );
    const value = active ?? await this.#readJson(
      this.#retirementAcknowledgementPath(projectId),
      'retirement',
      projectId,
    );
    if (value === null) return null;
    try {
      const decoded = decodeRetirementRecord(value);
      if (decoded.projectId !== projectId) throw new TypeError();
      return decoded;
    } catch {
      throw localRecordError('local-record-corrupt', 'retirement', projectId);
    }
  }

   #retirementAcknowledgementPath(projectId: CollabProjectId): string {
    return `${RETIREMENT_ACKNOWLEDGEMENT_DIRECTORY}/${projectId}.json`;
  }

   async #inspectAuthorityInstallationUnlocked(
    projectId: CollabProjectId,
  ): Promise<CollabAuthorityInstallationStatus> {
    const installationKey = this.#requireInstallationKey();
    const relativeDirectory = `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}`;
    const authorityDirectory = await resolveCollabVaultPath(this.vaultRoot, relativeDirectory);
    const directoryStat = await lstat(authorityDirectory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
    });
    if (directoryStat === null) return 'absent';
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw localRecordError('authority-directory-boundary-invalid', 'index', projectId);
    }
    const marker = await this.#loadAuthorityOwnershipMarker(
      `${relativeDirectory}/${AUTHORITY_OWNERSHIP_MARKER}`,
    );
    if (marker === null) {
      await this.#assertProvisionalAuthorityDirectory(authorityDirectory, projectId);
      return 'absent';
    }
    if (marker.projectId !== projectId) {
      throw localRecordError('authority-ownership-marker-mismatch', 'index', projectId);
    }
    if (marker.schemaVersion === LEGACY_AUTHORITY_OWNERSHIP_SCHEMA_VERSION) {
      return 'legacy-unbound';
    }
    return marker.ownerInstallationKey === installationKey
      ? 'hosted-here'
      : 'hosted-elsewhere';
  }

   #requireInstallationKey(): InstallationKey {
    if (!this.#installationKey) {
      throw localRecordError('installation-key-required', 'index');
    }
    return this.#installationKey;
  }

   #issueOwnedAuthorityCapability(
    projectId: CollabProjectId,
    authorityDirectory: string,
  ): OwnedAuthorityDirectoryCapability {
    const capability = Object.freeze({ authorityDirectory, projectId });
    this.#ownedAuthorityCapabilities.add(capability);
    return capability;
  }

   #issueProvisionalAuthorityCapability(
    projectId: CollabProjectId,
    authorityDirectory: string,
  ): ProvisionalAuthorityDirectoryCapability {
    const capability = Object.freeze({ authorityDirectory, projectId });
    this.#provisionalAuthorityCapabilities.add(capability);
    return capability;
  }

   #assertIssuedAuthorityCapability(
    capability: OwnedAuthorityDirectoryCapability,
  ): void {
    if (!this.#ownedAuthorityCapabilities.has(capability)) {
      throw localRecordError('authority-capability-invalid', 'index');
    }
  }

   #assertIssuedProvisionalAuthorityCapability(
    capability: ProvisionalAuthorityDirectoryCapability,
  ): void {
    if (!this.#provisionalAuthorityCapabilities.has(capability)) {
      throw localRecordError('authority-capability-invalid', 'index');
    }
  }

   async #isEmptyDirectory(authorityDirectory: string): Promise<boolean> {
    const entries = await readdir(authorityDirectory, { withFileTypes: true }).catch(() => {
      throw localRecordError('authority-directory-inspection-failed', 'index');
    });
    return entries.length === 0;
  }

   #writeCurrentAuthorityOwnershipMarker(
    projectId: CollabProjectId,
    installationKey: InstallationKey,
  ): Promise<void> {
    return writeCollabFileAtomically(
      this.vaultRoot,
      `${PRIVATE_STATE_DIRECTORY}/authorities/${projectId}/${AUTHORITY_OWNERSHIP_MARKER}`,
      `${JSON.stringify({
        ownerInstallationKey: installationKey,
        projectId,
        schemaVersion: AUTHORITY_OWNERSHIP_SCHEMA_VERSION,
      })}\n`,
      { mode: 0o600, onDiagnostic: this.#onDiagnostic },
    );
  }

   async #loadAuthorityOwnershipMarker(
    relativePath: string,
  ): Promise<AnyAuthorityOwnershipMarker | null> {
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    const fileStat = await lstat(absolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw localRecordError('authority-ownership-marker-inspection-failed', 'index');
    });
    if (fileStat === null) return null;
    if (
      !fileStat.isFile()
      || fileStat.isSymbolicLink()
      || fileStat.size > AUTHORITY_OWNERSHIP_MARKER_MAX_BYTES
    ) {
      throw localRecordError('authority-ownership-marker-invalid', 'index');
    }
    try {
      const value: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
      if (!isRecord(value) || !isCollabProjectId(value.projectId)) {
        throw new TypeError('invalid');
      }
      if (value.schemaVersion === LEGACY_AUTHORITY_OWNERSHIP_SCHEMA_VERSION) {
        requireExactKeys(value, ['projectId', 'schemaVersion']);
        return {
          projectId: value.projectId,
          schemaVersion: LEGACY_AUTHORITY_OWNERSHIP_SCHEMA_VERSION,
        };
      }
      if (value.schemaVersion === AUTHORITY_OWNERSHIP_SCHEMA_VERSION) {
        requireExactKeys(value, ['ownerInstallationKey', 'projectId', 'schemaVersion']);
        if (!isInstallationKey(value.ownerInstallationKey)) {
          throw new TypeError('invalid');
        }
        return {
          ownerInstallationKey: value.ownerInstallationKey,
          projectId: value.projectId,
          schemaVersion: AUTHORITY_OWNERSHIP_SCHEMA_VERSION,
        };
      }
      throw new TypeError('invalid');
    } catch {
      throw localRecordError('authority-ownership-marker-invalid', 'index');
    }
  }

   async #assertLegacyAuthorityDirectoryClaimable(
    authorityDirectory: string,
    projectId: CollabProjectId,
  ): Promise<void> {
    const entries = await readdir(authorityDirectory, { withFileTypes: true }).catch(() => {
      throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
    });
    if (
      entries.length === 0
      || entries.some(entry => (
        (entry.name !== AUTHORITY_OWNERSHIP_MARKER
          && !LEGACY_AUTHORITY_ROOT_ENTRIES.has(entry.name))
        || entry.isSymbolicLink()
        || (entry.name === 'repository.git' ? !entry.isDirectory() : !entry.isFile())
      ))
    ) {
      throw localRecordError('authority-legacy-directory-not-claimable', 'index', projectId);
    }
  }

   async #assertProvisionalAuthorityDirectory(
    authorityDirectory: string,
    projectId: CollabProjectId,
    requireComplete = false,
  ): Promise<void> {
    const entries = await readdir(authorityDirectory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw localRecordError('authority-directory-missing', 'index', projectId);
      }
      throw localRecordError('authority-directory-inspection-failed', 'index', projectId);
    });
    if (entries.some(entry => (
      entry.isSymbolicLink()
      || (entry.name !== 'collab.db' && entry.name !== 'repository.git')
      || (entry.name === 'collab.db' ? !entry.isFile() : !entry.isDirectory())
    ))) {
      throw localRecordError('authority-provisional-directory-invalid', 'index', projectId);
    }
    if (
      requireComplete
      && (!entries.some(entry => entry.name === 'collab.db')
        || !entries.some(entry => entry.name === 'repository.git'))
    ) {
      throw localRecordError('authority-provisional-directory-incomplete', 'index', projectId);
    }
  }

   async #loadIndexUnlocked(persistMigration: boolean): Promise<CollabLocalProjectIndex> {
    const value = await this.#readJson(`${PRIVATE_STATE_DIRECTORY}/index.json`, 'index');
    if (value === null) {
      return {
        projects: [],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: null,
      };
    }

    let decoded: DecodeResult<CollabLocalProjectIndex>;
    try {
      if (
        isRecord(value)
        && (value.schemaVersion === 0
          || value.schemaVersion === 1
          || value.schemaVersion === 2)
      ) {
        decoded = {
          migrated: true,
          value: migrateIndex(value, this.now().toISOString()),
        };
      } else if (
        isRecord(value)
        && value.schemaVersion !== COLLAB_LOCAL_PROJECT_SCHEMA_VERSION
      ) {
        throw schemaVersionError('index');
      } else {
        decoded = { migrated: false, value: normalizeIndex(value) };
      }
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw localRecordError('local-record-corrupt', 'index');
    }
    if (decoded.migrated && persistMigration) {
      await this.#saveIndexUnlocked(decoded.value);
    }
    return decoded.value;
  }

   async #loadMembershipUnlocked(
    projectId: CollabProjectId,
    persistMigration: boolean,
  ): Promise<CollabLocalMembershipRecord | null> {
    const relativePath = this.getProjectPaths(projectId).membership;
    const value = await this.#readJson(relativePath, 'membership', projectId);
    if (value === null) return null;
    try {
      const migrated = isRecord(value)
        && (value.schemaVersion === 1 || value.schemaVersion === 2);
      const membership = migrated ? migrateMembership(value) : normalizeMembership(value);
      if (membership.project.id !== projectId) {
        throw new TypeError('Membership Project mismatch');
      }
      if (migrated && persistMigration) {
        await this.#ensurePrivateProjectDirectory(projectId);
        await writeCollabFileAtomically(
          this.vaultRoot,
          relativePath,
          serializeJson(membership),
          { mode: 0o600, onDiagnostic: this.#onDiagnostic },
        );
      }
      return membership;
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw localRecordError('local-record-corrupt', 'membership', projectId);
    }
  }

   async #saveIndexUnlocked(index: CollabLocalProjectIndex): Promise<void> {
    let normalized: CollabLocalProjectIndex;
    try {
      normalized = normalizeIndex(index);
    } catch {
      throw localRecordError('local-record-corrupt', 'index');
    }
    await this.ensurePrivateStateContainer();
    await writeCollabFileAtomically(
      this.vaultRoot,
      `${PRIVATE_STATE_DIRECTORY}/index.json`,
      serializeJson(normalized),
      { mode: 0o600, onDiagnostic: this.#onDiagnostic },
    );
  }

   async #readJson(
    relativePath: string,
    recordKind: CollabLocalProjectDocumentKind | 'index' | 'membership' | CollabLifecycleProjectDocumentKind | 'retirement-tombstone',
    projectId?: string,
  ): Promise<unknown> {
    let absolutePath: string;
    try {
      absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
      return JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof CollabError) throw error;
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        throw localRecordError('local-record-corrupt', recordKind, projectId);
      }
      throw localRecordError('local-record-read-failed', recordKind, projectId);
    }
  }

   #projectDocumentPath(
    projectId: CollabProjectId,
    kind: CollabLocalProjectDocumentKind,
  ): string {
    const paths = this.getProjectPaths(projectId);
    if (kind === 'authority-transfer-claimant') return paths.authorityTransferClaimant;
    if (kind === 'cache') return paths.cache;
    if (kind === 'pending-operation') return paths.pendingOperation;
    if (kind === 'publication-state') return paths.publicationState;
    return paths.requestDraft;
  }

   #listProjectDocumentProjectIds(
    kind: CollabLocalProjectDocumentKind,
  ): Promise<readonly CollabProjectId[]> {
    return this.#operationQueue.run(async () => {
      const projectsDirectory = await resolveCollabVaultPath(
        this.vaultRoot,
        `${PRIVATE_STATE_DIRECTORY}/projects`,
      );
      const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw localRecordError('local-project-directory-read-failed', kind);
      });
      const projectIds: CollabProjectId[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) {
          if (entry.isSymbolicLink()) {
            throw localRecordError('local-project-directory-invalid', kind, entry.name);
          }
          continue;
        }
        if (!isCollabProjectId(entry.name)) {
          throw localRecordError('local-project-directory-invalid', kind, entry.name);
        }
        const value = await this.#readJson(
          this.#projectDocumentPath(entry.name, kind),
          kind,
          entry.name,
        );
        if (value !== null) projectIds.push(entry.name);
      }
      return projectIds;
    });
  }

   #lifecycleDocumentPath(
    projectId: CollabProjectId,
    kind: CollabLifecycleProjectDocumentKind,
  ): string {
    const paths = this.getProjectPaths(projectId);
    if (kind === 'manager-responsibility-receipt') return paths.managerResponsibilityReceipt;
    if (kind === 'local-cleanup') return paths.localCleanup;
    if (kind === 'host-transfer-recovery') return paths.hostTransferRecovery;
    if (kind === 'authority-transfer') return paths.authorityTransfer;
    if (kind === 'authority-transfer-claim-commitment') {
      return paths.authorityTransferClaimCommitment;
    }
    if (kind === 'authority-transfer-claims') return paths.authorityTransferClaims;
    return paths.retirement;
  }

   #retirementTombstonePath(projectId: CollabProjectId): string {
    return `${PRIVATE_STATE_DIRECTORY}/retirement-tombstones/${projectId}.json`;
  }

   async #ensureRetirementTombstoneDirectory(): Promise<void> {
    await this.ensurePrivateStateContainer();
    await ensureCollabVaultDirectory(
      this.vaultRoot,
      `${PRIVATE_STATE_DIRECTORY}/retirement-tombstones`,
      { mode: 0o700, onDiagnostic: this.#onDiagnostic },
    );
  }

   #requireProjectId(projectId: CollabProjectId): void {
    if (!isCollabProjectId(projectId)) {
      throw localRecordError('project-id-invalid', 'index');
    }
  }
}
