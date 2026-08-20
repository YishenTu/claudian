import { COLLAB_PROTOCOL_VERSION, type CollabProtocolVersion } from './CollabConstants';
import { CollabError } from './CollabError';
import type {
  CollabChangeRequest,
  CollabComment,
  CollabCommentPage,
  CollabGitOid,
  CollabIdempotencyKey,
  CollabProjectId,
  CollabRequestDetail,
  CollabRequestId,
  CollabResolvingTicketExpectation,
  CollabTicketAcceptedRelationPage,
  CollabTicketComment,
  CollabTicketCommentPage,
  CollabTicketDetail,
  CollabTicketId,
  CollabTicketPage,
  CollabTicketStatus,
  CollabTicketSummary,
} from './types';

export interface CollabProtocolEnvelope<T> {
  protocolVersion: CollabProtocolVersion;
  requestId: string;
  data: T;
}

export type CollabDecodeFailure =
  | { status: 'invalid'; error: CollabError }
  | {
    status: 'unsupported-version';
    receivedVersion: number;
    error: CollabError;
  };

export type CollabDecodeResult<T> =
  | { status: 'ok'; value: T }
  | CollabDecodeFailure;

export interface CollabMutationContext {
  projectId: CollabProjectId;
  idempotencyKey: CollabIdempotencyKey;
}

export interface GetRequestRequest {
  projectId: CollabProjectId;
  requestId: CollabRequestId;
}

export interface EnsureMyRequestRequest extends CollabMutationContext {
  expectedMainOid: CollabGitOid;
  headOid: CollabGitOid;
  description: string;
}

export interface EnsureMyRequestResponse {
  mainOid: CollabGitOid;
  request: CollabChangeRequest;
}

export interface CreateCommentRequest extends CollabMutationContext {
  requestId: CollabRequestId;
  body: string;
}

export interface CreateCommentResponse {
  comment: CollabComment;
  request: CollabChangeRequest;
}

export interface ListTicketsRequest {
  projectId: CollabProjectId;
  status: CollabTicketStatus | 'all';
  cursor?: string;
  limit?: number;
}

export interface ListRequestCommentsRequest {
  projectId: CollabProjectId;
  requestId: CollabRequestId;
  cursor?: string;
  limit?: number;
}

export interface ListTicketCommentsRequest {
  projectId: CollabProjectId;
  ticketId: CollabTicketId;
  cursor?: string;
  limit?: number;
}

export interface ListTicketAcceptedRelationsRequest {
  projectId: CollabProjectId;
  ticketId: CollabTicketId;
  cursor?: string;
  limit?: number;
}

export interface GetTicketRequest {
  projectId: CollabProjectId;
  ticketId: CollabTicketId;
}

export interface CreateTicketRequest extends CollabMutationContext {
  title: string;
  body: string;
}

export interface CreateTicketResponse {
  ticket: CollabTicketDetail;
}

export interface UpdateTicketContentRequest extends CollabMutationContext {
  ticketId: CollabTicketId;
  expectedRevision: number;
  title: string;
  body: string;
}

export interface CreateTicketCommentRequest extends CollabMutationContext {
  ticketId: CollabTicketId;
  body: string;
}

export interface CreateTicketCommentResponse {
  comment: CollabTicketComment;
  ticket: CollabTicketSummary;
}

export interface ChangeTicketStatusRequest extends CollabMutationContext {
  ticketId: CollabTicketId;
  expectedRevision: number;
}

export interface TicketMutationResponse {
  ticket: CollabTicketSummary;
}

export interface UpdateMyRequestMetadataRequest extends CollabMutationContext {
  requestId: CollabRequestId;
  expectedHeadOid: CollabGitOid;
  expectedRequestRevision: number;
  description: string;
}

export interface UpdateMyRequestMetadataResponse {
  request: CollabChangeRequest;
}

