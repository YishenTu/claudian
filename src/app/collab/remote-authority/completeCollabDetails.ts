import {
  COLLAB_LIMITS,
  type CollabCommentPage,
  type CollabRequestDetail,
  type CollabTicketAcceptedRelationPage,
  type CollabTicketCommentPage,
  type CollabTicketDetail,
} from '@claudian-collab/protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

const MAX_COMPLETE_READ_ATTEMPTS = 3;

function requestMetadata(detail: CollabRequestDetail): string {
  return JSON.stringify([
    detail.request,
    detail.currentMainOid,
    detail.reviewedHeadOid,
    detail.reviewCondition,
  ]);
}

function assertUniqueIds(
  values: readonly { readonly id: string }[],
  integrityError: (reason: string) => CollabError,
  reason: string,
): void {
  if (new Set(values.map(value => value.id)).size !== values.length) {
    throw integrityError(reason);
  }
}

function assertPageProgress(
  itemCount: number,
  nextCursor: string | undefined,
  visited: ReadonlySet<string>,
  kind: 'comment' | 'relation',
  integrityError: (reason: string) => CollabError,
): void {
  if (!nextCursor) return;
  if (visited.has(nextCursor)) throw integrityError(`${kind}-cursor-cycled`);
  if (itemCount === 0) throw integrityError(`${kind}-page-no-progress`);
}

function assertRequestCommentIdentities(
  detail: CollabRequestDetail,
  integrityError: (reason: string) => CollabError,
): void {
  if (detail.comments.comments.length > COLLAB_LIMITS.maxRequestComments) {
    throw integrityError('request-comment-limit-exceeded');
  }
  assertUniqueIds(detail.comments.comments, integrityError, 'request-comment-duplicate');
  if (detail.comments.comments.some(comment => comment.requestId !== detail.request.id)) {
    throw integrityError('request-comment-owner-mismatch');
  }
}

function assertCompleteRequestComments(
  detail: CollabRequestDetail,
  integrityError: (reason: string) => CollabError,
): void {
  assertRequestCommentIdentities(detail, integrityError);
  if (detail.comments.comments.length !== detail.request.commentCount) {
    throw integrityError('request-comment-count-mismatch');
  }
}

function assertTicketCollectionIdentities(
  detail: CollabTicketDetail,
  integrityError: (reason: string) => CollabError,
): void {
  if (detail.comments.comments.length > COLLAB_LIMITS.maxTicketComments) {
    throw integrityError('ticket-comment-limit-exceeded');
  }
  if (detail.acceptedRelations.acceptedRelations.length > COLLAB_LIMITS.maxTicketAcceptedRelations) {
    throw integrityError('ticket-relation-limit-exceeded');
  }
  assertUniqueIds(detail.comments.comments, integrityError, 'ticket-comment-duplicate');
  assertUniqueIds(detail.acceptedRelations.acceptedRelations, integrityError, 'ticket-relation-duplicate');
  if (detail.comments.comments.some(comment => comment.ticketId !== detail.ticket.id)) {
    throw integrityError('ticket-comment-owner-mismatch');
  }
}

function assertCompleteTicketCollections(
  detail: CollabTicketDetail,
  integrityError: (reason: string) => CollabError,
): void {
  assertTicketCollectionIdentities(detail, integrityError);
  if (detail.comments.comments.length !== detail.ticket.commentCount) {
    throw integrityError('ticket-comment-count-mismatch');
  }
  if (detail.acceptedRelations.acceptedRelations.length !== detail.ticket.acceptedRelationCount) {
    throw integrityError('ticket-relation-count-mismatch');
  }
}

export async function completeRequestDetail(
  detail: CollabRequestDetail,
  readComments: (cursor: string, limit: number) => Promise<CollabCommentPage>,
  integrityError: (reason: string) => CollabError,
  readDetail: () => Promise<CollabRequestDetail>,
): Promise<CollabRequestDetail> {
  for (let attempt = 0; attempt < MAX_COMPLETE_READ_ATTEMPTS; attempt += 1) {
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
      assertPageProgress(page.comments.length, page.nextCursor, visited, 'comment', integrityError);
      comments.push(...page.comments);
      if (comments.length > COLLAB_LIMITS.maxRequestComments) {
        throw integrityError('request-comment-limit-exceeded');
      }
      cursor = page.nextCursor;
    }
    const complete = { ...detail, comments: { comments } };
    assertRequestCommentIdentities(complete, integrityError);
    const current = await readDetail();
    if (requestMetadata(current) !== requestMetadata(detail)) {
      detail = current;
      continue;
    }
    assertCompleteRequestComments(complete, integrityError);
    return complete;
  }
  throw new CollabError({
    code: 'stale-request-head',
    recoveryActions: ['retry'],
    safeContext: { reason: 'request-detail-changed-during-paging' },
  });
}

export async function completeTicketDetail(
  detail: CollabTicketDetail,
  readComments: (cursor: string, limit: number) => Promise<CollabTicketCommentPage>,
  readAcceptedRelations: (cursor: string, limit: number) => Promise<CollabTicketAcceptedRelationPage>,
  integrityError: (reason: string) => CollabError,
  readDetail: () => Promise<CollabTicketDetail>,
): Promise<CollabTicketDetail> {
  for (let attempt = 0; attempt < MAX_COMPLETE_READ_ATTEMPTS; attempt += 1) {
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
      assertPageProgress(page.comments.length, page.nextCursor, visited, 'comment', integrityError);
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
      assertPageProgress(page.acceptedRelations.length, page.nextCursor, visited, 'relation', integrityError);
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
    assertTicketCollectionIdentities(complete, integrityError);
    const current = await readDetail();
    if (JSON.stringify([current.ticket, current.body]) !== JSON.stringify([detail.ticket, detail.body])) {
      detail = current;
      continue;
    }
    assertCompleteTicketCollections(complete, integrityError);
    return complete;
  }
  throw new CollabError({
    code: 'stale-ticket',
    recoveryActions: ['retry'],
    safeContext: { reason: 'ticket-detail-changed-during-paging' },
  });
}
