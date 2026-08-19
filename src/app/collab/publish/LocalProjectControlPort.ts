import { type AcceptResponse, type CollabChangeRequest, type CollabComment, type CollabMemberId, type CollabRequestDetail, type CollabResolvingTicketExpectation, type CollabTicketComment, type CollabTicketDetail, type CollabTicketPage, type CollabTicketSummary, type CreateCommentResponse } from '@claudian/collab-protocol';

import type {
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import {
  ProjectControlClient,
} from '@/app/collab/publish/ProjectControlClient';
import type {
  PublishRequestEnsureInput,
  PublishRequestEnsurePort,
} from '@/app/collab/publish/PublishCoordinator';
import { type CollabAddTicketCommentRequest, type CollabChangeTicketStatusRequest, type CollabCreateTicketRequest, type CollabListTicketsRequest, type CollabProjectSnapshot, type CollabUpdateRequestMetadataRequest, type CollabUpdateTicketContentRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CONTROL_TIMEOUT_MS = 10_000;

export interface LocalProjectControlClientPort {
  addTicketComment: ProjectControlClient['addTicketComment'];
  acceptRequest(input: {
    readonly expectedHeadOid: string;
    readonly expectedMainOid: string;
    readonly expectedRequestRevision: number;
    readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
    readonly idempotencyKey: string;
    readonly memberCredential: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptResponse>;
  createComment(input: {
    readonly body: string;
    readonly idempotencyKey: string;
    readonly memberCredential: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<CreateCommentResponse>;
  createTicket: ProjectControlClient['createTicket'];
  ensureMyRequest(input: {
    readonly description: string;
    readonly expectedMainOid: string;
    readonly headOid: string;
    readonly idempotencyKey: string;
    readonly memberCredential: string;
    readonly projectId: string;
    readonly signal?: AbortSignal;
  }): ReturnType<ProjectControlClient['ensureMyRequest']>;
  listTickets: ProjectControlClient['listTickets'];
  readSnapshot(
    projectId: string,
    memberCredential: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectSnapshot>;
  readRequest(input: {
    readonly memberCredential: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<CollabRequestDetail>;
  readTicket: ProjectControlClient['readTicket'];
  closeTicket: ProjectControlClient['closeTicket'];
  reopenTicket: ProjectControlClient['reopenTicket'];
  updateRequestMetadata: ProjectControlClient['updateRequestMetadata'];
  updateTicketContent: ProjectControlClient['updateTicketContent'];
}

export interface LocalProjectControlPortOptions {
  readonly createClient?: (
    trust: {
      readonly caCertificatePem: string;
      readonly caFingerprint: string;
      readonly endpoint: string;
      readonly projectId: string;
    },
  ) => LocalProjectControlClientPort;
}

function controlError(
  code: 'authority-integrity-error' | 'host-stopped' | 'project-not-found',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'host-stopped'
      ? ['restart-host', 'retry']
      : code === 'authority-integrity-error'
        ? ['open-diagnostics']
        : ['retry'],
    safeContext: { reason },
  });
}

export class LocalProjectControlPort implements PublishRequestEnsurePort {
  private readonly createClient: NonNullable<LocalProjectControlPortOptions['createClient']>;

  constructor(
    private readonly projects: Pick<CollabLocalProjectRepository, 'loadMembership'>,
    options: LocalProjectControlPortOptions = {},
  ) {
    this.createClient = options.createClient ?? (trust => new ProjectControlClient(
      new PinnedCollabHttpClient(trust, CONTROL_TIMEOUT_MS),
    ));
  }

  async ensure(input: PublishRequestEnsureInput): Promise<CollabChangeRequest> {
    const session = await this.loadSession(input.projectId);
    const response = await session.client.ensureMyRequest({
      description: input.description,
      expectedMainOid: input.expectedMainOid,
      headOid: input.headOid,
      idempotencyKey: input.idempotencyKey,
      memberCredential: session.memberCredential,
      projectId: input.projectId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      response.request.memberId !== session.memberId
      || response.request.latestHeadOid !== input.headOid
      || response.request.status !== 'open'
      || response.mainOid !== input.expectedMainOid
    ) {
      throw controlError('authority-integrity-error', 'control-request-response-mismatch');
    }
    return response.request;
  }

  async readSnapshot(
    projectId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabProjectSnapshot> {
    const session = await this.loadSession(projectId);
    const snapshot = await session.client.readSnapshot(
      projectId,
      session.memberCredential,
      options.signal ? { signal: options.signal } : {},
    );
    if (
      snapshot.project.id !== projectId
      || snapshot.currentMember.id !== session.memberId
      || snapshot.currentMember.personalRef !== session.personalRef
    ) {
      throw controlError('authority-integrity-error', 'control-snapshot-response-mismatch');
    }
    return snapshot;
  }

  async readRequest(
    projectId: string,
    requestId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabRequestDetail> {
    const session = await this.loadSession(projectId);
    const detail = await session.client.readRequest({
      memberCredential: session.memberCredential,
      projectId,
      requestId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (detail.request.id !== requestId) {
      throw controlError('authority-integrity-error', 'control-request-detail-mismatch');
    }
    return detail;
  }

  async createComment(input: {
    readonly body: string;
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly comment: CollabComment }> {
    const session = await this.loadSession(input.projectId);
    const response = await session.client.createComment({
      ...input,
      memberCredential: session.memberCredential,
    });
    if (
      response.comment.authorMemberId !== session.memberId
      || response.comment.requestId !== input.requestId
      || response.request.id !== input.requestId
    ) {
      throw controlError('authority-integrity-error', 'control-comment-response-mismatch');
    }
    return { comment: response.comment };
  }

  async listTickets(
    request: CollabListTicketsRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketPage> {
    const session = await this.loadSession(request.projectId);
    return session.client.listTickets({
      ...request,
      memberCredential: session.memberCredential,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async readTicket(
    projectId: string,
    ticketId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketDetail> {
    const session = await this.loadSession(projectId);
    const detail = await session.client.readTicket({
      memberCredential: session.memberCredential,
      projectId,
      ...(options.signal ? { signal: options.signal } : {}),
      ticketId,
    });
    if (detail.ticket.id !== ticketId) {
      throw controlError('authority-integrity-error', 'control-ticket-detail-mismatch');
    }
    return detail;
  }

  async createTicket(
    request: CollabCreateTicketRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketDetail> {
    const session = await this.loadSession(request.projectId);
    return session.client.createTicket({
      ...request,
      idempotencyKey,
      memberCredential: session.memberCredential,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  updateTicketContent(
    request: CollabUpdateTicketContentRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketSummary> {
    return this.ticketMutation('updateTicketContent', request, idempotencyKey, options);
  }

  async addTicketComment(
    request: CollabAddTicketCommentRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketComment> {
    const session = await this.loadSession(request.projectId);
    const response = await session.client.addTicketComment({
      ...request,
      idempotencyKey,
      memberCredential: session.memberCredential,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (
      response.comment.ticketId !== request.ticketId
      || response.comment.authorMemberId !== session.memberId
      || response.ticket.id !== request.ticketId
    ) {
      throw controlError('authority-integrity-error', 'control-ticket-comment-mismatch');
    }
    return response.comment;
  }

  closeTicket(
    request: CollabChangeTicketStatusRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketSummary> {
    return this.ticketMutation('closeTicket', request, idempotencyKey, options);
  }

  reopenTicket(
    request: CollabChangeTicketStatusRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabTicketSummary> {
    return this.ticketMutation('reopenTicket', request, idempotencyKey, options);
  }

  async updateRequestMetadata(
    request: CollabUpdateRequestMetadataRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabChangeRequest> {
    const session = await this.loadSession(request.projectId);
    const updated = await session.client.updateRequestMetadata({
      ...request,
      idempotencyKey,
      memberCredential: session.memberCredential,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (updated.id !== request.requestId || updated.memberId !== session.memberId) {
      throw controlError('authority-integrity-error', 'control-request-metadata-mismatch');
    }
    return updated;
  }

  async acceptRequest(input: {
    readonly expectedHeadOid: string;
    readonly expectedMainOid: string;
    readonly expectedRequestRevision: number;
    readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptResponse> {
    const session = await this.loadSession(input.projectId);
    const response = await session.client.acceptRequest({
      ...input,
      memberCredential: session.memberCredential,
    });
    if (
      response.mainOid !== response.mergeCommitOid
      || response.request.id !== input.requestId
      || response.request.latestHeadOid !== input.expectedHeadOid
      || response.request.mergedOid !== response.mainOid
      || response.request.status !== 'merged'
    ) {
      throw controlError('authority-integrity-error', 'control-accept-response-mismatch');
    }
    return response;
  }

  private async ticketMutation(
    method: 'closeTicket' | 'reopenTicket' | 'updateTicketContent',
    request: CollabChangeTicketStatusRequest
      | CollabUpdateTicketContentRequest,
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<CollabTicketSummary> {
    const session = await this.loadSession(request.projectId);
    const ticket = await session.client[method]({
      ...request,
      idempotencyKey,
      memberCredential: session.memberCredential,
      ...(options.signal ? { signal: options.signal } : {}),
    } as never);
    if (ticket.id !== request.ticketId) {
      throw controlError('authority-integrity-error', 'control-ticket-mutation-mismatch');
    }
    return ticket;
  }

  private async loadSession(projectId: string): Promise<{
    readonly client: LocalProjectControlClientPort;
    readonly memberCredential: string;
    readonly memberId: CollabMemberId;
    readonly personalRef: string;
  }> {
    const membership = await this.projects.loadMembership(projectId);
    if (!membership || membership.project.id !== projectId) {
      throw controlError('project-not-found', 'control-membership-missing');
    }
    const endpoint = membership.authority.endpoint;
    const caCertificatePem = membership.authority.hostCaCertificatePem;
    const caFingerprint = membership.authority.hostCaFingerprint;
    if (!endpoint || !caCertificatePem || !caFingerprint) {
      throw controlError('host-stopped', 'control-host-endpoint-unavailable');
    }
    return {
      client: this.createClient({
        caCertificatePem,
        caFingerprint,
        endpoint,
        projectId,
      }),
      memberCredential: membership.member.credential,
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
    };
  }
}
