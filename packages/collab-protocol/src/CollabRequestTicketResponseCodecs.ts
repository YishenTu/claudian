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
  type CollabChangeRequest,
  type CollabComment,
  type CollabCommentPage,
  type CollabRequestDetail,
  type CollabRequestTicketRelation,
  type CollabTicketAcceptedRelation,
  type CollabTicketAcceptedRelationPage,
  type CollabTicketComment,
  type CollabTicketCommentPage,
  type CollabTicketDetail,
  type CollabTicketPage,
  type CollabTicketSummary,
} from './types';
import {
  hasUtf8ByteLengthAtMost,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
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

function assertJsonUtf8ByteLengthAtMost(
  value: unknown,
  maximum: number,
  field: string,
): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw decodeError(field);
  }
  if (
    serialized === undefined
    || !hasUtf8ByteLengthAtMost(serialized, maximum)
  ) {
    throw decodeError(field);
  }
}

function string(
  value: UnknownRecord,
  field: string,
  maxLength: number,
  validate?: (value: string) => boolean,
  unit: 'utf16' | 'utf8' = 'utf16',
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || (unit === 'utf8'
      ? !hasUtf8ByteLengthAtMost(candidate, maxLength)
      : candidate.length > maxLength)
    || (validate && !validate(candidate))
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
  const kind = source.kind;
  const state = source.state;
  if (
    (kind !== 'references' && kind !== 'resolves')
    || (state !== 'pending' && state !== 'accepted')
  ) {
    throw decodeError('request.ticketRelations');
  }
  return {
    commitOid: string(source, 'commitOid', 64, isCollabGitOid),
    id: string(source, 'id', 128, isCollabOpaqueId),
    kind,
    state,
    ticketId: string(source, 'ticketId', 128, isCollabOpaqueId),
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
    : string(source, 'mergedOid', 64, isCollabGitOid);
  return {
    commentCount: boundedNonNegativeInteger(
      source,
      'commentCount',
      COLLAB_LIMITS.maxRequestComments,
    ),
    createdAt: timestamp(source, 'createdAt'),
    description: text(source, 'description', COLLAB_LIMITS.maxRequestDescriptionBytes, 'utf8'),
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
  ) {
    throw decodeError('ticket.status');
  }
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
    title: string(source, 'title', COLLAB_LIMITS.maxTicketTitleUtf16),
    updatedAt: timestamp(source, 'updatedAt'),
  };
}

function ticketComment(value: unknown): CollabTicketComment {
  const source = record(value, 'ticket.comment');
  return {
    authorMemberId: string(source, 'authorMemberId', 64, isCollabMemberId),
    body: string(source, 'body', COLLAB_LIMITS.maxTicketCommentBytes, undefined, 'utf8'),
    createdAt: timestamp(source, 'createdAt'),
    id: string(source, 'id', 128, isCollabOpaqueId),
    ticketId: string(source, 'ticketId', 128, isCollabOpaqueId),
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
    acceptedMergeOid: string(source, 'acceptedMergeOid', 64, isCollabGitOid),
    commitOid: string(source, 'commitOid', 64, isCollabGitOid),
    id: string(source, 'id', 128, isCollabOpaqueId),
    kind,
    requestId: string(source, 'requestId', 128, isCollabOpaqueId),
  };
}

function pageCursor(source: Readonly<Record<string, unknown>>): string | undefined {
  return source.nextCursor === undefined
    ? undefined
    : string(source, 'nextCursor', COLLAB_LIMITS.maxPageCursorUtf16);
}

