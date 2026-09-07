import type { CollabChangeRequest } from '@claudian-collab/protocol';

import type { CollabCoordinationSnapshot, CollabRequestReview } from '@/core/collab';
import { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';

const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const TREE = '3'.repeat(40);

describe('CollabPreparedReviewCache', () => {
  it('reuses a prepared request only while authoritative request metadata matches', () => {
    const cache = new CollabPreparedReviewCache();
    const request = changeRequest();
    const review = requestReview(request);
    const snapshot = coordination(request);
    cache.store({ coordination: snapshot, review });

    expect(cache.readRequest('project-a', request, snapshot)).toEqual({
      coordination: snapshot,
      review,
    });
    expect(cache.readRequest('project-a', {
      ...request,
      commentCount: 1,
    }, coordination({ ...request, commentCount: 1 }))).toBeNull();
    expect(cache.readRequest('project-a', {
      ...request,
      updatedAt: '2026-08-08T00:01:00.000Z',
    }, coordination({
      ...request,
      updatedAt: '2026-08-08T00:01:00.000Z',
    }))).toBeNull();
  });

  it('invalidates a prepared request when only the revision changes', () => {
    const cache = new CollabPreparedReviewCache();
    const request = changeRequest();
    const review = requestReview(request);
    const snapshot = coordination(request);
    cache.store({ coordination: snapshot, review });

    expect(cache.readRequest('project-a', request, snapshot)).not.toBeNull();
    expect(cache.readRequest('project-a', {
      ...request,
      revision: request.revision + 1,
    }, coordination({ ...request, revision: request.revision + 1 }))).toBeNull();
  });

  it('does not reuse Manager review authority after the current role changes', () => {
    const cache = new CollabPreparedReviewCache();
    const request = changeRequest();
    const review = requestReview(request);
    cache.store({
      coordination: coordination(request, 'manager'),
      review,
    });

    expect(cache.readRequest(
      'project-a',
      request,
      coordination(request, 'member'),
    )).toBeNull();
    expect(cache.read({
      comparisonBaseOid: review.comparisonBaseOid,
      comparisonTargetOid: review.comparisonTargetOid,
      projectId: review.projectId,
      requestId: review.detail.request.id,
      reviewedHeadOid: review.detail.reviewedHeadOid,
      reviewedMainOid: review.detail.currentMainOid,
    })).toBeNull();
  });
});

function changeRequest(): CollabChangeRequest {
  return {
    commentCount: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
    description: 'Published change',
    firstBaseOid: MAIN,
    id: 'request-a',
    latestHeadOid: HEAD,
    memberId: 'member-a',
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}

function requestReview(request: CollabChangeRequest): CollabRequestReview {
  return {
    canAccept: true,
    comparisonBaseOid: MAIN,
    comparisonKind: 'candidate',
    comparisonTargetOid: TREE,
    detail: {
      comments: { comments: [] },
      currentMainOid: MAIN,
      request,
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    },
    files: [],
    projectId: 'project-a',
  };
}

function coordination(
  request: CollabChangeRequest,
  role: 'manager' | 'member' = 'manager',
): CollabCoordinationSnapshot {
  const member = {
    activatedAt: '2026-08-08T00:00:00.000Z',
    createdAt: '2026-08-08T00:00:00.000Z',
    displayName: 'Member A',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role,
    status: 'active' as const,
  };
  return {
    snapshot: {
      currentMember: member,
      eventSequence: 1,
      members: [member],
      openTicketCount: 0,
      openRequests: [request],
      project: {
        authorityKind: 'lan',
        createdAt: '2026-08-08T00:00:00.000Z',
        hostMemberId: 'member-a',
        id: 'project-a',
        mainOid: MAIN,
        mainRef: 'refs/heads/main',
        managerSetGeneration: 0,
        name: 'Alpha',
      },
      ticketHighlights: [],
    },
    source: 'online',
    stale: false,
    syncState: {
      eventSequence: 1,
      generation: 1,
      projectId: 'project-a',
      status: 'synchronized',
    },
  };
}
