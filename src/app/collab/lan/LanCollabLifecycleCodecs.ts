import { type CollabDecodeResult, CollabError, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import type {
  LanCollabControlOperationMap,
  LanCollabLifecycleControlOperation,
} from '@/app/collab/lan/LanCollabControlOperations';
import { decodeLanCollabHostTrustTransitionProof } from '@/app/collab/lan/LanCollabHostTrustTransitionProof';

type LifecycleRequest<Operation extends LanCollabLifecycleControlOperation> =
  LanCollabControlOperationMap[Operation]['request'];
type LifecycleResponse<Operation extends LanCollabLifecycleControlOperation> =
  LanCollabControlOperationMap[Operation]['response'];
type UnknownRecord = Readonly<Record<string, unknown>>;

const SHA256_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CERTIFICATE_PATTERN = /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE-----\n?$/;

function invalid<T>(field: string): CollabDecodeResult<T> {
  return {
    error: new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { field },
    }),
    status: 'invalid',
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username.length === 0
      && url.password.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

function isCertificatePem(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64 * 1024
    && CERTIFICATE_PATTERN.test(value);
}

function isMutationContext(value: UnknownRecord): boolean {
  return isCollabProjectId(value.projectId) && isCollabOpaqueId(value.idempotencyKey);
}

function validRequest(
  operation: LanCollabLifecycleControlOperation,
  input: UnknownRecord,
): boolean {
  switch (operation) {
    case 'leaveProject':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'expectedMemberId',
        'expectedHostMemberId', 'idempotencyManagerMemberId',
      ], ['managerResponsibilityOfferId'])
        && isMutationContext(input)
        && isCollabMemberId(input.expectedMemberId)
        && isCollabMemberId(input.expectedHostMemberId)
        && (input.idempotencyManagerMemberId === null
          || isCollabMemberId(input.idempotencyManagerMemberId))
        && (input.managerResponsibilityOfferId === undefined
          || isCollabOpaqueId(input.managerResponsibilityOfferId));
    case 'createManagerResponsibilityOffer':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'purpose', 'targetMemberId',
      ])
        && isMutationContext(input)
        && (input.purpose === 'manager-promotion' || input.purpose === 'manager-leave')
        && isCollabMemberId(input.targetMemberId);
    case 'getCurrentManagerResponsibilityOffer':
    case 'getHostTransitions':
      return hasExactKeys(input, ['projectId']) && isCollabProjectId(input.projectId);
    case 'getManagerResponsibilityOffer':
      return hasExactKeys(input, ['projectId', 'offerId'])
        && isCollabProjectId(input.projectId)
        && isCollabOpaqueId(input.offerId);
    case 'acknowledgeManagerResponsibility':
    case 'declineManagerResponsibility':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'offerId', 'expectedTargetMemberId',
      ])
        && isMutationContext(input)
        && isCollabOpaqueId(input.offerId)
        && isCollabMemberId(input.expectedTargetMemberId);
    case 'cancelManagerResponsibilityOffer':
      return hasExactKeys(input, ['projectId', 'idempotencyKey', 'offerId'])
        && isMutationContext(input)
        && isCollabOpaqueId(input.offerId);
    case 'promoteManager':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'targetMemberId',
        'managerResponsibilityOfferId',
      ])
        && isMutationContext(input)
        && isCollabMemberId(input.targetMemberId)
        && isCollabOpaqueId(input.managerResponsibilityOfferId);
    case 'demoteManager':
      return hasExactKeys(input, ['projectId', 'idempotencyKey', 'targetMemberId'])
        && isMutationContext(input)
        && isCollabMemberId(input.targetMemberId);
    case 'createHostTransfer':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'expectedHostMemberId', 'targetMemberId',
      ])
        && isMutationContext(input)
        && isCollabMemberId(input.expectedHostMemberId)
        && isCollabMemberId(input.targetMemberId);
    case 'acceptHostTransfer':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'transferId', 'targetEndpoint',
        'targetCaCertificatePem', 'targetCaFingerprint', 'receiverCredential',
      ])
        && isMutationContext(input)
        && isCollabOpaqueId(input.transferId)
        && isHttpsEndpoint(input.targetEndpoint)
        && isCertificatePem(input.targetCaCertificatePem)
        && typeof input.targetCaFingerprint === 'string'
        && SHA256_FINGERPRINT_PATTERN.test(input.targetCaFingerprint)
        && typeof input.receiverCredential === 'string'
        && CREDENTIAL_PATTERN.test(input.receiverCredential);
    case 'declineHostTransfer':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'transferId', 'expectedTargetMemberId',
      ])
        && isMutationContext(input)
        && isCollabOpaqueId(input.transferId)
        && isCollabMemberId(input.expectedTargetMemberId);
    case 'cancelHostTransfer':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'transferId', 'expectedHostMemberId',
      ])
        && isMutationContext(input)
        && isCollabOpaqueId(input.transferId)
        && isCollabMemberId(input.expectedHostMemberId);
    case 'retireProject':
      return hasExactKeys(input, [
        'projectId', 'idempotencyKey', 'managerActorMemberId', 'expectedHostMemberId',
      ])
        && isMutationContext(input)
        && isCollabMemberId(input.managerActorMemberId)
        && isCollabMemberId(input.expectedHostMemberId);
    case 'acknowledgeRetirement':
      return hasExactKeys(input, ['projectId', 'idempotencyKey', 'retiredAt'])
        && isMutationContext(input)
        && isIsoTimestamp(input.retiredAt);
  }
}