function commentPage(value: unknown): CollabCommentPage {
  const source = record(value, 'commentPage');
  assertJsonUtf8ByteLengthAtMost(
    source,
    COLLAB_LIMITS.commentPageMaxUtf8Bytes,
    'commentPage.bytes',
  );
  if (
    !Array.isArray(source.comments)
    || source.comments.length > COLLAB_LIMITS.maxCommentPageSize
  ) {
    throw decodeError('commentPage');
  }
  const nextCursor = pageCursor(source);
  return {
    comments: source.comments.map(comment),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function ticketCommentPage(value: unknown): CollabTicketCommentPage {
  const source = record(value, 'ticketCommentPage');
  assertJsonUtf8ByteLengthAtMost(
    source,
    COLLAB_LIMITS.commentPageMaxUtf8Bytes,
    'ticketCommentPage.bytes',
  );
  if (
    !Array.isArray(source.comments)
    || source.comments.length > COLLAB_LIMITS.maxCommentPageSize
  ) {
    throw decodeError('ticketCommentPage');
  }
  const nextCursor = pageCursor(source);
  return {
    comments: source.comments.map(ticketComment),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function acceptedRelationPage(value: unknown): CollabTicketAcceptedRelationPage {
  const source = record(value, 'ticketAcceptedRelationPage');
  assertJsonUtf8ByteLengthAtMost(
    source,
    COLLAB_LIMITS.relationPageMaxUtf8Bytes,
    'ticketAcceptedRelationPage.bytes',
  );
  if (
    !Array.isArray(source.acceptedRelations)
    || source.acceptedRelations.length > COLLAB_LIMITS.maxRelationsPerPage
  ) {
    throw decodeError('ticketAcceptedRelationPage');
  }
  const nextCursor = pageCursor(source);
  return {
    acceptedRelations: source.acceptedRelations.map(acceptedTicketRelation),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function ticketDetail(value: unknown): CollabTicketDetail {
  const source = record(value, 'ticketDetail');
  assertJsonUtf8ByteLengthAtMost(
    source,
    COLLAB_LIMITS.detailMaxUtf8Bytes,
    'ticketDetail.bytes',
  );
  if (
    !isRecord(source.comments)
    || !isRecord(source.acceptedRelations)
  ) {
    throw decodeError('ticketDetail');
  }
  const decodedTicket = ticketSummary(source.ticket);
  const comments = ticketCommentPage(source.comments);
  if (comments.comments.some(commentValue => commentValue.ticketId !== decodedTicket.id)) {
    throw decodeError('ticketDetail.comments');
  }
  const acceptedRelations = acceptedRelationPage(source.acceptedRelations);
  return {
    acceptedRelations,
    body: string(source, 'body', COLLAB_LIMITS.maxTicketBodyBytes, undefined, 'utf8'),
    comments,
    ticket: decodedTicket,
  };
}

function comment(value: unknown): CollabComment {
  const source = record(value, 'comment');
  return {
    authorMemberId: string(source, 'authorMemberId', 64, isCollabMemberId),
    body: string(source, 'body', COLLAB_LIMITS.maxCommentBytes, undefined, 'utf8'),
    createdAt: timestamp(source, 'createdAt'),
    id: string(source, 'id', 128, isCollabOpaqueId),
    requestId: string(source, 'requestId', 128, isCollabOpaqueId),
  };
}

function envelopeData(value: unknown): unknown {
  return value;
}

export function decodeEnsureMyRequestResponse(value: unknown): EnsureMyRequestResponse {
  const data = record(envelopeData(value), 'data');
  return {
    mainOid: string(data, 'mainOid', 64, isCollabGitOid),
    request: changeRequest(data.request),
  };
}

export function decodeRequestDetailResponse(value: unknown): CollabRequestDetail {
  const data = record(envelopeData(value), 'data');
  assertJsonUtf8ByteLengthAtMost(
    data,
    COLLAB_LIMITS.detailMaxUtf8Bytes,
    'requestDetail.bytes',
  );
  if (
    !isRecord(data.comments)
    || data.changedFiles !== undefined
  ) {
    throw decodeError('requestDetail');
  }
  const decodedRequest = changeRequest(data.request);
  const reviewedHeadOid = string(data, 'reviewedHeadOid', 64, isCollabGitOid);
  const reviewCondition = data.reviewCondition;
  const comments = commentPage(data.comments);
  if (
    reviewedHeadOid !== decodedRequest.latestHeadOid
    || !['clean', 'conflicting', 'stale'].includes(String(reviewCondition))
    || comments.comments.some(item => item.requestId !== decodedRequest.id)
  ) {
    throw decodeError('requestDetail');
  }
  return {
    comments,
    currentMainOid: string(data, 'currentMainOid', 64, isCollabGitOid),
    request: decodedRequest,
    reviewCondition: reviewCondition as CollabRequestDetail['reviewCondition'],
    reviewedHeadOid,
  };
}

export function decodeCommentPageResponse(value: unknown): CollabCommentPage {
  return commentPage(record(envelopeData(value), 'data'));
}

export function decodeTicketCommentPageResponse(value: unknown): CollabTicketCommentPage {
  return ticketCommentPage(record(envelopeData(value), 'data'));
}

export function decodeTicketAcceptedRelationPageResponse(
  value: unknown,
): CollabTicketAcceptedRelationPage {
  return acceptedRelationPage(record(envelopeData(value), 'data'));
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
  const mainOid = string(data, 'mainOid', 64, isCollabGitOid);
  const mergeCommitOid = string(data, 'mergeCommitOid', 64, isCollabGitOid);
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
  assertJsonUtf8ByteLengthAtMost(
    data,
    COLLAB_LIMITS.ticketPageMaxUtf8Bytes,
    'ticketPage.bytes',
  );
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
