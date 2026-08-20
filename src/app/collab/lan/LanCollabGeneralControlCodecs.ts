import {
  type CollabDecodeResult,
  CollabError as SharedCollabError,
  type CollabMember,
  collabMemberRef,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian/collab-protocol';

import {
  decodeLanCollabInvitation,
} from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import type {
  CreateJoinAttemptResponse,
  LanCollabControlOperationMap,
  MembershipTerminationResponse,
} from '@/app/collab/lan/LanCollabControlOperations';
import { decodeLanCollabEnvelopeData } from '@/app/collab/lan/LanCollabEnvelope';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type UnknownRecord = Readonly<Record<string, unknown>>;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type CollabGeneralControlOperation =
  | 'activateJoinAttempt'
  | 'confirmEndpoint'
  | 'createInvitation'
  | 'createJoinAttempt'
  | 'getSnapshot'
  | 'refreshEndpoint'
  | 'removeMember'
  | 'revokeInvitation';

type GeneralRequest<Operation extends CollabGeneralControlOperation> =
  LanCollabControlOperationMap[Operation]['request'];

function invalid<T>(reason: string): CollabDecodeResult<T> {
  return {
    error: new SharedCollabError({
      code: 'protocol-payload-invalid',
      safeContext: { reason },
    }),
    status: 'invalid',
  };
}

function decodeError(field: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { field },
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isMutationContext(value: UnknownRecord): boolean {
  return isCollabProjectId(value.projectId) && isCollabOpaqueId(value.idempotencyKey);
}

export function decodeCollabGeneralOperationRequest<
  Operation extends CollabGeneralControlOperation,
>(
  operation: Operation,
  input: unknown,
): CollabDecodeResult<GeneralRequest<Operation>> {
  if (!isRecord(input)) {
    const reason = operation === 'createJoinAttempt'
      ? 'join-request-invalid'
      : operation === 'activateJoinAttempt'
        ? 'activation-request-invalid'
        : operation === 'removeMember'
          ? 'membership-mutation-request-invalid'
          : operation === 'refreshEndpoint'
            ? 'endpoint-refresh-request-invalid'
            : 'mutation-request-invalid';
    return invalid(reason);
  }
  switch (operation) {
    case 'createJoinAttempt':
      if (!isCollabProjectId(input.projectId)) return invalid('projectId-invalid');
      if (
        typeof input.displayName !== 'string'
        || input.displayName.length === 0
        || input.displayName.length > 200
      ) return invalid('displayName-invalid');
      if (!isCollabOpaqueId(input.joinAttemptId)) return invalid('joinAttemptId-invalid');
      break;
    case 'activateJoinAttempt':
      if (!isCollabProjectId(input.projectId)) return invalid('projectId-invalid');
      if (!isCollabOpaqueId(input.joinAttemptId)) return invalid('joinAttemptId-invalid');
      if (!isCollabOpaqueId(input.idempotencyKey)) return invalid('idempotencyKey-invalid');
      break;
    case 'getSnapshot':
    case 'confirmEndpoint':
      if (!isCollabProjectId(input.projectId)) return invalid('projectId-invalid');
      break;
    case 'createInvitation':
    case 'revokeInvitation':
      if (!isMutationContext(input)) return invalid('mutation-request-mismatch');
      break;
    case 'refreshEndpoint': {
      if (!isCollabProjectId(input.projectId)) return invalid('endpoint-refresh-request-invalid');
      const invitation = decodeLanCollabInvitation(input.invitation);
      if (invitation.status !== 'ok') return invalid('invitation-invalid');
      if (invitation.value.projectId !== input.projectId) {
        return invalid('endpoint-refresh-project-mismatch');
      }
      break;
    }
    case 'removeMember':
      if (!hasExactKeys(input, ['idempotencyKey', 'memberId', 'projectId'])) {
        return invalid('membership-mutation-request-invalid');
      }
      if (!isMutationContext(input)) return invalid('membership-mutation-request-mismatch');
      if (!isCollabMemberId(input.memberId)) return invalid('membership-removal-request-invalid');
      break;
  }
  return { status: 'ok', value: input as unknown as GeneralRequest<Operation> };
}

function record(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) throw decodeError(field);
  return value;
}

function string(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  validation?: RegExp | ((candidate: unknown) => boolean),
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || candidate.length > maxLength
    || (validation && (validation instanceof RegExp
      ? !validation.test(candidate)
      : !validation(candidate)))
  ) throw decodeError(field);
  return candidate;
}

