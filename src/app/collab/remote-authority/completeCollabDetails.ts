import {
  COLLAB_LIMITS,
  type CollabCommentPage,
  type CollabRequestDetail,
  type CollabTicketAcceptedRelationPage,
  type CollabTicketCommentPage,
  type CollabTicketDetail,
} from '@claudian-collab/protocol';

import type { CollabError } from '@/core/collab/ClaudianCollabError';

function assertCompleteRequestComments(
  detail: CollabRequestDetail,
  integrityError: (reason: string) => CollabError,
): void {
  if (detail.comments.comments.length > COLLAB_LIMITS.maxRequestComments) {
    throw integrityError('request-comment-limit-exceeded');
  }
  if (detail.comments.comments.length !== detail.request.commentCount) {
    throw integrityError('request-comment-count-mismatch');
  }
  if (detail.comments.comments.some(comment => comment.requestId !== detail.request.id)) {
    throw integrityError('request-comment-owner-mismatch');
  }
}

function assertCompleteTicketCollections(
  detail: CollabTicketDetail,
  integrityError: (reason: string) => CollabError,
): void {
  if (detail.comments.comments.length !== detail.ticket.commentCount) {
    throw integrityError('ticket-comment-count-mismatch');
  }
  if (detail.comments.comments.length > COLLAB_LIMITS.maxTicketComments) {
    throw integrityError('ticket-comment-limit-exceeded');
  }
  if (detail.acceptedRelations.acceptedRelations.length > COLLAB_LIMITS.maxTicketAcceptedRelations) {
    throw integrityError('ticket-relation-limit-exceeded');
  }
  if (detail.acceptedRelations.acceptedRelations.length !== detail.ticket.acceptedRelationCount) {
    throw integrityError('ticket-relation-count-mismatch');
  }
}

export async function completeRequestDetail(
  detail: CollabRequestDetail,
  readComments: (cursor: string, limit: number) => Promise<CollabCommentPage>,
  integrityError: (reason: string) => CollabError,
): Promise<CollabRequestDetail> {
  if (!detail.comments.nextCursor) {
    assertCompleteRequestComments(detail, integrityError);
    return detail;
  }
  const comments = [...detail.comments.comments];
  const visited = new Set<string>();
  let cursor: string | undefined = detail.comments.nextCursor;
  while (cursor) {
    if (visited.has(cursor)) throw integrityError('comment-cursor-cycled');
    visited.add(cursor);
    const page = await readComments(cursor, COLLAB_LIMITS.maxCommentPageSize);
    comments.push(...page.comments);
    if (comments.length > COLLAB_LIMITS.maxRequestComments) {
      throw integrityError('request-comment-limit-exceeded');
    }
    cursor = page.nextCursor;
  }
  const complete = { ...detail, comments: { comments } };
  assertCompleteRequestComments(complete, integrityError);
  return complete;
}

export async function completeTicketDetail(
  detail: CollabTicketDetail,
  readComments: (cursor: string, limit: number) => Promise<CollabTicketCommentPage>,
  readAcceptedRelations: (cursor: string, limit: number) => Promise<CollabTicketAcceptedRelationPage>,
  integrityError: (reason: string) => CollabError,
): Promise<CollabTicketDetail> {
  if (!detail.comments.nextCursor && !detail.acceptedRelations.nextCursor) {
    assertCompleteTicketCollections(detail, integrityError);
    return detail;
  }
  const comments = [...detail.comments.comments];
  const acceptedRelations = [...detail.acceptedRelations.acceptedRelations];
  const visited = new Set<string>();
  let commentCursor: string | undefined = detail.comments.nextCursor;
  while (commentCursor) {
    if (visited.has(commentCursor)) throw integrityError('comment-cursor-cycled');
    visited.add(commentCursor);
    const page = await readComments(commentCursor, COLLAB_LIMITS.maxCommentPageSize);
    comments.push(...page.comments);
    if (comments.length > COLLAB_LIMITS.maxTicketComments) {
      throw integrityError('ticket-comment-limit-exceeded');
    }
    commentCursor = page.nextCursor;
  }
  let relationCursor: string | undefined = detail.acceptedRelations.nextCursor;
  while (relationCursor) {
    if (visited.has(relationCursor)) throw integrityError('relation-cursor-cycled');
    visited.add(relationCursor);
    const page = await readAcceptedRelations(relationCursor, COLLAB_LIMITS.maxRelationsPerPage);
    acceptedRelations.push(...page.acceptedRelations);
    if (acceptedRelations.length > COLLAB_LIMITS.maxTicketAcceptedRelations) {
      throw integrityError('ticket-relation-limit-exceeded');
    }
    relationCursor = page.nextCursor;
  }
  const complete = {
    ...detail,
    acceptedRelations: { acceptedRelations },
    comments: { comments },
  };
  assertCompleteTicketCollections(complete, integrityError);
  return complete;
}
