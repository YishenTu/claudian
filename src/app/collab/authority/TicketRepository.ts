import { type CollabMemberId, type CollabTicketComment, type CollabTicketDetail, type CollabTicketId, type CollabTicketStatus, type CollabTicketSummary } from '@claudian/collab-protocol';

import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface TicketListCursor {
  readonly ticketNumber: number;
  readonly updatedAt: string;
}

function ticketError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function timestamp(value: unknown, nullable = false): string | undefined {
  if (nullable && value === null) return undefined;
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw ticketError('ticket-timestamp-invalid');
  }
  return value;
}

export function decodeTicketSummary(
  row: Readonly<Record<string, unknown>>,
): CollabTicketSummary {
  const id = row.ticket_id;
  const number = row.ticket_number;
  const title = row.title;
  const status = row.status;
  const authorMemberId = row.author_member_id;
  const revision = row.revision;
  const commentCount = row.comment_count;
  const closedAt = timestamp(row.closed_at, true);
  const closedByMemberId = row.closed_by_member_id;
  if (
    typeof id !== 'string'
    || !ID_PATTERN.test(id)
    || typeof number !== 'number'
    || !Number.isSafeInteger(number)
    || number < 1
    || typeof title !== 'string'
    || title.length === 0
    || (status !== 'open' && status !== 'closed')
    || typeof authorMemberId !== 'string'
    || !ID_PATTERN.test(authorMemberId)
    || typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 1
    || typeof commentCount !== 'number'
    || !Number.isSafeInteger(commentCount)
    || commentCount < 0
    || (closedByMemberId !== null && (
      typeof closedByMemberId !== 'string' || !ID_PATTERN.test(closedByMemberId)
    ))
    || (status === 'open' && (closedAt !== undefined || closedByMemberId !== null))
    || (status === 'closed' && (closedAt === undefined || closedByMemberId === null))
  ) {
    throw ticketError('ticket-row-invalid');
  }
  return {
    authorMemberId,
    commentCount,
    createdAt: timestamp(row.created_at)!,
    id,
    number,
    revision,
    status,
    title,
    updatedAt: timestamp(row.updated_at)!,
    ...(closedAt ? { closedAt, closedByMemberId: closedByMemberId as string } : {}),
  };
}

export function decodeTicketComment(
  row: Readonly<Record<string, unknown>>,
): CollabTicketComment {
  const id = row.comment_id;
  const ticketId = row.ticket_id;
  const authorMemberId = row.author_member_id;
  const body = row.body;
  if (
    typeof id !== 'string'
    || !ID_PATTERN.test(id)
    || typeof ticketId !== 'string'
    || !ID_PATTERN.test(ticketId)
    || typeof authorMemberId !== 'string'
    || !ID_PATTERN.test(authorMemberId)
    || typeof body !== 'string'
    || body.length === 0
  ) {
    throw ticketError('ticket-comment-row-invalid');
  }
  return {
    authorMemberId,
    body,
    createdAt: timestamp(row.created_at)!,
    id,
    ticketId,
  };
}

const TICKET_SELECT = `SELECT
  ticket_number, ticket_id, title, status, author_member_id,
  revision, comment_count, created_at, updated_at,
  closed_at, closed_by_member_id
FROM tickets`;

export class TicketRepository {
  constructor(
    private readonly relations = new RequestTicketRelationRepository(),
  ) {}

  find(
    connection: AuthorityDatabaseConnection,
    ticketId: CollabTicketId,
  ): CollabTicketSummary | null {
    if (!ID_PATTERN.test(ticketId)) throw ticketError('ticket-id-invalid');
    const row = connection.get(`${TICKET_SELECT} WHERE ticket_id = ?`, [ticketId]);
    return row ? decodeTicketSummary(row) : null;
  }