function isoTimestamp(value: UnknownRecord, field: string): string {
  const candidate = string(value, field, 64);
  if (Number.isNaN(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate) {
    throw decodeError(field);
  }
  return candidate;
}

function member(value: unknown): CollabMember {
  const source = record(value, 'member');
  const id = string(source, 'id', 64, isCollabMemberId);
  const personalRef = string(source, 'personalRef', 256);
  const role = source.role;
  const status = source.status;
  if (
    personalRef !== collabMemberRef(id)
    || (role !== 'manager' && role !== 'member')
    || !['pending', 'active', 'revoked', 'left'].includes(String(status))
  ) throw decodeError('member');
  const activatedAt = source.activatedAt === undefined
    ? undefined
    : isoTimestamp(source, 'activatedAt');
  const revokedAt = source.revokedAt === undefined
    ? undefined
    : isoTimestamp(source, 'revokedAt');
  return {
    ...(activatedAt ? { activatedAt } : {}),
    createdAt: isoTimestamp(source, 'createdAt'),
    displayName: string(source, 'displayName', 200),
    id,
    personalRef,
    ...(revokedAt ? { revokedAt } : {}),
    role,
    status: status as CollabMember['status'],
  };
}

function envelopeData(value: unknown): unknown {
  return decodeLanCollabEnvelopeData(value);
}

export function decodeJoinAttemptResponse(value: unknown): CreateJoinAttemptResponse {
  const data = record(envelopeData(value), 'data');
  const attempt = record(data.joinAttempt, 'joinAttempt');
  return { joinAttempt: {
    expiresAt: isoTimestamp(attempt, 'expiresAt'),
    id: string(attempt, 'id', 128, isCollabOpaqueId),
    member: member(attempt.member),
    memberCredential: string(attempt, 'memberCredential', 43, CREDENTIAL_PATTERN),
    projectId: string(attempt, 'projectId', 64, isCollabProjectId),
  } };
}

export function decodeMembershipTerminationResponse(
  value: unknown,
): MembershipTerminationResponse {
  const data = record(envelopeData(value), 'data');
  const discardedRequestId = data.discardedRequestId;
  if (discardedRequestId !== null && !isCollabOpaqueId(discardedRequestId)) {
    throw decodeError('discardedRequestId');
  }
  if (data.status !== 'left' && data.status !== 'revoked') {
    throw decodeError('membershipStatus');
  }
  return {
    discardedRequestId,
    memberId: string(data, 'memberId', 64, isCollabMemberId),
    projectId: string(data, 'projectId', 64, isCollabProjectId),
    status: data.status,
  };
}

export function decodeInvitationResponse(
  value: unknown,
): LanCollabControlOperationMap['createInvitation']['response'] {
  const data = record(envelopeData(value), 'data');
  const invitation = decodeLanCollabInvitation(data.invitation);
  if (invitation.status !== 'ok') throw decodeError('invitation');
  const encodedInvitation = data.encodedInvitation;
  if (typeof encodedInvitation !== 'string') throw decodeError('encodedInvitation');
  const match = new RegExp(
    `^claudian-collab:v${COLLAB_CONTROL_PROTOCOL_VERSION}:([A-Za-z0-9_-]+)$`,
  ).exec(encodedInvitation);
  if (!match) throw decodeError('encodedInvitation');
  let encoded: ReturnType<typeof decodeLanCollabInvitation>;
  try {
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) throw new Error('non-canonical');
    encoded = decodeLanCollabInvitation(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw decodeError('encodedInvitation');
  }
  if (encoded.status !== 'ok') throw decodeError('invitation');
  const fields = [
    'caFingerprint', 'endpoint', 'expiresAt', 'invitationId',
    'invitationSecret', 'projectId', 'protocolVersion',
  ] as const;
  if (fields.some(field => invitation.value[field] !== encoded.value[field])) {
    throw decodeError('invitationResponse');
  }
  return { encodedInvitation, invitation: invitation.value };
}

export function decodeEndpointResponse(
  value: unknown,
): LanCollabControlOperationMap['refreshEndpoint']['response'] {
  const data = record(envelopeData(value), 'data');
  if (typeof data.caFingerprint !== 'string' || typeof data.endpoint !== 'string') {
    throw decodeError('refreshEndpointResponse');
  }
  return {
    caFingerprint: data.caFingerprint,
    endpoint: data.endpoint,
  };
}
