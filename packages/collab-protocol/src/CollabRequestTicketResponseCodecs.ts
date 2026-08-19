import { COLLAB_LIMITS } from './CollabConstants';
import { CollabError } from './CollabError';
import {
  type AcceptResponse,
  type CreateCommentResponse,
  type CreateTicketCommentResponse,
  type CreateTicketResponse,
  type EnsureMyRequestResponse,
  type TicketMutationResponse,
  type UpdateMyRequestMetadataResponse,
} from './CollabProtocol';
import {
  type CollabChangedFile,
  type CollabChangeRequest,
  type CollabComment,
  type CollabRequestDetail,
  type CollabRequestTicketRelation,
  type CollabTicketAcceptedRelation,
  type CollabTicketComment,
  type CollabTicketDetail,
  type CollabTicketPage,
  type CollabTicketSummary,
} from './types';
import {
  COLLAB_GIT_OID_PATTERN,
  COLLAB_MEMBER_ID_PATTERN,
  COLLAB_OPAQUE_ID_PATTERN,
  hasUtf8ByteLengthAtMost,
} from './CollabValidation';

type UnknownRecord = Readonly<Record<string, unknown>>;

function decodeError(field: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    recoveryActions: ['retry'],
    safeContext: { field },
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) throw decodeError(field);
  return value;
}

function string(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  pattern?: RegExp,
  unit: 'utf16' | 'utf8' = 'utf16',
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || (unit === 'utf8'
      ? !hasUtf8ByteLengthAtMost(candidate, maxLength)
      : candidate.length > maxLength)
    || (pattern && !pattern.test(candidate))
  ) {
    throw decodeError(field);
  }
  return candidate;
}

function text(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  unit: 'utf16' | 'utf8' = 'utf16',
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string'
    || (unit === 'utf8'
      ? !hasUtf8ByteLengthAtMost(candidate, maxLength)
      : candidate.length > maxLength)
  ) throw decodeError(field);
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
  if (
    typeof candidate !== 'number'
    || !Number.isSafeInteger(candidate)
    || candidate < 0
  ) {
    throw decodeError(field);
  }
  return candidate;
}

function positiveInteger(value: UnknownRecord, field: string): number {
  const candidate = nonNegativeInteger(value, field);
  if (candidate < 1) throw decodeError(field);
  return candidate;
}

function requestTicketRelation(value: unknown): CollabRequestTicketRelation {
  const source = record(value, 'request.ticketRelations');
  const kind = source.kind;
  const state = source.state;
  if (
    (kind !== 'references' && kind !== 'resolves')
    || (state !== 'pending' && state !== 'accepted')
  ) {
    throw decodeError('request.ticketRelations');
  }
  return {
    commitOid: string(source, 'commitOid', 64, COLLAB_GIT_OID_PATTERN),
    id: string(source, 'id', 128, COLLAB_OPAQUE_ID_PATTERN),
    kind,
    state,
    ticketId: string(source, 'ticketId', 128, COLLAB_OPAQUE_ID_PATTERN),
    ticketNumber: positiveInteger(source, 'ticketNumber'),
    ticketRevision: positiveInteger(source, 'ticketRevision'),
    ticketTitle: string(source, 'ticketTitle', COLLAB_LIMITS.maxTicketTitleUtf16),
  };
}