export function decodeLanCollabLifecycleOperationRequest<
  Operation extends LanCollabLifecycleControlOperation,
>(
  operation: Operation,
  input: unknown,
): CollabDecodeResult<LifecycleRequest<Operation>> {
  if (!isRecord(input) || !validRequest(operation, input)) {
    return invalid(`lifecycleRequest.${operation}`);
  }
  return { status: 'ok', value: input as unknown as LifecycleRequest<Operation> };
}

function isMembershipTermination(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['discardedRequestId', 'memberId', 'projectId', 'status'])
    && (value.discardedRequestId === null || isCollabOpaqueId(value.discardedRequestId))
    && isCollabMemberId(value.memberId)
    && isCollabProjectId(value.projectId)
    && (value.status === 'left' || value.status === 'revoked');
}

function isManagerOffer(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'offerId', 'purpose', 'sourceManagerMemberId', 'targetMemberId',
    'status', 'offeredAt', 'expiresAt',
  ], ['acknowledgedAt'])) return false;
  return isCollabOpaqueId(value.offerId)
    && (value.purpose === 'manager-promotion' || value.purpose === 'manager-leave')
    && isCollabMemberId(value.sourceManagerMemberId)
    && isCollabMemberId(value.targetMemberId)
    && typeof value.status === 'string'
    && ['offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired']
      .includes(value.status)
    && isIsoTimestamp(value.offeredAt)
    && isIsoTimestamp(value.expiresAt)
    && (value.acknowledgedAt === undefined || isIsoTimestamp(value.acknowledgedAt));
}

function isManagerRoleMutation(
  value: unknown,
  memberField: 'promotedMemberId' | 'demotedMemberId',
): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['projectId', memberField, 'managerSetGeneration'])
    && isCollabMemberId(value[memberField])
    && isCollabProjectId(value.projectId)
    && typeof value.managerSetGeneration === 'number'
    && Number.isSafeInteger(value.managerSetGeneration)
    && value.managerSetGeneration >= 0;
}

function isHostTransfer(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'transferId', 'targetMemberId', 'phase', 'offeredAt', 'expiresAt',
    'canAccept', 'canDecline', 'canCancel',
  ])) return false;
  return isCollabOpaqueId(value.transferId)
    && isCollabMemberId(value.targetMemberId)
    && typeof value.phase === 'string'
    && [
      'offered', 'accepted', 'transferring', 'recovery-required',
      'completed', 'cancelled', 'declined', 'expired',
    ].includes(value.phase)
    && isIsoTimestamp(value.offeredAt)
    && isIsoTimestamp(value.expiresAt)
    && typeof value.canAccept === 'boolean'
    && typeof value.canDecline === 'boolean'
    && typeof value.canCancel === 'boolean';
}

function validResponse(
  operation: LanCollabLifecycleControlOperation,
  input: unknown,
): boolean {
  switch (operation) {
    case 'leaveProject': return isMembershipTermination(input);
    case 'createManagerResponsibilityOffer':
    case 'getManagerResponsibilityOffer':
    case 'acknowledgeManagerResponsibility':
    case 'declineManagerResponsibility':
    case 'cancelManagerResponsibilityOffer': return isManagerOffer(input);
    case 'getCurrentManagerResponsibilityOffer': return input === null || isManagerOffer(input);
    case 'promoteManager': return isManagerRoleMutation(input, 'promotedMemberId');
    case 'demoteManager': return isManagerRoleMutation(input, 'demotedMemberId');
    case 'createHostTransfer':
    case 'acceptHostTransfer':
    case 'declineHostTransfer':
    case 'cancelHostTransfer': return isHostTransfer(input);
    case 'retireProject':
      return isRecord(input)
        && hasExactKeys(input, ['projectId', 'retiredAt'])
        && isCollabProjectId(input.projectId)
        && isIsoTimestamp(input.retiredAt);
    case 'acknowledgeRetirement':
      return isRecord(input)
        && hasExactKeys(input, ['projectId', 'retiredAt', 'acknowledgedAt'])
        && isCollabProjectId(input.projectId)
        && isIsoTimestamp(input.retiredAt)
        && isIsoTimestamp(input.acknowledgedAt);
    case 'getHostTransitions':
      if (!isRecord(input)
        || !hasExactKeys(input, ['projectId', 'proofs'])
        || !isCollabProjectId(input.projectId)
        || !Array.isArray(input.proofs)
        || input.proofs.length > 64) return false;
      return input.proofs.every((proof) => {
        const decoded = decodeLanCollabHostTrustTransitionProof(proof);
        return decoded.status === 'ok' && decoded.value.projectId === input.projectId;
      });
  }
}

export function decodeLanCollabLifecycleOperationResponse<
  Operation extends LanCollabLifecycleControlOperation,
>(
  operation: Operation,
  input: unknown,
): CollabDecodeResult<LifecycleResponse<Operation>> {
  if (!validResponse(operation, input)) {
    return invalid(`lifecycleResponse.${operation}`);
  }
  return { status: 'ok', value: input as LifecycleResponse<Operation> };
}
