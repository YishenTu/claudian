import { isIP } from 'node:net';

import { type CollabMemberId, type CollabOperationId, type CollabProjectId, type CollabRole, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import { parseCollabProjectsFolder } from '@/core/collab';

export const COLLAB_JOIN_PROJECT_SCHEMA_VERSION = 2 as const;

export type JoinProjectPhase =
  | 'planned'
  | 'trusted'
  | 'membership-created'
  | 'clone-completed'
  | 'placed'
  | 'activated';

export interface JoinProjectRecord {
  readonly createdAt: string;
  readonly encodedInvitation: string | null;
  readonly endpoint: string;
  readonly hostCaCertificatePem: string | null;
  readonly hostCaFingerprint: string;
  readonly joinAttemptId: string;
  readonly lastEventSequence: number | null;
  /** Transient decoder flag used only for safe version-1 staging recovery. */
  readonly legacyJoinRecord?: true;
  readonly memberCredential: string | null;
  readonly memberDisplayName: string;
  readonly memberId: CollabMemberId | null;
  readonly memberRole: CollabRole | null;
  readonly membershipExpiresAt: string | null;
  readonly operationKind: 'join-project';
  readonly operationId: CollabOperationId;
  readonly phase: JoinProjectPhase;
  readonly projectId: CollabProjectId;
  readonly projectName: string | null;
  readonly projectsFolder: string;
  readonly schemaVersion: typeof COLLAB_JOIN_PROJECT_SCHEMA_VERSION;
  readonly slug: string;
  readonly stagingDirectoryName: string;
  readonly updatedAt: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const SAFE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  pattern?: RegExp,
  predicate?: (candidate: unknown) => candidate is string,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || candidate.length > maxLength
    || (pattern && !pattern.test(candidate))
    || (predicate && !predicate(candidate))
  ) {
    throw new TypeError(`Invalid ${field}`);
  }
  return candidate;
}

function nullableString(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  pattern?: RegExp,
  predicate?: (candidate: unknown) => candidate is string,
): string | null {
  return value[field] === null
    ? null
    : requiredString(value, field, maxLength, pattern, predicate);
}

function timestamp(value: UnknownRecord, field: string, nullable = false): string | null {
  if (nullable && value[field] === null) return null;
  const candidate = requiredString(value, field, 64);
  if (Number.isNaN(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate) {
    throw new TypeError(`Invalid ${field}`);
  }
  return candidate;
}

function endpoint(value: UnknownRecord): string {
  const candidate = requiredString(value, 'endpoint', 2_048);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError('Invalid endpoint');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.port.length === 0
    || isIP(parsed.hostname) !== 4
  ) {
    throw new TypeError('Invalid endpoint');
  }
  const [first, second] = parsed.hostname.split('.').map(Number);
  const privateAddress = first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
  if (!privateAddress) throw new TypeError('Invalid endpoint');
  return candidate;
}

function phase(value: unknown): JoinProjectPhase {
  if (
    value !== 'planned'
    && value !== 'trusted'
    && value !== 'membership-created'
    && value !== 'clone-completed'
    && value !== 'placed'
    && value !== 'activated'
  ) {
    throw new TypeError('Invalid phase');
  }
  return value;
}

function phaseRank(value: JoinProjectPhase): number {
  return [
    'planned',
    'trusted',
    'membership-created',
    'clone-completed',
    'placed',
    'activated',
  ].indexOf(value);
}

