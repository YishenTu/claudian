import { type AcceptResponse, type CollabChangeRequest, type CollabCommentPage, type CollabRequestDetail, type CollabResolvingTicketExpectation, type CollabTicketAcceptedRelationPage, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketPage, type CollabTicketStatus, type CollabTicketSummary, type CreateCommentResponse, type CreateTicketCommentResponse, type EnsureMyRequestResponse } from '@claudian/collab-protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type {
  CollabHttpOperationOptions,
  CollabJsonRequest,
} from '@/app/collab/lan/CollabHttpClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type { CollabLanProjectSnapshot } from '@/core/collab';

export interface ProjectControlTransport {
  requestWithMember<T>(
    request: CollabJsonRequest<T>,
    memberCredential: string,
    options?: CollabHttpOperationOptions,
  ): Promise<T>;
}

export interface EnsureProjectRequestInput {
  readonly description: string;
  readonly expectedMainOid: string;
  readonly headOid: string;
  readonly idempotencyKey: string;
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

export interface ReadProjectRequestInput {
  readonly memberCredential: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface CreateProjectCommentInput extends ReadProjectRequestInput {
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface AcceptProjectRequestInput extends ReadProjectRequestInput {
  readonly expectedHeadOid: string;
  readonly expectedMainOid: string;
  readonly expectedRequestRevision: number;
  readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
  readonly idempotencyKey: string;
}

export interface UpdateProjectRequestMetadataInput extends ReadProjectRequestInput {
  readonly description: string;
  readonly expectedHeadOid: string;
  readonly expectedRequestRevision: number;
  readonly idempotencyKey: string;
}

export interface ListProjectTicketsInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
  readonly status: CollabTicketStatus;
}

export interface ReadProjectTicketInput {
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
  readonly ticketId: string;
}

export interface PageProjectTicketCommentsInput extends ReadProjectTicketInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PageProjectTicketRelationsInput extends ReadProjectTicketInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PageProjectRequestCommentsInput extends ReadProjectRequestInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CreateProjectTicketInput {
  readonly body: string;
  readonly idempotencyKey: string;
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
  readonly title: string;
}

export interface UpdateProjectTicketContentInput extends ReadProjectTicketInput {
  readonly body: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly title: string;
}

export interface CreateProjectTicketCommentInput extends ReadProjectTicketInput {
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface ChangeProjectTicketStatusInput extends ReadProjectTicketInput {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export class ProjectControlClient {
  constructor(private readonly transport: ProjectControlTransport) {}

  readSnapshot(
    projectId: string,
    memberCredential: string,
    options: CollabHttpOperationOptions = {},
  ): Promise<CollabLanProjectSnapshot> {
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('getSnapshot').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getSnapshot.method,
      path: collabControlOperationPath('getSnapshot', projectId),
    }, memberCredential, options);
  }