export interface AcceptRequest extends CollabMutationContext {
  requestId: CollabRequestId;
  expectedMainOid: CollabGitOid;
  expectedHeadOid: CollabGitOid;
  expectedRequestRevision: number;
  expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
}

export interface AcceptResponse {
  request: CollabChangeRequest;
  mainOid: CollabGitOid;
  mergeCommitOid: CollabGitOid;
}

export interface CollabControlOperationDefinition<Request, Response> {
  request: Request;
  response: Response;
}

export interface CollabControlOperationMap {
  getRequest: CollabControlOperationDefinition<GetRequestRequest, CollabRequestDetail>;
  listRequestComments: CollabControlOperationDefinition<
    ListRequestCommentsRequest,
    CollabCommentPage
  >;
  ensureMyRequest: CollabControlOperationDefinition<
    EnsureMyRequestRequest,
    EnsureMyRequestResponse
  >;
  createComment: CollabControlOperationDefinition<CreateCommentRequest, CreateCommentResponse>;
  listTickets: CollabControlOperationDefinition<ListTicketsRequest, CollabTicketPage>;
  getTicket: CollabControlOperationDefinition<GetTicketRequest, CollabTicketDetail>;
  listTicketComments: CollabControlOperationDefinition<
    ListTicketCommentsRequest,
    CollabTicketCommentPage
  >;
  listTicketAcceptedRelations: CollabControlOperationDefinition<
    ListTicketAcceptedRelationsRequest,
    CollabTicketAcceptedRelationPage
  >;
  createTicket: CollabControlOperationDefinition<CreateTicketRequest, CreateTicketResponse>;
  updateTicketContent: CollabControlOperationDefinition<
    UpdateTicketContentRequest,
    TicketMutationResponse
  >;
  createTicketComment: CollabControlOperationDefinition<
    CreateTicketCommentRequest,
    CreateTicketCommentResponse
  >;
  closeTicket: CollabControlOperationDefinition<ChangeTicketStatusRequest, TicketMutationResponse>;
  reopenTicket: CollabControlOperationDefinition<ChangeTicketStatusRequest, TicketMutationResponse>;
  updateMyRequestMetadata: CollabControlOperationDefinition<
    UpdateMyRequestMetadataRequest,
    UpdateMyRequestMetadataResponse
  >;
  acceptRequest: CollabControlOperationDefinition<AcceptRequest, AcceptResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  return required.every(key => Object.hasOwn(record, key))
    && Object.keys(record).every(key => allowed.has(key));
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function invalidPayload(field: string): CollabDecodeFailure {
  return {
    status: 'invalid',
    error: new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { field },
    }),
  };
}

function unsupportedVersion(receivedVersion: number): CollabDecodeFailure {
  return {
    status: 'unsupported-version',
    receivedVersion,
    error: new CollabError({
      code: 'protocol-version-unsupported',
      safeContext: {
        receivedVersion,
        supportedVersion: COLLAB_PROTOCOL_VERSION,
      },
    }),
  };
}

function decodeVersion(
  record: Readonly<Record<string, unknown>>,
): CollabDecodeResult<CollabProtocolVersion> {
  const version = record.protocolVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return invalidPayload('protocolVersion');
  }
  if (version !== COLLAB_PROTOCOL_VERSION) return unsupportedVersion(version);
  return { status: 'ok', value: COLLAB_PROTOCOL_VERSION };
}

export function decodeCollabProtocolEnvelope<T = unknown>(
  input: unknown,
): CollabDecodeResult<CollabProtocolEnvelope<T>> {
  if (!isRecord(input) || !hasExactKeys(input, ['protocolVersion', 'requestId', 'data'])) {
    return invalidPayload('envelope');
  }
  const version = decodeVersion(input);
  if (version.status !== 'ok') return version;
  const requestId = requiredString(input, 'requestId');
  if (!requestId) return invalidPayload('requestId');
  return {
    status: 'ok',
    value: {
      data: input.data as T,
      protocolVersion: version.value,
      requestId,
    },
  };
}
