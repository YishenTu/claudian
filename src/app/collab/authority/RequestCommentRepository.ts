import { COLLAB_LIMITS, type CollabChangeRequest, type CollabComment, isCollabMemberId, isCollabOpaqueId } from '@claudian/collab-protocol';

import { decodeAuthorityChangeRequest } from '@/app/collab/authority/RequestEnsureRepository';
import {
  decodeAuthorityComment,
} from '@/app/collab/authority/RequestQueryRepository';
import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function commentError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class RequestCommentRepository {
  private readonly relations = new RequestTicketRelationRepository();

  private countForRequest(
    connection: AuthorityDatabaseConnection,
    requestId: string,
  ): number {
    if (!isCollabOpaqueId(requestId)) {
      throw commentError('request-comment-request-id-invalid');
    }
    const count = connection.get(
      'SELECT COUNT(*) AS count FROM comments WHERE request_id = ?',
      [requestId],
    )?.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw commentError('request-comment-count-invalid');
    }
    return count;
  }

  create(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly authorMemberId: string;
      readonly body: string;
      readonly commentId: string;
      readonly createdAt: string;
      readonly requestId: string;
    },
  ): { readonly comment: CollabComment; readonly request: CollabChangeRequest } {
    if (
      !isCollabMemberId(input.authorMemberId)
      || !isCollabOpaqueId(input.commentId)
      || !isCollabOpaqueId(input.requestId)
    ) {
      throw commentError('request-comment-input-invalid');
    }
    const requestRow = connection.get(
      'SELECT status FROM change_requests WHERE request_id = ?',
      [input.requestId],
    );
    if (!requestRow || requestRow.status !== 'open') {
      throw new CollabError({ code: 'request-not-open', recoveryActions: ['retry'] });
    }
    if (this.countForRequest(connection, input.requestId) >= COLLAB_LIMITS.maxRequestComments) {
      throw new CollabError({
        code: 'quota-exceeded',
        safeContext: {
          limit: COLLAB_LIMITS.maxRequestComments,
          quota: 'maxRequestComments',
        },
      });
    }
    connection.run(
      `INSERT INTO comments (
        comment_id, request_id, author_member_id, body, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        input.commentId,
        input.requestId,
        input.authorMemberId,
        input.body,
        input.createdAt,
      ],
    );
    connection.run(
      "UPDATE change_requests SET updated_at = ? WHERE request_id = ? AND status = 'open'",
      [input.createdAt, input.requestId],
    );
    const comment = connection.get(
      `SELECT comment_id, request_id, author_member_id, body, created_at
       FROM comments WHERE comment_id = ?`,
      [input.commentId],
    );
    const request = connection.get(
      `SELECT
        r.request_id, r.member_id, r.status, r.first_base_oid,
        r.latest_head_oid, r.merged_oid, r.description, r.revision,
        r.created_at, r.updated_at,
        COUNT(c.comment_id) AS comment_count
       FROM change_requests r
       LEFT JOIN comments c ON c.request_id = r.request_id
       WHERE r.request_id = ?
       GROUP BY r.request_id`,
      [input.requestId],
    );
    if (!comment || !request) throw commentError('request-comment-create-failed');
    return {
      comment: decodeAuthorityComment(comment),
      request: decodeAuthorityChangeRequest(
        request,
        this.relations.listForRequest(connection, input.requestId),
      ),
    };
  }
}