  ensureMyRequest(
    input: EnsureProjectRequestInput,
  ): Promise<EnsureMyRequestResponse> {
    return this.transport.requestWithMember({
      body: {
        description: input.description,
        expectedMainOid: input.expectedMainOid,
        headOid: input.headOid,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
      },
      decode: lanCollabControlOperationCodec('ensureMyRequest').decodeResponse,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.ensureMyRequest.method,
      path: collabControlOperationPath('ensureMyRequest', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }


  readRequest(input: ReadProjectRequestInput): Promise<CollabRequestDetail> {
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('getRequest').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getRequest.method,
      path: collabControlOperationPath('getRequest', input.projectId, {
        requestId: input.requestId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  createComment(input: CreateProjectCommentInput): Promise<CreateCommentResponse> {
    return this.transport.requestWithMember({
      body: {
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        requestId: input.requestId,
      },
      decode: lanCollabControlOperationCodec('createComment').decodeResponse,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.createComment.method,
      path: collabControlOperationPath('createComment', input.projectId, {
        requestId: input.requestId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  acceptRequest(input: AcceptProjectRequestInput): Promise<AcceptResponse> {
    return this.transport.requestWithMember({
      body: {
        expectedHeadOid: input.expectedHeadOid,
        expectedMainOid: input.expectedMainOid,
        expectedRequestRevision: input.expectedRequestRevision,
        expectedResolvingTickets: input.expectedResolvingTickets,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        requestId: input.requestId,
      },
      decode: lanCollabControlOperationCodec('acceptRequest').decodeResponse,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.acceptRequest.method,
      path: collabControlOperationPath('acceptRequest', input.projectId, {
        requestId: input.requestId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  updateRequestMetadata(
    input: UpdateProjectRequestMetadataInput,
  ): Promise<CollabChangeRequest> {
    return this.transport.requestWithMember({
      body: {
        description: input.description,
        expectedHeadOid: input.expectedHeadOid,
        expectedRequestRevision: input.expectedRequestRevision,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        requestId: input.requestId,
      },
      decode: value => lanCollabControlOperationCodec('updateMyRequestMetadata')
        .decodeResponse(value).request,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.updateMyRequestMetadata.method,
      path: collabControlOperationPath('updateMyRequestMetadata', input.projectId, {
        requestId: input.requestId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  listTickets(input: ListProjectTicketsInput): Promise<CollabTicketPage> {
    const query = new URLSearchParams({ status: input.status });
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('listTickets').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.listTickets.method,
      path: `${collabControlOperationPath('listTickets', input.projectId)}?${query.toString()}`,
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  readTicket(input: ReadProjectTicketInput): Promise<CollabTicketDetail> {
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('getTicket').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getTicket.method,
      path: collabControlOperationPath('getTicket', input.projectId, {
        ticketId: input.ticketId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  listTicketComments(input: PageProjectTicketCommentsInput): Promise<CollabTicketCommentPage> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('listTicketComments').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.listTicketComments.method,
      path: `${collabControlOperationPath('listTicketComments', input.projectId, {
        ticketId: input.ticketId,
      })}${suffix}`,
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  listTicketAcceptedRelations(
    input: PageProjectTicketRelationsInput,
  ): Promise<CollabTicketAcceptedRelationPage> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('listTicketAcceptedRelations').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.listTicketAcceptedRelations.method,
      path: `${collabControlOperationPath('listTicketAcceptedRelations', input.projectId, {
        ticketId: input.ticketId,
      })}${suffix}`,
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  listRequestComments(input: PageProjectRequestCommentsInput): Promise<CollabCommentPage> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.transport.requestWithMember({
      decode: lanCollabControlOperationCodec('listRequestComments').decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.listRequestComments.method,
      path: `${collabControlOperationPath('listRequestComments', input.projectId, {
        requestId: input.requestId,
      })}${suffix}`,
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  createTicket(input: CreateProjectTicketInput): Promise<CollabTicketDetail> {
    return this.transport.requestWithMember({
      body: {
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        title: input.title,
      },
      decode: value => lanCollabControlOperationCodec('createTicket').decodeResponse(value).ticket,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.createTicket.method,
      path: collabControlOperationPath('createTicket', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  updateTicketContent(
    input: UpdateProjectTicketContentInput,
  ): Promise<CollabTicketSummary> {
    return this.ticketMutation(input, 'content', {
      body: input.body,
      title: input.title,
    });
  }

  addTicketComment(
    input: CreateProjectTicketCommentInput,
  ): Promise<CreateTicketCommentResponse> {
    return this.transport.requestWithMember({
      body: {
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        ticketId: input.ticketId,
      },
      decode: lanCollabControlOperationCodec('createTicketComment').decodeResponse,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.createTicketComment.method,
      path: collabControlOperationPath('createTicketComment', input.projectId, {
        ticketId: input.ticketId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  closeTicket(input: ChangeProjectTicketStatusInput): Promise<CollabTicketSummary> {
    return this.ticketMutation(input, 'close');
  }

  reopenTicket(input: ChangeProjectTicketStatusInput): Promise<CollabTicketSummary> {
    return this.ticketMutation(input, 'reopen');
  }

  private ticketMutation(
    input: UpdateProjectTicketContentInput
      | ChangeProjectTicketStatusInput,
    action: 'close' | 'content' | 'reopen',
    fields: Readonly<Record<string, unknown>> = {},
  ): Promise<CollabTicketSummary> {
    const operation = action === 'content'
      ? 'updateTicketContent'
      : action === 'close' ? 'closeTicket' : 'reopenTicket';
    return this.transport.requestWithMember({
      body: {
        ...fields,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        ticketId: input.ticketId,
      },
      decode: value => lanCollabControlOperationCodec(operation).decodeResponse(value).ticket,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS[operation].method,
      path: collabControlOperationPath(operation, input.projectId, {
        ticketId: input.ticketId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }
}
