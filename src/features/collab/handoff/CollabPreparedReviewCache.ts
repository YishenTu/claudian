import type { CollabChangeRequest } from '@claudian/collab-protocol';

import type { CollabCoordinationSnapshot, CollabPublicationReview, CollabRequestReview } from '@/core/collab';
import {
  type CollabReviewSourceIdentity,
  collabReviewSourceKey,
} from '@/features/collab/handoff/CollabReviewSourceKey';

export interface CollabPreparedReviewIdentity {
  readonly comparisonBaseOid: string;
  readonly comparisonTargetOid: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly reviewedHeadOid: string;
  readonly reviewedMainOid: string;
}

export interface CollabPreparedReviewEntry {
  readonly coordination: CollabCoordinationSnapshot;
  readonly review: CollabRequestReview;
}

export type CollabPreparedPublicationReviewIdentity = Pick<
  CollabPublicationReview,
  | 'candidateOid'
  | 'comparisonBaseOid'
  | 'comparisonTargetOid'
  | 'currentMainOid'
  | 'operationId'
  | 'projectId'
>;

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_TTL_MS = 5 * 60_000;

interface CachedEntry {
  readonly entry: CollabPreparedReviewEntry;
  readonly expiresAt: number;
  readonly sourceKey: string;
}

interface CachedPublicationEntry {
  readonly review: CollabPublicationReview;
  readonly expiresAt: number;
}

function identityKey(identity: CollabPreparedReviewIdentity): string {
  return [
    identity.projectId,
    identity.requestId,
    identity.reviewedMainOid,
    identity.reviewedHeadOid,
    identity.comparisonBaseOid,
    identity.comparisonTargetOid,
  ].join(':');
}

function reviewKey(review: CollabRequestReview): string {
  return identityKey({
    comparisonBaseOid: review.comparisonBaseOid,
    comparisonTargetOid: review.comparisonTargetOid,
    projectId: review.projectId,
    requestId: review.detail.request.id,
    reviewedHeadOid: review.detail.reviewedHeadOid,
    reviewedMainOid: review.detail.currentMainOid,
  });
}

function requestSourceKey(
  projectId: string,
  request: CollabChangeRequest,
  coordination: CollabCoordinationSnapshot,
): string {
  const source: CollabReviewSourceIdentity = {
    currentMemberId: coordination.snapshot.currentMember.id,
    currentMemberRole: coordination.snapshot.currentMember.role,
    mainOid: coordination.snapshot.project.mainOid,
  };
  return collabReviewSourceKey(projectId, request, source);
}

function publicationIdentityKey(identity: CollabPreparedPublicationReviewIdentity): string {
  return [
    identity.projectId,
    identity.operationId,
    identity.currentMainOid,
    identity.candidateOid,
    identity.comparisonBaseOid,
    identity.comparisonTargetOid,
  ].join(':');
}

function mergeReviewComments(
  retained: CollabRequestReview,
  incoming: CollabRequestReview,
): CollabRequestReview {
  const comments = [...incoming.detail.comments.comments];
  const commentIds = new Set(comments.map(comment => comment.id));
  for (const comment of retained.detail.comments.comments) {
    if (commentIds.has(comment.id)) continue;
    commentIds.add(comment.id);
    comments.push(comment);
  }
  if (comments.length === incoming.detail.comments.comments.length) return incoming;
  return {
    ...incoming,
    detail: {
      ...incoming.detail,
      comments: { comments },
      request: {
        ...incoming.detail.request,
        commentCount: Math.max(
          retained.detail.request.commentCount,
          incoming.detail.request.commentCount,
          comments.length,
        ),
      },
    },
  };
}

export class CollabPreparedReviewCache {
  private readonly entries = new Map<string, CachedEntry>();
  private readonly publicationEntries = new Map<string, CachedPublicationEntry>();
  private readonly requestEntries = new Map<string, string>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  store(entry: CollabPreparedReviewEntry): void {
    if (
      entry.coordination.snapshot.project.id !== entry.review.projectId
      || entry.coordination.snapshot.project.mainOid !== entry.review.detail.currentMainOid
    ) {
      return;
    }
    const key = reviewKey(entry.review);
    const cached = this.entries.get(key);
    const nextEntry = cached
      ? { ...entry, review: mergeReviewComments(cached.entry.review, entry.review) }
      : entry;
    if (cached) this.requestEntries.delete(cached.sourceKey);
    const sourceKey = requestSourceKey(
      entry.review.projectId,
      entry.review.detail.request,
      entry.coordination,
    );
    this.entries.delete(key);
    this.entries.set(key, {
      entry: nextEntry,
      expiresAt: this.now() + this.ttlMs,
      sourceKey,
    });
    this.requestEntries.set(sourceKey, key);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.deleteEntry(oldest);
    }
  }

  read(identity: CollabPreparedReviewIdentity): CollabPreparedReviewEntry | null {
    const key = identityKey(identity);
    const cached = this.entries.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      this.deleteEntry(key);
      return null;
    }
    return cached.entry;
  }

  readRequest(
    projectId: string,
    request: CollabChangeRequest,
    coordination: CollabCoordinationSnapshot,
  ): CollabPreparedReviewEntry | null {
    if (coordination.snapshot.project.id !== projectId) return null;
    const sourceKey = requestSourceKey(
      projectId,
      request,
      coordination,
    );
    this.discardStaleRequestEntries(projectId, request.id, sourceKey);
    const key = this.requestEntries.get(sourceKey);
    if (!key) return null;
    const cached = this.entries.get(key);
    if (!cached || cached.expiresAt <= this.now()) {
      if (cached) this.deleteEntry(key);
      else this.requestEntries.delete(sourceKey);
      return null;
    }
    return cached.entry;
  }

  discard(identity: CollabPreparedReviewIdentity): void {
    this.deleteEntry(identityKey(identity));
  }

  storePublication(review: CollabPublicationReview): void {
    const key = publicationIdentityKey(review);
    this.publicationEntries.delete(key);
    this.publicationEntries.set(key, {
      expiresAt: this.now() + this.ttlMs,
      review,
    });
    while (this.publicationEntries.size > this.maxEntries) {
      const oldest = this.publicationEntries.keys().next().value;
      if (!oldest) break;
      this.publicationEntries.delete(oldest);
    }
  }

  readPublication(
    identity: CollabPreparedPublicationReviewIdentity,
  ): CollabPublicationReview | null {
    const key = publicationIdentityKey(identity);
    const cached = this.publicationEntries.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      this.publicationEntries.delete(key);
      return null;
    }
    return cached.review;
  }

  discardPublication(identity: CollabPreparedPublicationReviewIdentity): void {
    this.publicationEntries.delete(publicationIdentityKey(identity));
  }

  clear(): void {
    this.entries.clear();
    this.publicationEntries.clear();
    this.requestEntries.clear();
  }

  private deleteEntry(key: string): void {
    const cached = this.entries.get(key);
    if (cached) this.requestEntries.delete(cached.sourceKey);
    this.entries.delete(key);
  }

  private discardStaleRequestEntries(
    projectId: string,
    requestId: string,
    sourceKey: string,
  ): void {
    for (const [key, cached] of this.entries) {
      if (
        cached.entry.review.projectId === projectId
        && cached.entry.review.detail.request.id === requestId
        && cached.sourceKey !== sourceKey
      ) {
        this.deleteEntry(key);
      }
    }
  }
}
