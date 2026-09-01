import { collabControlOperationCodec, type CollabProjectMembershipOperationMap, isCollabMemberId, isCollabProjectId } from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CloudMembershipBinding } from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';

interface CloudManagementIntentBase extends CloudMembershipBinding {
  readonly schemaVersion: 1;
  readonly kind: 'cloud-management-intent';
  readonly phase: 'prepared' | 'submitted' | 'result-retained';
  readonly createdAt: string;
  readonly updatedAt: string;
}

const MUTATIONS = ['createProjectInvitation', 'revokeProjectInvitation', 'demoteManager', 'removeMember', 'createManagerResponsibilityOffer', 'cancelManagerResponsibilityOffer', 'promoteManager', 'reissueTransferredMembershipClaim', 'revokeTransferredMembershipClaim'] as const satisfies readonly (keyof CollabProjectMembershipOperationMap)[];
export type CloudManagementMutation = typeof MUTATIONS[number];
export type CloudManagementIntent = {
  [Operation in CloudManagementMutation]: CloudManagementIntentBase & {
    readonly operation: Operation;
    readonly request: CollabProjectMembershipOperationMap[Operation]['request'];
    readonly response: CollabProjectMembershipOperationMap[Operation]['response'] | null;
  }
}[CloudManagementMutation];

export function decodeCloudManagementIntent(value: unknown): CloudManagementIntent {
  const keys = ['schemaVersion', 'kind', 'operation', 'phase', 'request', 'response', 'createdAt', 'updatedAt', 'projectId', 'serverUrl', 'memberId', 'authorityGeneration'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError('Invalid Cloud management intent');
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || input.kind !== 'cloud-management-intent'
    || !MUTATIONS.some(operation => operation === input.operation)
    || !isCollabProjectId(input.projectId) || !isCollabMemberId(input.memberId)
    || typeof input.authorityGeneration !== 'number' || !Number.isSafeInteger(input.authorityGeneration) || input.authorityGeneration < 1
    || typeof input.serverUrl !== 'string'
    || (input.phase !== 'prepared' && input.phase !== 'submitted' && input.phase !== 'result-retained')
    || (input.phase === 'result-retained') !== (input.response !== null)) {
    throw new TypeError('Invalid Cloud management identity');
  }
  const codec = collabControlOperationCodec(input.operation as CloudManagementMutation);
  const request = codec.decodeRequest(input.request);
  if (request.status !== 'ok' || request.value.projectId !== input.projectId) {
    throw new TypeError('Invalid Cloud management request');
  }
  const response = input.response === null ? null : codec.decodeResponse(input.response);
  if (response && 'projectId' in response && response.projectId !== input.projectId) throw new TypeError('Invalid Cloud management response');
  if (input.operation === 'revokeProjectInvitation' && response
    && (!('invitationId' in request.value) || !('invitationId' in response) || request.value.invitationId !== response.invitationId)) {
    throw new TypeError('Invalid Cloud invitation identity');
  }
  if (input.operation === 'demoteManager' && response
    && (!('targetMemberId' in request.value) || !('demotedMemberId' in response) || request.value.targetMemberId !== response.demotedMemberId)) {
    throw new TypeError('Invalid Cloud demotion identity');
  }
  if (input.operation === 'removeMember' && response
    && (!('targetMemberId' in request.value) || !('memberId' in response) || request.value.targetMemberId !== response.memberId)) {
    throw new TypeError('Invalid Cloud removal identity');
  }
  if (input.operation === 'promoteManager' && response
    && (!('targetMemberId' in request.value) || !('promotedMemberId' in response) || request.value.targetMemberId !== response.promotedMemberId)) {
    throw new TypeError('Invalid Cloud promotion identity');
  }
  if (input.operation === 'createManagerResponsibilityOffer' && response
    && (!('offer' in response) || !('targetMemberId' in request.value) || !('purpose' in request.value) || !('expectedTargetMembershipRevision' in request.value) || !('expectedManagerSetGeneration' in request.value)
      || response.offer.sourceManagerMemberId !== input.memberId || response.offer.targetMemberId !== request.value.targetMemberId
      || response.offer.purpose !== request.value.purpose || response.offer.managerSetGenerationAtOffer !== request.value.expectedManagerSetGeneration
      || response.offer.targetMembershipRevisionAtOffer !== request.value.expectedTargetMembershipRevision)) {
    throw new TypeError('Invalid Cloud responsibility offer identity');
  }
  if (input.operation === 'cancelManagerResponsibilityOffer' && response
    && (!('offer' in response) || !('offerId' in request.value) || response.offer.offerId !== request.value.offerId
      || response.offer.sourceManagerMemberId !== input.memberId)) {
    throw new TypeError('Invalid Cloud cancelled offer identity');
  }
  if (input.operation === 'reissueTransferredMembershipClaim' && response
    && (!('memberId' in request.value) || !('memberId' in response) || response.memberId !== request.value.memberId
      || !('targetAuthorityGeneration' in response) || response.targetAuthorityGeneration !== input.authorityGeneration)) {
    throw new TypeError('Invalid Cloud reissued claim identity');
  }
  if (input.operation === 'revokeTransferredMembershipClaim' && response
    && (!('memberId' in request.value) || !('memberId' in response) || response.memberId !== request.value.memberId)) {
    throw new TypeError('Invalid Cloud revoked claim identity');
  }
  const createdAt = timestamp(input.createdAt);
  const updatedAt = timestamp(input.updatedAt);
  if (updatedAt < createdAt) throw new TypeError('Invalid Cloud management time');
  return {
    authorityGeneration: input.authorityGeneration, createdAt, kind: input.kind, memberId: input.memberId,
    operation: input.operation, phase: input.phase, projectId: input.projectId, request: request.value,
    response, schemaVersion: 1, serverUrl: validateCloudServerUrl(input.serverUrl, 'serverUrl'), updatedAt,
  } as CloudManagementIntent;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Invalid Cloud management timestamp');
  }
  return value;
}
