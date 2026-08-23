import { collabMemberRef, type CollabRequestDetail } from '@claudian-collab/protocol';

import { ensureTrustedCollabOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import {
  COLLAB_MAIN_FETCH_REFSPEC,
  COLLAB_ORIGIN_MAIN_REF,
  collabOriginTrackingRef,
} from '@/app/collab/git/collabGitRefs';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import type {
  GitRepositoryReadSession,
  GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import type {
  CollabReviewProjectContext,
  CollabReviewRepositoryPort,
} from '@/app/collab/review/CollabReviewService';
import { NativeGitExactComparisonRepository } from '@/app/collab/review/NativeGitExactComparisonRepository';
import { type CollabRequestReview, type CollabReviewFileContent, type CollabReviewFileRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ReviewGitNetworkPort {
  withNetwork<T>(
    context: CollabReviewProjectContext,
    operation: (network?: GitNetworkEnvironment) => Promise<T>,
  ): Promise<T>;
}

function reviewError(
  code: 'authority-integrity-error' | 'repository-invalid'
    | 'stale-main' | 'stale-request-head',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'stale-main' || code === 'stale-request-head'
        ? ['retry']
        : ['open-diagnostics'],
    safeContext: { reason, ...safeContext },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function remoteMemberRef(memberId: string): string {
  return collabOriginTrackingRef(collabMemberRef(memberId));
}

type ReviewRefAuthority =
  | 'authoritative'
  | 'head-changed'
  | 'head-missing'
  | 'head-unreachable'
  | 'main-changed';

export class NativeGitReviewRepository implements CollabReviewRepositoryPort {
  constructor(
    private readonly git: GitRepositoryService,
    private readonly network: ReviewGitNetworkPort,
    private readonly comparisons = new NativeGitExactComparisonRepository(git),
  ) {}

  async prepare(
    context: CollabReviewProjectContext,
    detail: CollabRequestDetail,
    signal?: AbortSignal,
  ): Promise<Omit<CollabRequestReview, 'canAccept'>> {
    throwIfCancelled(signal);
    if (detail.request.latestHeadOid !== detail.reviewedHeadOid) {
      throw reviewError('authority-integrity-error', 'review-request-head-mismatch');
    }
    await ensureTrustedCollabOrigin(this.git, context, 'review-origin-url-mismatch');

    const memberRef = collabMemberRef(detail.request.memberId);
    const memberRemoteRef = remoteMemberRef(detail.request.memberId);
    const localReview = await this.git.withReadSession(
      context.repositoryPath,
      'working',
      async session => {
        if (
          await this.readRefAuthority(session, detail, memberRemoteRef)
          !== 'authoritative'
        ) {
          return null;
        }
        return this.prepareInSession(session, context, detail, signal);
      },
    );
    if (localReview) return localReview;

    await this.network.withNetwork(context, network => this.git.fetch(
      context.repositoryPath,
      'origin',
      [
        COLLAB_MAIN_FETCH_REFSPEC,
        `+${memberRef}:${memberRemoteRef}`,
      ],
      network,
      signal,
    ));
    throwIfCancelled(signal);

    return this.git.withReadSession(context.repositoryPath, 'working', async session => {
      await this.assertAuthoritativeRefs(session, detail, memberRemoteRef);
      return this.prepareInSession(session, context, detail, signal);
    });
  }

  private async readRefAuthority(
    session: GitRepositoryReadSession,
    detail: CollabRequestDetail,
    memberRemoteRef: string,
  ): Promise<ReviewRefAuthority> {
    const refs = await session.resolveRefs([COLLAB_ORIGIN_MAIN_REF, memberRemoteRef]);
    const mainOid = refs.get(COLLAB_ORIGIN_MAIN_REF) ?? null;
    const advertisedHeadOid = refs.get(memberRemoteRef) ?? null;
    if (mainOid !== detail.currentMainOid) return 'main-changed';
    if (!advertisedHeadOid) return 'head-missing';
    if (detail.reviewCondition === 'stale') {
      return await session.isAncestor(detail.reviewedHeadOid, advertisedHeadOid)
        ? 'authoritative'
        : 'head-unreachable';
    }
    return advertisedHeadOid === detail.reviewedHeadOid
      ? 'authoritative'
      : 'head-changed';
  }

  private async assertAuthoritativeRefs(
    session: GitRepositoryReadSession,
    detail: CollabRequestDetail,
    memberRemoteRef: string,
  ): Promise<void> {
    switch (await this.readRefAuthority(session, detail, memberRemoteRef)) {
      case 'authoritative': return;
      case 'main-changed': throw reviewError('stale-main', 'review-main-changed');
      case 'head-missing':
        throw reviewError('stale-request-head', 'review-member-ref-missing');
      case 'head-unreachable':
        throw reviewError('stale-request-head', 'review-head-not-reachable');
      case 'head-changed':
        throw reviewError('stale-request-head', 'review-head-changed');
    }
  }

  private async prepareInSession(
    session: GitRepositoryReadSession,
    context: CollabReviewProjectContext,
    detail: CollabRequestDetail,
    signal?: AbortSignal,
  ): Promise<Omit<CollabRequestReview, 'canAccept'>> {
    throwIfCancelled(signal);
    const merge = await session.mergeTree(detail.currentMainOid, detail.reviewedHeadOid);
    if (detail.reviewCondition === 'clean' && merge.kind !== 'clean') {
      throw reviewError('authority-integrity-error', 'review-clean-condition-mismatch');
    }
    if (detail.reviewCondition === 'conflicting' && merge.kind !== 'conflicting') {
      throw reviewError('authority-integrity-error', 'review-conflict-condition-mismatch');
    }

    const candidate = detail.reviewCondition === 'clean';
    const comparisonBaseOid = candidate
      ? detail.currentMainOid
      : await session.findMergeBase(detail.currentMainOid, detail.reviewedHeadOid);
    const comparisonTargetOid = candidate
      ? (merge.kind === 'clean' ? merge.treeOid : null)
      : detail.reviewedHeadOid;
    if (!comparisonTargetOid) {
      throw reviewError('authority-integrity-error', 'review-candidate-tree-missing');
    }
    const files = await this.comparisons.compareInSession(
      session,
      comparisonBaseOid,
      comparisonTargetOid,
      signal,
    );

    return {
      comparisonBaseOid,
      comparisonKind: candidate ? 'candidate' : 'contribution',
      comparisonTargetOid,
      detail,
      files,
      projectId: context.projectId,
    };
  }

  async readFile(
    context: CollabReviewProjectContext,
    request: CollabReviewFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabReviewFileContent> {
    return this.comparisons.readFile(context.repositoryPath, request, signal);
  }
}
