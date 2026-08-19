import type { AcceptRequest, AcceptResponse, ChangeTicketStatusRequest, CollabMemberStatus, CollabRequestDetail, CollabTicketDetail, CollabTicketPage, CreateCommentRequest, CreateCommentResponse, CreateTicketCommentRequest, CreateTicketCommentResponse, CreateTicketRequest, CreateTicketResponse, EnsureMyRequestRequest, EnsureMyRequestResponse, GetRequestRequest, ListTicketsRequest, TicketMutationResponse, UpdateMyRequestMetadataRequest, UpdateMyRequestMetadataResponse, UpdateTicketContentRequest } from '@claudian/collab-protocol';

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
import type { CollabProjectSnapshot, CollabRetirementResult } from '@/core/collab';

export interface CollabControlProjectService {
  acceptRequest?(
    memberCredential: string,
    request: AcceptRequest,
  ): Promise<AcceptResponse>;
  activateJoinAttempt(
    memberCredential: string,
    request: ActivateJoinAttemptRequest,
  ): Promise<CollabProjectSnapshot>;
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
  ensureMyRequest?(
    memberCredential: string,
    request: EnsureMyRequestRequest,
  ): Promise<EnsureMyRequestResponse>;
  createComment?(
    memberCredential: string,
    request: CreateCommentRequest,
  ): Promise<CreateCommentResponse>;
  createTicket?(
    memberCredential: string,
    request: CreateTicketRequest,
  ): Promise<CreateTicketResponse>;
  createTicketComment?(
    memberCredential: string,
    request: CreateTicketCommentRequest,
  ): Promise<CreateTicketCommentResponse>;
  closeTicket?(
    memberCredential: string,
    request: ChangeTicketStatusRequest,
  ): Promise<TicketMutationResponse>;
  getTicket?(
    memberCredential: string,
    projectId: string,
    ticketId: string,
  ): Promise<CollabTicketDetail>;
  listTickets?(
    memberCredential: string,
    request: ListTicketsRequest,
  ): Promise<CollabTicketPage>;
  readRequest?(
    memberCredential: string,
    request: GetRequestRequest,
  ): Promise<CollabRequestDetail>;
  readSnapshot(memberCredential: string): Promise<CollabProjectSnapshot>;
  reopenTicket?(
    memberCredential: string,
    request: ChangeTicketStatusRequest,
  ): Promise<TicketMutationResponse>;
  removeMember?(
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
  updateMyRequestMetadata?(
    memberCredential: string,
    request: UpdateMyRequestMetadataRequest,
  ): Promise<UpdateMyRequestMetadataResponse>;
  updateTicketContent?(
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

export interface CollabControlRouteRequest {
  readonly authorization: string | null;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
  readonly lifecycle?: LifecycleGatewayPort;
  readonly method: string;
  readonly operationMatch?: CollabControlOperationMatch;
  readonly projectId: string;
  readonly query: Readonly<Record<string, string>>;
  readonly remoteAddress: string;
  readonly segments: readonly string[];
  readonly service: CollabControlProjectService;
}

export interface CollabControlRouteResult {
  readonly afterResponseFlushed?: () => void;
  readonly afterResponseSettled?: () => void;
  readonly data: unknown;
}

export type CollabControlRouteHandler = (
  request: CollabControlRouteRequest,
) => Promise<CollabControlRouteResult | null>;
