import { COLLAB_LIMITS } from './CollabConstants';
import { CollabError } from './CollabError';
import type {
  AcceptRequest,
  ChangeTicketStatusRequest,
  CollabControlOperationMap,
  CollabDecodeResult,
  CreateCommentRequest,
  CreateTicketCommentRequest,
  CreateTicketRequest,
  EnsureMyRequestRequest,
  GetRequestRequest,
  GetTicketRequest,
  ListRequestCommentsRequest,
  ListTicketAcceptedRelationsRequest,
  ListTicketCommentsRequest,
  ListTicketsRequest,
  UpdateMyRequestMetadataRequest,
  UpdateTicketContentRequest,
} from './CollabProtocol';
import type { CollabResolvingTicketExpectation } from './types';
import {
  hasUtf8ByteLengthAtMost,
  isCollabGitOid,
  isCollabOpaqueId,
  isCollabProjectId,
} from './CollabValidation';

export type CollabRequestTicketOperation =
  | 'acceptRequest'
  | 'closeTicket'
  | 'createComment'
  | 'createTicket'
  | 'createTicketComment'
  | 'ensureMyRequest'
  | 'getRequest'
  | 'getTicket'
  | 'listRequestComments'
  | 'listTicketAcceptedRelations'
  | 'listTicketComments'
  | 'listTickets'
  | 'reopenTicket'
  | 'updateMyRequestMetadata'
  | 'updateTicketContent';

type OperationRequest<Operation extends CollabRequestTicketOperation> =
  CollabControlOperationMap[Operation]['request'];

function invalid<T>(reason: string): CollabDecodeResult<T> {
  return {
    error: new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { reason },
    }),
    status: 'invalid',
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isRevision(value: unknown, minimum = 0): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum;
}

function isPageQuery(
  value: Readonly<Record<string, unknown>>,
  maxLimit = COLLAB_LIMITS.maxCommentPageSize,
): boolean {
  return (value.cursor === undefined
      || (typeof value.cursor === 'string'
        && value.cursor.length > 0
        && value.cursor.length <= COLLAB_LIMITS.maxPageCursorUtf16))
    && (value.limit === undefined
      || (isRevision(value.limit, 1) && value.limit <= maxLimit));
}

function mutationContext(value: Readonly<Record<string, unknown>>): boolean {
  return isCollabProjectId(value.projectId) && isCollabOpaqueId(value.idempotencyKey);
}

function resolvingTickets(value: unknown): readonly CollabResolvingTicketExpectation[] | null {
  if (!Array.isArray(value) || value.length > COLLAB_LIMITS.maxRequestTicketRelations) return null;
  const seen = new Set<string>();
  const result: CollabResolvingTicketExpectation[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !isCollabOpaqueId(entry.ticketId)
      || seen.has(entry.ticketId)
      || !isRevision(entry.revision, 1)
    ) return null;
    seen.add(entry.ticketId);
    result.push({ ticketId: entry.ticketId, revision: entry.revision });
  }
  return result;
}

