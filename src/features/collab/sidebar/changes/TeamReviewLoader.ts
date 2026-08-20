import type { CollabChangeRequest } from '@claudian/collab-protocol';

import type { CollabCoordinationSnapshot, CollabOperationOptions, CollabRequestReview, CollabResult } from '@/core/collab';
import type { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';
import {
  collabReviewSourceKey,
} from '@/features/collab/handoff/CollabReviewSourceKey';

export interface TeamReviewLoaderPort {
  prepareReview(
    projectId: string,
    requestId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabRequestReview>>;
}

export type TeamReviewLoadResult =
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly review: CollabRequestReview }
  | { readonly kind: 'stale' };

interface ReviewSource {
  readonly coordination: CollabCoordinationSnapshot;
  readonly key: string;
  readonly projectId: string;
  readonly request: CollabChangeRequest;
}

interface ReviewJob {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  readonly finish: () => void;
  readonly key: string;
  readonly promise: Promise<TeamReviewLoadResult>;
  readonly resolve: (result: TeamReviewLoadResult) => void;
  readonly source: ReviewSource;
}

interface CachedReview {
  readonly key: string;
  readonly review: CollabRequestReview;
}

function reviewKey(
  projectId: string,
  request: CollabChangeRequest,
  coordination: CollabCoordinationSnapshot,
): string {
  return collabReviewSourceKey(projectId, request, {
    currentMemberId: coordination.snapshot.currentMember.id,
    currentMemberRole: coordination.snapshot.currentMember.role,
    mainOid: coordination.snapshot.project.mainOid,
  });
}

export class TeamReviewLoader {
  private activeJob: ReviewJob | null = null;
  private readonly cache = new Map<string, CachedReview>();
  private destroyed = false;
  private readonly jobs = new Map<string, ReviewJob>();
  private pendingJobs: ReviewJob[] = [];
  private projectId: string | null = null;
  private readonly sources = new Map<string, ReviewSource>();

  constructor(
    private readonly port: TeamReviewLoaderPort,
    private readonly preparedReviews?: CollabPreparedReviewCache,
  ) {}

  update(projectId: string, coordination: CollabCoordinationSnapshot): void {
    if (this.destroyed) return;
    if (this.projectId !== null && this.projectId !== projectId) this.reset();
    this.projectId = projectId;

    const sources = new Map<string, ReviewSource>();
    for (const request of coordination.snapshot.openRequests) {
      sources.set(request.id, {
        coordination,
        key: reviewKey(projectId, request, coordination),
        projectId,
        request,
      });
    }
    this.sources.clear();
    for (const [requestId, source] of sources) this.sources.set(requestId, source);

    for (const [requestId, cached] of this.cache) {
      if (sources.get(requestId)?.key !== cached.key) this.cache.delete(requestId);
    }
    for (const [requestId, source] of sources) {
      if (this.cache.get(requestId)?.key === source.key) continue;
      const prepared = this.preparedReviews?.readRequest(
        projectId,
        source.request,
        coordination,
      );
      if (prepared) {
        this.cache.set(requestId, { key: source.key, review: prepared.review });
      }
    }
    this.cancelInvalidJobs();
  }

  load(requestId: string): Promise<TeamReviewLoadResult> {
    if (this.destroyed) return Promise.resolve({ kind: 'stale' });
    const source = this.sources.get(requestId);
    if (!source) return Promise.resolve({ kind: 'stale' });
    this.cancelPendingExcept(source.key);
    const cached = this.cache.get(requestId);
    if (cached?.key === source.key) {
      return Promise.resolve({ kind: 'ready', review: cached.review });
    }

    const existing = this.jobs.get(source.key);
    if (existing && !existing.controller.signal.aborted) return existing.promise;

    let resolve!: (result: TeamReviewLoadResult) => void;
    let finish!: () => void;
    const promise = new Promise<TeamReviewLoadResult>(next => {
      resolve = next;
    });
    const completion = new Promise<void>(next => {
      finish = next;
    });
    const job: ReviewJob = {
      completion,
      controller: new AbortController(),
      finish,
      key: source.key,
      promise,
      resolve,
      source,
    };
    this.jobs.set(job.key, job);
    this.pendingJobs.push(job);
    this.pump();
    return promise;
  }

  select(requestId: string | null): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const retainedKey = requestId === null
      ? null
      : this.sources.get(requestId)?.key ?? null;
    this.cancelPendingExcept(retainedKey);
    const active = this.activeJob;
    if (!active || active.key === retainedKey) return Promise.resolve();
    active.controller.abort();
    active.resolve({ kind: 'stale' });
    return active.completion;
  }

  cancelPending(): void {
    void this.select(null);
  }

  peek(requestId: string): TeamReviewLoadResult | null {
    const source = this.sources.get(requestId);
    const cached = this.cache.get(requestId);
    return source && cached?.key === source.key
      ? { kind: 'ready', review: cached.review }
      : null;
  }

  currentKey(requestId: string): string | null {
    return this.sources.get(requestId)?.key ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reset();
  }

  private pump(): void {
    if (this.destroyed || this.activeJob) return;
    const job = this.pendingJobs.shift();
    if (!job) return;
    if (!this.isCurrent(job)) {
      this.jobs.delete(job.key);
      job.resolve({ kind: 'stale' });
      job.finish();
      this.pump();
      return;
    }
    this.activeJob = job;
    void this.run(job).then(result => {
      job.resolve(result);
    }).finally(() => {
      job.finish();
      if (this.activeJob === job) this.activeJob = null;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.pump();
    });
  }

  private async run(job: ReviewJob): Promise<TeamReviewLoadResult> {
    let result: CollabResult<CollabRequestReview>;
    try {
      result = await this.port.prepareReview(
        job.source.projectId,
        job.source.request.id,
        { signal: job.controller.signal },
      );
    } catch {
      return this.isCurrent(job) ? { kind: 'error' } : { kind: 'stale' };
    }
    if (!this.isCurrent(job)) return { kind: 'stale' };
    if (result.status !== 'success') return { kind: 'error' };
    const review = result.value;
    if (
      review.projectId !== job.source.projectId
      || review.detail.request.id !== job.source.request.id
      || review.detail.currentMainOid !== job.source.coordination.snapshot.project.mainOid
      || review.detail.reviewedHeadOid !== job.source.request.latestHeadOid
    ) {
      return { kind: 'error' };
    }
    this.cache.set(job.source.request.id, { key: job.key, review });
    this.preparedReviews?.store({
      coordination: job.source.coordination,
      review,
    });
    return { kind: 'ready', review };
  }

  private cancelInvalidJobs(): void {
    if (this.activeJob && !this.isCurrent(this.activeJob)) {
      this.activeJob.controller.abort();
      this.activeJob.resolve({ kind: 'stale' });
    }
    const retained: ReviewJob[] = [];
    for (const job of this.pendingJobs) {
      if (this.isCurrent(job)) {
        retained.push(job);
      } else {
        this.jobs.delete(job.key);
        job.controller.abort();
        job.resolve({ kind: 'stale' });
        job.finish();
      }
    }
    this.pendingJobs = retained;
  }

  private cancelPendingExcept(retainedKey: string | null): void {
    const retained: ReviewJob[] = [];
    for (const job of this.pendingJobs) {
      if (job.key === retainedKey) {
        retained.push(job);
      } else {
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        job.controller.abort();
        job.resolve({ kind: 'stale' });
        job.finish();
      }
    }
    this.pendingJobs = retained;
  }

  private isCurrent(job: ReviewJob): boolean {
    return !this.destroyed
      && !job.controller.signal.aborted
      && this.sources.get(job.source.request.id)?.key === job.key;
  }

  private reset(): void {
    if (this.activeJob) {
      this.activeJob.controller.abort();
      this.activeJob.resolve({ kind: 'stale' });
    }
    for (const job of this.pendingJobs) {
      job.controller.abort();
      job.resolve({ kind: 'stale' });
      job.finish();
    }
    this.pendingJobs = [];
    this.jobs.clear();
    this.sources.clear();
    this.cache.clear();
  }
}
