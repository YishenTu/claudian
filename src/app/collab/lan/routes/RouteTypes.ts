import type { AcceptRequest, AcceptResponse, ChangeTicketStatusRequest, CollabCommentPage, CollabMemberStatus, CollabRequestDetail, CollabTicketAcceptedRelationPage, CollabTicketCommentPage, CollabTicketDetail, CollabTicketPage, CreateCommentRequest, CreateCommentResponse, CreateTicketCommentRequest, CreateTicketCommentResponse, CreateTicketRequest, CreateTicketResponse, EnsureMyRequestRequest, EnsureMyRequestResponse, GetRequestRequest, ListRequestCommentsRequest, ListTicketAcceptedRelationsRequest, ListTicketCommentsRequest, ListTicketsRequest, TicketMutationResponse, UpdateMyRequestMetadataRequest, UpdateMyRequestMetadataResponse, UpdateTicketContentRequest } from '@claudian/collab-protocol';

import type {
  CollabControlOperationMatch,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type { LanCollabInvitation as CollabInvitation } from '@/app/collab/lan/InvitationCodec';
import type {
  AcknowledgeRetirementRequest,
  AcknowledgeRetirementResponse,
  ActivateJoinAttemptRequest,
  ConfirmEndpointResponse,
  CreateInvitationRequest,
  CreateJoinAttemptRequest,
  GetHostTransitionsRequest,
  GetHostTransitionsResponse,
  LanCollabJoinAttempt as CollabJoinAttempt,
  MembershipTerminationResponse,
  RefreshEndpointResponse,
  RemoveMemberRequest,
  RevokeInvitationRequest,
} from '@/app/collab/lan/LanCollabControlOperations';
import type { LifecycleGatewayPort } from '@/app/collab/lan/lifecycle/LifecycleGateway';
import type { CollabLanProjectSnapshot, CollabRetirementResult } from '@/core/collab';

export interface CollabControlProjectService {
  acceptRequest(
    memberCredential: string,
    request: AcceptRequest,
  ): Promise<AcceptResponse>;
  activateJoinAttempt(
    memberCredential: string,
    request: ActivateJoinAttemptRequest,
  ): Promise<CollabLanProjectSnapshot>;
  authenticateMemberCredential(
    memberCredential: string,
    statuses: readonly CollabMemberStatus[],
  ): Promise<{ readonly member: { readonly id: string } }>;
  createInvitation(
    memberCredential: string,
    request: CreateInvitationRequest,
  ): Promise<CollabInvitation>;
  confirmEndpoint(
    memberCredential: string,
    projectId: string,
  ): Promise<ConfirmEndpointResponse>;
  createJoinAttempt(
    invitationSecret: string,
    request: CreateJoinAttemptRequest,
    options: { readonly remoteAddress: string },
  ): Promise<CollabJoinAttempt>;
  encodeInvitation(invitation: CollabInvitation): string;
  ensureMyRequest(
    memberCredential: string,
    request: EnsureMyRequestRequest,
  ): Promise<EnsureMyRequestResponse>;
  createComment(
    memberCredential: string,
    request: CreateCommentRequest,
  ): Promise<CreateCommentResponse>;
  createTicket(
    memberCredential: string,
    request: CreateTicketRequest,
  ): Promise<CreateTicketResponse>;
  createTicketComment(
    memberCredential: string,
    request: CreateTicketCommentRequest,
  ): Promise<CreateTicketCommentResponse>;
  closeTicket(
    memberCredential: string,
    request: ChangeTicketStatusRequest,
  ): Promise<TicketMutationResponse>;
  getTicket(
    memberCredential: string,
    projectId: string,
    ticketId: string,
  ): Promise<CollabTicketDetail>;
  listRequestComments(
    memberCredential: string,
    request: ListRequestCommentsRequest,
  ): Promise<CollabCommentPage>;
  listTicketAcceptedRelations(
    memberCredential: string,
    request: ListTicketAcceptedRelationsRequest,
  ): Promise<CollabTicketAcceptedRelationPage>;
  listTicketComments(
    memberCredential: string,
    request: ListTicketCommentsRequest,
  ): Promise<CollabTicketCommentPage>;
  listTickets(
    memberCredential: string,
    request: ListTicketsRequest,
  ): Promise<CollabTicketPage>;
  readRequest(
    memberCredential: string,
    request: GetRequestRequest,
  ): Promise<CollabRequestDetail>;
  readSnapshot(memberCredential: string): Promise<CollabLanProjectSnapshot>;
  reopenTicket(
    memberCredential: string,
    request: ChangeTicketStatusRequest,
  ): Promise<TicketMutationResponse>;
  removeMember(
    memberCredential: string,
    request: RemoveMemberRequest,
  ): Promise<MembershipTerminationResponse>;
  refreshEndpoint(
    memberCredential: string,
    invitation: CollabInvitation,
  ): Promise<RefreshEndpointResponse>;
  revokeInvitation(
    memberCredential: string,
    request: RevokeInvitationRequest,
  ): Promise<void>;
  updateMyRequestMetadata(
    memberCredential: string,
    request: UpdateMyRequestMetadataRequest,
  ): Promise<UpdateMyRequestMetadataResponse>;
  updateTicketContent(
    memberCredential: string,
    request: UpdateTicketContentRequest,
  ): Promise<TicketMutationResponse>;
}

export interface CollabControlDeferredResult<T> {
  readonly afterResponseFlushed?: () => void;
  readonly afterResponseSettled?: () => void;
  readonly response: T;
}

export interface CollabTerminalProjectService {
  acknowledgeRetirement(
    memberCredential: string,
    request: AcknowledgeRetirementRequest,
  ): Promise<CollabControlDeferredResult<AcknowledgeRetirementResponse>>;
  getHostTransitions(
    request: GetHostTransitionsRequest,
  ): Promise<GetHostTransitionsResponse>;
  getRetirement(
    memberCredential: string,
  ): Promise<CollabRetirementResult>;
}

interface CollabControlRouteRequestBase {
  readonly authorization: string | null;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly operationMatch?: CollabControlOperationMatch;
  readonly projectId: string;
  readonly query: Readonly<Record<string, string>>;
  readonly remoteAddress: string;
  readonly segments: readonly string[];
}

export interface CollabControlRouteRequest extends CollabControlRouteRequestBase {
  readonly lifecycle: LifecycleGatewayPort;
  readonly service: CollabControlProjectService;
}

export interface CollabTerminalControlRouteRequest extends CollabControlRouteRequestBase {
  readonly lifecycle: LifecycleGatewayPort;
}

export type CollabLifecycleRouteRequest =
  | CollabControlRouteRequest
  | CollabTerminalControlRouteRequest;

export interface CollabControlRouteResult {
  readonly afterResponseFlushed?: () => void;
  readonly afterResponseSettled?: () => void;
  readonly data: unknown;
}

export type CollabControlRouteHandler = (
  request: CollabControlRouteRequest,
) => Promise<CollabControlRouteResult | null>;
