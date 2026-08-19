import { type CollabChangeRequest, type CollabComment } from '@claudian/collab-protocol';

import { decodeAuthorityChangeRequest } from '@/app/collab/authority/RequestEnsureRepository';
import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface AuthorityRequestRecord {
  readonly personalRef: string;
  readonly request: CollabChangeRequest;
}

function queryError(reason: string): CollabError {
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
    throw queryError('request-comment-row-invalid');
  }
  return value;
}

export function decodeAuthorityComment(
  row: Readonly<Record<string, unknown>>,
): CollabComment {
  const id = row.comment_id;
  const requestId = row.request_id;
  const authorMemberId = row.author_member_id;
  const body = row.body;
  if (
    typeof id !== 'string'
    || !ID_PATTERN.test(id)
    || typeof requestId !== 'string'
    || !ID_PATTERN.test(requestId)
    || typeof authorMemberId !== 'string'
    || !ID_PATTERN.test(authorMemberId)
    || typeof body !== 'string'
    || body.length === 0
  ) {
    throw queryError('request-comment-row-invalid');
  }
  return {
    authorMemberId,
    body,
    createdAt: timestamp(row.created_at),
    id,
    requestId,
  };
}

const REQUEST_SELECT = `
  SELECT
    r.request_id, r.member_id, r.status, r.first_base_oid,
    r.latest_head_oid, r.merged_oid, r.description, r.revision,
    r.created_at, r.updated_at,
    m.personal_ref,
    COUNT(c.comment_id) AS comment_count
  FROM change_requests r
  JOIN members m ON m.member_id = r.member_id
  LEFT JOIN comments c ON c.request_id = r.request_id
`;

export class RequestQueryRepository {
  private readonly relations = new RequestTicketRelationRepository();

  find(
    connection: AuthorityDatabaseConnection,
    requestId: string,
  ): AuthorityRequestRecord | null {
    if (!ID_PATTERN.test(requestId)) throw queryError('request-query-id-invalid');
    const row = connection.get(`${REQUEST_SELECT}
      WHERE r.request_id = ?
      GROUP BY r.request_id`, [requestId]);
    if (!row) return null;
    if (typeof row.personal_ref !== 'string') {
      throw queryError('request-personal-ref-invalid');
    }
    return {
      personalRef: row.personal_ref,
      request: decodeAuthorityChangeRequest(
        row,
        this.relations.listForRequest(connection, requestId),
      ),
    };
  }

  listComments(
    connection: AuthorityDatabaseConnection,
    requestId: string,
  ): readonly CollabComment[] {
    if (!ID_PATTERN.test(requestId)) throw queryError('request-query-id-invalid');
    return connection.all(
      `SELECT comment_id, request_id, author_member_id, body, created_at
       FROM comments
       WHERE request_id = ?
       ORDER BY created_at, comment_id`,
      [requestId],
    ).map(decodeAuthorityComment);
  }
}
