import { COLLAB_LIMITS, COLLAB_MAIN_REF, type CollabChangeRequest, type CollabMember, collabMemberRef, type CollabRequestTicketRelation, type CollabTicketSummary, isCollabGitOid, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import { decodeLanCollabLifecycleOperationResponse } from '@/app/collab/lan/LanCollabLifecycleCodecs';
import type {
  CollabHostTransferSummary,
  CollabLanProject,
  CollabLanProjectSnapshot,
  CollabManagerResponsibilityOfferSummary,
} from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type UnknownRecord = Readonly<Record<string, unknown>>;

function decodeError(field: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { field },
  });
}

function record(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw decodeError(field);
  return value as UnknownRecord;
}

function string(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  validation?: (candidate: unknown) => boolean,
  unit: 'utf16' | 'utf8' = 'utf16',
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || (unit === 'utf8'
      ? Buffer.byteLength(candidate, 'utf8') > maxLength
      : candidate.length > maxLength)
    || (validation && !validation(candidate))
  ) throw decodeError(field);
  return candidate;
}

function text(
  value: UnknownRecord,
  field: string,
  maxLength: number,
): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || Buffer.byteLength(candidate, 'utf8') > maxLength) {
    throw decodeError(field);
  }
  return candidate;
}

function timestamp(value: UnknownRecord, field: string): string {
  const candidate = string(value, field, 64);
  if (Number.isNaN(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate) {
    throw decodeError(field);
  }
  return candidate;
}

function optionalTimestamp(value: UnknownRecord, field: string): string | undefined {
  return value[field] === undefined ? undefined : timestamp(value, field);
}

function nonNegativeInteger(value: UnknownRecord, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw decodeError(field);
  }
  return candidate;
}

function boundedNonNegativeInteger(
  value: UnknownRecord,
  field: string,
  maximum: number,
): number {
  const candidate = nonNegativeInteger(value, field);
  if (candidate > maximum) throw decodeError(field);
  return candidate;
}

function positiveInteger(value: UnknownRecord, field: string): number {
  const candidate = nonNegativeInteger(value, field);
  if (candidate < 1) throw decodeError(field);
  return candidate;
}

function requestTicketRelation(value: unknown): CollabRequestTicketRelation {
  const source = record(value, 'request.ticketRelations');
  if (
    (source.kind !== 'references' && source.kind !== 'resolves')
    || (source.state !== 'pending' && source.state !== 'accepted')
  ) throw decodeError('request.ticketRelations');
  return {
    commitOid: string(source, 'commitOid', 64, isCollabGitOid),
    id: string(source, 'id', 128, isCollabOpaqueId),
    kind: source.kind,
    state: source.state,
    ticketId: string(source, 'ticketId', 128, isCollabOpaqueId),
    ticketNumber: positiveInteger(source, 'ticketNumber'),
    ticketRevision: positiveInteger(source, 'ticketRevision'),
    ticketTitle: string(source, 'ticketTitle', CLAUDIAN_COLLAB_LIMITS.maxTicketTitleUtf16),
  };
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
  const activatedAt = optionalTimestamp(source, 'activatedAt');
  const revokedAt = optionalTimestamp(source, 'revokedAt');
  return {
    ...(activatedAt ? { activatedAt } : {}),
    createdAt: timestamp(source, 'createdAt'),
    displayName: string(source, 'displayName', 200),
    id,
    personalRef,
    ...(revokedAt ? { revokedAt } : {}),
    role,
    status: status as CollabMember['status'],
  };
}

function changeRequest(value: unknown): CollabChangeRequest {
  const source = record(value, 'request');
  const status = source.status;
  if (
    (status !== 'open' && status !== 'merged' && status !== 'discarded')
    || !Array.isArray(source.ticketRelations)
    || source.ticketRelations.length > CLAUDIAN_COLLAB_LIMITS.maxRequestTicketRelations
  ) throw decodeError('request.status');
  const mergedOid = source.mergedOid === undefined
    ? undefined
    : string(source, 'mergedOid', 64, isCollabGitOid);
  return {
    commentCount: boundedNonNegativeInteger(
      source,
      'commentCount',
      COLLAB_LIMITS.maxRequestComments,
    ),
    createdAt: timestamp(source, 'createdAt'),
    description: text(source, 'description', CLAUDIAN_COLLAB_LIMITS.maxRequestDescriptionBytes),
    firstBaseOid: string(source, 'firstBaseOid', 64, isCollabGitOid),
    id: string(source, 'id', 128, isCollabOpaqueId),
    latestHeadOid: string(source, 'latestHeadOid', 64, isCollabGitOid),
    memberId: string(source, 'memberId', 64, isCollabMemberId),
    ...(mergedOid ? { mergedOid } : {}),
    revision: nonNegativeInteger(source, 'revision'),
    status,
    ticketRelations: source.ticketRelations.map(requestTicketRelation),
    updatedAt: timestamp(source, 'updatedAt'),
  };
}