function changeRequest(value: unknown): CollabChangeRequest {
  const source = record(value, 'request');
  const status = source.status;
  if (
    (status !== 'open' && status !== 'merged' && status !== 'discarded')
    || !Array.isArray(source.ticketRelations)
    || source.ticketRelations.length > COLLAB_LIMITS.maxRequestTicketRelations
  ) {
    throw decodeError('request.status');
  }
  const mergedOid = source.mergedOid === undefined
    ? undefined
    : string(source, 'mergedOid', 64, COLLAB_GIT_OID_PATTERN);
  return {
    commentCount: nonNegativeInteger(source, 'commentCount'),
    createdAt: timestamp(source, 'createdAt'),
    description: text(source, 'description', COLLAB_LIMITS.maxRequestDescriptionBytes, 'utf8'),
    firstBaseOid: string(source, 'firstBaseOid', 64, COLLAB_GIT_OID_PATTERN),
    id: string(source, 'id', 128, COLLAB_OPAQUE_ID_PATTERN),
    latestHeadOid: string(source, 'latestHeadOid', 64, COLLAB_GIT_OID_PATTERN),
    memberId: string(source, 'memberId', 64, COLLAB_MEMBER_ID_PATTERN),
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
    : string(source, 'closedByMemberId', 64, COLLAB_MEMBER_ID_PATTERN);
  if (
    (status !== 'open' && status !== 'closed')
    || (status === 'open' && (closedAt !== undefined || closedByMemberId !== undefined))
    || (status === 'closed' && (closedAt === undefined || closedByMemberId === undefined))
  ) {
    throw decodeError('ticket.status');
  }
  return {
    authorMemberId: string(source, 'authorMemberId', 64, COLLAB_MEMBER_ID_PATTERN),
    ...(closedAt && closedByMemberId ? { closedAt, closedByMemberId } : {}),
    commentCount: nonNegativeInteger(source, 'commentCount'),
    createdAt: timestamp(source, 'createdAt'),
    id: string(source, 'id', 128, COLLAB_OPAQUE_ID_PATTERN),
    number: positiveInteger(source, 'number'),
    revision: positiveInteger(source, 'revision'),
    status,
    title: string(source, 'title', COLLAB_LIMITS.maxTicketTitleUtf16),
    updatedAt: timestamp(source, 'updatedAt'),
  };
}

function ticketComment(value: unknown): CollabTicketComment {
  const source = record(value, 'ticket.comment');
  return {
    authorMemberId: string(source, 'authorMemberId', 64, COLLAB_MEMBER_ID_PATTERN),
    body: string(source, 'body', COLLAB_LIMITS.maxTicketCommentBytes, undefined, 'utf8'),
    createdAt: timestamp(source, 'createdAt'),
    id: string(source, 'id', 128, COLLAB_OPAQUE_ID_PATTERN),
    ticketId: string(source, 'ticketId', 128, COLLAB_OPAQUE_ID_PATTERN),
  };
}

function acceptedTicketRelation(value: unknown): CollabTicketAcceptedRelation {
  const source = record(value, 'ticket.acceptedRelation');
  const kind = source.kind;
  if (kind !== 'references' && kind !== 'resolves') {
    throw decodeError('ticket.acceptedRelation.kind');
  }
  return {
    acceptedAt: timestamp(source, 'acceptedAt'),
    acceptedMergeOid: string(source, 'acceptedMergeOid', 64, COLLAB_GIT_OID_PATTERN),
    commitOid: string(source, 'commitOid', 64, COLLAB_GIT_OID_PATTERN),
    id: string(source, 'id', 128, COLLAB_OPAQUE_ID_PATTERN),
    kind,
    requestId: string(source, 'requestId', 128, COLLAB_OPAQUE_ID_PATTERN),
  };
}

function ticketDetail(value: unknown): CollabTicketDetail {
  const source = record(value, 'ticketDetail');
  if (
    !Array.isArray(source.comments)
    || source.comments.length > COLLAB_LIMITS.maxTicketComments
    || !Array.isArray(source.acceptedRelations)
  ) {
    throw decodeError('ticketDetail');
  }
  const decodedTicket = ticketSummary(source.ticket);
  const comments = source.comments.map(ticketComment);
  if (comments.some(commentValue => commentValue.ticketId !== decodedTicket.id)) {
    throw decodeError('ticketDetail.comments');
  }
  return {
    acceptedRelations: source.acceptedRelations.map(acceptedTicketRelation),
    body: string(source, 'body', COLLAB_LIMITS.maxTicketBodyBytes, undefined, 'utf8'),
    comments,
    ticket: decodedTicket,
  };
}

function comment(value: unknown): CollabComment {
  const source = record(value, 'comment');
  return {
    authorMemberId: string(source, 'authorMemberId', 64, COLLAB_MEMBER_ID_PATTERN),
    body: string(source, 'body', COLLAB_LIMITS.maxCommentBytes, undefined, 'utf8'),
    createdAt: timestamp(source, 'createdAt'),
    id: string(source, 'id', 128, COLLAB_OPAQUE_ID_PATTERN),
    requestId: string(source, 'requestId', 128, COLLAB_OPAQUE_ID_PATTERN),
  };
}

function changedFile(value: unknown): CollabChangedFile {
  const source = record(value, 'changedFile');
  const kind = source.kind;
  if (
    !['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed']
      .includes(String(kind))
    || typeof source.binary !== 'boolean'
    || typeof source.largeForReview !== 'boolean'
  ) {
    throw decodeError('changedFile');
  }
  const previousPath = source.previousPath === undefined
    ? undefined
    : string(source, 'previousPath', 240);
  const optionalCount = (field: string): number | undefined => (
    source[field] === undefined ? undefined : nonNegativeInteger(source, field)
  );
  const oldBytes = optionalCount('oldBytes');
  const newBytes = optionalCount('newBytes');
  const additions = optionalCount('additions');
  const deletions = optionalCount('deletions');
  return {
    ...(additions === undefined ? {} : { additions }),
    binary: source.binary,
    ...(deletions === undefined ? {} : { deletions }),
    kind: kind as CollabChangedFile['kind'],
    largeForReview: source.largeForReview,
    ...(newBytes === undefined ? {} : { newBytes }),
    ...(oldBytes === undefined ? {} : { oldBytes }),
    path: string(source, 'path', 240),
    ...(previousPath ? { previousPath } : {}),
  };
}

function envelopeData(value: unknown): unknown {
  return value;
}

export function decodeEnsureMyRequestResponse(value: unknown): EnsureMyRequestResponse {
  const data = record(envelopeData(value), 'data');
  return {
    mainOid: string(data, 'mainOid', 64, COLLAB_GIT_OID_PATTERN),
    request: changeRequest(data.request),
  };
}

export function decodeRequestDetailResponse(value: unknown): CollabRequestDetail {
  const data = record(envelopeData(value), 'data');
  if (
    !Array.isArray(data.changedFiles)
    || data.changedFiles.length > COLLAB_LIMITS.maxChangedPaths
    || !Array.isArray(data.comments)
  ) {
    throw decodeError('requestDetail');
  }
  const decodedRequest = changeRequest(data.request);
  const reviewedHeadOid = string(data, 'reviewedHeadOid', 64, COLLAB_GIT_OID_PATTERN);
  const reviewCondition = data.reviewCondition;
  const comments = data.comments.map(comment);
  if (
    reviewedHeadOid !== decodedRequest.latestHeadOid
    || !['clean', 'conflicting', 'stale'].includes(String(reviewCondition))
    || comments.some(item => item.requestId !== decodedRequest.id)
    || comments.length !== decodedRequest.commentCount
  ) {
    throw decodeError('requestDetail');
  }
  return {
    changedFiles: data.changedFiles.map(changedFile),
    comments,
    currentMainOid: string(data, 'currentMainOid', 64, COLLAB_GIT_OID_PATTERN),
    request: decodedRequest,
    reviewCondition: reviewCondition as CollabRequestDetail['reviewCondition'],
    reviewedHeadOid,
  };
}

export function decodeCreateCommentResponse(value: unknown): CreateCommentResponse {
  const data = record(envelopeData(value), 'data');
  const decodedRequest = changeRequest(data.request);
  const decodedComment = comment(data.comment);
  if (
    decodedComment.requestId !== decodedRequest.id
    || decodedRequest.commentCount < 1
  ) {
    throw decodeError('commentResponse');
  }
  return { comment: decodedComment, request: decodedRequest };
}

export function decodeAcceptResponse(value: unknown): AcceptResponse {
  const data = record(envelopeData(value), 'data');
  const mainOid = string(data, 'mainOid', 64, COLLAB_GIT_OID_PATTERN);
  const mergeCommitOid = string(data, 'mergeCommitOid', 64, COLLAB_GIT_OID_PATTERN);
  const decodedRequest = changeRequest(data.request);
  if (
    mergeCommitOid !== mainOid
    || decodedRequest.status !== 'merged'
    || decodedRequest.mergedOid !== mainOid
  ) {
    throw decodeError('acceptResponse');
  }
  return { mainOid, mergeCommitOid, request: decodedRequest };
}

export function decodeTicketPageResponse(value: unknown): CollabTicketPage {
  const data = record(envelopeData(value), 'data');
  if (
    !Array.isArray(data.tickets)
    || data.tickets.length > COLLAB_LIMITS.maxTicketPageSize
  ) throw decodeError('ticketPage');
  const nextCursor = data.nextCursor === undefined
    ? undefined
    : string(data, 'nextCursor', 512);
  return {
    ...(nextCursor ? { nextCursor } : {}),
    tickets: data.tickets.map(ticketSummary),
  };
}

export function decodeTicketDetailResponse(value: unknown): CollabTicketDetail {
  return ticketDetail(envelopeData(value));
}

export function decodeCreateTicketResponse(value: unknown): CreateTicketResponse {
  return { ticket: ticketDetail(record(envelopeData(value), 'data').ticket) };
}

export function decodeTicketMutationResponse(value: unknown): TicketMutationResponse {
  return { ticket: ticketSummary(record(envelopeData(value), 'data').ticket) };
}

export function decodeTicketCommentResponse(value: unknown): CreateTicketCommentResponse {
  const data = record(envelopeData(value), 'data');
  const decodedTicket = ticketSummary(data.ticket);
  const decodedComment = ticketComment(data.comment);
  if (decodedComment.ticketId !== decodedTicket.id) {
    throw decodeError('ticketCommentResponse');
  }
  return { comment: decodedComment, ticket: decodedTicket };
}

export function decodeUpdateRequestMetadataResponse(
  value: unknown,
): UpdateMyRequestMetadataResponse {
  return { request: changeRequest(record(envelopeData(value), 'data').request) };
}
