import type { CollabChangeRequest } from '@claudian/collab-protocol';

/**
 * Canonical source identity for cached and in-flight request-review work.
 * Two mutations may share a millisecond `updatedAt`, so the canonical
 * request revision is part of the key alongside the exact review OIDs,
 * comment count, and the current Member identity and role.
 */
export interface CollabReviewSourceIdentity {
  readonly currentMemberId: string;
  readonly currentMemberRole: string;
  readonly mainOid: string;
}

export type CollabReviewSourceRequest = Pick<
  CollabChangeRequest,
  'commentCount' | 'id' | 'latestHeadOid' | 'revision' | 'updatedAt'
>;

export function collabReviewSourceKey(
  projectId: string,
  request: CollabReviewSourceRequest,
  source: CollabReviewSourceIdentity,
): string {
  return [
    projectId,
    request.id,
    String(request.revision),
    source.mainOid,
    request.latestHeadOid,
    request.updatedAt,
    String(request.commentCount),
    source.currentMemberId,
    source.currentMemberRole,
  ].join(':');
}
