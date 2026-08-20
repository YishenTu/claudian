import { type CollabMemberId, type CollabTicketId, isCollabMemberId, isCollabOpaqueId, parseCollabMemberMentions } from '@claudian/collab-protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function mentionError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw mentionError('ticket-mention-timestamp-invalid');
  }
}

export class TicketMentionRepository {
  replaceDescriptionMentions(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly body: string;
      readonly createdAt: string;
      readonly ticketId: CollabTicketId;
    },
  ): void {
    this.assertSource(input.ticketId, input.ticketId, input.createdAt);
    connection.run(
      `DELETE FROM ticket_mentions
       WHERE ticket_id = ? AND source_kind = 'description'`,
      [input.ticketId],
    );
    this.insertMentions(connection, {
      ...input,
      sourceId: input.ticketId,
      sourceKind: 'description',
    });
  }

  recordCommentMentions(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly body: string;
      readonly commentId: string;
      readonly createdAt: string;
      readonly ticketId: CollabTicketId;
    },
  ): void {
    this.assertSource(input.ticketId, input.commentId, input.createdAt);
    this.insertMentions(connection, {
      body: input.body,
      createdAt: input.createdAt,
      sourceId: input.commentId,
      sourceKind: 'comment',
      ticketId: input.ticketId,
    });
  }

  deleteForMember(
    connection: AuthorityDatabaseConnection,
    memberId: CollabMemberId,
  ): void {
    if (!isCollabMemberId(memberId)) throw mentionError('ticket-mention-member-id-invalid');
    connection.run(
      'DELETE FROM ticket_mentions WHERE mentioned_member_id = ?',
      [memberId],
    );
  }

  private insertMentions(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly body: string;
      readonly createdAt: string;
      readonly sourceId: string;
      readonly sourceKind: 'comment' | 'description';
      readonly ticketId: CollabTicketId;
    },
  ): void {
    const activeMembers = connection.all(
      `SELECT member_id, display_name
       FROM members
       WHERE status = 'active'
       ORDER BY member_id`,
    );
    const targets = activeMembers.map(row => {
      if (
        typeof row.member_id !== 'string'
        || !isCollabMemberId(row.member_id)
        || typeof row.display_name !== 'string'
        || row.display_name.trim().length === 0
      ) {
        throw mentionError('ticket-mention-member-row-invalid');
      }
      return { displayName: row.display_name, memberId: row.member_id };
    });
    const memberIds = parseCollabMemberMentions(input.body, targets);
    for (const memberId of memberIds) {
      connection.run(
        `INSERT INTO ticket_mentions (
          ticket_id, mentioned_member_id, source_kind, source_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          input.ticketId,
          memberId,
          input.sourceKind,
          input.sourceId,
          input.createdAt,
        ],
      );
    }
  }

  private assertSource(ticketId: string, sourceId: string, createdAt: string): void {
    if (!isCollabOpaqueId(ticketId) || !isCollabOpaqueId(sourceId)) {
      throw mentionError('ticket-mention-source-id-invalid');
    }
    assertTimestamp(createdAt);
  }
}
