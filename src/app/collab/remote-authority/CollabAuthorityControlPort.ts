import type {
  AcceptResponse,
  CollabComment,
  CollabCommentPage,
  CollabRequestDetail,
  CollabResolvingTicketExpectation,
  CollabTicketAcceptedRelationPage,
  CollabTicketComment,
  CollabTicketCommentPage,
  CollabTicketDetail,
  CollabTicketPage,
} from '@claudian/collab-protocol';
import type { CollabChangeRequest, CollabTicketSummary } from '@claudian/collab-protocol';

import type { PublishRequestEnsureInput } from '@/app/collab/publish/PublishCoordinator';
import type {
  CollabAddTicketCommentRequest,
  CollabChangeTicketStatusRequest,
  CollabCreateTicketRequest,
  CollabListTicketsRequest,
  CollabOperationOptions,
  CollabProjectSnapshot,
  CollabUpdateRequestMetadataRequest,
  CollabUpdateTicketContentRequest,
} from '@/core/collab';

export interface CollabAuthorityControlPort {
  ensure(input: PublishRequestEnsureInput): Promise<CollabChangeRequest>;
  acceptRequest(input: {
    readonly expectedHeadOid: string;
    readonly expectedMainOid: string;
    readonly expectedRequestRevision: number;
    readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptResponse>;
  createComment(input: {
    readonly body: string;
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly comment: CollabComment }>;
  createTicket(
    request: CollabCreateTicketRequest,
    idempotencyKey: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketDetail>;
  updateTicketContent(
    request: CollabUpdateTicketContentRequest,
    idempotencyKey: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketSummary>;
  addTicketComment(
    request: CollabAddTicketCommentRequest,
    idempotencyKey: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketComment>;
  closeTicket(
    request: CollabChangeTicketStatusRequest,
    idempotencyKey: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketSummary>;
  reopenTicket(
    request: CollabChangeTicketStatusRequest,
    idempotencyKey: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketSummary>;
  updateRequestMetadata(
    request: CollabUpdateRequestMetadataRequest,
    idempotencyKey: string,
    options?: CollabOperationOptions,
  ): Promise<CollabChangeRequest>;
  listTickets(
    request: CollabListTicketsRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketPage>;
  listRequestComments(
    projectId: string,
    requestId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options?: CollabOperationOptions,
  ): Promise<CollabCommentPage>;
  listTicketComments(
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options?: CollabOperationOptions,
  ): Promise<CollabTicketCommentPage>;
  listTicketAcceptedRelations(
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options?: CollabOperationOptions,
  ): Promise<CollabTicketAcceptedRelationPage>;
  readRequest(
    projectId: string,
    requestId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabRequestDetail>;
  readRequestPage(
    projectId: string,
    requestId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabRequestDetail>;
  readSnapshot(
    projectId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabProjectSnapshot>;
  readTicket(
    projectId: string,
    ticketId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketDetail>;
  readTicketPage(
    projectId: string,
    ticketId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketDetail>;
}
