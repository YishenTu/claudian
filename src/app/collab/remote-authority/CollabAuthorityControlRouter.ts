import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabProjectWorkSessionRegistry,
} from '@/app/collab/activity/CollabProjectWorkSession';
import type {
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type {
  CollabAuthorityMembershipControlPort,
  CollabAuthorityMembershipOperation,
  CollabAuthorityMembershipOperationMap,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import type { CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';
import type {
  CollabAuthoritySessionFactory,
} from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabAuthorityMembershipStore {
  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null>;
}

export interface CollabAuthorityControlRouterOptions {
  readonly tryReconnect?: (
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ) => Promise<boolean>;
}

function routerError(reason: string): CollabError {
  return new CollabError({
    code: 'project-not-found',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

export class CollabAuthorityControlRouter implements
  CollabAuthorityControlPort,
  CollabAuthorityMembershipControlPort {
  constructor(
    private readonly memberships: CollabAuthorityMembershipStore,
    private readonly sessions: CollabProjectWorkSessionRegistry,
    private readonly factory: CollabAuthoritySessionFactory,
    private readonly options: CollabAuthorityControlRouterOptions = {},
  ) {}

  ensure(input: Parameters<CollabAuthorityControlPort['ensure']>[0]) {
    return this.execute(input.projectId, { signal: input.signal }, control => control.ensure(input));
  }

  acceptRequest(input: Parameters<CollabAuthorityControlPort['acceptRequest']>[0]) {
    return this.execute(
      input.projectId,
      { signal: input.signal },
      control => control.acceptRequest(input),
    );
  }

  createComment(input: Parameters<CollabAuthorityControlPort['createComment']>[0]) {
    return this.execute(
      input.projectId,
      { signal: input.signal },
      control => control.createComment(input),
    );
  }

  createTicket(
    request: Parameters<CollabAuthorityControlPort['createTicket']>[0],
    idempotencyKey: string,
    options?: Parameters<CollabAuthorityControlPort['createTicket']>[2],
  ) {
    return this.execute(request.projectId, options, control => (
      control.createTicket(request, idempotencyKey, options)
    ));
  }

  updateTicketContent(
    request: Parameters<CollabAuthorityControlPort['updateTicketContent']>[0],
    idempotencyKey: string,
    options?: Parameters<CollabAuthorityControlPort['updateTicketContent']>[2],
  ) {
    return this.execute(request.projectId, options, control => (
      control.updateTicketContent(request, idempotencyKey, options)
    ));
  }

  addTicketComment(
    request: Parameters<CollabAuthorityControlPort['addTicketComment']>[0],
    idempotencyKey: string,
    options?: Parameters<CollabAuthorityControlPort['addTicketComment']>[2],
  ) {
    return this.execute(request.projectId, options, control => (
      control.addTicketComment(request, idempotencyKey, options)
    ));
  }

  closeTicket(
    request: Parameters<CollabAuthorityControlPort['closeTicket']>[0],
    idempotencyKey: string,
    options?: Parameters<CollabAuthorityControlPort['closeTicket']>[2],
  ) {
    return this.execute(request.projectId, options, control => (
      control.closeTicket(request, idempotencyKey, options)
    ));
  }

  reopenTicket(
    request: Parameters<CollabAuthorityControlPort['reopenTicket']>[0],
    idempotencyKey: string,
    options?: Parameters<CollabAuthorityControlPort['reopenTicket']>[2],
  ) {
    return this.execute(request.projectId, options, control => (
      control.reopenTicket(request, idempotencyKey, options)
    ));
  }

  updateRequestMetadata(
    request: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[0],
    idempotencyKey: string,
    options?: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[2],
  ) {
    return this.execute(request.projectId, options, control => (
      control.updateRequestMetadata(request, idempotencyKey, options)
    ));
  }

  listTickets(
    request: Parameters<CollabAuthorityControlPort['listTickets']>[0],
    options?: Parameters<CollabAuthorityControlPort['listTickets']>[1],
  ) {
    return this.execute(
      request.projectId,
      options,
      control => control.listTickets(request, options),
    );
  }

  listRequestComments(
    projectId: string,
    requestId: string,
    query: Parameters<CollabAuthorityControlPort['listRequestComments']>[2],
    options?: Parameters<CollabAuthorityControlPort['listRequestComments']>[3],
  ) {
    return this.execute(projectId, options, control => (
      control.listRequestComments(projectId, requestId, query, options)
    ));
  }

  listTicketComments(
    projectId: string,
    ticketId: string,
    query: Parameters<CollabAuthorityControlPort['listTicketComments']>[2],
    options?: Parameters<CollabAuthorityControlPort['listTicketComments']>[3],
  ) {
    return this.execute(projectId, options, control => (
      control.listTicketComments(projectId, ticketId, query, options)
    ));
  }

  listTicketAcceptedRelations(
    projectId: string,
    ticketId: string,
    query: Parameters<CollabAuthorityControlPort['listTicketAcceptedRelations']>[2],
    options?: Parameters<CollabAuthorityControlPort['listTicketAcceptedRelations']>[3],
  ) {
    return this.execute(projectId, options, control => (
      control.listTicketAcceptedRelations(projectId, ticketId, query, options)
    ));
  }

  readRequest(
    projectId: string,
    requestId: string,
    options?: Parameters<CollabAuthorityControlPort['readRequest']>[2],
  ) {
    return this.execute(projectId, options, control => (
      control.readRequest(projectId, requestId, options)
    ));
  }

  readRequestPage(
    projectId: string,
    requestId: string,
    options?: Parameters<CollabAuthorityControlPort['readRequestPage']>[2],
  ) {
    return this.execute(projectId, options, control => (
      control.readRequestPage(projectId, requestId, options)
    ));
  }

  readSnapshot(
    projectId: string,
    options?: Parameters<CollabAuthorityControlPort['readSnapshot']>[1],
  ) {
    return this.execute(projectId, options, control => control.readSnapshot(projectId, options));
  }

  readTicket(
    projectId: string,
    ticketId: string,
    options?: Parameters<CollabAuthorityControlPort['readTicket']>[2],
  ) {
    return this.execute(projectId, options, control => (
      control.readTicket(projectId, ticketId, options)
    ));
  }

  readTicketPage(
    projectId: string,
    ticketId: string,
    options?: Parameters<CollabAuthorityControlPort['readTicketPage']>[2],
  ) {
    return this.execute(projectId, options, control => (
      control.readTicketPage(projectId, ticketId, options)
    ));
  }

  membership<Operation extends CollabAuthorityMembershipOperation>(
    operation: Operation,
    input: CollabAuthorityMembershipOperationMap[Operation]['input'],
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityMembershipOperationMap[Operation]['result']> {
    return this.executeMembership(input.projectId, options, control => (
      control.membership(operation, input, options)
    ));
  }

  private async execute<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions | undefined,
    operation: (control: CollabAuthorityControlPort) => Promise<T>,
  ): Promise<T> {
    return this.executeSession(projectId, options, session => operation(session.control));
  }

  private executeMembership<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions | undefined,
    operation: (control: CollabAuthorityMembershipControlPort) => Promise<T>,
  ): Promise<T> {
    return this.executeSession(projectId, options, session => {
      if (!session.membership) {
        throw routerError('authority-session-membership-control-unavailable');
      }
      return operation(session.membership);
    });
  }

  private async executeSession<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions | undefined,
    operation: (session: CollabAuthoritySession) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(await this.session(projectId));
    } catch (error) {
      const reconnectable = error instanceof CollabError
        && (error.group === 'connectivity' || error.code === 'operation-timeout');
      if (
        !reconnectable
        || options?.signal?.aborted
        || !await this.options.tryReconnect?.(projectId, options ?? {})
      ) throw error;
      return operation(await this.session(projectId));
    }
  }

  private async session(projectId: CollabProjectId): Promise<CollabAuthoritySession> {
    const work = this.sessions.acquire(projectId);
    const session = await work.ensureAuthoritySession<CollabAuthoritySession>(async () => {
      const membership = await this.memberships.loadMembership(projectId);
      if (!membership || membership.project.id !== projectId) {
        throw routerError('authority-session-membership-missing');
      }
      return this.factory.create(membership);
    });
    return session;
  }
}
