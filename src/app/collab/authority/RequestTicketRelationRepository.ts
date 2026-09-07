import { COLLAB_LIMITS, type CollabGitOid, type CollabMemberId, type CollabRequestId, type CollabRequestTicketRelation, type CollabTicketAcceptedRelation, type CollabTicketCommitRelationKind, type CollabTicketId, isCollabGitOid, isCollabMemberId, isCollabOpaqueId } from '@claudian-collab/protocol';

import {
  type AuthorityKeysetCursor,
  type AuthorityKeysetPage,
  trimAuthorityKeysetPage,
} from '@/app/collab/authority/AuthorityKeysetPage';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface PendingTicketRelationInput {
  readonly relationId: string;
  readonly ticketId: CollabTicketId;
  readonly kind: CollabTicketCommitRelationKind;
}

function relationError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw relationError('ticket-relation-timestamp-invalid');
  }
  return value;
}

function decodeRelation(
  row: Readonly<Record<string, unknown>>,
): CollabRequestTicketRelation {
  const id = row.relation_id;
  const ticketId = row.ticket_id;
  const ticketNumber = row.ticket_number;
  const ticketTitle = row.title;
  const ticketRevision = row.ticket_revision;
  const commitOid = row.commit_oid;
  const kind = row.kind;
  const state = row.state;
  if (
    typeof id !== 'string'
    || !isCollabOpaqueId(id)
    || typeof ticketId !== 'string'
    || !isCollabOpaqueId(ticketId)
    || typeof ticketNumber !== 'number'
    || !Number.isSafeInteger(ticketNumber)
    || ticketNumber < 1
    || typeof ticketTitle !== 'string'
    || ticketTitle.length === 0
    || typeof ticketRevision !== 'number'
    || !Number.isSafeInteger(ticketRevision)
    || ticketRevision < 1
    || typeof commitOid !== 'string'
    || !isCollabGitOid(commitOid)
    || (kind !== 'references' && kind !== 'resolves')
    || (state !== 'pending' && state !== 'accepted')
  ) {
    throw relationError('ticket-relation-row-invalid');
  }
  return {
    commitOid,
    id,
    kind,
    state,
    ticketId,
    ticketNumber,
    ticketRevision,
    ticketTitle,
  };
}

function relationSelect(): string {
  return `SELECT
    r.relation_id, r.ticket_id, r.commit_oid, r.kind, r.state,
    t.ticket_number, t.title, t.revision AS ticket_revision
  FROM request_ticket_relations r
  JOIN tickets t ON t.ticket_id = r.ticket_id`;
}

export class RequestTicketRelationRepository {
  listForRequest(
    connection: AuthorityDatabaseConnection,
    requestId: CollabRequestId,
  ): readonly CollabRequestTicketRelation[] {
    if (!isCollabOpaqueId(requestId)) {
      throw relationError('ticket-relation-request-id-invalid');
    }
    return connection.all(
      `${relationSelect()}
       WHERE r.request_id = ?
       ORDER BY t.ticket_number, r.relation_id`,
      [requestId],
    ).map(decodeRelation);
  }

