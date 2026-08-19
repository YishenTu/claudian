import { createHash } from 'node:crypto';
import path from 'node:path';

import type { PublishRepositorySnapshot } from '@/app/collab/publish/PublishCoordinator';
import type { CollabChangedFile, CollabGitStatus } from '@/core/collab';

const LARGE_TEXT_REVIEW_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.canvas',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.markdown',
  '.mermaid',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function changedFilesFromPublishSnapshot(
  snapshot: PublishRepositorySnapshot,
): readonly CollabChangedFile[] {
  return snapshot.changedFiles.map(file => changedFileForReview({
    kind: file.status,
    ...(file.size === undefined ? {} : { newBytes: file.size }),
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  }));
}

export function changedFileForReview(input: {
  readonly kind: CollabChangedFile['kind'];
  readonly newBytes?: number;
  readonly path: string;
  readonly previousPath?: string;
  readonly workingTreeContentHash?: string;
}): CollabChangedFile {
  const binary = !TEXT_EXTENSIONS.has(
    path.posix.extname(input.path).toLocaleLowerCase('en-US'),
  );
  return {
    binary,
    kind: input.kind,
    largeForReview: !binary && (input.newBytes ?? 0) > LARGE_TEXT_REVIEW_BYTES,
    ...(input.newBytes === undefined ? {} : { newBytes: input.newBytes }),
    path: input.path,
    ...(input.previousPath ? { previousPath: input.previousPath } : {}),
    ...(input.workingTreeContentHash
      ? { workingTreeContentHash: input.workingTreeContentHash }
      : {}),
  };
}

export function toCollabGitStatus(snapshot: PublishRepositorySnapshot): CollabGitStatus {
  return {
    acceptedMainOid: snapshot.acceptedMainOid,
    aheadBy: snapshot.personalAheadBy,
    behindBy: snapshot.personalBehindBy,
    changedFiles: changedFilesFromPublishSnapshot(snapshot),
    headOid: snapshot.headOid,
    includesAcceptedMain: snapshot.includesAcceptedMain,
    personalRemoteOid: snapshot.personalRemoteOid,
    workingTreeClean: snapshot.workingTreeClean,
  };
}

export function workingTreeSnapshotId(
  snapshot: PublishRepositorySnapshot,
  baseOid: string,
  files: readonly CollabChangedFile[],
): string {
  return createHash('sha256').update(JSON.stringify({
    baseOid,
    files,
    headOid: snapshot.headOid,
    workingTreeFiles: snapshot.changedFiles.map(file => ({
      mode: file.mode ?? null,
      modifiedAtMs: file.modifiedAtMs ?? null,
      path: file.path,
      previousPath: file.previousPath ?? null,
      size: file.size ?? null,
      status: file.status,
    })),
    workingTreeClean: snapshot.workingTreeClean,
  })).digest('hex');
}
