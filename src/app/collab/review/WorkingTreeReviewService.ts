import { type CollabProjectId } from '@claudian/collab-protocol';

import type {
  PublishProjectPort,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import { workingTreeSnapshotId } from '@/app/collab/publish/PublishSnapshotProjection';
import { type CollabChangedFile, type CollabOperationOptions, type CollabReviewFileContent, type CollabWorkingTreeReview, type CollabWorkingTreeReviewFileRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface WorkingTreeSnapshotPort {
  inspect(
    context: Awaited<ReturnType<PublishProjectPort['load']>>,
    signal?: AbortSignal,
  ): Promise<PublishRepositorySnapshot>;
}

export interface WorkingTreeReviewFilePort {
  listChanges(
    repositoryPath: string,
    baseOid: string,
    headOid: string,
    signal?: AbortSignal,
  ): Promise<readonly CollabChangedFile[]>;
  readFile(
    repositoryPath: string,
    request: CollabWorkingTreeReviewFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabReviewFileContent>;
}

function reviewError(
  code: 'authority-integrity-error' | 'repository-invalid' | 'working-tree-busy',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'working-tree-busy' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function sameChangedFile(left: CollabChangedFile, right: CollabChangedFile): boolean {
  return left.path === right.path
    && left.previousPath === right.previousPath
    && left.kind === right.kind
    && left.binary === right.binary
    && left.workingTreeContentHash === right.workingTreeContentHash
    && left.oldBytes === right.oldBytes
    && left.newBytes === right.newBytes
    && left.additions === right.additions
    && left.deletions === right.deletions
    && left.largeForReview === right.largeForReview;
}

export class WorkingTreeReviewService {
  constructor(
    private readonly projects: PublishProjectPort,
    private readonly snapshots: WorkingTreeSnapshotPort,
    private readonly files: WorkingTreeReviewFilePort,
  ) {}

  async prepare(
    projectId: CollabProjectId,
    baseOid: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabWorkingTreeReview> {
    return (await this.capture(projectId, baseOid, options)).review;
  }

  async readFile(
    request: CollabWorkingTreeReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabReviewFileContent> {
    const captured = await this.capture(request.projectId, request.baseOid, options);
    const review = captured.review;
    if (
      review.headOid !== request.headOid
      || review.baseOid !== request.baseOid
      || review.snapshotId !== request.snapshotId
    ) {
      throw reviewError('working-tree-busy', 'working-tree-review-stale');
    }
    const expectedFile = review.files.find(file => file.path === request.file.path);
    if (!expectedFile || !sameChangedFile(expectedFile, request.file)) {
      throw reviewError('authority-integrity-error', 'working-tree-review-file-mismatch');
    }
    return this.files.readFile(captured.repositoryPath, request, options.signal);
  }

  private async capture(
    projectId: CollabProjectId,
    baseOid: string,
    options: CollabOperationOptions,
  ): Promise<{ readonly repositoryPath: string; readonly review: CollabWorkingTreeReview }> {
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const context = await this.projects.load(projectId);
    const snapshot = await this.snapshots.inspect(context, options.signal);
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    if (!snapshot.headOid) {
      throw reviewError('repository-invalid', 'working-tree-review-head-missing');
    }
    const files = await this.files.listChanges(
      context.repositoryPath,
      baseOid,
      snapshot.headOid,
      options.signal,
    );
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    return {
      repositoryPath: context.repositoryPath,
      review: {
        baseOid,
        files,
        headOid: snapshot.headOid,
        kind: 'working-tree',
        projectId,
        snapshotId: workingTreeSnapshotId(snapshot, baseOid, files),
      },
    };
  }
}