export function decodeJoinProjectRecord(value: unknown): JoinProjectRecord {
  if (
    !isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.operationKind !== 'join-project'
  ) {
    throw new TypeError('Invalid Join Project record');
  }
  const decodedPhase = phase(value.phase);
  const legacy = value.schemaVersion === 1;
  const projectsFolder = legacy ? 'workspace' : value.projectsFolder;
  if (typeof projectsFolder !== 'string' || !parseCollabProjectsFolder(projectsFolder).ok) {
    throw new TypeError('Invalid Projects folder');
  }
  const projectId = requiredString(value, 'projectId', 64, undefined, isCollabProjectId);
  const operationId = requiredString(value, 'operationId', 128, undefined, isCollabOpaqueId);
  const joinAttemptId = requiredString(value, 'joinAttemptId', 128, undefined, isCollabOpaqueId);
  const slug = requiredString(value, 'slug', 64, SAFE_SLUG_PATTERN);
  const stagingDirectoryName = requiredString(
    value,
    'stagingDirectoryName',
    143,
  );
  if (
    operationId !== joinAttemptId
    || stagingDirectoryName !== `.claudian-join-${joinAttemptId}`
  ) {
    throw new TypeError('Invalid Join operation identity');
  }

  const encodedInvitation = nullableString(value, 'encodedInvitation', 8 * 1024);
  const hostCaCertificatePem = nullableString(
    value,
    'hostCaCertificatePem',
    64 * 1024,
  );
  const memberCredential = nullableString(value, 'memberCredential', 43, CREDENTIAL_PATTERN);
  const memberId = nullableString(value, 'memberId', 64, undefined, isCollabMemberId);
  const membershipExpiresAt = timestamp(value, 'membershipExpiresAt', true);
  const projectName = nullableString(value, 'projectName', 200);
  const memberRole = value.memberRole;
  const lastEventSequence = value.lastEventSequence;

  if (
    (memberRole !== null && memberRole !== 'manager' && memberRole !== 'member')
    || (
      lastEventSequence !== null
      && (
        typeof lastEventSequence !== 'number'
        || !Number.isSafeInteger(lastEventSequence)
        || lastEventSequence < 0
      )
    )
  ) {
    throw new TypeError('Invalid activated Join state');
  }
  const rank = phaseRank(decodedPhase);
  if (rank < phaseRank('membership-created')) {
    if (encodedInvitation === null || memberCredential || memberId || membershipExpiresAt) {
      throw new TypeError('Invalid pre-membership Join state');
    }
  } else if (
    encodedInvitation !== null
    || !memberCredential
    || !memberId
    || !membershipExpiresAt
  ) {
    throw new TypeError('Invalid membership Join state');
  }
  if (rank < phaseRank('trusted')) {
    if (hostCaCertificatePem !== null) throw new TypeError('Invalid planned Join trust');
  } else if (
    !hostCaCertificatePem
    || !hostCaCertificatePem.includes('-----BEGIN CERTIFICATE-----')
    || !hostCaCertificatePem.includes('-----END CERTIFICATE-----')
    || hostCaCertificatePem.includes('PRIVATE KEY')
  ) {
    throw new TypeError('Invalid Join trust');
  }
  if (decodedPhase === 'activated') {
    if (!projectName || !memberRole || lastEventSequence === null) {
      throw new TypeError('Invalid activated Join state');
    }
  } else if (projectName !== null || memberRole !== null || lastEventSequence !== null) {
    throw new TypeError('Invalid pre-activation Join state');
  }

  return {
    createdAt: timestamp(value, 'createdAt')!,
    encodedInvitation,
    endpoint: endpoint(value),
    hostCaCertificatePem,
    hostCaFingerprint: requiredString(
      value,
      'hostCaFingerprint',
      64,
      FINGERPRINT_PATTERN,
    ),
    joinAttemptId,
    lastEventSequence: lastEventSequence,
    memberCredential,
    memberDisplayName: requiredString(value, 'memberDisplayName', 200),
    memberId,
    memberRole,
    membershipExpiresAt,
    operationKind: 'join-project',
    operationId,
    phase: decodedPhase,
    projectId,
    projectName,
    projectsFolder,
    schemaVersion: COLLAB_JOIN_PROJECT_SCHEMA_VERSION,
    slug,
    stagingDirectoryName,
    updatedAt: timestamp(value, 'updatedAt')!,
    ...(legacy ? { legacyJoinRecord: true as const } : {}),
  };
}
