import { type AcceptRequest, type AcceptResponse, type ChangeTicketStatusRequest, type CollabCommentPage, type CollabMemberId, type CollabRequestDetail, type CollabTicketAcceptedRelationPage, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketPage, type CollabTicketSummary, type CreateCommentRequest, type CreateCommentResponse, type CreateTicketCommentRequest, type CreateTicketCommentResponse, type CreateTicketRequest, type EnsureMyRequestRequest, type EnsureMyRequestResponse, type GetRequestRequest, type ListRequestCommentsRequest, type ListTicketAcceptedRelationsRequest, type ListTicketCommentsRequest, type ListTicketsRequest, type UpdateMyRequestMetadataRequest, type UpdateMyRequestMetadataResponse, type UpdateTicketContentRequest } from '@claudian-collab/protocol';

import type {
  CollabActiveProjectRouting,
  CollabControlAdmissionPort,
} from '@/app/collab/lan/CollabControlRouter';
import type {
  AcceptHostTransferRequest,
  AcknowledgeManagerResponsibilityRequest,
  CancelHostTransferRequest,
  CancelManagerResponsibilityOfferRequest,
  CreateHostTransferRequest,
  CreateManagerResponsibilityOfferRequest,
  DeclineHostTransferRequest,
  DeclineManagerResponsibilityRequest,
  DemoteManagerRequest,
  DemoteManagerResponse,
  GetCurrentManagerResponsibilityOfferRequest,
  GetHostTransitionsRequest,
  GetHostTransitionsResponse,
  GetManagerResponsibilityOfferRequest,
  LeaveProjectRequest,
  MembershipTerminationResponse,
  PromoteManagerRequest,
  PromoteManagerResponse,
  RemoveMemberRequest,
  RetireProjectRequest,
} from '@/app/collab/lan/LanCollabControlOperations';
import {
  ActiveLifecycleGateway,
  type LifecycleGatewayPort,
} from '@/app/collab/lan/lifecycle/LifecycleGateway';
import type {
  CollabControlDeferredResult,
  CollabControlProjectService,
} from '@/app/collab/lan/routes/RouteTypes';
import type {
  CollabHostTransferSummary,
  CollabManagerResponsibilityOfferSummary,
  CollabRetirementResult,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type HostedMembershipControlPort = Pick<
  CollabControlProjectService,
  | 'activateJoinAttempt'
  | 'authenticateMemberCredential'
  | 'confirmEndpoint'
  | 'createInvitation'
  | 'createJoinAttempt'
  | 'encodeInvitation'
  | 'readSnapshot'
  | 'refreshEndpoint'
  | 'revokeInvitation'
>;

export interface HostedRequestControlPort {
  accept(
    actorMemberId: CollabMemberId,
    request: AcceptRequest,
  ): Promise<AcceptResponse>;
  createComment(
    actorMemberId: CollabMemberId,
    request: CreateCommentRequest,
  ): Promise<CreateCommentResponse>;
  ensure(
    actorMemberId: CollabMemberId,
    request: EnsureMyRequestRequest,
  ): Promise<EnsureMyRequestResponse>;
  read(
    actorMemberId: CollabMemberId,
    projectId: string,
    requestId: string,
  ): Promise<CollabRequestDetail>;
  readComments(
    actorMemberId: CollabMemberId,
    projectId: string,
    requestId: string,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<CollabCommentPage>;
  updateMetadata(
    actorMemberId: CollabMemberId,
    request: UpdateMyRequestMetadataRequest,
  ): Promise<UpdateMyRequestMetadataResponse>;
}

export interface HostedTicketControlPort {
  close(
    actorMemberId: CollabMemberId,
    request: ChangeTicketStatusRequest,
  ): Promise<CollabTicketSummary>;
  comment(
    actorMemberId: CollabMemberId,
    request: CreateTicketCommentRequest,
  ): Promise<CreateTicketCommentResponse>;
  create(
    actorMemberId: CollabMemberId,
    request: CreateTicketRequest,
  ): Promise<CollabTicketDetail>;
  list(
    actorMemberId: CollabMemberId,
    request: ListTicketsRequest,
  ): Promise<CollabTicketPage>;
  listAcceptedRelations(
    actorMemberId: CollabMemberId,
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<CollabTicketAcceptedRelationPage>;
  listComments(
    actorMemberId: CollabMemberId,
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<CollabTicketCommentPage>;
  read(
    actorMemberId: CollabMemberId,
    projectId: string,
    ticketId: string,
  ): Promise<CollabTicketDetail>;
  reopen(
    actorMemberId: CollabMemberId,
    request: ChangeTicketStatusRequest,
  ): Promise<CollabTicketSummary>;
  updateContent(
    actorMemberId: CollabMemberId,
    request: UpdateTicketContentRequest,
  ): Promise<CollabTicketSummary>;
}

export interface HostedMembershipAdminPort {
  leaveProject(
    actorMemberId: CollabMemberId,
    request: LeaveProjectRequest,
  ): Promise<MembershipTerminationResponse>;
  removeMember(
    actorMemberId: CollabMemberId,
    request: RemoveMemberRequest,
  ): Promise<MembershipTerminationResponse>;
  promoteManager(
    actorMemberId: CollabMemberId,
    request: PromoteManagerRequest,
  ): Promise<PromoteManagerResponse>;
  demoteManager(
    actorMemberId: CollabMemberId,
    request: DemoteManagerRequest,
  ): Promise<DemoteManagerResponse>;
}

export interface HostedLifecycleControlPort {
  acceptHostTransfer(
    actorMemberId: CollabMemberId,
    request: AcceptHostTransferRequest,
  ): Promise<
    | CollabHostTransferSummary
    | CollabControlDeferredResult<CollabHostTransferSummary>
  >;
  acknowledgeManagerResponsibility(
    actorMemberId: CollabMemberId,
    request: AcknowledgeManagerResponsibilityRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  cancelHostTransfer(
    actorMemberId: CollabMemberId,
    request: CancelHostTransferRequest,
  ): Promise<CollabHostTransferSummary>;
  cancelManagerResponsibilityOffer(
    actorMemberId: CollabMemberId,
    request: CancelManagerResponsibilityOfferRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  createHostTransfer(
    actorMemberId: CollabMemberId,
    request: CreateHostTransferRequest,
  ): Promise<CollabHostTransferSummary>;
  createManagerResponsibilityOffer(
    actorMemberId: CollabMemberId,
    request: CreateManagerResponsibilityOfferRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  declineHostTransfer(
    actorMemberId: CollabMemberId,
    request: DeclineHostTransferRequest,
  ): Promise<CollabHostTransferSummary>;
  declineManagerResponsibility(
    actorMemberId: CollabMemberId,
    request: DeclineManagerResponsibilityRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  getCurrentManagerResponsibilityOffer(
    actorMemberId: CollabMemberId,
    request: GetCurrentManagerResponsibilityOfferRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary | null>;
  getCurrentHostTransfer(
    actorMemberId: CollabMemberId,
    projectId: string,
  ): Promise<CollabHostTransferSummary | null>;
  getHostTransitions(
    request: GetHostTransitionsRequest,
  ): Promise<GetHostTransitionsResponse>;
  getManagerResponsibilityOffer(
    actorMemberId: CollabMemberId,
    request: GetManagerResponsibilityOfferRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  retireProject(
    actorMemberId: CollabMemberId,
    request: RetireProjectRequest,
  ): Promise<CollabRetirementResult>;
}

export class HostedProjectControlService implements CollabControlProjectService {
  readonly routing: CollabActiveProjectRouting;

  constructor(
    private readonly membership: HostedMembershipControlPort,
    private readonly requests: HostedRequestControlPort,
    private readonly administration: HostedMembershipAdminPort,
    private readonly tickets: HostedTicketControlPort,
    private readonly lifecycle: HostedLifecycleControlPort,
    lifecycleAdmission?: CollabControlAdmissionPort,
  ) {
    const lifecycleGateway: LifecycleGatewayPort = new ActiveLifecycleGateway({
      ...(lifecycleAdmission ? { admission: lifecycleAdmission } : {}),
      administration,
      authenticateMemberCredential: (credential, statuses) => (
        membership.authenticateMemberCredential(credential, statuses)
      ),
      lifecycle,
    });
    this.routing = Object.freeze({
      ...(lifecycleAdmission ? { admission: lifecycleAdmission } : {}),
      lifecycle: lifecycleGateway,
    });
  }

  activateJoinAttempt: HostedMembershipControlPort['activateJoinAttempt'] = (...args) => (
    this.membership.activateJoinAttempt(...args)
  );

  authenticateMemberCredential: HostedMembershipControlPort[
    'authenticateMemberCredential'
  ] = (...args) => this.membership.authenticateMemberCredential(...args);

  createInvitation: HostedMembershipControlPort['createInvitation'] = (...args) => (
    this.membership.createInvitation(...args)
  );

  confirmEndpoint: HostedMembershipControlPort['confirmEndpoint'] = (...args) => (
    this.membership.confirmEndpoint(...args)
  );

  createJoinAttempt: HostedMembershipControlPort['createJoinAttempt'] = (...args) => (
    this.membership.createJoinAttempt(...args)
  );

  encodeInvitation: HostedMembershipControlPort['encodeInvitation'] = (...args) => (
    this.membership.encodeInvitation(...args)
  );

  async readSnapshot(memberCredential: string) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await this.membership.readSnapshot(memberCredential);
      const actorMemberId = before.currentMember.id;
      const projectId = before.project.id;
      const [hostTransfer, managerResponsibilityOffer] = await Promise.all([
        this.lifecycle.getCurrentHostTransfer(actorMemberId, projectId),
        this.lifecycle.getCurrentManagerResponsibilityOffer(actorMemberId, { projectId }),
      ]);
      const after = await this.membership.readSnapshot(memberCredential);
      if (
        before.eventSequence !== after.eventSequence
        || before.currentMember.id !== after.currentMember.id
        || before.project.id !== after.project.id
        || before.project.managerSetGeneration !== after.project.managerSetGeneration
      ) {
        continue;
      }
      return {
        ...after,
        ...(hostTransfer ? { hostTransfer } : {}),
        ...(managerResponsibilityOffer ? { managerResponsibilityOffer } : {}),
      };
    }
    throw new CollabError({
      code: 'operation-timeout',
      recoveryActions: ['retry'],
      safeContext: { reason: 'coordination-snapshot-changed-during-read' },
    });
  }

  refreshEndpoint: HostedMembershipControlPort['refreshEndpoint'] = (...args) => (
    this.membership.refreshEndpoint(...args)
  );

  revokeInvitation: HostedMembershipControlPort['revokeInvitation'] = (...args) => (
    this.membership.revokeInvitation(...args)
  );

  async ensureMyRequest(
    memberCredential: string,
    request: EnsureMyRequestRequest,
  ): Promise<EnsureMyRequestResponse> {
    const actor = await this.membership.authenticateMemberCredential(
      memberCredential,
      ['active'],
    );
    return this.requests.ensure(actor.member.id, request);
  }

  async acceptRequest(
    memberCredential: string,
    request: AcceptRequest,
  ): Promise<AcceptResponse> {
    const actor = await this.membership.authenticateMemberCredential(
      memberCredential,
      ['active'],
    );
    return this.requests.accept(actor.member.id, request);
  }

  async createComment(
    memberCredential: string,
    request: CreateCommentRequest,
  ): Promise<CreateCommentResponse> {
    const actor = await this.membership.authenticateMemberCredential(
      memberCredential,
      ['active'],
    );
    return this.requests.createComment(actor.member.id, request);
  }

  async readRequest(
    memberCredential: string,
    request: GetRequestRequest,
  ): Promise<CollabRequestDetail> {
    const actor = await this.membership.authenticateMemberCredential(
      memberCredential,
      ['active'],
    );
    return this.requests.read(
      actor.member.id,
      request.projectId,
      request.requestId,
    );
  }

  async listRequestComments(
    memberCredential: string,
    request: ListRequestCommentsRequest,
  ): Promise<CollabCommentPage> {
    const actor = await this.authenticateActive(memberCredential);
    return this.requests.readComments(
      actor,
      request.projectId,
      request.requestId,
      {
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      },
    );
  }

  async updateMyRequestMetadata(
    memberCredential: string,
    request: UpdateMyRequestMetadataRequest,
  ): Promise<UpdateMyRequestMetadataResponse> {
    const actor = await this.authenticateActive(memberCredential);
    return this.requests.updateMetadata(actor, request);
  }

  async listTickets(
    memberCredential: string,
    request: ListTicketsRequest,
  ): Promise<CollabTicketPage> {
    const actor = await this.authenticateActive(memberCredential);
    return this.tickets.list(actor, request);
  }

  async listTicketComments(
    memberCredential: string,
    request: ListTicketCommentsRequest,
  ): Promise<CollabTicketCommentPage> {
    const actor = await this.authenticateActive(memberCredential);
    return this.tickets.listComments(
      actor,
      request.projectId,
      request.ticketId,
      {
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      },
    );
  }

  async listTicketAcceptedRelations(
    memberCredential: string,
    request: ListTicketAcceptedRelationsRequest,
  ): Promise<CollabTicketAcceptedRelationPage> {
    const actor = await this.authenticateActive(memberCredential);
    return this.tickets.listAcceptedRelations(
      actor,
      request.projectId,
      request.ticketId,
      {
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      },
    );
  }

  async getTicket(
    memberCredential: string,
    projectId: string,
    ticketId: string,
  ): Promise<CollabTicketDetail> {
    const actor = await this.authenticateActive(memberCredential);
    return this.tickets.read(actor, projectId, ticketId);
  }

  async createTicket(
    memberCredential: string,
    request: CreateTicketRequest,
  ) {
    const actor = await this.authenticateActive(memberCredential);
    return { ticket: await this.tickets.create(actor, request) };
  }

  async updateTicketContent(
    memberCredential: string,
    request: UpdateTicketContentRequest,
  ) {
    const actor = await this.authenticateActive(memberCredential);
    return { ticket: await this.tickets.updateContent(actor, request) };
  }

  async createTicketComment(
    memberCredential: string,
    request: CreateTicketCommentRequest,
  ): Promise<CreateTicketCommentResponse> {
    const actor = await this.authenticateActive(memberCredential);
    return this.tickets.comment(actor, request);
  }

  async closeTicket(
    memberCredential: string,
    request: ChangeTicketStatusRequest,
  ) {
    const actor = await this.authenticateActive(memberCredential);
    return { ticket: await this.tickets.close(actor, request) };
  }

  async reopenTicket(
    memberCredential: string,
    request: ChangeTicketStatusRequest,
  ) {
    const actor = await this.authenticateActive(memberCredential);
    return { ticket: await this.tickets.reopen(actor, request) };
  }

  async removeMember(
    memberCredential: string,
    request: RemoveMemberRequest,
  ): Promise<MembershipTerminationResponse> {
    const actor = await this.authenticateAdministration(memberCredential);
    return this.administration.removeMember(actor, request);
  }

  private async authenticateAdministration(memberCredential: string): Promise<string> {
    return this.authenticateActive(memberCredential);
  }

  private async authenticateActive(memberCredential: string): Promise<string> {
    const actor = await this.membership.authenticateMemberCredential(
      memberCredential,
      ['active'],
    );
    return actor.member.id;
  }

}
