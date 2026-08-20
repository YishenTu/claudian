import { createHash, randomUUID } from 'node:crypto';

import { type ChangeTicketStatusRequest, type CollabMemberId, type CollabRole, type CollabTicketAcceptedRelationPage, type CollabTicketComment, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketPage, type CollabTicketSummary, type CreateTicketCommentRequest, type CreateTicketCommentResponse, type CreateTicketRequest, type ListTicketsRequest, type UpdateTicketContentRequest } from '@claudian/collab-protocol';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { decodeAuthorityKeysetCursor, trimAuthorityKeysetPage } from '@/app/collab/authority/AuthorityKeysetPage';
import { RequestEnsureRepository } from '@/app/collab/authority/RequestEnsureRepository';
import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketMentionRepository } from '@/app/collab/authority/TicketMentionRepository';
import {
  decodeTicketComment,
  decodeTicketSummary,
  type TicketListCursor,
  TicketRepository,
} from '@/app/collab/authority/TicketRepository';
import { type CollabOperationKind } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface TicketDatabasePort {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

export interface TicketServiceOptions {
  readonly createId?: (kind: 'ticket' | 'ticket-comment') => string;
  readonly now?: () => Date;
}

interface TicketActor {
  readonly memberId: CollabMemberId;
  readonly role: CollabRole;
}

function ticketError(
  code:
    | 'acceptance-recovery-required'
    | 'authorization-denied'
    | 'protocol-payload-invalid'
    | 'quota-exceeded'
    | 'stale-ticket'
    | 'ticket-not-found'
    | 'ticket-not-open',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'stale-ticket'
      ? ['retry']
      : code === 'acceptance-recovery-required'
        ? ['open-diagnostics']
        : [],
    safeContext: { reason },
  });
}

function normalizeMarkdown(value: string, maxBytes: number, field: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  while (lines[0]?.trim().length === 0) lines.shift();
  while (lines.at(-1)?.trim().length === 0) lines.pop();
  const normalized = lines.join('\n');
  if (normalized.trim().length === 0) {
    throw ticketError('protocol-payload-invalid', `${field}-blank`);
  }
  if (new TextEncoder().encode(normalized).byteLength > maxBytes) {
    throw ticketError('quota-exceeded', `${field}-too-large`);
  }
  return normalized;
}

function normalizeTitle(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > CLAUDIAN_COLLAB_LIMITS.maxTicketTitleUtf16) {
    throw ticketError('protocol-payload-invalid', 'ticket-title-invalid');
  }
  return normalized;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function storedSummary(value: unknown): CollabTicketSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ticketError('protocol-payload-invalid', 'stored-ticket-invalid');
  }
  const row = value as Readonly<Record<string, unknown>>;
  return decodeTicketSummary({
    accepted_relation_count: row.acceptedRelationCount,
    author_member_id: row.authorMemberId,
    closed_at: row.closedAt ?? null,
    closed_by_member_id: row.closedByMemberId ?? null,
    comment_count: row.commentCount,
    created_at: row.createdAt,
    revision: row.revision,
    status: row.status,
    ticket_id: row.id,
    ticket_number: row.number,
    title: row.title,
    updated_at: row.updatedAt,
  });
}

function storedComment(value: unknown): CollabTicketComment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ticketError('protocol-payload-invalid', 'stored-ticket-comment-invalid');
  }
  const row = value as Readonly<Record<string, unknown>>;
  return decodeTicketComment({
    author_member_id: row.authorMemberId,
    body: row.body,
    comment_id: row.id,
    created_at: row.createdAt,
    ticket_id: row.ticketId,
  });
}

function storedDetail(value: unknown): CollabTicketDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ticketError('protocol-payload-invalid', 'stored-ticket-detail-invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const comments = record.comments as Readonly<Record<string, unknown>> | undefined;
  const acceptedRelations = record.acceptedRelations as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    typeof record.body !== 'string'
    || !comments
    || Array.isArray(comments)
    || !Array.isArray(comments.comments)
    || comments.comments.length !== 0
    || comments.nextCursor !== undefined
    || !acceptedRelations
    || Array.isArray(acceptedRelations)
    || !Array.isArray(acceptedRelations.acceptedRelations)
    || acceptedRelations.acceptedRelations.length !== 0
    || acceptedRelations.nextCursor !== undefined
  ) {
    throw ticketError('protocol-payload-invalid', 'stored-ticket-detail-invalid');
  }
  return {
    acceptedRelations: { acceptedRelations: [] },
    body: record.body,
    comments: { comments: [] },
    ticket: storedSummary(record.ticket),
  };
}

