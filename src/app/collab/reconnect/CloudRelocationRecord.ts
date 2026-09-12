import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabMemberId,
  collabMemberRef,
  type CollabOperationId,
  type CollabProjectId,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import {
  cloudProjectGitRemoteUrl,
  validateCloudServerUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';

export interface CloudRelocationBinding {
  readonly bindingVersion: typeof COLLAB_CLOUD_BINDING_VERSION;
  readonly gitRemoteUrl: string;
  readonly serverUrl: string;
  readonly wireVersion: typeof COLLAB_PROTOCOL_VERSION;
}

export interface CloudRelocationRecord {
  readonly authorityGeneration: number;
  readonly createdAt: string;
  readonly memberId: CollabMemberId;
  readonly newAuthority: CloudRelocationBinding;
  readonly oldAuthority: CloudRelocationBinding;
  readonly operationId: CollabOperationId;
  readonly operationKind: 'cloud-relocation';
  readonly personalRef: string;
  readonly phase: 'prepared' | 'origin-updated' | 'membership-updated';
  readonly projectId: CollabProjectId;
  readonly schemaVersion: 1;
  readonly updatedAt: string;
}

const RECORD_KEYS = new Set([
  'authorityGeneration',
  'createdAt',
  'memberId',
  'newAuthority',
  'oldAuthority',
  'operationId',
  'operationKind',
  'personalRef',
  'phase',
  'projectId',
  'schemaVersion',
  'updatedAt',
]);

const BINDING_KEYS = new Set([
  'bindingVersion',
  'gitRemoteUrl',
  'serverUrl',
  'wireVersion',
]);

function strictRecord(
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some(key => !keys.has(key))
  ) throw new TypeError('Invalid Cloud relocation record');
  return value as Readonly<Record<string, unknown>>;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError('Invalid Cloud relocation timestamp');
  return value;
}

function binding(value: unknown, projectId: CollabProjectId): CloudRelocationBinding {
  const input = strictRecord(value, BINDING_KEYS);
  if (
    input.bindingVersion !== COLLAB_CLOUD_BINDING_VERSION
    || input.wireVersion !== COLLAB_PROTOCOL_VERSION
    || typeof input.serverUrl !== 'string'
    || typeof input.gitRemoteUrl !== 'string'
  ) throw new TypeError('Invalid Cloud relocation binding');
  const serverUrl = validateCloudServerUrl(input.serverUrl, 'serverUrl');
  if (input.gitRemoteUrl !== cloudProjectGitRemoteUrl(serverUrl, projectId)) {
    throw new TypeError('Invalid Cloud relocation Git binding');
  }
  return {
    bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
    gitRemoteUrl: input.gitRemoteUrl,
    serverUrl,
    wireVersion: COLLAB_PROTOCOL_VERSION,
  };
}

export function decodeCloudRelocationRecord(value: unknown): CloudRelocationRecord {
  const input = strictRecord(value, RECORD_KEYS);
  if (
    input.schemaVersion !== 1
    || input.operationKind !== 'cloud-relocation'
    || !isCollabOpaqueId(input.operationId)
    || !isCollabProjectId(input.projectId)
    || !isCollabMemberId(input.memberId)
    || input.personalRef !== collabMemberRef(input.memberId)
    || !Number.isSafeInteger(input.authorityGeneration)
    || (input.authorityGeneration as number) < 1
    || (
      input.phase !== 'prepared'
      && input.phase !== 'origin-updated'
      && input.phase !== 'membership-updated'
    )
  ) throw new TypeError('Invalid Cloud relocation identity');
  const createdAt = timestamp(input.createdAt);
  const updatedAt = timestamp(input.updatedAt);
  if (updatedAt < createdAt) throw new TypeError('Invalid Cloud relocation time');
  const oldAuthority = binding(input.oldAuthority, input.projectId);
  const newAuthority = binding(input.newAuthority, input.projectId);
  if (
    oldAuthority.serverUrl === newAuthority.serverUrl
    || oldAuthority.gitRemoteUrl === newAuthority.gitRemoteUrl
  ) throw new TypeError('Invalid Cloud relocation target');
  return {
    authorityGeneration: Number(input.authorityGeneration),
    createdAt,
    memberId: input.memberId,
    newAuthority,
    oldAuthority,
    operationId: input.operationId,
    operationKind: 'cloud-relocation',
    personalRef: input.personalRef,
    phase: input.phase,
    projectId: input.projectId,
    schemaVersion: 1,
    updatedAt,
  };
}
