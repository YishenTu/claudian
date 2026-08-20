import { COLLAB_LIMITS, type CollabChangeRequest, type CollabComment, isCollabMemberId, isCollabOpaqueId } from '@claudian/collab-protocol';

import {
  type AuthorityKeysetCursor,
  type AuthorityKeysetPage,
  trimAuthorityKeysetPage,
} from '@/app/collab/authority/AuthorityKeysetPage';
import { decodeAuthorityChangeRequest } from '@/app/collab/authority/RequestEnsureRepository';
import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

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
    || !isCollabOpaqueId(id)
    || typeof requestId !== 'string'
    || !isCollabOpaqueId(requestId)
    || typeof authorMemberId !== 'string'
    || !isCollabMemberId(authorMemberId)
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
    if (!isCollabOpaqueId(requestId)) throw queryError('request-query-id-invalid');
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

  listCommentsPage(
    connection: AuthorityDatabaseConnection,
    requestId: string,
    query: {
      readonly after?: AuthorityKeysetCursor;
      readonly limit: number;
      readonly maxUtf8Bytes?: number;
    },
  ): AuthorityKeysetPage<CollabComment> {
    if (!isCollabOpaqueId(requestId)) throw queryError('request-query-id-invalid');
    const rows = connection.all(
      `SELECT comment_id, request_id, author_member_id, body, created_at
       FROM comments
       WHERE request_id = ?
         AND (created_at > ? OR (created_at = ? AND comment_id > ?))
       ORDER BY created_at, comment_id
       LIMIT ?`,
      [
        requestId,
        query.after?.createdAt ?? '',
        query.after?.createdAt ?? '',
        query.after?.id ?? '',
        query.limit + 1,
      ],
    ).map(decodeAuthorityComment);
    return trimAuthorityKeysetPage(
      rows,
      query.limit,
      query.maxUtf8Bytes ?? COLLAB_LIMITS.commentPageMaxUtf8Bytes,
      comment => ({ createdAt: comment.createdAt, id: comment.id }),
      undefined,
      'comments',
    );
  }
}