function encodeCursor(cursor: TicketListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string | undefined): TicketListCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 512) {
    throw ticketError('protocol-payload-invalid', 'ticket-cursor-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw ticketError('protocol-payload-invalid', 'ticket-cursor-invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ticketError('protocol-payload-invalid', 'ticket-cursor-invalid');
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  if (
    typeof record.ticketNumber !== 'number'
    || !Number.isSafeInteger(record.ticketNumber)
    || record.ticketNumber < 1
    || typeof record.updatedAt !== 'string'
    || Number.isNaN(Date.parse(record.updatedAt))
    || new Date(record.updatedAt).toISOString() !== record.updatedAt
  ) {
    throw ticketError('protocol-payload-invalid', 'ticket-cursor-invalid');
  }
  return { ticketNumber: record.ticketNumber, updatedAt: record.updatedAt };
}

export class TicketService {
  private readonly createId: (kind: 'ticket' | 'ticket-comment') => string;
  private readonly events = new AuthorityEventRepository();
  private readonly idempotency = new AuthorityIdempotencyRepository();
  private readonly members = new RequestEnsureRepository();
  private readonly mentions = new TicketMentionRepository();
  private readonly now: () => Date;
  private readonly tickets = new TicketRepository();

  constructor(
    private readonly database: TicketDatabasePort,
    options: TicketServiceOptions = {},
  ) {
    this.createId = options.createId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  async list(
    actorMemberId: CollabMemberId,
    request: ListTicketsRequest,
  ): Promise<CollabTicketPage> {
    const limit = request.limit ?? CLAUDIAN_COLLAB_LIMITS.defaultTicketPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLAUDIAN_COLLAB_LIMITS.maxTicketPageSize) {
      throw ticketError('protocol-payload-invalid', 'ticket-list-limit-invalid');
    }
    const cursor = decodeCursor(request.cursor);
    return this.database.read(connection => {
      this.requireActor(connection, request.projectId, actorMemberId);
      const rows = this.tickets.list(connection, {
        cursor,
        limit: limit + 1,
        status: request.status,
      });
      // Bound the page by serialized bytes as well as count: a count-only
      // page of maximal summaries could exceed the transport envelope.
      const page = trimAuthorityKeysetPage(
        rows,
        limit,
        CLAUDIAN_COLLAB_LIMITS.ticketPageMaxUtf8Bytes,
        ticket => ({ createdAt: ticket.updatedAt, id: String(ticket.number) }),
        key => encodeCursor({ ticketNumber: Number(key.id), updatedAt: key.createdAt }),
        'tickets',
      );
      return {
        tickets: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  }

  async read(
    actorMemberId: CollabMemberId,
    projectId: string,
    ticketId: string,
  ): Promise<CollabTicketDetail> {
    return this.database.read(connection => {
      this.requireActor(connection, projectId, actorMemberId);
      const detail = this.tickets.detail(connection, ticketId);
      if (!detail) throw ticketError('ticket-not-found', 'ticket-detail-missing');
      return detail;
    });
  }

  async listComments(
    actorMemberId: CollabMemberId,
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<CollabTicketCommentPage> {
    const limit = query.limit ?? CLAUDIAN_COLLAB_LIMITS.defaultCommentPageSize;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > CLAUDIAN_COLLAB_LIMITS.maxCommentPageSize
    ) {
      throw ticketError('protocol-payload-invalid', 'ticket-comment-page-limit-invalid');
    }
    const cursor = decodeAuthorityKeysetCursor(query.cursor, 'ticket-comment-cursor-invalid');
    return this.database.read(connection => {
      this.requireActor(connection, projectId, actorMemberId);
      if (!this.tickets.find(connection, ticketId)) {
        throw ticketError('ticket-not-found', 'ticket-detail-missing');
      }
      const page = this.tickets.listCommentsPage(connection, ticketId, {
        ...(cursor ? { after: cursor } : {}),
        limit,
      });
      return {
        comments: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  }

  async listAcceptedRelations(
    actorMemberId: CollabMemberId,
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<CollabTicketAcceptedRelationPage> {
    const limit = query.limit ?? CLAUDIAN_COLLAB_LIMITS.maxRelationsPerPage;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > CLAUDIAN_COLLAB_LIMITS.maxRelationsPerPage
    ) {
      throw ticketError('protocol-payload-invalid', 'ticket-relation-page-limit-invalid');
    }
    const cursor = decodeAuthorityKeysetCursor(query.cursor, 'ticket-relation-cursor-invalid');
    return this.database.read(connection => {
      this.requireActor(connection, projectId, actorMemberId);
      if (!this.tickets.find(connection, ticketId)) {
        throw ticketError('ticket-not-found', 'ticket-detail-missing');
      }
      const page = this.tickets.listAcceptedForTicketPage(connection, ticketId, {
        ...(cursor ? { after: cursor } : {}),
        limit,
      });
      return {
        acceptedRelations: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  }

  create(
    actorMemberId: CollabMemberId,
    request: CreateTicketRequest,
  ): Promise<CollabTicketDetail> {
    const title = normalizeTitle(request.title);
    const body = normalizeMarkdown(
      request.body,
      CLAUDIAN_COLLAB_LIMITS.maxTicketBodyBytes,
      'ticket-body',
    );
    return this.mutateIdempotently(
      actorMemberId,
      request.projectId,
      'create-ticket',
      request.idempotencyKey,
      fingerprint({ body, title }),
      storedDetail,
      (connection, actor, createdAt) => {
        const detail = this.tickets.create(connection, {
          authorMemberId: actor.memberId,
          body,
          createdAt,
          ticketId: this.createId('ticket'),
          title,
        });
        this.mentions.replaceDescriptionMentions(connection, {
          body,
          createdAt,
          ticketId: detail.ticket.id,
        });
        this.appendEvent(connection, actor.memberId, createdAt, 'ticket.created', detail.ticket.id);
        return detail;
      },
    );
  }

  updateContent(
    actorMemberId: CollabMemberId,
    request: UpdateTicketContentRequest,
  ): Promise<CollabTicketSummary> {
    const title = normalizeTitle(request.title);
    const body = normalizeMarkdown(
      request.body,
      CLAUDIAN_COLLAB_LIMITS.maxTicketBodyBytes,
      'ticket-body',
    );
    return this.mutateIdempotently(
      actorMemberId,
      request.projectId,
      'update-ticket',
      request.idempotencyKey,
      fingerprint({
        action: 'content',
        body,
        expectedRevision: request.expectedRevision,
        ticketId: request.ticketId,
        title,
      }),
      storedSummary,
      (connection, actor, updatedAt) => {
        const current = this.requireTicket(connection, request.ticketId);
        if (actor.role !== 'manager' && current.ticket.authorMemberId !== actor.memberId) {
          throw ticketError('authorization-denied', 'ticket-edit-denied');
        }
        this.requireRevision(current.ticket, request.expectedRevision);
        if (current.ticket.title === title && current.body === body) return current.ticket;
        this.requireNoIncompleteAcceptance(connection, current.ticket.id);
        const updated = this.tickets.updateContent(connection, {
          body,
          expectedRevision: request.expectedRevision,
          ticketId: request.ticketId,
          title,
          updatedAt,
        });
        if (!updated || updated.revision !== request.expectedRevision + 1) {
          throw ticketError('stale-ticket', 'ticket-content-cas-failed');
        }
        this.mentions.replaceDescriptionMentions(connection, {
          body,
          createdAt: updatedAt,
          ticketId: updated.id,
        });
        this.appendEvent(connection, actor.memberId, updatedAt, 'ticket.updated', updated.id);
        return updated;
      },
    );
  }

  comment(
    actorMemberId: CollabMemberId,
    request: CreateTicketCommentRequest,
  ): Promise<CreateTicketCommentResponse> {
    const body = normalizeMarkdown(
      request.body,
      CLAUDIAN_COLLAB_LIMITS.maxTicketCommentBytes,
      'ticket-comment',
    );
    return this.mutateIdempotently(
      actorMemberId,
      request.projectId,
      'comment-ticket',
      request.idempotencyKey,
      fingerprint({ body, ticketId: request.ticketId }),
      value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw ticketError('protocol-payload-invalid', 'stored-ticket-comment-invalid');
        }
        const record = value as Readonly<Record<string, unknown>>;
        return {
          comment: storedComment(record.comment),
          ticket: storedSummary(record.ticket),
        };
      },
      (connection, actor, createdAt) => {
        const current = this.requireTicket(connection, request.ticketId).ticket;
        this.requireNoIncompleteAcceptance(connection, current.id);
        if (current.commentCount >= CLAUDIAN_COLLAB_LIMITS.maxTicketComments) {
          throw ticketError('quota-exceeded', 'ticket-comment-limit');
        }
        const response = this.tickets.createComment(connection, {
          authorMemberId: actor.memberId,
          body,
          commentId: this.createId('ticket-comment'),
          createdAt,
          ticketId: request.ticketId,
        });
        this.mentions.recordCommentMentions(connection, {
          body,
          commentId: response.comment.id,
          createdAt,
          ticketId: request.ticketId,
        });
        this.appendEvent(
          connection,
          actor.memberId,
          createdAt,
          'ticket-comment.created',
          request.ticketId,
        );
        return response;
      },
    );
  }

  close(
    actorMemberId: CollabMemberId,
    request: ChangeTicketStatusRequest,
  ): Promise<CollabTicketSummary> {
    return this.changeStatus(actorMemberId, request, 'closed');
  }

  reopen(
    actorMemberId: CollabMemberId,
    request: ChangeTicketStatusRequest,
  ): Promise<CollabTicketSummary> {
    return this.changeStatus(actorMemberId, request, 'open');
  }

  private changeStatus(
    actorMemberId: CollabMemberId,
    request: ChangeTicketStatusRequest,
    status: 'open' | 'closed',
  ): Promise<CollabTicketSummary> {
    return this.mutateIdempotently(
      actorMemberId,
      request.projectId,
      'change-ticket-status',
      request.idempotencyKey,
      fingerprint({
        expectedRevision: request.expectedRevision,
        status,
        ticketId: request.ticketId,
      }),
      storedSummary,
      (connection, actor, updatedAt) => {
        const current = this.requireTicket(connection, request.ticketId).ticket;
        this.requireRevision(current, request.expectedRevision);
        if (
          actor.role !== 'manager'
          && current.authorMemberId !== actor.memberId
        ) {
          throw ticketError('authorization-denied', 'ticket-status-denied');
        }
        if (current.status === status) return current;
        this.requireNoIncompleteAcceptance(connection, current.id);
        if (status === 'open' && this.ticketsHasPendingResolve(connection, current.id)) {
          throw ticketError('stale-ticket', 'ticket-pending-resolve-reopen');
        }
        const updated = this.tickets.changeStatus(connection, {
          actorMemberId: actor.memberId,
          expectedRevision: request.expectedRevision,
          status,
          ticketId: request.ticketId,
          updatedAt,
        });
        if (!updated || updated.revision !== request.expectedRevision + 1) {
          throw ticketError('stale-ticket', 'ticket-status-cas-failed');
        }
        this.appendEvent(connection, actor.memberId, updatedAt, 'ticket.updated', updated.id);
        return updated;
      },
    );
  }

  private async mutateIdempotently<T>(
    actorMemberId: CollabMemberId,
    projectId: string,
    operationKind: CollabOperationKind,
    key: string,
    requestFingerprint: string,
    decode: (value: unknown) => T,
    mutation: (
      connection: AuthorityDatabaseConnection,
      actor: TicketActor,
      createdAt: string,
    ) => T,
  ): Promise<T> {
    const idempotencyInput = {
      actorMemberId,
      key,
      operationKind,
      requestFingerprint,
    };
    const initial = await this.database.read(connection => {
      this.requireActor(connection, projectId, actorMemberId);
      return this.idempotency.find<unknown>(connection, idempotencyInput);
    });
    if (initial) return decode(initial.response);
    const createdAt = this.now().toISOString();
    const result = await this.database.mutate(connection => {
      const replay = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decode(replay.response);
      const actor = this.requireActor(connection, projectId, actorMemberId);
      const response = mutation(connection, actor, createdAt);
      const stored = this.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt,
        response,
      });
      return stored.status === 'existing' ? decode(stored.response) : response;
    });
    return result.value;
  }

  private requireActor(
    connection: AuthorityDatabaseConnection,
    projectId: string,
    memberId: CollabMemberId,
  ): TicketActor {
    this.members.requireActiveMember(connection, projectId, memberId);
    const role = connection.get(
      'SELECT role FROM members WHERE member_id = ? AND status = \'active\'',
      [memberId],
    )?.role;
    if (role !== 'manager' && role !== 'member') {
      throw ticketError('authorization-denied', 'ticket-actor-invalid');
    }
    return { memberId, role };
  }

  private requireTicket(
    connection: AuthorityDatabaseConnection,
    ticketId: string,
  ): CollabTicketDetail {
    const ticket = this.tickets.detail(connection, ticketId);
    if (!ticket) throw ticketError('ticket-not-found', 'ticket-missing');
    return ticket;
  }

  private requireRevision(ticket: CollabTicketSummary, expectedRevision: number): void {
    if (ticket.revision !== expectedRevision) {
      throw ticketError('stale-ticket', 'ticket-revision-changed');
    }
  }

  private requireNoIncompleteAcceptance(
    connection: AuthorityDatabaseConnection,
    ticketId: string,
  ): void {
    if (this.tickets.hasIncompleteAcceptance(connection, ticketId)) {
      throw ticketError(
        'acceptance-recovery-required',
        'ticket-accept-operation-incomplete',
      );
    }
  }

  private ticketsHasPendingResolve(
    connection: AuthorityDatabaseConnection,
    ticketId: string,
  ): boolean {
    return connection.get(
      `SELECT relation_id FROM request_ticket_relations
       WHERE ticket_id = ? AND state = 'pending' AND kind = 'resolves'
       LIMIT 1`,
      [ticketId],
    ) !== null;
  }

  private appendEvent(
    connection: AuthorityDatabaseConnection,
    actorMemberId: CollabMemberId,
    createdAt: string,
    kind: string,
    ticketId: string,
  ): void {
    this.events.append(connection, {
      actorMemberId,
      createdAt,
      kind,
      payload: { ticketId },
    });
  }
}
