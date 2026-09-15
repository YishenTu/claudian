import {
  type CollabMemberId,
  collabMemberRef,
  type CollabProjectId,
  type CollabProjectRetirementOperationMap,
  decodeCollabProjectRetirementOperationRequest,
  decodeCollabProjectRetirementOperationResponse,
  isCollabMemberId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';

export type CloudRetirementIntentPhase =
  | 'prepared'
  | 'submitted'
  | 'terminal-retained'
  | 'rejected';

interface CloudRetirementIntentBase {
  readonly schemaVersion: 1;
  readonly kind: 'cloud-retirement-intent';
  readonly authorityGeneration: number;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly projectId: CollabProjectId;
  readonly request: CollabProjectRetirementOperationMap['retireProject']['request'];
  readonly serverUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CloudRetirementIntent = CloudRetirementIntentBase & (
  | {
    readonly phase: Exclude<CloudRetirementIntentPhase, 'terminal-retained'>;
    readonly result: null;
  }
  | {
    readonly phase: 'terminal-retained';
    readonly result: CollabProjectRetirementOperationMap['retireProject']['response'];
  }
);

const KEYS = new Set([
  'schemaVersion', 'kind', 'authorityGeneration', 'memberId', 'personalRef', 'projectId',
  'request', 'result', 'serverUrl', 'phase', 'createdAt', 'updatedAt',
]);

function timestamp(value: unknown, name: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError(`Invalid Cloud retirement ${name}`);
  return value;
}

export function decodeCloudRetirementIntent(value: unknown): CloudRetirementIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Cloud retirement intent');
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(input).length !== KEYS.size
    || Object.keys(input).some(key => !KEYS.has(key))
    || input.schemaVersion !== 1
    || input.kind !== 'cloud-retirement-intent'
    || !Number.isSafeInteger(input.authorityGeneration)
    || (input.authorityGeneration as number) < 1
    || !isCollabMemberId(input.memberId)
    || input.personalRef !== collabMemberRef(input.memberId)
    || !isCollabProjectId(input.projectId)
    || typeof input.serverUrl !== 'string'
    || (
      input.phase !== 'prepared'
      && input.phase !== 'submitted'
      && input.phase !== 'terminal-retained'
      && input.phase !== 'rejected'
    )
  ) throw new TypeError('Invalid Cloud retirement identity');
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const updatedAt = timestamp(input.updatedAt, 'updatedAt');
  if (updatedAt < createdAt) throw new TypeError('Invalid Cloud retirement time');
  const request = decodeCollabProjectRetirementOperationRequest(
    'retireProject',
    input.request,
  );
  if (
    request.projectId !== input.projectId
    || request.expectedAuthorityGeneration !== input.authorityGeneration
  ) throw new TypeError('Invalid Cloud retirement request identity');
  const result = input.result === null
    ? null
    : decodeCollabProjectRetirementOperationResponse('retireProject', input.result);
  if (
    (input.phase === 'terminal-retained') !== (result !== null)
    || (result !== null && result.projectId !== input.projectId)
  ) throw new TypeError('Invalid Cloud retirement result identity');
  const base: CloudRetirementIntentBase = {
    authorityGeneration: input.authorityGeneration,
    createdAt,
    kind: 'cloud-retirement-intent',
    memberId: input.memberId,
    personalRef: input.personalRef,
    projectId: input.projectId,
    request,
    schemaVersion: 1,
    serverUrl: validateCloudServerUrl(input.serverUrl, 'serverUrl'),
    updatedAt,
  };
  if (input.phase === 'terminal-retained') {
    if (result === null) throw new TypeError('Invalid Cloud retirement terminal result');
    return { ...base, phase: input.phase, result };
  }
  return { ...base, phase: input.phase, result: null };
}