  replacePending(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly commitOid: CollabGitOid;
      readonly requestId: CollabRequestId;
      readonly relations: readonly PendingTicketRelationInput[];
      readonly updatedAt: string;
    },
  ): { readonly changed: boolean; readonly relations: readonly CollabRequestTicketRelation[] } {
    if (
      !isCollabMemberId(input.actorMemberId)
      || !isCollabOpaqueId(input.requestId)
      || !isCollabGitOid(input.commitOid)
      || input.relations.length > COLLAB_LIMITS.maxRequestTicketRelations
    ) {
      throw relationError('ticket-relation-input-invalid');
    }
    timestamp(input.updatedAt);
    const desired = new Map<CollabTicketId, PendingTicketRelationInput>();
    for (const relation of input.relations) {
      if (
        !isCollabOpaqueId(relation.relationId)
        || !isCollabOpaqueId(relation.ticketId)
        || (relation.kind !== 'references' && relation.kind !== 'resolves')
        || desired.has(relation.ticketId)
      ) {
        throw relationError('ticket-relation-input-invalid');
      }
      desired.set(relation.ticketId, relation);
    }

    const existing = this.listForRequest(connection, input.requestId);
    if (existing.some(relation => relation.state !== 'pending')) {
      throw relationError('accepted-relation-on-open-request');
    }
    let changed = false;

    for (const relation of existing) {
      const next = desired.get(relation.ticketId);
      if (!next) {
        connection.run(
          `DELETE FROM request_ticket_relations
           WHERE relation_id = ? AND state = 'pending'`,
          [relation.id],
        );
        changed = true;
        continue;
      }
      desired.delete(relation.ticketId);
      if (next.kind !== relation.kind || input.commitOid !== relation.commitOid) {
        connection.run(
          `UPDATE request_ticket_relations
           SET kind = ?, commit_oid = ?, updated_at = ?
           WHERE relation_id = ? AND state = 'pending'`,
          [next.kind, input.commitOid, input.updatedAt, relation.id],
        );
        changed = true;
      }
    }

    for (const relation of desired.values()) {
      connection.run(
        `INSERT INTO request_ticket_relations (
          relation_id, request_id, ticket_id, commit_oid, kind, state,
          created_by_member_id, created_at, updated_at,
          accepted_at, accepted_merge_oid
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)`,
        [
          relation.relationId,
          input.requestId,
          relation.ticketId,
          input.commitOid,
          relation.kind,
          input.actorMemberId,
          input.updatedAt,
          input.updatedAt,
        ],
      );
      changed = true;
    }

    return {
      changed,
      relations: this.listForRequest(connection, input.requestId),
    };
  }

  deletePendingForRequest(
    connection: AuthorityDatabaseConnection,
    requestId: CollabRequestId,
  ): void {
    if (!isCollabOpaqueId(requestId)) {
      throw relationError('ticket-relation-request-id-invalid');
    }
    connection.run(
      `DELETE FROM request_ticket_relations
       WHERE request_id = ? AND state = 'pending'`,
      [requestId],
    );
  }

  hasPendingResolve(
    connection: AuthorityDatabaseConnection,
    ticketId: CollabTicketId,
  ): boolean {
    if (!isCollabOpaqueId(ticketId)) {
      throw relationError('ticket-relation-ticket-id-invalid');
    }
    return connection.get(
      `SELECT relation_id FROM request_ticket_relations
       WHERE ticket_id = ? AND state = 'pending' AND kind = 'resolves'
       LIMIT 1`,
      [ticketId],
    ) !== null;
  }

  assertAcceptCapacity(
    connection: AuthorityDatabaseConnection,
    requestId: CollabRequestId,
  ): void {
    if (!isCollabOpaqueId(requestId)) {
      throw relationError('ticket-relation-request-id-invalid');
    }
    const fullTicket = connection.get(
      `SELECT pending.ticket_id, COUNT(accepted.relation_id) AS accepted_count
       FROM request_ticket_relations pending
       LEFT JOIN request_ticket_relations accepted
         ON accepted.ticket_id = pending.ticket_id
        AND accepted.state = 'accepted'
       WHERE pending.request_id = ? AND pending.state = 'pending'
       GROUP BY pending.ticket_id
       HAVING COUNT(accepted.relation_id) >= ?
       LIMIT 1`,
      [requestId, COLLAB_LIMITS.maxTicketAcceptedRelations],
    );
    if (!fullTicket) return;
    if (
      typeof fullTicket.ticket_id !== 'string'
      || !isCollabOpaqueId(fullTicket.ticket_id)
      || typeof fullTicket.accepted_count !== 'number'
      || !Number.isSafeInteger(fullTicket.accepted_count)
    ) {
      throw relationError('accepted-ticket-relation-count-invalid');
    }
    throw new CollabError({
      code: 'quota-exceeded',
      safeContext: {
        limit: COLLAB_LIMITS.maxTicketAcceptedRelations,
        quota: 'maxTicketAcceptedRelations',
      },
    });
  }

  acceptPending(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly acceptedAt: string;
      readonly acceptedMergeOid: CollabGitOid;
      readonly requestId: CollabRequestId;
    },
  ): readonly CollabRequestTicketRelation[] {
    if (!isCollabOpaqueId(input.requestId) || !isCollabGitOid(input.acceptedMergeOid)) {
      throw relationError('ticket-relation-accept-input-invalid');
    }
    timestamp(input.acceptedAt);
    connection.run(
      `UPDATE request_ticket_relations
       SET state = 'accepted', accepted_at = ?, accepted_merge_oid = ?, updated_at = ?
       WHERE request_id = ? AND state = 'pending'`,
      [input.acceptedAt, input.acceptedMergeOid, input.acceptedAt, input.requestId],
    );
    return this.listForRequest(connection, input.requestId);
  }

  listAcceptedForTicketPage(
    connection: AuthorityDatabaseConnection,
    ticketId: CollabTicketId,
    query: {
      readonly after?: AuthorityKeysetCursor;
      readonly limit: number;
      readonly maxUtf8Bytes?: number;
    },
  ): AuthorityKeysetPage<CollabTicketAcceptedRelation> {
    if (!isCollabOpaqueId(ticketId)) {
      throw relationError('ticket-relation-ticket-id-invalid');
    }
    const rows = connection.all(
      `SELECT relation_id, request_id, kind, commit_oid,
        accepted_merge_oid, accepted_at
       FROM request_ticket_relations
       WHERE ticket_id = ? AND state = 'accepted'
         AND (accepted_at > ? OR (accepted_at = ? AND relation_id > ?))
       ORDER BY accepted_at, relation_id
       LIMIT ?`,
      [
        ticketId,
        query.after?.createdAt ?? '',
        query.after?.createdAt ?? '',
        query.after?.id ?? '',
        query.limit + 1,
      ],
    ).map((row): CollabTicketAcceptedRelation => {
      const id = row.relation_id;
      const requestId = row.request_id;
      const kind = row.kind;
      const commitOid = row.commit_oid;
      const acceptedMergeOid = row.accepted_merge_oid;
      if (
        typeof id !== 'string'
        || !isCollabOpaqueId(id)
        || typeof requestId !== 'string'
        || !isCollabOpaqueId(requestId)
        || (kind !== 'references' && kind !== 'resolves')
        || typeof commitOid !== 'string'
        || !isCollabGitOid(commitOid)
        || typeof acceptedMergeOid !== 'string'
        || !isCollabGitOid(acceptedMergeOid)
      ) {
        throw relationError('accepted-ticket-relation-row-invalid');
      }
      return {
        acceptedAt: timestamp(row.accepted_at),
        acceptedMergeOid,
        commitOid,
        id,
        kind,
        requestId,
      };
    });
    return trimAuthorityKeysetPage(
      rows,
      query.limit,
      query.maxUtf8Bytes ?? COLLAB_LIMITS.relationPageMaxUtf8Bytes,
      relation => ({ createdAt: relation.acceptedAt, id: relation.id }),
      undefined,
      'acceptedRelations',
    );
  }
}