  findByNumber(
    connection: AuthorityDatabaseConnection,
    ticketNumber: number,
  ): CollabTicketSummary | null {
    if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
      throw ticketError('ticket-number-invalid');
    }
    const row = connection.get(`${TICKET_SELECT} WHERE ticket_number = ?`, [ticketNumber]);
    return row ? decodeTicketSummary(row) : null;
  }

  findByNumbers(
    connection: AuthorityDatabaseConnection,
    ticketNumbers: readonly number[],
  ): readonly CollabTicketSummary[] {
    if (ticketNumbers.length === 0) return [];
    if (ticketNumbers.some(number => !Number.isSafeInteger(number) || number < 1)) {
      throw ticketError('ticket-number-invalid');
    }
    const unique = [...new Set(ticketNumbers)];
    const placeholders = unique.map(() => '?').join(', ');
    return connection.all(
      `${TICKET_SELECT} WHERE ticket_number IN (${placeholders})
       ORDER BY ticket_number`,
      unique,
    ).map(decodeTicketSummary);
  }

  list(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly status: CollabTicketStatus | 'all';
      readonly limit: number;
      readonly cursor?: TicketListCursor;
    },
  ): readonly CollabTicketSummary[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw ticketError('ticket-list-limit-invalid');
    }
    const statusClause = input.status === 'all' ? '' : 'status = ? AND';
    const cursorClause = input.cursor
      ? '(updated_at < ? OR (updated_at = ? AND ticket_number < ?))'
      : '';
    const params: Array<string | number> = [];
    if (input.status !== 'all') params.push(input.status);
    if (input.cursor) {
      params.push(
        input.cursor.updatedAt,
        input.cursor.updatedAt,
        input.cursor.ticketNumber,
      );
    }
    params.push(input.limit);
    return connection.all(
      `${TICKET_SELECT}
       WHERE ${statusClause} ${cursorClause || '1 = 1'}
       ORDER BY updated_at DESC, ticket_number DESC
       LIMIT ?`,
      params,
    ).map(decodeTicketSummary);
  }

  listHighlights(
    connection: AuthorityDatabaseConnection,
    limit: number,
  ): readonly CollabTicketSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw ticketError('ticket-highlight-input-invalid');
    }
    return connection.all(
      `${TICKET_SELECT}
       WHERE status = 'open'
       ORDER BY updated_at DESC, ticket_number DESC
       LIMIT ?`,
      [limit],
    ).map(decodeTicketSummary);
  }

  countOpen(connection: AuthorityDatabaseConnection): number {
    const count = connection.get(
      "SELECT COUNT(*) AS count FROM tickets WHERE status = 'open'",
    )?.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw ticketError('ticket-count-invalid');
    }
    return count;
  }

  hasIncompleteAcceptance(
    connection: AuthorityDatabaseConnection,
    ticketId: CollabTicketId,
  ): boolean {
    if (!ID_PATTERN.test(ticketId)) throw ticketError('ticket-id-invalid');
    return connection.get(
      `SELECT ao.operation_id
       FROM accept_operations ao
       JOIN request_ticket_relations r ON r.request_id = ao.request_id
       WHERE ao.state != 'completed'
         AND r.ticket_id = ?
         AND r.kind = 'resolves'
         AND r.state = 'pending'
       LIMIT 1`,
      [ticketId],
    ) !== null;
  }

  detail(
    connection: AuthorityDatabaseConnection,
    ticketId: CollabTicketId,
  ): CollabTicketDetail | null {
    const ticket = this.find(connection, ticketId);
    if (!ticket) return null;
    const body = connection.get(
      'SELECT body FROM tickets WHERE ticket_id = ?',
      [ticketId],
    )?.body;
    if (typeof body !== 'string' || body.length === 0) {
      throw ticketError('ticket-body-invalid');
    }
    return {
      acceptedRelations: this.relations.listAcceptedForTicket(connection, ticketId),
      body,
      comments: this.listComments(connection, ticketId),
      ticket,
    };
  }

  create(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly authorMemberId: CollabMemberId;
      readonly body: string;
      readonly createdAt: string;
      readonly ticketId: CollabTicketId;
      readonly title: string;
    },
  ): CollabTicketDetail {
    if (
      !ID_PATTERN.test(input.ticketId)
      || !ID_PATTERN.test(input.authorMemberId)
    ) {
      throw ticketError('ticket-create-input-invalid');
    }
    timestamp(input.createdAt);
    connection.run(
      `INSERT INTO tickets (
        ticket_id, title, body, status, author_member_id,
        revision, comment_count, created_at, updated_at, closed_at,
        closed_by_member_id
      ) VALUES (?, ?, ?, 'open', ?, 1, 0, ?, ?, NULL, NULL)`,
      [
        input.ticketId,
        input.title,
        input.body,
        input.authorMemberId,
        input.createdAt,
        input.createdAt,
      ],
    );
    const created = this.detail(connection, input.ticketId);
    if (!created) throw ticketError('ticket-create-failed');
    return created;
  }

  updateContent(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly body: string;
      readonly expectedRevision: number;
      readonly ticketId: CollabTicketId;
      readonly title: string;
      readonly updatedAt: string;
    },
  ): CollabTicketSummary | null {
    connection.run(
      `UPDATE tickets
       SET title = ?, body = ?, revision = revision + 1, updated_at = ?
       WHERE ticket_id = ? AND revision = ?`,
      [input.title, input.body, input.updatedAt, input.ticketId, input.expectedRevision],
    );
    return this.find(connection, input.ticketId);
  }

  createComment(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly authorMemberId: CollabMemberId;
      readonly body: string;
      readonly commentId: string;
      readonly createdAt: string;
      readonly ticketId: CollabTicketId;
    },
  ): { readonly comment: CollabTicketComment; readonly ticket: CollabTicketSummary } {
    connection.run(
      `INSERT INTO ticket_comments (
        comment_id, ticket_id, author_member_id, body, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        input.commentId,
        input.ticketId,
        input.authorMemberId,
        input.body,
        input.createdAt,
      ],
    );
    connection.run(
      `UPDATE tickets
       SET comment_count = comment_count + 1,
         revision = revision + 1,
         updated_at = ?
       WHERE ticket_id = ?`,
      [input.createdAt, input.ticketId],
    );
    const comment = connection.get(
      `SELECT comment_id, ticket_id, author_member_id, body, created_at
       FROM ticket_comments WHERE comment_id = ?`,
      [input.commentId],
    );
    const ticket = this.find(connection, input.ticketId);
    if (!comment || !ticket) throw ticketError('ticket-comment-create-failed');
    return { comment: decodeTicketComment(comment), ticket };
  }

  listComments(
    connection: AuthorityDatabaseConnection,
    ticketId: CollabTicketId,
  ): readonly CollabTicketComment[] {
    return connection.all(
      `SELECT comment_id, ticket_id, author_member_id, body, created_at
       FROM ticket_comments
       WHERE ticket_id = ?
       ORDER BY created_at, comment_id`,
      [ticketId],
    ).map(decodeTicketComment);
  }

  changeStatus(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly expectedRevision: number;
      readonly status: CollabTicketStatus;
      readonly ticketId: CollabTicketId;
      readonly updatedAt: string;
    },
  ): CollabTicketSummary | null {
    const closed = input.status === 'closed';
    connection.run(
      `UPDATE tickets
       SET status = ?, revision = revision + 1, updated_at = ?,
         closed_at = ?, closed_by_member_id = ?
       WHERE ticket_id = ? AND revision = ?`,
      [
        input.status,
        input.updatedAt,
        closed ? input.updatedAt : null,
        closed ? input.actorMemberId : null,
        input.ticketId,
        input.expectedRevision,
      ],
    );
    return this.find(connection, input.ticketId);
  }
}