function ticketSummary(value: unknown): CollabTicketSummary {
  const source = record(value, 'ticket');
  const status = source.status;
  const closedAt = optionalTimestamp(source, 'closedAt');
  const closedByMemberId = source.closedByMemberId === undefined
    ? undefined
    : string(source, 'closedByMemberId', 64, isCollabMemberId);
  if (
    (status !== 'open' && status !== 'closed')
    || (status === 'open' && (closedAt !== undefined || closedByMemberId !== undefined))
    || (status === 'closed' && (closedAt === undefined || closedByMemberId === undefined))
  ) throw decodeError('ticket.status');
  return {
    acceptedRelationCount: boundedNonNegativeInteger(
      source,
      'acceptedRelationCount',
      COLLAB_LIMITS.maxTicketAcceptedRelations,
    ),
    authorMemberId: string(source, 'authorMemberId', 64, isCollabMemberId),
    ...(closedAt && closedByMemberId ? { closedAt, closedByMemberId } : {}),
    commentCount: boundedNonNegativeInteger(
      source,
      'commentCount',
      COLLAB_LIMITS.maxTicketComments,
    ),
    createdAt: timestamp(source, 'createdAt'),
    id: string(source, 'id', 128, isCollabOpaqueId),
    number: positiveInteger(source, 'number'),
    revision: positiveInteger(source, 'revision'),
    status,
    title: string(source, 'title', CLAUDIAN_COLLAB_LIMITS.maxTicketTitleUtf16),
    updatedAt: timestamp(source, 'updatedAt'),
  };
}

function project(value: unknown): CollabLanProject {
  const source = record(value, 'project');
  if (source.authorityKind !== 'lan' || source.mainRef !== COLLAB_MAIN_REF) {
    throw decodeError('project');
  }
  return {
    authorityKind: 'lan',
    createdAt: timestamp(source, 'createdAt'),
    hostMemberId: string(source, 'hostMemberId', 64, isCollabMemberId),
    id: string(source, 'id', 64, isCollabProjectId),
    mainOid: string(source, 'mainOid', 64, isCollabGitOid),
    mainRef: COLLAB_MAIN_REF,
    managerSetGeneration: nonNegativeInteger(source, 'managerSetGeneration'),
    name: string(source, 'name', 200),
  };
}

function managerOffer(value: unknown): CollabManagerResponsibilityOfferSummary {
  const decoded = decodeLanCollabLifecycleOperationResponse(
    'createManagerResponsibilityOffer',
    value,
  );
  if (decoded.status !== 'ok') throw decodeError('snapshot.managerResponsibilityOffer');
  return decoded.value;
}

function hostTransfer(value: unknown): CollabHostTransferSummary {
  const decoded = decodeLanCollabLifecycleOperationResponse('createHostTransfer', value);
  if (decoded.status !== 'ok') throw decodeError('snapshot.hostTransfer');
  return decoded.value;
}

export function decodeLanCollabProjectSnapshot(value: unknown): CollabLanProjectSnapshot {
  const data = record(value, 'snapshot');
  if (
    !Array.isArray(data.members)
    || !Array.isArray(data.openRequests)
    || !Array.isArray(data.ticketHighlights)
    || data.ticketHighlights.length > CLAUDIAN_COLLAB_LIMITS.maxTicketHighlights
  ) throw decodeError('snapshot');
  const currentMember = member(data.currentMember);
  const members = data.members.map(member);
  if (!members.some(candidate => candidate.id === currentMember.id)) {
    throw decodeError('snapshot');
  }
  const decodedManagerOffer = data.managerResponsibilityOffer === undefined
    ? undefined
    : managerOffer(data.managerResponsibilityOffer);
  const decodedHostTransfer = data.hostTransfer === undefined
    ? undefined
    : hostTransfer(data.hostTransfer);
  return {
    currentMember,
    eventSequence: nonNegativeInteger(data, 'eventSequence'),
    ...(decodedHostTransfer ? { hostTransfer: decodedHostTransfer } : {}),
    ...(decodedManagerOffer ? { managerResponsibilityOffer: decodedManagerOffer } : {}),
    members,
    openRequests: data.openRequests.map(changeRequest),
    openTicketCount: nonNegativeInteger(data, 'openTicketCount'),
    project: project(data.project),
    ticketHighlights: data.ticketHighlights.map(ticketSummary),
  };
}