function decodeRequestTicketRequest(
  operation: CollabRequestTicketOperation,
  input: unknown,
): OperationRequest<CollabRequestTicketOperation> | null {
  if (!isRecord(input)) return null;
  switch (operation) {
    case 'getRequest':
      return isCollabProjectId(input.projectId) && isCollabOpaqueId(input.requestId)
        ? { projectId: input.projectId, requestId: input.requestId } as GetRequestRequest
        : null;
    case 'ensureMyRequest':
      return mutationContext(input)
        && isCollabGitOid(input.expectedMainOid)
        && isCollabGitOid(input.headOid)
        && typeof input.description === 'string'
        && hasUtf8ByteLengthAtMost(input.description, COLLAB_LIMITS.maxRequestDescriptionBytes)
        ? {
          description: input.description,
          expectedMainOid: input.expectedMainOid,
          headOid: input.headOid,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
        } as EnsureMyRequestRequest
        : null;
    case 'createComment':
      return mutationContext(input)
        && isCollabOpaqueId(input.requestId)
        && typeof input.body === 'string'
        && hasUtf8ByteLengthAtMost(input.body, COLLAB_LIMITS.maxCommentBytes)
        && input.anchor === undefined
        ? {
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          requestId: input.requestId,
        } as CreateCommentRequest
        : null;
    case 'updateMyRequestMetadata':
      return mutationContext(input)
        && isCollabOpaqueId(input.requestId)
        && isCollabGitOid(input.expectedHeadOid)
        && isRevision(input.expectedRequestRevision)
        && typeof input.description === 'string'
        && hasUtf8ByteLengthAtMost(input.description, COLLAB_LIMITS.maxRequestDescriptionBytes)
        ? {
          description: input.description,
          expectedHeadOid: input.expectedHeadOid,
          expectedRequestRevision: input.expectedRequestRevision,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          requestId: input.requestId,
        } as UpdateMyRequestMetadataRequest
        : null;
    case 'acceptRequest': {
      const expectedResolvingTickets = resolvingTickets(input.expectedResolvingTickets);
      return mutationContext(input)
        && isCollabOpaqueId(input.requestId)
        && isCollabGitOid(input.expectedMainOid)
        && isCollabGitOid(input.expectedHeadOid)
        && isRevision(input.expectedRequestRevision)
        && expectedResolvingTickets !== null
        ? {
          expectedHeadOid: input.expectedHeadOid,
          expectedMainOid: input.expectedMainOid,
          expectedRequestRevision: input.expectedRequestRevision,
          expectedResolvingTickets,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          requestId: input.requestId,
        } as AcceptRequest
        : null;
    }
    case 'listTickets':
      return hasExactKeys(input, ['projectId', 'status'], ['cursor', 'limit'])
        && isCollabProjectId(input.projectId)
        && (input.status === 'open' || input.status === 'closed' || input.status === 'all')
        && isPageQuery(input, COLLAB_LIMITS.maxTicketPageSize)
        ? {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          projectId: input.projectId,
          status: input.status,
        } as ListTicketsRequest
        : null;
    case 'listRequestComments':
      return hasExactKeys(input, ['projectId', 'requestId'], ['cursor', 'limit'])
        && isCollabProjectId(input.projectId)
        && isCollabOpaqueId(input.requestId)
        && isPageQuery(input)
        ? {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          projectId: input.projectId,
          requestId: input.requestId,
        } as ListRequestCommentsRequest
        : null;
    case 'listTicketComments':
      return hasExactKeys(input, ['projectId', 'ticketId'], ['cursor', 'limit'])
        && isCollabProjectId(input.projectId)
        && isCollabOpaqueId(input.ticketId)
        && isPageQuery(input)
        ? {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          projectId: input.projectId,
          ticketId: input.ticketId,
        } as ListTicketCommentsRequest
        : null;
    case 'listTicketAcceptedRelations':
      return hasExactKeys(input, ['projectId', 'ticketId'], ['cursor', 'limit'])
        && isCollabProjectId(input.projectId)
        && isCollabOpaqueId(input.ticketId)
        && isPageQuery(input, COLLAB_LIMITS.maxRelationsPerPage)
        ? {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          projectId: input.projectId,
          ticketId: input.ticketId,
        } as ListTicketAcceptedRelationsRequest
        : null;
    case 'getTicket':
      return hasExactKeys(input, ['projectId', 'ticketId'])
        && isCollabProjectId(input.projectId)
        && isCollabOpaqueId(input.ticketId)
        ? { projectId: input.projectId, ticketId: input.ticketId } as GetTicketRequest
        : null;
    case 'createTicket':
      return hasExactKeys(input, ['body', 'idempotencyKey', 'projectId', 'title'])
        && mutationContext(input)
        && typeof input.body === 'string'
        && typeof input.title === 'string'
        && hasUtf8ByteLengthAtMost(input.body, COLLAB_LIMITS.maxTicketBodyBytes)
        && input.title.length <= COLLAB_LIMITS.maxTicketTitleUtf16
        ? {
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          title: input.title,
        } as CreateTicketRequest
        : null;
    case 'updateTicketContent':
      return hasExactKeys(input, [
        'body', 'expectedRevision', 'idempotencyKey', 'projectId', 'ticketId', 'title',
      ])
        && mutationContext(input)
        && isCollabOpaqueId(input.ticketId)
        && isRevision(input.expectedRevision, 1)
        && typeof input.body === 'string'
        && typeof input.title === 'string'
        && hasUtf8ByteLengthAtMost(input.body, COLLAB_LIMITS.maxTicketBodyBytes)
        && input.title.length <= COLLAB_LIMITS.maxTicketTitleUtf16
        ? {
          body: input.body,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          ticketId: input.ticketId,
          title: input.title,
        } as UpdateTicketContentRequest
        : null;
    case 'createTicketComment':
      return hasExactKeys(input, ['body', 'idempotencyKey', 'projectId', 'ticketId'])
        && mutationContext(input)
        && isCollabOpaqueId(input.ticketId)
        && typeof input.body === 'string'
        && hasUtf8ByteLengthAtMost(input.body, COLLAB_LIMITS.maxTicketCommentBytes)
        ? {
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          ticketId: input.ticketId,
        } as CreateTicketCommentRequest
        : null;
    case 'closeTicket':
    case 'reopenTicket':
      return hasExactKeys(input, [
        'expectedRevision', 'idempotencyKey', 'projectId', 'ticketId',
      ])
        && mutationContext(input)
        && isCollabOpaqueId(input.ticketId)
        && isRevision(input.expectedRevision, 1)
        ? {
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          ticketId: input.ticketId,
        } as ChangeTicketStatusRequest
        : null;
  }
}

const INVALID_REASONS = {
  acceptRequest: 'request-accept-payload-invalid',
  closeTicket: 'ticket-mutation-payload-invalid',
  createComment: 'request-comment-payload-invalid',
  createTicket: 'ticket-create-payload-invalid',
  createTicketComment: 'ticket-comment-payload-invalid',
  ensureMyRequest: 'request-ensure-payload-invalid',
  getRequest: 'request-read-payload-invalid',
  getTicket: 'ticket-read-payload-invalid',
  listRequestComments: 'request-comment-page-query-invalid',
  listTicketAcceptedRelations: 'ticket-relation-page-query-invalid',
  listTicketComments: 'ticket-comment-page-query-invalid',
  listTickets: 'ticket-list-query-invalid',
  reopenTicket: 'ticket-mutation-payload-invalid',
  updateMyRequestMetadata: 'request-metadata-payload-invalid',
  updateTicketContent: 'ticket-content-payload-invalid',
} as const satisfies Record<CollabRequestTicketOperation, string>;

export function decodeCollabRequestTicketOperationRequest<
  Operation extends CollabRequestTicketOperation,
>(
  operation: Operation,
  input: unknown,
): CollabDecodeResult<OperationRequest<Operation>> {
  const value = decodeRequestTicketRequest(operation, input);
  return value
    ? { status: 'ok', value: value }
    : invalid(INVALID_REASONS[operation]);
}
